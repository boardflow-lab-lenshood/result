'use strict';

// Local, synthetic Socket.IO fixtures only; never connect to deployed voting services.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const root = path.resolve(__dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache/ms-playwright');
const { chromium, expect } = require('@playwright/test');
const artifacts = path.join(root, 'test-results/realtime');

async function startFixture() {
  const app = express();
  app.use(express.static(path.join(root, 'views')));
  const server = http.createServer(app);
  const io = require('socket.io')(server);
  let connections = 0;
  io.on('connection', () => { connections++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    connections: () => connections,
    emit: (event, value) => io.emit(event, value),
    close: () => new Promise(resolve => io.close(resolve))
  };
}

async function startActualApp() {
  // Port 1 refuses connections. No shared or developer database is used or mutated.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', DATABASE_URL: 'postgresql://isolated:isolated@127.0.0.1:1/realtime_test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', chunk => log.push(chunk.toString()));
  child.stderr.on('data', chunk => log.push(chunk.toString()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App startup timed out: ' + log.join(''))), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('App exited during startup: ' + code)); });
      child.stdout.on('data', chunk => {
        const match = chunk.toString().match(/App running on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    return { url: 'http://127.0.0.1:' + port, stop, log };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function assertWaiting(page) {
  await expect(page.locator('#realtime-status')).toContainText('等待实时数据');
  await expect(page.getByText('等待实时数据', { exact: true })).toBeVisible();
  await expect(page.getByText('最近更新：', { exact: false })).not.toBeVisible();
  await expect(page.locator('time#last-updated[datetime]')).toHaveCount(0);
}

async function assertStatistics(page, a, b, percentA, percentB) {
  await expect(page.locator('#count-a')).toHaveText(String(a));
  await expect(page.locator('#count-b')).toHaveText(String(b));
  await expect(page.locator('#total-count')).toHaveText(String(a + b));
  await expect(page.locator('#choice')).toContainText(percentA.toFixed(1) + '%');
  await expect(page.locator('#choice')).toContainText(percentB.toFixed(1) + '%');
  assert.equal(await page.locator('#background-stats-1').evaluate(element => element.style.width), percentA + '%');
  assert.equal(await page.locator('#background-stats-2').evaluate(element => element.style.width), percentB + '%');
}

test('real Chromium: local result page receives isolated scores and preserves receive-time semantics', { timeout: 90000 }, async t => {
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = await startFixture();
  let browser;
  let context;
  let tracing = false;
  t.after(async () => {
    if (tracing) await context.tracing.stop({ path: path.join(artifacts, 'fixture-trace.zip') });
    if (context) await context.close();
    if (browser) await browser.close();
    await fixture.close();
  });
  browser = await chromium.launch({ headless: true });

  await t.test('waiting is visible even before Angular and before any connection', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('https://**/*', route => route.abort());
      await page.goto(fixture.url);
      await assertWaiting(page);
      await page.screenshot({ path: path.join(artifacts, 'waiting-before-script.png'), fullPage: true, animations: 'disabled' });
    } finally { await context.close(); }
  });

  context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await context.route('https://**/*', route => route.abort());
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url);
  await expect.poll(fixture.connections).toBe(1);

  await t.test('connection, waiting, welcome and malformed scores do not manufacture an update', async () => {
    await page.waitForTimeout(1100);
    await assertWaiting(page);
    fixture.emit('message', { text: 'Welcome!' });
    fixture.emit('message', { text: 'Welcome again!' });
    fixture.emit('scores', 'not JSON');
    fixture.emit('scores', 'null');
    fixture.emit('scores', '{"a":"bad","b":0}');
    await page.waitForTimeout(150);
    await assertWaiting(page);
    await page.screenshot({ path: path.join(artifacts, 'connected-waiting.png'), fullPage: true, animations: 'disabled' });
  });

  async function scores(a, b, percentA, percentB) {
    const time = page.locator('#last-updated');
    const old = await time.count() ? await time.getAttribute('datetime') : null;
    const before = await page.evaluate(() => Date.now());
    fixture.emit('scores', JSON.stringify({ a, b }));
    await expect(page.locator('#last-updated')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT.*Z$/);
    if (old) await expect(page.locator('#last-updated')).not.toHaveAttribute('datetime', old);
    const iso = await page.locator('#last-updated').getAttribute('datetime');
    const after = await page.evaluate(() => Date.now());
    assert.ok(Date.parse(iso) >= before && Date.parse(iso) <= after, 'timestamp must be inside browser receive window');
    const humanTime = await page.evaluate(value => new Date(value).toLocaleString(), iso);
    await expect(page.locator('#last-updated')).toHaveText(humanTime);
    await expect(page.getByText('等待实时数据', { exact: true })).toHaveCount(0);
    await expect(page.locator('#realtime-status')).toContainText('最近更新：');
    await assertStatistics(page, a, b, percentA, percentB);
    return iso;
  }

  await t.test('first zero/zero scores get a real browser timestamp and 50.0%/50.0%', async () => {
    await scores(0, 0, 50, 50);
    await page.screenshot({ path: path.join(artifacts, 'zero-scores.png'), fullPage: true, animations: 'disabled' });
  });

  await t.test('3/1 and 4/2 retain total and rounded percentages', async () => {
    await scores(3, 1, 75, 25);
    await scores(4, 2, 67, 33);
    await page.screenshot({ path: path.join(artifacts, 'uneven-scores.png'), fullPage: true, animations: 'disabled' });
  });

  await t.test('elapsed time and invalid messages retain the last good data; identical scores advance time', async () => {
    const previous = await page.locator('#last-updated').getAttribute('datetime');
    await page.waitForTimeout(1100);
    fixture.emit('message', { text: 'Welcome!' });
    for (const bad of ['{', 'null', '{}', '{"a":4,"b":"bad"}']) fixture.emit('scores', bad);
    await page.waitForTimeout(150);
    await expect(page.locator('#last-updated')).toHaveAttribute('datetime', previous);
    await assertStatistics(page, 4, 2, 67, 33);
    const next = await scores(4, 2, 67, 33);
    assert.ok(Date.parse(next) > Date.parse(previous));
  });

  await t.test('refresh resets waiting; a score before any welcome still renders', async () => {
    const connections = fixture.connections();
    await page.reload();
    await expect.poll(fixture.connections).toBe(connections + 1);
    await assertWaiting(page);
    await scores(3, 1, 75, 25);
    assert.deepEqual(errors, [], 'no uncaught browser errors, including invalid scores');
  });

  await t.test('actual server.js serves the waiting page and real welcome without inventing scores', async () => {
    const actual = await startActualApp();
    const livePage = await context.newPage();
    const responses = [];
    livePage.on('response', response => {
      if (response.url().includes('/socket.io/') && response.status() === 200) responses.push(response.url());
    });
    try {
      const response = await livePage.goto(actual.url);
      assert.equal(response.status(), 200);
      await expect.poll(() => responses.length).toBeGreaterThan(0);
      await livePage.waitForTimeout(1100);
      await assertWaiting(livePage);
      const unavailable = await context.request.get(actual.url + '/api/results');
      assert.equal(unavailable.status(), 503);
      await livePage.screenshot({ path: path.join(artifacts, 'actual-server-waiting.png'), fullPage: true, animations: 'disabled' });
    } finally {
      await livePage.close();
      await actual.stop();
      fs.writeFileSync(path.join(artifacts, 'actual-server.log'), actual.log.join(''));
    }
  });
});
