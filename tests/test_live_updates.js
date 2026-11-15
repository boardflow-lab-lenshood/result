const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../views/app.js'), 'utf8');

function loadPage() {
  let now = Date.parse('2026-11-15T10:00:00.000Z');
  const handlers = {};
  const scope = { $apply: (fn) => fn() };
  const backgrounds = [{ style: {} }, { style: {} }];
  const body = { style: {} };
  class BrowserDate extends Date {
    constructor() { super(now); }
  }
  vm.runInNewContext(source, {
    Date: BrowserDate,
    document: {
      body,
      getElementById: (id) => backgrounds[id.endsWith('1') ? 0 : 1]
    },
    angular: { module: () => ({ controller: (name, init) => init(scope) }) },
    io: { connect: () => ({
      on: (name, fn) => {
        if (!handlers[name]) handlers[name] = [];
        handlers[name].push(fn);
      }
    }) }
  });
  return {
    scope, backgrounds, body, handlers,
    advance: () => { now += 2500; return new Date(now).toISOString(); },
    emit: (event, payload) => (handlers[event] || []).forEach((fn) => fn(payload)),
    snapshot: () => JSON.stringify({ scope, backgrounds })
  };
}

test('page waits with no time until a valid scores event, independently of welcome', () => {
  const page = loadPage();
  assert.equal(page.body.style.opacity, 1);
  assert.equal(page.scope.lastUpdated, null);
  assert.equal(page.handlers.scores.length, 1);
  page.advance();
  page.emit('connect');
  page.emit('message', { text: 'Welcome!' });
  page.emit('message', { text: 'Welcome again!' });
  assert.equal(page.scope.lastUpdated, null);
  assert.equal(page.handlers.scores.length, 1);
  const receivedAt = page.advance();
  page.emit('scores', '{"a":0,"b":0}');
  assert.equal(page.scope.lastUpdated, receivedAt);
  assert.equal(page.scope.total, 0);
  assert.equal(page.scope.aPercent, 50);
  assert.equal(page.scope.bPercent, 50);
});

test('valid messages update counts, existing rounding and time, including equal counts', () => {
  const page = loadPage();
  for (const [a, b, aPercent, bPercent] of [[3, 1, 75, 25], [4, 2, 67, 33], [4, 2, 67, 33], [0, 0, 50, 50]]) {
    const receivedAt = page.advance();
    page.emit('scores', JSON.stringify({ a, b }));
    assert.equal(page.scope.lastUpdated, receivedAt);
    assert.equal(page.scope.aCount, a);
    assert.equal(page.scope.bCount, b);
    assert.equal(page.scope.total, a + b);
    assert.equal(page.scope.aPercent, aPercent);
    assert.equal(page.scope.bPercent, bPercent);
    assert.equal(page.backgrounds[0].style.width, aPercent + '%');
    assert.equal(page.backgrounds[1].style.width, bPercent + '%');
  }
});

test('invalid messages never change scores or generate/advance the receipt time', () => {
  const invalid = [
    '{', 'null', '[]', 'true', '0', '"hello"', '{}',
    '{"a":1}', '{"b":2}', '{"a":-1,"b":2}', '{"a":1,"b":-2}',
    '{"a":1.5,"b":2}', '{"a":1,"b":2.5}',
    '{"a":"3","b":1}', '{"a":3,"b":"1"}',
    '{"a":null,"b":0}', '{"a":0,"b":false}',
    '{"a":1e400,"b":0}', '{"a":0,"b":1e400}',
    '{"a":{},"b":0}', '{"a":0,"b":[]}'
  ];
  const page = loadPage();
  for (const hasValidData of [false, true]) {
    if (hasValidData) page.emit('scores', '{"a":3,"b":1}');
    const before = page.snapshot();
    for (const payload of invalid) {
      page.advance();
      assert.doesNotThrow(() => page.emit('scores', payload));
      assert.equal(page.snapshot(), before, payload);
    }
    page.advance();
    page.emit('connect');
    page.emit('message', { text: 'Welcome!' });
    assert.equal(page.snapshot(), before);
  }
});

test('a fresh page starts waiting again instead of reusing the previous receipt time', () => {
  const page = loadPage();
  page.emit('scores', '{"a":4,"b":2}');
  assert.ok(page.scope.lastUpdated);
  const refreshed = loadPage();
  assert.equal(refreshed.scope.lastUpdated, null);
  assert.equal(refreshed.scope.total, 0);
});
