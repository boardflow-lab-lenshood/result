const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { parse } = require('parse5');

const views = path.join(__dirname, '..', 'views');
const html = fs.readFileSync(path.join(views, 'index.html'), 'utf8');

function elements(node) {
  return (node.childNodes || []).flatMap(child => [child, ...elements(child)]);
}

function attr(node, name) {
  return (node.attrs || []).find(item => item.name === name)?.value;
}

function text(node) {
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
}

function checkPage(source) {
  const nodes = elements(parse(source));
  const headings = nodes.filter(node => node.tagName === 'h1');
  assert.equal(headings.length, 1, 'exactly one h1');
  const heading = headings[0];
  assert.equal(text(heading), '实时投票结果', 'exact heading text');
  assert.equal(attr(heading, 'hidden'), undefined, 'heading is not hidden');
  assert.notEqual(attr(heading, 'aria-hidden'), 'true');

  function byId(id) {
    const found = nodes.filter(node => attr(node, 'id') === id);
    assert.equal(found.length, 1, `unique #${id}`);
    return found[0];
  }

  const choice = byId('choice');
  assert.equal(heading.parentNode, byId('content-container-center'));
  assert.equal(heading.parentNode, choice.parentNode, 'heading and choice share layout container');
  assert.ok(nodes.indexOf(heading) < nodes.indexOf(choice), 'heading precedes both choices');

  const titles = nodes.filter(node => node.tagName === 'title');
  assert.equal(titles.length, 1);
  assert.equal(text(titles[0]), '猫派 vs 狗派 -- Result');
  assert.equal(attr(nodes.find(node => node.tagName === 'html'), 'ng-app'), 'catsvsdogs');
  assert.equal(attr(nodes.find(node => node.tagName === 'body'), 'ng-controller'), 'statsCtrl');

  const sides = elements(choice).filter(node => (attr(node, 'class') || '').split(/\s+/).includes('choice'));
  assert.equal(sides.length, 2, 'both result columns remain');
  for (const [index, label, count, binding, percentage] of [
    [0, '猫派', 'count-a', '{{aCount}}', '{{aPercent | number:1}}%'],
    [1, '狗派', 'count-b', '{{bCount}}', '{{bPercent | number:1}}%']
  ]) {
    const children = elements(sides[index]);
    const withClass = name => children.filter(node => (attr(node, 'class') || '').split(/\s+/).includes(name));
    assert.equal(withClass('label').length, 1);
    assert.equal(text(withClass('label')[0]), label);
    assert.ok(children.includes(byId(count)), 'count remains inside its result column');
    assert.equal(text(byId(count)), binding);
    assert.equal(withClass('stat').length, 1);
    assert.equal(text(withClass('stat')[0]), percentage);
  }
  const result = elements(byId('result'));
  assert.ok(result.includes(byId('total-label')));
  assert.ok(result.includes(byId('total-count')));
  assert.equal(text(byId('total-label')), '总票数');
  assert.equal(text(byId('total-count')), '{{total}}');
  assert.deepEqual(nodes.filter(node => node.tagName === 'script').map(node => attr(node, 'src')),
    ['socket.io.js', 'angular.min.js', 'app.js'], 'original client loading order');
}

test('page heading, DOM order, document title and original result bindings', () => {
  checkPage(html);
});

const headingMarkup = '<h1>实时投票结果</h1>';
for (const [name, change] of [
  ['missing heading', source => source.replace(headingMarkup, '')],
  ['duplicate heading', source => source.replace(headingMarkup, headingMarkup + headingMarkup)],
  ['incorrect heading text', source => source.replace('实时投票结果', '投票结果')],
  ['heading after results', source => source.replace(headingMarkup, '').replace('      </div>\n    </div>\n    <div id="result">', `        ${headingMarkup}\n      </div>\n    </div>\n    <div id="result">`)],
  ['hidden heading', source => source.replace('<h1>', '<h1 hidden>')],
  ['changed document title', source => source.replace('猫派 vs 狗派 -- Result', 'Result')],
  ['broken count binding', source => source.replace('{{aCount}}', '{{wrongCount}}')],
  ['changed percentage format', source => source.replace('{{bPercent | number:1}}%', '{{bPercent}}%')],
  ['broken total binding', source => source.replace('{{total}}', '{{wrongTotal}}')]
]) {
  test(`structure regression detects ${name}`, () => {
    const changed = change(html);
    assert.notEqual(changed, html, 'mutation must alter the fixture');
    assert.throws(() => checkPage(changed), assert.AssertionError);
  });
}

test('original message/scores controller updates isolated zero and nonzero counts', () => {
  const listeners = {};
  const background = { 'background-stats-1': { style: {} }, 'background-stats-2': { style: {} } };
  const body = { style: {} };
  const scope = { $apply: callback => callback() };
  let connections = 0;
  const context = {
    angular: {
      module(name, dependencies) {
        assert.equal(name, 'catsvsdogs');
        assert.equal(dependencies.length, 0);
        return { controller(name, callback) {
          assert.equal(name, 'statsCtrl');
          callback(scope);
        } };
      }
    },
    io: { connect() {
      connections++;
      return { on: (event, callback) => { listeners[event] = callback; } };
    } },
    document: { body, getElementById: id => background[id] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(views, 'app.js'), 'utf8'), context);
  assert.equal(connections, 1);
  assert.equal(scope.aCount, 0);
  assert.equal(scope.bCount, 0);
  assert.equal(scope.total, 0);
  assert.equal(scope.aPercent, 50);
  assert.equal(scope.bPercent, 50);
  assert.equal(typeof listeners.message, 'function');
  assert.equal(listeners.scores, undefined, 'scores registration follows original initialization');
  listeners.message('connected');
  assert.equal(body.style.opacity, 1);
  assert.equal(typeof listeners.scores, 'function');

  for (const [payload, a, b, aPercent, bPercent] of [
    [{}, 0, 0, 50, 50],
    [{ a: '2', b: '1' }, 2, 1, 67, 33],
    [{ a: '0', b: '4' }, 0, 4, 0, 100],
    [{ a: '0', b: '0' }, 0, 0, 50, 50]
  ]) {
    listeners.scores(JSON.stringify(payload));
    assert.equal(scope.aCount, a);
    assert.equal(scope.bCount, b);
    assert.equal(scope.total, a + b);
    assert.equal(scope.aPercent, aPercent);
    assert.equal(scope.bPercent, bPercent);
    assert.equal(background['background-stats-1'].style.width, aPercent + '%');
    assert.equal(background['background-stats-2'].style.width, bPercent + '%');
  }
});
