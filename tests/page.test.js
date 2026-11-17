const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { parse } = require('parse5');

const views = path.join(__dirname, '..', 'views');
const document = parse(fs.readFileSync(path.join(views, 'index.html'), 'utf8'));

function elements(node) {
  return (node.childNodes || []).flatMap((child) => [child, ...elements(child)]);
}

function attribute(node, name) {
  return (node.attrs || []).find((attr) => attr.name === name)?.value;
}

function text(node) {
  return node.nodeName === '#text'
    ? node.value
    : (node.childNodes || []).map(text).join('');
}

function byId(id) {
  const matches = elements(document).filter((node) => attribute(node, 'id') === id);
  assert.equal(matches.length, 1, 'unique #' + id);
  return matches[0];
}

function withClass(node, name) {
  return elements(node).filter((child) =>
    (attribute(child, 'class') || '').split(/\s+/).includes(name));
}

test('one native h1 has the exact title and precedes the score region', () => {
  const headings = elements(document).filter((node) => node.tagName === 'h1');
  assert.equal(headings.length, 1);
  const heading = headings[0];
  assert.equal(text(heading), '实时投票结果');
  const center = byId('content-container-center');
  const choice = byId('choice');
  assert.equal(heading.parentNode, center);
  assert.equal(choice.parentNode, center);
  assert.ok(center.childNodes.indexOf(heading) < center.childNodes.indexOf(choice));
});

test('the original document title and Angular initialization are preserved', () => {
  const titles = elements(document).filter((node) => node.tagName === 'title');
  assert.equal(titles.length, 1);
  assert.equal(text(titles[0]), '猫派 vs 狗派 -- Result');
  const html = elements(document).find((node) => node.tagName === 'html');
  const body = elements(document).find((node) => node.tagName === 'body');
  assert.equal(attribute(html, 'ng-app'), 'catsvsdogs');
  assert.equal(attribute(body, 'ng-controller'), 'statsCtrl');
  const scripts = elements(document).filter((node) => node.tagName === 'script');
  assert.deepEqual(scripts.map((node) => attribute(node, 'src')),
    ['socket.io.js', 'angular.min.js', 'app.js']);
});

test('both options keep their counts and one-decimal percentage bindings', () => {
  const choice = byId('choice');
  for (const [side, label, countId, count, percent] of [
    ['cats', '猫派', 'count-a', '{{aCount}}', '{{aPercent | number:1}}%'],
    ['dogs', '狗派', 'count-b', '{{bCount}}', '{{bPercent | number:1}}%']
  ]) {
    const options = withClass(choice, side);
    assert.equal(options.length, 1);
    const option = options[0];
    const labels = withClass(option, 'label');
    const stats = withClass(option, 'stat');
    assert.equal(labels.length, 1);
    assert.equal(stats.length, 1);
    assert.equal(text(labels[0]), label);
    assert.equal(text(stats[0]), percent);
    assert.equal(byId(countId).parentNode, option);
    assert.equal(text(byId(countId)), count);
  }
  const result = byId('result');
  assert.equal(byId('total-label').parentNode, result);
  assert.equal(byId('total-count').parentNode, result);
  assert.equal(text(byId('total-label')), '总票数');
  assert.equal(text(byId('total-count')), '{{total}}');
  byId('background-stats-1');
  byId('background-stats-2');
});

function initializeController() {
  const listeners = new Map();
  const scope = { $apply: (update) => update() };
  const body = { style: { opacity: 0 } };
  const backgrounds = {
    'background-stats-1': { style: {} },
    'background-stats-2': { style: {} }
  };
  const socket = { on: (event, listener) => listeners.set(event, listener) };
  const context = {
    angular: {
      module: (name, dependencies) => {
        assert.equal(name, 'catsvsdogs');
        assert.equal(dependencies.length, 0);
        return {
          controller: (name, controller) => {
            assert.equal(name, 'statsCtrl');
            controller(scope);
          }
        };
      }
    },
    io: { connect: () => socket },
    document: { body, getElementById: (id) => backgrounds[id] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(views, 'app.js'), 'utf8'), context);
  return { listeners, scope, body, backgrounds };
}

test('message initializes the existing scores listener and reveals the page', () => {
  const { listeners, scope, body } = initializeController();
  assert.equal(scope.aCount, 0);
  assert.equal(scope.bCount, 0);
  assert.equal(scope.total, 0);
  assert.equal(scope.aPercent, 50);
  assert.equal(scope.bPercent, 50);
  assert.equal(listeners.has('scores'), false);
  assert.equal(typeof listeners.get('message'), 'function');
  listeners.get('message')('Welcome!');
  assert.equal(body.style.opacity, 1);
  assert.equal(typeof listeners.get('scores'), 'function');
});

test('successive scores preserve counts, totals, percentages and the zero rule', () => {
  const { listeners, scope, backgrounds } = initializeController();
  listeners.get('message')('Welcome!');
  for (const [scores, a, b, aPercent, bPercent] of [
    [{ a: '2', b: '1' }, 2, 1, 67, 33],
    [{ a: '1', b: '3' }, 1, 3, 25, 75],
    [{ a: '5' }, 5, 0, 100, 0],
    [{ a: '0', b: '0' }, 0, 0, 50, 50]
  ]) {
    listeners.get('scores')(JSON.stringify(scores));
    assert.equal(scope.aCount, a);
    assert.equal(scope.bCount, b);
    assert.equal(scope.total, a + b);
    assert.equal(scope.aPercent, aPercent);
    assert.equal(scope.bPercent, bPercent);
    assert.equal(backgrounds['background-stats-1'].style.width, aPercent + '%');
    assert.equal(backgrounds['background-stats-2'].style.width, bPercent + '%');
  }
});
