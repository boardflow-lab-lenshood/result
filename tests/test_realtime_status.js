'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../views/app.js'), 'utf8');

function controller() {
  let now = Date.parse('2026-11-17T12:00:00.123Z');
  const socket = new EventEmitter();
  const backgrounds = { 'background-stats-1': { style: {} }, 'background-stats-2': { style: {} } };
  const scope = { $apply: callback => callback() };
  const BrowserDate = class extends Date {
    constructor() { super(now); }
  };
  const context = {
    Date: BrowserDate,
    document: { getElementById: id => backgrounds[id] },
    io: { connect: () => socket },
    angular: { module: () => ({ controller: (name, callback) => callback(scope) }) }
  };
  vm.runInNewContext(source, context, { filename: 'views/app.js' });
  return {
    scope, socket, backgrounds,
    advance: milliseconds => { now += milliseconds; },
    expectedISO: () => new Date(now).toISOString(),
    expectedText: () => new Date(now).toLocaleString(),
    scores: data => socket.emit('scores', JSON.stringify(data))
  };
}

test('connection and repeated welcome messages do not timestamp or multiply scores listeners', () => {
  const app = controller();
  assert.equal(app.scope.lastUpdated, undefined);
  assert.equal(app.socket.listenerCount('scores'), 1);
  app.socket.emit('connect');
  app.socket.emit('message', 'Welcome!');
  app.socket.emit('message', 'Welcome again!');
  app.advance(10000);
  assert.equal(app.scope.lastUpdated, undefined);
  assert.equal(app.socket.listenerCount('scores'), 1);
});

test('first zero scores work without a welcome and use this browser receive time', () => {
  const app = controller();
  app.advance(2000);
  app.scores({ a: 0, b: 0 });
  assert.equal(app.scope.lastUpdated, app.expectedISO());
  assert.equal(app.scope.lastUpdatedText, app.expectedText());
  assert.equal(app.scope.aCount, 0);
  assert.equal(app.scope.bCount, 0);
  assert.equal(app.scope.total, 0);
  assert.equal(app.scope.aPercent, 50);
  assert.equal(app.scope.bPercent, 50);
});

test('continuous messages preserve counts, total and existing percentage rounding', () => {
  const app = controller();
  for (const [a, b, total, percentA, percentB] of [[3, 1, 4, 75, 25], [4, 2, 6, 67, 33], [0, 0, 0, 50, 50]]) {
    app.advance(2000);
    app.scores({ a: String(a), b: String(b) });
    assert.equal(app.scope.aCount, a);
    assert.equal(app.scope.bCount, b);
    assert.equal(app.scope.total, total);
    assert.equal(app.scope.aPercent, percentA);
    assert.equal(app.scope.bPercent, percentB);
    assert.equal(app.backgrounds['background-stats-1'].style.width, percentA + '%');
    assert.equal(app.backgrounds['background-stats-2'].style.width, percentB + '%');
    assert.equal(app.scope.lastUpdated, app.expectedISO());
  }
});

test('identical counts received later advance the timestamp, elapsed time alone does not', () => {
  const app = controller();
  app.scores({ a: 3, b: 1 });
  const first = app.scope.lastUpdated;
  app.advance(10000);
  assert.equal(app.scope.lastUpdated, first);
  app.socket.emit('message', 'Welcome!');
  app.socket.emit('connect');
  assert.equal(app.scope.lastUpdated, first);
  app.scores({ a: 3, b: 1 });
  assert.equal(app.scope.lastUpdated, app.expectedISO());
  assert.ok(Date.parse(app.scope.lastUpdated) > Date.parse(first));
});

test('invalid scores neither create nor replace a valid timestamp or totals, and recovery works', () => {
  const app = controller();
  const invalid = [
    'not JSON', '{', 'null', '42', '[]', '{}',
    '{"a":"bad","b":1}', '{"a":1}', '{"a":null,"b":0}',
    '{"a":{"toString":null},"b":0}', '{"a":0,"b":{"toString":null}}'
  ];
  for (const value of invalid) {
    assert.doesNotThrow(() => app.socket.emit('scores', value));
    assert.equal(app.scope.lastUpdated, undefined);
    assert.equal(app.scope.total, 0);
  }
  app.scores({ a: 4, b: 2 });
  const last = app.scope.lastUpdated;
  const lastText = app.scope.lastUpdatedText;
  app.advance(10000);
  for (const value of invalid) {
    assert.doesNotThrow(() => app.socket.emit('scores', value));
    assert.equal(app.scope.lastUpdated, last);
    assert.equal(app.scope.lastUpdatedText, lastText);
    assert.equal(app.scope.total, 6);
    assert.equal(app.scope.aCount, 4);
    assert.equal(app.scope.bCount, 2);
    assert.equal(app.scope.aPercent, 67);
    assert.equal(app.scope.bPercent, 33);
    assert.equal(app.backgrounds['background-stats-1'].style.width, '67%');
    assert.equal(app.backgrounds['background-stats-2'].style.width, '33%');
  }
  app.scores({ a: 0, b: 0 });
  assert.equal(app.scope.lastUpdated, app.expectedISO());
  assert.equal(app.scope.total, 0);
});
