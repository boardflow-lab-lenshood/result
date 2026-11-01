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
  try {
    const port = await waitForPort(started.child, started.getOutput);
    await fn(port, started.getOutput);
  } finally {
    await stopChild(started.child);
  }
}

function assertSummaryShape(payload) {
  assert.deepStrictEqual(Object.keys(payload).sort(), ['leader', 'total']);
  assert.strictEqual(typeof payload.total, 'number');
  assert.ok(['a', 'b', 'tie'].includes(payload.leader));
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
      const empty = await requestJson(port, '/api/summary');
      assert.strictEqual(empty.status, 200);
      assert.ok(String(empty.contentType).includes('application/json'));
      assertSummaryShape(empty.json);
      assert.deepStrictEqual(empty.json, { total: 0, leader: 'tie' });

      const resultsWhileEmpty = await requestJson(port, '/api/results');
      assert.strictEqual(resultsWhileEmpty.status, 200);
      assert.deepStrictEqual(resultsWhileEmpty.json, { a: 0, b: 0 });

      await checkpoint('insert tied votes', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('tie-a', 'a'), ('tie-b', 'b')"
      ));
      const tied = await requestJson(port, '/api/summary');
      assert.strictEqual(tied.status, 200);
      assertSummaryShape(tied.json);
      assert.deepStrictEqual(tied.json, { total: 2, leader: 'tie' });

      await checkpoint('insert leading a', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('lead-a', 'a')"
      ));
      const leadA = await requestJson(port, '/api/summary');
      assert.strictEqual(leadA.status, 200);
      assertSummaryShape(leadA.json);
      assert.deepStrictEqual(leadA.json, { total: 3, leader: 'a' });

      const resultsAfterA = await requestJson(port, '/api/results');
      assert.deepStrictEqual(resultsAfterA.json, { a: 2, b: 1 });
      assert.strictEqual(leadA.json.total, resultsAfterA.json.a + resultsAfterA.json.b);

      await checkpoint('insert leading b', () => admin.query(
        "INSERT INTO votes (id, vote) VALUES ('lead-b-1', 'b'), ('lead-b-2', 'b')"
      ));
      const leadB = await requestJson(port, '/api/summary');
      assert.strictEqual(leadB.status, 200);
      assertSummaryShape(leadB.json);
      assert.deepStrictEqual(leadB.json, { total: 5, leader: 'b' });

      const home = await requestJson(port, '/');
      assert.strictEqual(home.status, 200);
      assert.ok(home.body.includes('猫派'));
      assert.ok(home.body.includes('狗派'));
      assert.ok(home.body.includes('id="total-count"'));
    });

    await withServer('postgres://invalid:invalid@127.0.0.1:1/none', async (port, output) => {
      const failed = await requestJson(port, '/api/summary');
      assert.strictEqual(failed.status, 503);
      assert.ok(String(failed.contentType).includes('application/json'));
      assert.deepStrictEqual(failed.json, {
        error: 'database_unavailable',
        service: 'result'
      });
      assert.ok(!('total' in failed.json));
      assert.ok(!('leader' in failed.json));
      assert.ok(output().includes('Failed to read vote summary'));

      const results = await requestJson(port, '/api/results');
      assert.strictEqual(results.status, 503);
      assert.deepStrictEqual(results.json, {
        error: 'database_unavailable',
        service: 'result'
      });
    });
  } finally {
    await Promise.race([
      admin.end(),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  console.log('result summary self-tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
