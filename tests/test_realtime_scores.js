const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../views/app.js'), 'utf8');

function browserController() {
  const listeners = {};
  let now = Date.parse('2026-11-14T12:00:00.000Z');
  const scope = { $apply: (render) => render() };
  const backgrounds = {
    'background-stats-1': { style: {} },
    'background-stats-2': { style: {} }
  };
  const context = {
    angular: { module: () => ({ controller: (name, controller) => controller(scope) }) },
    io: { connect: () => ({ on: (event, listener) => {
      (listeners[event] ||= []).push(listener);
    } }) },
    document: { getElementById: (id) => backgrounds[id] },
    Date: class extends Date {
      constructor() { super(now); }
    }
  };
  vm.runInNewContext(source, context);
  return {
    scope,
    backgrounds,
    listeners,
    advance: () => { now += 1000; return new Date(now).toISOString(); },
    emit: (event, payload) => (listeners[event] || []).forEach(listener => listener(payload))
  };
}

function snapshot(browser) {
  const { aCount, bCount, aPercent, bPercent, total, lastUpdated } = browser.scope;
  return { aCount, bCount, aPercent, bPercent, total, lastUpdated };
}

test('waits without a timestamp through connection and welcome messages', () => {
  const browser = browserController();
  assert.equal(browser.scope.lastUpdated, null);
  browser.advance();
  browser.emit('connect');
  browser.emit('message', { text: 'Welcome!' });
  browser.emit('message', { text: 'Welcome again!' });
  assert.equal(browser.scope.lastUpdated, null);
  assert.equal(browser.listeners.scores.length, 1);
});

test('records the first zero scores and preserves the established percentage rules', () => {
  const browser = browserController();
  for (const [a, b, aPercent, bPercent] of [[0, 0, 50, 50], [3, 1, 75, 25], [4, 2, 67, 33]]) {
    const receivedAt = browser.advance();
    browser.emit('scores', JSON.stringify({ a, b }));
    assert.deepEqual(snapshot(browser), {
      aCount: a, bCount: b, aPercent, bPercent, total: a + b, lastUpdated: receivedAt
    });
    assert.equal(browser.backgrounds['background-stats-1'].style.width, aPercent + '%');
    assert.equal(browser.backgrounds['background-stats-2'].style.width, bPercent + '%');
  }
});

test('every valid scores message advances reception time even with unchanged counts', () => {
  const browser = browserController();
  browser.emit('scores', '{"a":3,"b":1}');
  const first = browser.scope.lastUpdated;
  const next = browser.advance();
  browser.emit('scores', '{"a":3,"b":1}');
  assert.equal(browser.scope.lastUpdated, next);
  assert.ok(Date.parse(next) > Date.parse(first));
  assert.equal(browser.scope.total, 4);
});

test('invalid messages neither end waiting nor change established results or reception time', () => {
  const invalid = [
    '{', 'null', '[]', 'false', '0', '"scores"',
    '{"a":-1}', '{"a":1.5}', '{"a":"3oops"}', '{"a":"1.5"}',
    '{"a":{},"b":1}', '{"a":[],"b":1}', '{"a":true}',
    '{"a":false,"b":1}', '{"a":null,"b":1}', '{"a":"","b":1}',
    '{"a":1,"b":false}', '{"a":1,"b":null}', '{"a":1,"b":""}',
    '{"a":"NaN"}', '{"a":"Infinity"}', '{"a":1e309}',
    '{"a":9007199254740992}', '{"b":-2}'
  ];
  const browser = browserController();
  for (const payload of invalid) {
    browser.advance();
    browser.emit('scores', payload);
    assert.equal(browser.scope.lastUpdated, null, payload);
  }
  browser.emit('scores', '{"a":4,"b":2}');
  const before = snapshot(browser);
  for (const payload of invalid) {
    browser.advance();
    browser.emit('scores', payload);
    assert.deepEqual(snapshot(browser), before, payload);
  }
  browser.advance();
  browser.emit('message', { text: 'Welcome!' });
  assert.deepEqual(snapshot(browser), before);
});

test('accepts normal count strings and defaults an absent count to zero', () => {
  const browser = browserController();
  browser.emit('scores', '{"a":"3","b":"1"}');
  assert.equal(browser.scope.aCount, 3);
  assert.equal(browser.scope.bCount, 1);
  browser.emit('scores', '{"b":2}');
  assert.equal(browser.scope.aCount, 0);
  assert.equal(browser.scope.bCount, 2);
  browser.emit('scores', '{}');
  assert.equal(browser.scope.total, 0);
  assert.equal(browser.scope.aPercent, 50);
});

test('captures reception time before rendering, rather than when the view updates', () => {
  const browser = browserController();
  const receivedAt = browser.advance();
  browser.scope.$apply = (render) => {
    browser.advance();
    render();
  };
  browser.emit('scores', '{"a":3,"b":1}');
  assert.equal(browser.scope.lastUpdated, receivedAt);
});
