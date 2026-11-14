const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../views/app.js'), 'utf8');

function createPage() {
  const socket = new EventEmitter();
  const backgrounds = { 'background-stats-1': { style: {} }, 'background-stats-2': { style: {} } };
  const body = { style: {} };
  let now = Date.parse('2026-11-14T10:00:00.000Z');
  let updates = 0;
  const scope = { $apply: (update) => { updates++; update(); } };
  class BrowserDate extends Date {
    constructor() { super(now); }
  }
  vm.runInNewContext(source, {
    angular: { module: () => ({ controller: (name, controller) => controller(scope) }) },
    io: { connect: () => socket },
    document: { getElementById: (id) => backgrounds[id], body },
    Date: BrowserDate
  });
  return {
    scope, socket, body, backgrounds,
    advance: () => { now += 2000; },
    receive: (json) => socket.emit('scores', json),
    time: () => new Date(now).toISOString(),
    updates: () => updates
  };
}

test('the page is visible and has no receive time before a valid score', () => {
  const page = createPage();
  assert.equal(page.body.style.opacity, 1);
  assert.equal(page.scope.lastUpdated, null);
  assert.equal(page.updates(), 0);
  page.socket.emit('message', { text: 'Welcome!' });
  page.socket.emit('connect');
  assert.equal(page.scope.lastUpdated, null);
});

test('zero, 3/1 and 4/2 keep counts, totals, percentages and backgrounds', () => {
  const page = createPage();
  for (const [a, b, aPercent, bPercent] of [[0, 0, 50, 50], [3, 1, 75, 25], [4, 2, 67, 33]]) {
    page.advance();
    page.receive(JSON.stringify({ a, b }));
    assert.equal(page.scope.aCount, a);
    assert.equal(page.scope.bCount, b);
    assert.equal(page.scope.total, a + b);
    assert.equal(page.scope.aPercent, aPercent);
    assert.equal(page.scope.bPercent, bPercent);
    assert.equal(page.backgrounds['background-stats-1'].style.width, aPercent + '%');
    assert.equal(page.backgrounds['background-stats-2'].style.width, bPercent + '%');
    assert.equal(page.scope.lastUpdated, page.time());
    assert.ok(Number.isFinite(Date.parse(page.scope.lastUpdated)));
  }
});

test('an identical score updates the receive time and connection events do not', () => {
  const page = createPage();
  page.receive('{"a":3,"b":1}');
  const first = page.scope.lastUpdated;
  page.advance();
  page.socket.emit('message', { text: 'Welcome again!' });
  page.socket.emit('message', { text: 'Welcome again!' });
  page.socket.emit('connect');
  page.socket.emit('disconnect');
  assert.equal(page.scope.lastUpdated, first);
  assert.equal(page.socket.listenerCount('scores'), 1);
  page.receive('{"a":3,"b":1}');
  assert.equal(page.scope.lastUpdated, page.time());
  assert.ok(Date.parse(page.scope.lastUpdated) > Date.parse(first));
  assert.equal(page.updates(), 2);
});

test('malformed or unusable scores preserve waiting or the last successful update', () => {
  const invalid = ['not json', '', 'null', 'false', '42', '"text"', '[1,2]',
    '{"a":"no votes","b":1}', '{"a":1,"b":{}}', '{"a":-1,"b":1}'];
  const page = createPage();
  for (const json of invalid) page.receive(json);
  assert.equal(page.scope.lastUpdated, null);
  assert.equal(page.updates(), 0);
  page.receive('{"a":4,"b":2}');
  const previous = { ...page.scope };
  page.advance();
  for (const json of invalid) page.receive(json);
  assert.deepEqual(page.scope, previous);
  assert.equal(page.updates(), 1);
  page.receive('{"a":0,"b":0}');
  assert.equal(page.scope.lastUpdated, page.time());
  assert.equal(page.scope.total, 0);
});

test('legacy empty arrays, numeric strings and missing option defaults still work', () => {
  const page = createPage();
  page.receive('[]');
  assert.equal(page.scope.lastUpdated, page.time());
  assert.equal(page.scope.total, 0);
  assert.equal(page.scope.aPercent, 50);
  page.advance();
  page.receive('{"a":"3","b":"1"}');
  assert.equal(page.scope.total, 4);
  assert.equal(page.scope.aPercent, 75);
  page.receive('{"a":3}');
  assert.equal(page.scope.bCount, 0);
  assert.equal(page.scope.total, 3);
});
