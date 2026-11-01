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

function requestJson(port, pathName) {
  return checkpoint('GET ' + pathName + ' :' + port, () => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'GET',
      headers: { connection: 'close' }
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
    req.end();
  }));
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
      const emptySummary = await requestJson(port, '/api/uat/result-summary');
      assert.strictEqual(emptySummary.status, 200);
      assert.ok(String(emptySummary.contentType).includes('application/json'));
      assert.deepStrictEqual(emptySummary.json, {
        counts: { a: 0, b: 0 },
        total: 0,
        leader: null
      });
      const emptyResults = await requestJson(port, '/api/results');
      assert.deepStrictEqual(emptyResults.json, { a: 0, b: 0 });

      await checkpoint('insert summary vote a', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('summary-a', 'a')"
      ));
      const leaderA = await requestJson(port, '/api/uat/result-summary');
      assert.strictEqual(leaderA.status, 200);
      assert.deepStrictEqual(leaderA.json, {
        counts: { a: 1, b: 0 },
        total: 1,
        leader: 'a'
      });

      await checkpoint('insert summary vote b', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('summary-b', 'b')"
      ));
      const tied = await requestJson(port, '/api/uat/result-summary');
      assert.deepStrictEqual(tied.json, {
        counts: { a: 1, b: 1 },
        total: 2,
        leader: null
      });
      const tiedAgain = await requestJson(port, '/api/uat/result-summary');
      assert.deepStrictEqual(tiedAgain.json, tied.json);
      const tiedResults = await requestJson(port, '/api/results');
      assert.deepStrictEqual(tiedResults.json, { a: 1, b: 1 });

      await checkpoint('insert second summary vote b', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('summary-b2', 'b')"
      ));
      const leaderB = await requestJson(port, '/api/uat/result-summary');
      assert.deepStrictEqual(leaderB.json, {
        counts: { a: 1, b: 2 },
        total: 3,
        leader: 'b'
      });
      const resultsAfterSummary = await requestJson(port, '/api/results');
      assert.deepStrictEqual(resultsAfterSummary.json, { a: 1, b: 2 });
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
