const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { after, before, describe, test } = require('node:test');
const { Pool } = require('pg');

const execute = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = '/api/arena/seven-20261103/runtime';
const TIMEOUT_MS = 8000;
const evidence = { node_version: process.versions.node, commands: [], processes: [], http: [] };
const servers = [];
let fixture;
let pgBin;
let dataDir;
let databaseUrl;
let databaseRunning = false;

async function command(file, args, options = {}) {
  const env = { ...process.env, ...options.env };
  // Nested Node test runners must not inherit their parent's runner context.
  delete env.NODE_TEST_CONTEXT;
  const result = await execute(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options, env });
  evidence.commands.push({ file, args, stdout: result.stdout, stderr: result.stderr, exit_code: 0 });
  return result.stdout.trim();
}

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function startDatabase() {
  await command(path.join(pgBin, 'pg_ctl'), [
    '-D', dataDir, '-l', path.join(fixture, 'postgres.log'), '-w', '-t', '15', 'start'
  ]);
  databaseRunning = true;
}

async function stopDatabase() {
  await command(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '15', 'stop']);
  databaseRunning = false;
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  if (!await Promise.race([exited.then(() => true), delay(2500, false)])) {
    server.child.kill('SIGKILL');
    await exited;
  }
}

async function startServer(url) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const server = { child, output: '', origin: null };
  servers.push(server);
  let spawnError;
  child.on('error', (err) => { spawnError = err; });
  child.stdout.on('data', (chunk) => { server.output += chunk; });
  child.stderr.on('data', (chunk) => { server.output += chunk; });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const match = server.output.match(/App running on port (\d+)/);
    if (match) {
      server.origin = 'http://127.0.0.1:' + match[1];
      evidence.processes.push({ pid: child.pid, executable: process.execPath, origin: server.origin });
      return server;
    }
    assert.equal(child.exitCode, null, server.output);
    await delay(20);
  }
  throw new Error('result did not listen within timeout: ' + server.output);
}

async function get(server, pathname, phase, timeout = TIMEOUT_MS) {
  const started = performance.now();
  const response = await fetch(server.origin + pathname, {
    headers: { connection: 'close' }, signal: AbortSignal.timeout(timeout)
  });
  const body = await response.text();
  evidence.http.push({
    phase, pid: server.child.pid, method: 'GET', url: server.origin + pathname,
    status: response.status, headers: Object.fromEntries(response.headers), body,
    duration_ms: performance.now() - started
  });
  return { response, body };
}

async function runtime(server, phase, timeout) {
  const { response, body } = await get(server, RUNTIME_PATH, phase, timeout);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = JSON.parse(body);
  assert.equal(payload.service, 'result');
  // Both parent and server use this exact Node executable; no configured version string.
  assert.equal(payload.node_version, process.versions.node);
  assert.equal(typeof payload.uptime_seconds, 'number');
  assert.ok(Number.isFinite(payload.uptime_seconds) && payload.uptime_seconds >= 0);
  return payload;
}

async function health(server, status, phase) {
  const { response, body } = await get(server, '/healthz', phase);
  assert.equal(response.status, status);
  assert.deepEqual(JSON.parse(body), {
    status: status === 200 ? 'ok' : 'unavailable', service: 'result'
  });
}

async function compatibility(server, phase) {
  const page = await get(server, '/', phase);
  assert.equal(page.response.status, 200);
  assert.ok(page.body.includes('id="total-count"'));
  const results = await get(server, '/api/results', phase);
  assert.equal(results.response.status, 200);
  assert.deepEqual(JSON.parse(results.body), { a: 2, b: 1 });
  for (const pathname of ['/api/arena/20261102/summary', '/api/arena/three-20261102/summary', '/api/uat/result-summary']) {
    const result = await get(server, pathname, phase);
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(result.body), { total: 3, leader: 'a', counts: { a: 2, b: 1 } });
  }
  const socket = await get(server, '/socket.io/?EIO=4&transport=polling', phase);
  assert.equal(socket.response.status, 200);
  assert.equal(typeof JSON.parse(socket.body.slice(1)).sid, 'string');
}

