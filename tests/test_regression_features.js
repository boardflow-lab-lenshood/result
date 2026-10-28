const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

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
  const boomPath = path.join(__dirname, '..', 'regression_features', 'boom.js');
  const stop = await withServer(databaseUrl, async (port, output) => {
    for (const value of [0, 7, -3]) {
      const response = await requestJson(port, '/api/regression/echo?x=' + value);
      assert.strictEqual(response.status, 200, output());
      assert.ok(String(response.contentType).includes('application/json'));
      assert.deepStrictEqual(response.json, { feature: 'echo', value: value });
    }

    const missing = await requestJson(port, '/api/regression/missing?x=1');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.error, 'feature_not_found');

    const invalid = await requestJson(port, '/api/regression/echo?x=1.5');
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.json.error, 'invalid_integer');

    const uppercase = await requestJson(port, '/api/regression/Echo?x=1');
    assert.strictEqual(uppercase.status, 400);
    assert.strictEqual(uppercase.json.error, 'invalid_feature');

    const traversal = await requestJson(port, '/api/regression/..%2Fserver?x=1');
    assert.ok(traversal.status === 400 || traversal.status === 404);
    assert.ok(!traversal.body.includes('function getVotes'));

    const home = await requestJson(port, '/');
    assert.strictEqual(home.status, 200);
    assert.ok(home.body.includes('Cats vs Dogs'));

    require('fs').writeFileSync(
      boomPath,
      'module.exports = { evaluate: function() { throw new Error("token=super-secret"); } };\n'
    );
    try {
      const failed = await requestJson(port, '/api/regression/boom?x=1');
      assert.strictEqual(failed.status, 500);
      assert.strictEqual(failed.json.error, 'feature_failed');
      assert.ok(!failed.body.includes('super-secret'));
      assert.ok(output().includes('feature_failed'));
      assert.ok(!output().includes('super-secret'));
    } finally {
      require('fs').rmSync(boomPath, { force: true });
    }
  });
  assert.strictEqual(stop.graceful, true, 'SIGTERM must stop the server without waiting on pool.end');
  console.log('result regression self-tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
