'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.html'), 'utf8');

function createClient(timestampValues) {
  const socketHandlers = {};
  const nodes = {
    'background-stats-1': { style: {} },
    'background-stats-2': { style: {} }
  };
  const scope = {
    $apply: function (work) {
      work();
    }
  };
  const FakeDate = function () {
    const value = timestampValues.shift();
    if (!value) {
      throw new Error('unexpected browser clock read');
    }
    return {
      toISOString: function () {
        return value;
      }
    };
  };
  const context = {
    angular: {
      module: function () {
        return {
          controller: function (name, controller) {
            assert.strictEqual(name, 'statsCtrl');
            controller(scope);
          }
        };
      }
    },
    io: {
      connect: function () {
        return {
          on: function (event, handler) {
            socketHandlers[event] = handler;
          }
        };
      }
    },
    document: {
      body: { style: {} },
      getElementById: function (id) {
        return nodes[id];
      }
    },
    Date: FakeDate,
    JSON: JSON,
    console: console,
    isNaN: isNaN,
    parseInt: parseInt
  };

  vm.runInNewContext(appSource, context, { filename: 'views/app.js' });
  return { nodes, scope, socketHandlers };
}

function main() {
  assert.ok(indexSource.includes('id="waiting-for-data"'));
  assert.ok(indexSource.includes('等待实时数据'));
  assert.ok(indexSource.includes('id="last-updated"'));
  assert.ok(indexSource.includes('datetime="{{lastUpdated}}"'));
  assert.ok(indexSource.includes('最近更新：'));

  const client = createClient([
    '2026-11-14T10:10:00.000Z',
    '2026-11-14T10:10:01.000Z',
    '2026-11-14T10:10:02.000Z',
    '2026-11-14T10:10:03.000Z'
  ]);
  assert.strictEqual(client.scope.lastUpdated, null);
  assert.strictEqual(client.scope.total, 0);

  client.socketHandlers.message({ text: 'Welcome!' });
  client.socketHandlers.scores('{"a":0,"b":0}');
  assert.strictEqual(client.scope.aCount, 0);
  assert.strictEqual(client.scope.bCount, 0);
  assert.strictEqual(client.scope.aPercent, 50);
  assert.strictEqual(client.scope.bPercent, 50);
  assert.strictEqual(client.scope.total, 0);
  assert.strictEqual(client.scope.lastUpdated, '2026-11-14T10:10:00.000Z');
  assert.strictEqual(client.nodes['background-stats-1'].style.width, '50%');
  assert.strictEqual(client.nodes['background-stats-2'].style.width, '50%');

  const firstUpdated = client.scope.lastUpdated;
  client.socketHandlers.scores('{"a":3,"b":1}');
  assert.strictEqual(client.scope.aCount, 3);
  assert.strictEqual(client.scope.bCount, 1);
  assert.strictEqual(client.scope.aPercent, 75);
  assert.strictEqual(client.scope.bPercent, 25);
  assert.strictEqual(client.scope.total, 4);
  assert.strictEqual(client.scope.lastUpdated, '2026-11-14T10:10:01.000Z');
  assert.ok(new Date(client.scope.lastUpdated) > new Date(firstUpdated));

  client.socketHandlers.scores('{"a":3,"b":1}');
  assert.strictEqual(client.scope.aCount, 3);
  assert.strictEqual(client.scope.bCount, 1);
  assert.strictEqual(client.scope.total, 4);
  assert.strictEqual(client.scope.lastUpdated, '2026-11-14T10:10:02.000Z');
  assert.ok(new Date(client.scope.lastUpdated) > new Date(firstUpdated));

  const secondUpdated = client.scope.lastUpdated;
  client.socketHandlers.scores('{"a":4,"b":2}');
  assert.strictEqual(client.scope.aCount, 4);
  assert.strictEqual(client.scope.bCount, 2);
  assert.strictEqual(client.scope.aPercent, 67);
  assert.strictEqual(client.scope.bPercent, 33);
  assert.strictEqual(client.scope.total, 6);
  assert.strictEqual(client.scope.lastUpdated, '2026-11-14T10:10:03.000Z');
  assert.ok(new Date(client.scope.lastUpdated) > new Date(secondUpdated));

  const invalidClient = createClient(['2026-11-14T10:11:00.000Z']);
  invalidClient.socketHandlers.message({ text: 'Welcome!' });
  invalidClient.socketHandlers.scores('not-json');
  assert.strictEqual(invalidClient.scope.aCount, 0);
  assert.strictEqual(invalidClient.scope.bCount, 0);
  assert.strictEqual(invalidClient.scope.aPercent, 50);
  assert.strictEqual(invalidClient.scope.bPercent, 50);
  assert.strictEqual(invalidClient.scope.total, 0);
  assert.strictEqual(invalidClient.scope.lastUpdated, null);
  invalidClient.socketHandlers.scores('{"a":-1,"b":2}');
  assert.strictEqual(invalidClient.scope.aCount, 0);
  assert.strictEqual(invalidClient.scope.bCount, 0);
  assert.strictEqual(invalidClient.scope.aPercent, 50);
  assert.strictEqual(invalidClient.scope.bPercent, 50);
  assert.strictEqual(invalidClient.scope.total, 0);
  assert.strictEqual(invalidClient.scope.lastUpdated, null);
  invalidClient.socketHandlers.scores('[]');
  assert.strictEqual(invalidClient.scope.aCount, 0);
  assert.strictEqual(invalidClient.scope.bCount, 0);
  assert.strictEqual(invalidClient.scope.aPercent, 50);
  assert.strictEqual(invalidClient.scope.bPercent, 50);
  assert.strictEqual(invalidClient.scope.total, 0);
  assert.strictEqual(invalidClient.scope.lastUpdated, null);

  console.log('client live scores self-tests passed');
}

main();
