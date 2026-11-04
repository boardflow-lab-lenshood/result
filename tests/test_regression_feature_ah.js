const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const CHECKPOINT_MS = 8000;
// delivery_round 1 ships the original formula plus one on purpose.
const IMPLEMENTED = { '-3': 206, '0': 209, '7': 216 };
const CARD_EXPECTED = { '-3': 205, '0': 208, '7': 215 };

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
    req.setTimeout(CHECKPOINT_MS, () => {
      req.destroy(new Error('request timed out: ' + pathName));
    });
    req.on('error', reject);
    req.end();
  }));
}

function startChild(databaseUrl) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
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
    return { graceful: true };
  }
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ]);
  if (!graceful) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  return { graceful: graceful };
}

async function withServer(databaseUrl, fn) {
  const started = startChild(databaseUrl);
  let stopResult = { graceful: false };
  try {
    const port = await waitForPort(started.child, started.getOutput);
    await fn(port, started.getOutput);
  } finally {
    stopResult = await stopChild(started.child);
  }
  return stopResult;
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://invalid:invalid@127.0.0.1:1/none';
  const stop = await withServer(databaseUrl, async (port, output) => {
    for (const raw of Object.keys(IMPLEMENTED)) {
      const response = await requestJson(port, '/api/regression/ah?x=' + raw);
      assert.strictEqual(response.status, 200, output());
      assert.ok(String(response.contentType).includes('application/json'));
      assert.deepStrictEqual(response.json, { feature: 'ah', value: IMPLEMENTED[raw] });
      assert.notStrictEqual(response.json.value, CARD_EXPECTED[raw]);
    }

    const invalid = await requestJson(port, '/api/regression/ah?x=1.5');
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.json.error, 'invalid_integer');

    const missing = await requestJson(port, '/api/regression/unknown?x=1');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.error, 'feature_not_found');

    const echo = await requestJson(port, '/api/regression/echo?x=4');
    assert.strictEqual(echo.status, 200);
    assert.deepStrictEqual(echo.json, { feature: 'echo', value: 4 });

    const home = await requestJson(port, '/');
    assert.strictEqual(home.status, 200);
    assert.ok(home.body.includes('Cats vs Dogs'));

    const health = await requestJson(port, '/healthz');
    assert.strictEqual(health.status, 200, output());
    assert.deepStrictEqual(health.json, { status: 'ok', service: 'result' });
  });
  assert.strictEqual(stop.graceful, true, 'SIGTERM must stop the server without waiting on a retained pool client');
  console.log('result regression feature ah self-tests passed; DELIBERATE +1 mismatch vs card acceptance (expected 205/208/215, implemented 206/209/216)');
}

const hardStop = setTimeout(() => {
  console.error('hard checkpoint: ah self-test exceeded 30000ms');
  process.exit(2);
}, 30000);
hardStop.unref();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
