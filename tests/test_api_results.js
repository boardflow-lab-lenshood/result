const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const CHECKPOINT_MS = 8000;

function checkpoint(label, work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('checkpoint timed out: ' + label));
    }, CHECKPOINT_MS);
    Promise.resolve()
      .then(work)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function requestJson(port, pathName, body) {
  const method = body === undefined ? 'GET' : 'POST';
  return checkpoint(method + ' ' + pathName + ' :' + port, () => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: { connection: 'close', 'content-type': 'text/plain;charset=UTF-8' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          json = null;
        }
        resolve({ status: res.statusCode, body, json, contentType: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    req.end(body);
  }));
}

async function assertScores(port, counts) {
  const transportPath = '/socket.io/?EIO=4&transport=polling';
  const opened = await requestJson(port, transportPath);
  assert.strictEqual(opened.status, 200);
  assert.strictEqual(opened.body[0], '0');
  const session = JSON.parse(opened.body.slice(1));
  const sessionPath = transportPath + '&sid=' + encodeURIComponent(session.sid);
  try {
    const connected = await requestJson(port, sessionPath, '40');
    assert.strictEqual(connected.status, 200);
    for (let attempt = 0; attempt < 3; attempt++) {
      const polled = await requestJson(port, sessionPath);
      assert.strictEqual(polled.status, 200);
      for (const packet of polled.body.split('\x1e')) {
        if (!packet.startsWith('42')) continue;
        const event = JSON.parse(packet.slice(2));
        if (event[0] !== 'scores') continue;
        assert.strictEqual(event.length, 2);
        assert.strictEqual(typeof event[1], 'string');
        assert.deepStrictEqual(JSON.parse(event[1]), counts);
        return;
      }
    }
    throw new Error('Socket.IO scores event was not received');
  } finally {
    await requestJson(port, sessionPath, '1');
  }
}

function startChild(databaseUrl) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      DATABASE_URL: databaseUrl,
      PORT: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  return { child, getOutput: () => output };
}