describe('runtime using real HTTP and an exclusively owned PostgreSQL cluster', { concurrency: false }, () => {
  let server;

  before(async () => {
    // Never accept an external/shared database for destructive outage tests.
    const parent = process.env.RUNTIME_EVIDENCE_DIR || os.tmpdir();
    await fs.mkdir(parent, { recursive: true });
    fixture = await fs.mkdtemp(path.join(parent, 'result-runtime-owned-'));
    dataDir = path.join(fixture, 'data');
    pgBin = process.env.PG_BINDIR || await command('pg_config', ['--bindir']);
    await command(path.join(pgBin, 'initdb'), ['-D', dataDir, '-A', 'trust', '-U', 'result_runtime']);
    const port = await freePort();
    await fs.appendFile(path.join(dataDir, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nlog_statement = 'all'\n`);
    evidence.fixture = { owner: 'result-runtime-test', directory: fixture, port, exclusive: true };
    await startDatabase();
    databaseUrl = `postgresql://result_runtime@127.0.0.1:${port}/postgres`;
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('CREATE TABLE votes (id VARCHAR(255) NOT NULL UNIQUE, vote VARCHAR(255) NOT NULL)');
      await pool.query("INSERT INTO votes VALUES ('a1', 'a'), ('a2', 'a'), ('b1', 'b')");
    } finally {
      await pool.end();
    }
    server = await startServer(databaseUrl);
  });

  after(async () => {
    try {
      for (const instance of servers) await stopServer(instance);
    } finally {
      try {
        if (databaseRunning) await stopDatabase();
      } finally {
        if (fixture) {
          evidence.process_logs = servers.map((instance) => ({ pid: instance.child.pid, output: instance.output }));
          await fs.writeFile(path.join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
          await fs.rm(dataDir, { recursive: true, force: true });
        }
      }
    }
  });

  test('test_returns_actual_process_runtime_when_database_is_available', async () => {
    await health(server, 200, 'before-outage');
    await runtime(server, 'before-outage');
  });

  test('test_uptime_never_decreases_when_same_process_is_requested_repeatedly', async () => {
    let previous = 0;
    for (let request = 0; request < 5; request++) {
      const payload = await runtime(server, 'monotonic');
      assert.ok(payload.uptime_seconds >= previous);
      previous = payload.uptime_seconds;
      await delay(25);
    }
  });

  test('test_preserves_existing_routes_when_runtime_is_added', async () => {
    await compatibility(server, 'before-outage');
  });

  test('test_preserves_runtime_and_recovers_dependencies_when_owned_database_is_stopped', async () => {
    const before = await runtime(server, 'immediately-before-stop');
    await stopDatabase();
    try {
      const during = await runtime(server, 'database-stopped', 1000);
      assert.ok(during.uptime_seconds >= before.uptime_seconds);
      await health(server, 503, 'database-stopped');
      const results = await get(server, '/api/results', 'database-stopped');
      assert.equal(results.response.status, 503);
      assert.deepEqual(JSON.parse(results.body), { error: 'database_unavailable', service: 'result' });
    } finally {
      await startDatabase();
    }
    await health(server, 200, 'database-restored');
    await runtime(server, 'database-restored');
    await compatibility(server, 'database-restored');
  });

  test('test_serves_runtime_on_cold_start_when_owned_database_is_offline', async () => {
    await stopDatabase();
    try {
      const cold = await startServer(databaseUrl);
      await runtime(cold, 'cold-start-database-stopped', 1000);
      await health(cold, 503, 'cold-start-database-stopped');
      await stopServer(cold);
    } finally {
      await startDatabase();
    }
  });

  test('test_serves_runtime_without_waiting_when_database_handshake_is_pending', async () => {
    const sockets = new Set();
    const pendingDatabase = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    pendingDatabase.listen(0, '127.0.0.1');
    await once(pendingDatabase, 'listening');
    let waiting;
    try {
      waiting = await startServer(`postgresql://result_runtime@127.0.0.1:${pendingDatabase.address().port}/postgres`);
      assert.ok(sockets.size > 0, 'real TCP database handshake must be pending');
      await runtime(waiting, 'database-handshake-pending', 1000);
    } finally {
      if (waiting) await stopServer(waiting);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => pendingDatabase.close((err) => err ? reject(err) : resolve()));
    }
  });

  test('test_passes_existing_suite_when_using_the_owned_database', async () => {
    await command(process.execPath, ['tests/test_api_results.js'], {
      cwd: ROOT, env: { ...process.env, TEST_DATABASE_URL: databaseUrl }
    });
    const suiteOutput = await command(process.execPath, [
      '--test', 'tests/test_api_arena_summary.js', 'tests/test_api_arena_traces.js'
    ], {
      cwd: ROOT, env: { ...process.env, TEST_DATABASE_URL: databaseUrl }
    });
    assert.match(suiteOutput, /arena summary with a real PostgreSQL database and HTTP server/);
    assert.match(suiteOutput, /arena trace HTTP API with real PostgreSQL/);
    assert.match(suiteOutput, /(?:#|ℹ) pass [1-9]\d*\b/);
    assert.match(suiteOutput, /(?:#|ℹ) skipped 0\b/);
    await command(process.execPath, ['tests/test_regression_features.js'], { cwd: ROOT });
  });
});
