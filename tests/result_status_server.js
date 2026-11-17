'use strict';

// Isolated browser fixture: only PostgreSQL is replaced. The application,
// Angular bindings and Socket.IO server/client run unchanged.
var EventEmitter = require('events');
var pg = require('pg');
var counts = { a: 0, b: 0 };

function query(sql, params, callback) {
  if (typeof params === 'function') callback = params;
  var result = { rows: [
    { vote: 'a', count: String(counts.a) },
    { vote: 'b', count: String(counts.b) }
  ] };
  if (callback) {
    process.nextTick(function () { callback(null, result); });
    return;
  }
  return Promise.resolve(result);
}

class TestPool extends EventEmitter {
  connect(callback) {
    var client = { query: query, release: function () {} };
    if (callback) {
      process.nextTick(function () { callback(null, client, client.release); });
      return;
    }
    return Promise.resolve(client);
  }
  query(sql, params, callback) { return query(sql, params, callback); }
  end() { return Promise.resolve(); }
}

pg.Pool = TestPool;
process.on('message', function (message) {
  if (message.type === 'counts') {
    counts = message.counts;
    process.send({ type: 'counts-set' });
  }
});
var server = require('../server').server;
server.once('listening', function () {
  process.send({ type: 'ready', port: server.address().port });
});
