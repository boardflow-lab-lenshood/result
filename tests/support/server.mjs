import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runtime = path.join(root, '.test-runtime');
await mkdir(runtime, { recursive: true });
const runDir = await mkdtemp(path.join(runtime, 'run-'));
// initdb also creates temporary files: keep those in the worktree.
process.env.TMPDIR = runDir;

const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));

const postgres = new EmbeddedPostgres({
  databaseDir: path.join(runDir, 'postgres'),
  port,
  user: 'result_test',
  password: 'result_test',
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1', '-k', '']
});
const databaseUrl = `postgres://result_test:result_test@127.0.0.1:${port}/result_test`;
let app;
let stopping = false;
let started = false;

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
      })
    ]);
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await stopChild(app);
  if (started) await postgres.stop();
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase('result_test');

  // Exercise the existing API regression against real, isolated PostgreSQL.
  const api = spawn(process.execPath, ['tests/test_api_results.js'], {
    cwd: root,
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });
  const [code] = await once(api, 'exit');
  if (code !== 0) throw new Error(`Existing API regression exited ${code}`);

  const client = postgres.getPgClient('result_test');
  await client.connect();
  try {
    await client.query('TRUNCATE votes');
  } finally {
    await client.end();
  }
  await writeFile(path.join(runtime, 'connection.json'), JSON.stringify({ databaseUrl }));

  // Launch the unchanged production entrypoint, with isolated endpoints only.
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });
  app.on('error', async (error) => {
    console.error(error);
    await shutdown(1);
  });
  app.on('exit', (code) => {
    if (!stopping) shutdown(code || 1);
  });
} catch (error) {
  console.error(error);
  await shutdown(1);
}