async function waitForPort(child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < CHECKPOINT_MS) {
    const match = getOutput().match(/App running on port (\d+)/);
    if (match) {
      return Number(match[1]);
    }
    if (child.exitCode !== null) {
      throw new Error('server exited before listening: ' + getOutput());
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('checkpoint timed out: server listen\n' + getOutput());
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
}

async function withServer(databaseUrl, fn) {
  const started = startChild(databaseUrl);
  let port;
  try {
    port = await waitForPort(started.child, started.getOutput);
    await fn(port, started.getOutput);
  } finally {
    await stopChild(started.child);
  }
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL is required');
  }

  const admin = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000
  });
  try {
    await checkpoint('prepare votes table', () => admin.query(
      'CREATE TABLE IF NOT EXISTS votes (id VARCHAR(255) NOT NULL UNIQUE, vote VARCHAR(255) NOT NULL)'
    ));
    await checkpoint('truncate votes', () => admin.query('TRUNCATE votes'));

    await withServer(databaseUrl, async (port) => {
      const empty = await requestJson(port, '/api/results');
      assert.strictEqual(empty.status, 200);
      assert.ok(String(empty.contentType).includes('application/json'));
      assert.deepStrictEqual(empty.json, { a: 0, b: 0 });

      await checkpoint('insert vote a', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('voter-a', 'a')"
      ));
      const onlyA = await requestJson(port, '/api/results');
      assert.strictEqual(onlyA.status, 200);
      assert.deepStrictEqual(onlyA.json, { a: 1, b: 0 });

      await checkpoint('insert vote b', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('voter-b', 'b')"
      ));
      const both = await requestJson(port, '/api/results');
      assert.strictEqual(both.status, 200);
      assert.strictEqual(typeof both.json.a, 'number');
      assert.strictEqual(typeof both.json.b, 'number');
      assert.deepStrictEqual(both.json, { a: 1, b: 1 });

      const home = await requestJson(port, '/');
      assert.strictEqual(home.status, 200);
      assert.ok(home.body.includes('猫派'));
      assert.ok(home.body.includes('狗派'));
      assert.ok(home.body.includes('总票数'));
      assert.ok(home.body.includes('id="count-a"'));
      assert.ok(home.body.includes('id="count-b"'));
      assert.ok(home.body.includes('id="total-count"'));
      assert.ok(!home.body.includes('Cats'));
      assert.ok(!home.body.includes('Dogs'));

      const health = await requestJson(port, '/healthz');
      assert.strictEqual(health.status, 200);
      assert.deepStrictEqual(health.json, { status: 'ok', service: 'result' });
    });

    await checkpoint('truncate votes before summary', () => admin.query('TRUNCATE votes'));
    await withServer(databaseUrl, async (port) => {
      const cases = [
        { counts: { a: 0, b: 0 }, total: 0, leader: null, percentages: { a: 0, b: 0 } },
        { counts: { a: 3, b: 1 }, total: 4, leader: 'a', percentages: { a: 75, b: 25 } },
        { counts: { a: 1, b: 2 }, total: 3, leader: 'b', percentages: { a: 33.3, b: 66.7 } },
        { counts: { a: 1, b: 0 }, total: 1, leader: 'a', percentages: { a: 100, b: 0 } },
        { counts: { a: 7, b: 7 }, total: 14, leader: null, percentages: { a: 50, b: 50 } },
        { counts: { a: 1, b: 15 }, total: 16, leader: 'b', percentages: { a: 6.3, b: 93.7 } },
        { counts: { a: 0, b: 1 }, total: 1, leader: 'b', percentages: { a: 0, b: 100 } },
        { counts: { a: 1, b: 1 }, total: 2, leader: null, percentages: { a: 50, b: 50 } },
        { counts: { a: 2, b: 1 }, total: 3, leader: 'a', percentages: { a: 66.7, b: 33.3 } }
      ];
      for (const expected of cases) {
        await checkpoint('seed summary counts ' + JSON.stringify(expected.counts), async () => {
          await admin.query('TRUNCATE votes');
          for (const vote of ['a', 'b']) {
            for (let n = 0; n < expected.counts[vote]; n++) {
              await admin.query('INSERT INTO votes (id, vote) VALUES ($1, $2)', [vote + n, vote]);
            }
          }
        });
        const summary = await requestJson(port, '/api/uat/result-summary');
        assert.strictEqual(summary.status, 200);
        assert.ok(String(summary.contentType).includes('application/json'));
        assert.deepStrictEqual(summary.json, expected);
        assert.strictEqual(summary.json.percentages.a + summary.json.percentages.b,
          expected.total === 0 ? 0 : 100);
        for (const value of Object.values(summary.json.percentages)) {
          assert.strictEqual(typeof value, 'number');
          assert.ok(Number.isFinite(value));
          assert.match(String(value), /^\d+(?:\.\d)?$/);
        }
        const repeated = await requestJson(port, '/api/uat/result-summary');
        assert.strictEqual(repeated.status, 200);
        assert.deepStrictEqual(repeated.json, summary.json);
        const results = await requestJson(port, '/api/results');
        assert.strictEqual(results.status, 200);
        assert.deepStrictEqual(results.json, expected.counts);
        await assertScores(port, expected.counts);
        console.log('summary fixture passed: ' + JSON.stringify(summary.json));
      }
      const home = await requestJson(port, '/');
      assert.strictEqual(home.status, 200);
      assert.ok(home.body.includes('id="count-a"'));
      assert.ok(home.body.includes('id="count-b"'));
      assert.ok(home.body.includes('id="total-count"'));
    });

    await withServer('postgres://invalid:invalid@127.0.0.1:1/none', async (port, output) => {
      const failed = await requestJson(port, '/api/results');
      assert.strictEqual(failed.status, 503);
      assert.ok(String(failed.contentType).includes('application/json'));
      assert.deepStrictEqual(failed.json, {
        error: 'database_unavailable',
        service: 'result'
      });
      assert.ok(!('a' in failed.json));
      assert.ok(!('b' in failed.json));
      assert.ok(output().includes('Failed to read vote counts'));

      const failedSummary = await requestJson(port, '/api/uat/result-summary');
      assert.strictEqual(failedSummary.status, 503);
      assert.deepStrictEqual(failedSummary.json, {
        error: 'database_unavailable',
        service: 'result'
      });
      assert.strictEqual(failed.body, '{"error":"database_unavailable","service":"result"}');
      assert.strictEqual(failedSummary.body, '{"error":"database_unavailable","service":"result"}');
      assert.ok(output().includes('Failed to read result summary'));
    });
  } finally {
    await Promise.race([
      admin.end(),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  console.log('result api self-tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
