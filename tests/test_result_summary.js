const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const FAILURE = { error: 'database_unavailable', service: 'result' };

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: { connection: 'close', 'content-type': 'text/plain' }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(counts, error, run) {
  const args = counts ? ['--require', './tests/fixtures/summary_pool.js', 'server.js'] : ['server.js'];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/none',
      TEST_SUMMARY_COUNTS: JSON.stringify(counts), TEST_SUMMARY_ERROR: error || ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    const started = Date.now();
    while (!/App running on port (\d+)/.test(output)) {
      if (child.exitCode !== null || child.signalCode) throw new Error(output);
      if (Date.now() - started > 8000) throw new Error('Server startup timed out: ' + output);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await run(Number(output.match(/App running on port (\d+)/)[1]));
  } finally {
    if (child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
      assert.equal(child.exitCode, 0, output);
    }
  }
}

async function assertScores(port, counts) {
  const base = '/socket.io/?EIO=4&transport=polling';
  const handshake = await request(port, base);
  assert.equal(handshake.status, 200);
  assert.equal(handshake.text[0], '0');
  const sid = JSON.parse(handshake.text.slice(1)).sid;
  const session = base + '&sid=' + encodeURIComponent(sid);
  const connected = await request(port, session, '40');
  assert.equal(connected.status, 200);
  const deadline = Date.now() + 5000;
  let scores;
  let welcome;
  try {
    while (scores === undefined || welcome === undefined) {
      assert.ok(Date.now() < deadline, 'Socket.IO events timed out');
      const response = await request(port, session);
      assert.equal(response.status, 200);
      for (const packet of response.text.split('\x1e')) {
        if (!packet.startsWith('42')) continue;
        const [event, payload] = JSON.parse(packet.slice(2));
        if (event === 'scores') scores = payload;
        if (event === 'message') welcome = payload;
      }
    }
    assert.deepEqual(welcome, { text: 'Welcome!' });
    assert.equal(typeof scores, 'string');
    assert.deepEqual(JSON.parse(scores), counts);
  } finally {
    await request(port, session, '1');
  }
}

const samples = [
  { counts: { a: 0, b: 0 }, percentages: { a: 0, b: 0 }, leader: null },
  { counts: { a: 3, b: 1 }, percentages: { a: 75, b: 25 }, leader: 'a' },
  { counts: { a: 1, b: 2 }, percentages: { a: 33.3, b: 66.7 }, leader: 'b' },
  { counts: { a: 1, b: 0 }, percentages: { a: 100, b: 0 }, leader: 'a' },
  { counts: { a: 7, b: 7 }, percentages: { a: 50, b: 50 }, leader: null },
  // Independent rounding of b would incorrectly give 93.8 for this half-tenth case.
  { counts: { a: 1, b: 15 }, percentages: { a: 6.3, b: 93.7 }, leader: 'b' },
  // Scale integer counts before division so 2.95% does not become 2.94999...%.
  { counts: { a: 59, b: 1941 }, percentages: { a: 3, b: 97 }, leader: 'b' },
  { counts: { a: 0, b: 1 }, percentages: { a: 0, b: 100 }, leader: 'b' },
  { counts: { a: 1, b: 1 }, percentages: { a: 50, b: 50 }, leader: null }
];

for (const sample of samples) {
  test('isolated summary ' + JSON.stringify(sample.counts), { timeout: 15000 }, async () => {
    await withServer(sample.counts, null, async (port) => {
      const total = sample.counts.a + sample.counts.b;
      const expected = { counts: sample.counts, total, leader: sample.leader, percentages: sample.percentages };
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await request(port, '/api/uat/result-summary');
        assert.equal(response.status, 200);
        assert.match(response.headers['content-type'], /application\/json/);
        const summary = JSON.parse(response.text);
        assert.deepEqual(summary, expected);
        for (const value of Object.values(summary.percentages)) {
          assert.equal(typeof value, 'number');
          assert.ok(Number.isFinite(value));
          assert.ok(Math.abs(value * 10 - Math.round(value * 10)) < 1e-10);
        }
        if (total > 0) assert.equal(summary.percentages.a + summary.percentages.b, 100);
        const original = await request(port, '/api/results');
        assert.equal(original.status, 200);
        assert.deepEqual(JSON.parse(original.text), sample.counts);
        console.log(JSON.stringify({ input: sample.counts, repeat, status: response.status, summary }));
      }
      if (total === 0 || (sample.counts.a === 1 && sample.counts.b === 2)) {
        await assertScores(port, sample.counts);
      }
    });
  });
}

for (const error of ['connection', 'query']) {
  test('isolated ' + error + ' failure preserves both 503 contracts', { timeout: 15000 }, async () => {
    // Connection failure uses the real pg client against an unavailable loopback port.
    // Query failure uses the controlled Pool; no shared database is used in either case.
    await withServer(error === 'query' ? { a: 3, b: 1 } : null, error, async (port) => {
      for (const endpoint of ['/api/uat/result-summary', '/api/results']) {
        const response = await request(port, endpoint);
        assert.equal(response.status, 503);
        assert.match(response.headers['content-type'], /application\/json/);
        assert.deepEqual(JSON.parse(response.text), FAILURE);
        console.log(JSON.stringify({ error, endpoint, status: response.status, body: JSON.parse(response.text) }));
      }
    });
  });
}
