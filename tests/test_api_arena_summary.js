const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { after, before, beforeEach, describe, test } = require('node:test');
const { Pool } = require('pg');

const SUMMARY_PATH = '/api/arena/20261102/summary';
const TIMEOUT_MS = 8000;

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(2000, false)
  ]);
  if (!graceful) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function startServer(databaseUrl) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let spawnError;
  child.on('error', (err) => { spawnError = err; });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw spawnError;
    }
    const match = output.match(/App running on port (\d+)/);
    if (match) {
      return { child, origin: 'http://127.0.0.1:' + match[1] };
    }
    if (child.exitCode !== null) {
      throw new Error('result server exited before listening: ' + output);
    }
    await delay(25);
  }
  await stopServer(child);
  throw new Error('result server listen timed out');
}

async function get(server, pathname, headers = {}) {
  return fetch(server.origin + pathname, {
    headers: { connection: 'close', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

async function summary(server, expected, headers) {
  const response = await get(server, SUMMARY_PATH, headers);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), expected);
  return response;
}

describe('arena summary with a real PostgreSQL database and HTTP server', { concurrency: false }, () => {
  const schema = 'arena_summary_' + randomUUID().replace(/-/g, '');
  let admin;
  let server;

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
    const scopedUrl = new URL(process.env.TEST_DATABASE_URL);
    const options = scopedUrl.searchParams.get('options') || '';
    scopedUrl.searchParams.set('options', options + ' -c search_path=' + schema);
    admin = new Pool({
      connectionString: scopedUrl.toString(),
      connectionTimeoutMillis: 2000,
      query_timeout: TIMEOUT_MS
    });
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE TABLE votes (id VARCHAR(255) NOT NULL UNIQUE, vote VARCHAR(255) NOT NULL)');
    scopedUrl.searchParams.set('application_name', schema);
    server = await startServer(scopedUrl.toString());
  });

  after(async () => {
    try {
      if (server) {
        await stopServer(server.child);
      }
    } finally {
      if (admin) {
        try {
          await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
        } finally {
          await admin.end();
        }
      }
    }
  });

  beforeEach(async () => {
    await admin.query('TRUNCATE votes');
  });

  test('test_returns_zero_counts_and_tie_when_no_votes_exist', async () => {
    await summary(server, { total: 0, leader: 'tie', counts: { a: 0, b: 0 } });
  });

  test('test_returns_tie_when_nonzero_counts_are_equal', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a'), ('a2', 'a'), ('b1', 'b'), ('b2', 'b')");
    await summary(server, { total: 4, leader: 'tie', counts: { a: 2, b: 2 } });
  });

  test('test_returns_a_when_a_has_more_votes', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a'), ('a2', 'a'), ('b1', 'b')");
    await summary(server, { total: 3, leader: 'a', counts: { a: 2, b: 1 } });
  });

  test('test_returns_b_when_b_has_more_votes', async () => {
    await admin.query("INSERT INTO votes VALUES ('b1', 'b'), ('b2', 'b')");
    await summary(server, { total: 2, leader: 'b', counts: { a: 0, b: 2 } });
  });

  test('test_reads_current_counts_when_votes_are_inserted_updated_and_deleted', async () => {
    await summary(server, { total: 0, leader: 'tie', counts: { a: 0, b: 0 } });
    await admin.query("INSERT INTO votes VALUES ('voter', 'a')");
    const first = await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
    await admin.query("INSERT INTO votes VALUES ('voter', 'b') ON CONFLICT (id) DO UPDATE SET vote = EXCLUDED.vote");
    await summary(server, { total: 1, leader: 'b', counts: { a: 0, b: 1 } }, {
      'If-None-Match': first.headers.get('etag')
    });
    await admin.query('DELETE FROM votes');
    await summary(server, { total: 0, leader: 'tie', counts: { a: 0, b: 0 } });
  });

  test('test_counts_only_a_and_b_when_other_vote_values_exist', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a'), ('other', 'c')");
    await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
  });

  test('test_preserves_existing_results_when_summary_is_requested', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a'), ('b1', 'b')");
    await summary(server, { total: 2, leader: 'tie', counts: { a: 1, b: 1 } });
    const response = await get(server, '/api/results');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { a: 1, b: 1 });
  });

  test('test_preserves_legacy_null_leader_when_votes_are_tied', async () => {
    const response = await get(server, '/api/uat/result-summary');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { total: 0, leader: null, counts: { a: 0, b: 0 } });
  });

  test('test_serves_results_page_when_summary_route_is_installed', async () => {
    const response = await get(server, '/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const body = await response.text();
    for (const marker of ['猫派', '狗派', 'id="count-a"', 'id="count-b"', 'id="total-count"']) {
      assert.ok(body.includes(marker), 'missing page marker: ' + marker);
    }
  });

  test('test_reports_ready_when_database_is_available', async () => {
    const response = await get(server, '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'result' });
  });

  test('test_accepts_socket_connections_when_summary_route_is_installed', async () => {
    const response = await get(server, '/socket.io/?EIO=4&transport=polling');
    assert.equal(response.status, 200);
    const packet = await response.text();
    assert.equal(packet[0], '0');
    assert.equal(typeof JSON.parse(packet.slice(1)).sid, 'string');
  });

  test('test_keeps_serving_and_broadcasting_when_database_connections_are_lost', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a')");
    await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
    const terminated = await admin.query(
      'SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1',
      [schema]
    );
    assert.ok(terminated.rows.length > 0, 'must disconnect actual result database connections');
    assert.ok(terminated.rows.every((row) => row.terminated));
    await delay(100);
    await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
    const handshake = await get(server, '/socket.io/?EIO=4&transport=polling');
    const session = JSON.parse((await handshake.text()).slice(1));
    const pollingPath = '/socket.io/?EIO=4&transport=polling&sid=' + session.sid;
    const connected = await fetch(server.origin + pollingPath, {
      method: 'POST',
      body: '40',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    assert.equal(connected.status, 200);
    await connected.text();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await get(server, pollingPath);
      assert.equal(response.status, 200);
      const packets = (await response.text()).split('\x1e');
      const events = packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2)));
      const scores = events.find((event) => event[0] === 'scores');
      if (scores) {
        assert.deepEqual(JSON.parse(scores[1]), { a: 1, b: 0 });
        return;
      }
    }
    assert.fail('live scores must resume after database connections are lost');
  });

  test('test_returns_503_json_when_database_cannot_be_reached', async () => {
    const unavailable = await startServer('postgresql://127.0.0.1:1/unavailable');
    try {
      const response = await get(unavailable, SUMMARY_PATH);
      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'database_unavailable', service: 'result' });
    } finally {
      await stopServer(unavailable.child);
    }
  });

  test('test_returns_503_and_recovers_when_vote_table_becomes_unavailable', async () => {
    await admin.query("INSERT INTO votes VALUES ('a1', 'a')");
    await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
    await admin.query('ALTER TABLE votes RENAME TO temporarily_unavailable_votes');
    try {
      const response = await get(server, SUMMARY_PATH);
      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), { error: 'database_unavailable', service: 'result' });
    } finally {
      await admin.query('ALTER TABLE temporarily_unavailable_votes RENAME TO votes');
    }
    await summary(server, { total: 1, leader: 'a', counts: { a: 1, b: 0 } });
  });
});
