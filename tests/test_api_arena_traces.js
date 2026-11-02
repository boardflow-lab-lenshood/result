const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { after, before, beforeEach, describe, test } = require('node:test');
const { Pool } = require('pg');

const TRACE_PATH = '/api/arena/seven-20261103/traces';
const TIMEOUT_MS = 8000;

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  if (!await Promise.race([exited.then(() => true), delay(2000, false)])) {
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
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = output.match(/App running on port (\d+)/);
    if (match) return { child, port: Number(match[1]) };
    if (child.exitCode !== null) throw new Error('result exited: ' + output);
    await delay(25);
  }
  await stopServer(child);
  throw new Error('result listen timed out: ' + output);
}

function get(server, pathname) {
  // Raw request preserves malformed percent escapes for the 400 JSON checks.
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.port, path: pathname,
      headers: { connection: 'close' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
  });
}

async function expectJson(server, pathname, status, expected) {
  const response = await get(server, pathname);
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(response.body), expected);
  return response;
}

function tracePath(trace) { return TRACE_PATH + '/' + encodeURIComponent(trace); }
function empty(trace) { return { trace_id: trace, total: 0, counts: { a: 0, b: 0 }, voters: [] }; }
const failure = { error: 'database_unavailable', service: 'result' };

describe('arena trace HTTP API with real PostgreSQL', { concurrency: false }, () => {
  const schema = 'arena_trace_' + randomUUID().replace(/-/g, '');
  let admin;
  let server;

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
    databaseUrl.searchParams.set('options', '-c search_path=' + schema);
    admin = new Pool({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 2000,
      query_timeout: TIMEOUT_MS });
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE TABLE votes (id VARCHAR(255) NOT NULL UNIQUE, vote VARCHAR(255) NOT NULL, trace_id VARCHAR(64))');
    server = await startServer(databaseUrl.toString());
  });

  after(async () => {
    try {
      if (server) await stopServer(server.child);
    } finally {
      if (admin) {
        try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
        finally { await admin.end(); }
      }
    }
  });

  beforeEach(async () => { await admin.query('TRUNCATE votes'); });

  test('test_returns_sorted_current_voters_and_counts_when_trace_matches_exactly', async () => {
    // Arrange
    await admin.query('INSERT INTO votes VALUES ($1,$2,$3),($4,$5,$3),($6,$7,$8),($9,$7,NULL)',
      ['z-voter', 'a', 'Target', 'a-voter', 'b', 'other', 'a', 'target', 'legacy']);
    // Act / Assert
    const response = await expectJson(server, tracePath('Target'), 200, {
      trace_id: 'Target', total: 2, counts: { a: 1, b: 1 },
      voters: [{ voter_id: 'a-voter', vote: 'b' }, { voter_id: 'z-voter', vote: 'a' }]
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test('test_returns_zero_counts_when_trace_is_unknown', async () => {
    await admin.query("INSERT INTO votes VALUES ('other', 'a', 'other-trace')");
    await expectJson(server, tracePath('unknown'), 200, empty('unknown'));
  });

  test('test_reflects_current_vote_without_duplicates_when_same_voter_changes_vote', async () => {
    await admin.query("INSERT INTO votes VALUES ('one', 'a', 'trace')");
    await admin.query("INSERT INTO votes VALUES ('one', 'b', 'trace') ON CONFLICT (id) DO UPDATE SET vote = EXCLUDED.vote");
    await expectJson(server, tracePath('trace'), 200, {
      trace_id: 'trace', total: 1, counts: { a: 0, b: 1 }, voters: [{ voter_id: 'one', vote: 'b' }]
    });
  });

  test('test_excludes_old_trace_when_current_vote_moves_to_another_trace', async () => {
    await admin.query("INSERT INTO votes VALUES ('one', 'a', 'old-trace')");
    await admin.query("UPDATE votes SET trace_id = 'new-trace', vote = 'b' WHERE id = 'one'");
    await expectJson(server, tracePath('old-trace'), 200, empty('old-trace'));
  });

  for (const trace of ['A', '0', 'a'.repeat(64), 'A0._:-z']) {
    test('test_accepts_exact_trace_when_valid_' + trace.length + '_' + trace.slice(0, 8), async () => {
      await admin.query('INSERT INTO votes VALUES ($1, $2, $3)', ['voter', 'a', trace]);
      await expectJson(server, tracePath(trace), 200, {
        trace_id: trace, total: 1, counts: { a: 1, b: 0 }, voters: [{ voter_id: 'voter', vote: 'a' }]
      });
    });
  }

  const invalid = ['', 'a'.repeat(65), '-first', '.first', '_first', ':first', 'a\n', 'a\r',
    'a\r\n', 'a ', 'a ', 'a\0', '\0a', 'é', 'a中', 'a b', ' a', 'a/b', 'a\\b',
    'a?b', 'a#b', "a' OR '1'='1", 'a%20', 'a\tb', 'a'];
  for (const [index, trace] of invalid.entries()) {
    test('test_returns_400_json_when_trace_is_invalid_' + index, async () => {
      await expectJson(server, tracePath(trace), 400, { error: 'invalid_trace_id', service: 'result' });
    });
  }

  for (const suffix of ['', '/a/b', '/%ZZ', '/%E0%A4%A']) {
    test('test_returns_400_json_when_path_is_invalid_' + encodeURIComponent(suffix), async () => {
      await expectJson(server, TRACE_PATH + suffix, 400, { error: 'invalid_trace_id', service: 'result' });
    });
  }

  test('test_returns_503_json_when_trace_column_is_not_migrated', async () => {
    await admin.query('ALTER TABLE votes DROP COLUMN trace_id');
    try {
      await expectJson(server, tracePath('trace'), 503, failure);
    } finally {
      await admin.query('ALTER TABLE votes ADD COLUMN trace_id VARCHAR(64)');
    }
    await expectJson(server, tracePath('trace'), 200, empty('trace'));
  });

  test('test_returns_503_json_when_votes_table_is_not_ready', async () => {
    await admin.query('ALTER TABLE votes RENAME TO owned_missing_votes');
    try { await expectJson(server, tracePath('trace'), 503, failure); }
    finally { await admin.query('ALTER TABLE owned_missing_votes RENAME TO votes'); }
  });

  test('test_preserves_existing_apis_when_trace_query_is_added', async () => {
    await admin.query("INSERT INTO votes VALUES ('one', 'a', 'trace'), ('two', 'b', NULL)");
    for (const [pathname, expected] of [
      ['/api/results', { a: 1, b: 1 }],
      ['/api/uat/result-summary', { total: 2, counts: { a: 1, b: 1 }, leader: null }],
      ['/api/arena/20261102/summary', { total: 2, counts: { a: 1, b: 1 }, leader: 'tie' }],
      ['/api/arena/three-20261102/summary', { total: 2, counts: { a: 1, b: 1 }, leader: 'tie' }],
      ['/healthz', { status: 'ok', service: 'result' }]
    ]) await expectJson(server, pathname, 200, expected);
  });

  test('test_preserves_homepage_when_trace_query_is_added', async () => {
    const response = await get(server, '/');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /text\/html/);
    for (const marker of ['猫派', '狗派', 'id="total-count"']) assert.ok(response.body.includes(marker));
  });

  test('test_returns_503_and_unhealthy_when_database_is_unreachable', async () => {
    const unavailable = await startServer('postgresql://127.0.0.1:1/unavailable');
    try {
      await expectJson(unavailable, tracePath('trace'), 503, failure);
      await expectJson(unavailable, '/healthz', 503, { status: 'unavailable', service: 'result' });
      await expectJson(unavailable, tracePath('a\n'), 400, { error: 'invalid_trace_id', service: 'result' });
    } finally { await stopServer(unavailable.child); }
  });
});
