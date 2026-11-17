const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const html = readFileSync(path.join(__dirname, '..', 'views', 'index.html'), 'utf8');

function withDocument(check) {
  const dom = new JSDOM(html);
  try {
    check(dom.window.document);
  } finally {
    dom.window.close();
  }
}

function assertHeading(document) {
  const headings = document.querySelectorAll('h1');
  assert.equal(headings.length, 1, 'page must contain exactly one h1');
  const heading = headings[0];
  assert.equal(heading.tagName, 'H1');
  assert.equal(heading.textContent, '实时投票结果', 'h1 text must match exactly');

  const container = document.querySelector('#content-container-center');
  const choice = document.querySelector('#choice');
  assert.ok(container && choice, 'result container and choice region must exist');
  assert.equal(heading.parentElement, container, 'h1 must be in the centered content');
  assert.equal(choice.parentElement, container, 'choice must remain in the centered content');
  assert.ok(
    heading.compareDocumentPosition(choice) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'h1 must precede the choice region'
  );
}

function assertResults(document) {
  assert.equal(document.title, '猫派 vs 狗派 -- Result');
  assert.equal(document.documentElement.getAttribute('ng-app'), 'catsvsdogs');
  assert.equal(document.body.getAttribute('ng-controller'), 'statsCtrl');
  assert.equal(document.querySelectorAll('#choice .choice').length, 2);

  for (const [side, label, count, percent] of [
    ['cats', '猫派', 'a', 'aPercent'],
    ['dogs', '狗派', 'b', 'bPercent']
  ]) {
    const option = document.querySelector('#choice .choice.' + side);
    assert.ok(option, side + ' option must exist');
    assert.equal(option.querySelector('.label').textContent, label);
    assert.equal(document.querySelectorAll('#count-' + count).length, 1);
    assert.equal(option.querySelector('#count-' + count).textContent, '{{' + count + 'Count}}');
    assert.equal(option.querySelector('.stat').textContent, '{{' + percent + ' | number:1}}%');
  }

  assert.equal(document.querySelectorAll('#total-count').length, 1);
  assert.equal(document.querySelector('#result #total-label').textContent, '总票数');
  assert.equal(document.querySelector('#result #total-count').textContent, '{{total}}');
  assert.ok(document.querySelector('#background-stats-1'));
  assert.ok(document.querySelector('#background-stats-2'));
  assert.deepEqual(
    Array.from(document.querySelectorAll('script[src]'), (script) => script.getAttribute('src')),
    ['socket.io.js', 'angular.min.js', 'app.js']
  );
}

test('page has a unique exact h1 before the results', () => {
  withDocument(assertHeading);
});

test('original title, options, bindings and runtime scripts remain', () => {
  withDocument(assertResults);
});

test('missing h1 fails the heading assertion', () => {
  withDocument((document) => {
    document.querySelector('h1').remove();
    assert.throws(() => assertHeading(document), /exactly one h1/);
  });
});

test('duplicate h1 fails the heading assertion', () => {
  withDocument((document) => {
    const heading = document.querySelector('h1');
    heading.after(heading.cloneNode(true));
    assert.throws(() => assertHeading(document), /exactly one h1/);
  });
});

test('incorrect h1 text fails the heading assertion', () => {
  withDocument((document) => {
    document.querySelector('h1').textContent = '投票结果';
    assert.throws(() => assertHeading(document), /h1 text must match exactly/);
  });
});

test('h1 after the choice region fails the heading assertion', () => {
  withDocument((document) => {
    document.querySelector('#choice').after(document.querySelector('h1'));
    assert.throws(() => assertHeading(document), /h1 must precede the choice region/);
  });
});

test('changed document title fails the results assertion', () => {
  withDocument((document) => {
    document.title = 'Result';
    assert.throws(() => assertResults(document));
  });
});

test('missing count binding fails the results assertion', () => {
  withDocument((document) => {
    document.querySelector('#count-a').remove();
    assert.throws(() => assertResults(document));
  });
});
