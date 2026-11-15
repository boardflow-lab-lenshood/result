const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { chromium } = require('playwright');

async function run() {
  // Only this isolated fixture emits controlled samples; no deployed server is used.
  const app = express();
  app.use(express.static(path.join(__dirname, '../views')));
  const server = http.createServer(app);
  const io = new Server(server);
  io.on('connection', (socket) => socket.emit('message', { text: 'Welcome!' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    const evidence = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('response', (response) => requests.push({ url: response.url(), status: response.status() }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.angular && document.querySelector('#update-status').innerText.includes('等待实时数据'));
    await page.waitForFunction(() => document.querySelector('body').style.opacity === '1');
    await page.waitForFunction(() => window.io && document.querySelector('#update-status').getAttribute('ng-cloak') === null);
    const waiting = async () => {
      assert.match(await page.locator('#update-status').innerText(), /等待实时数据/);
      assert.equal(await page.locator('time#last-updated').count(), 0);
    };
    await waiting();
    const result = await page.locator('#result').elementHandle();
    const checkResult = async (total) => {
      assert.equal(await page.locator('#result #total-label').innerText(), '总票数');
      assert.equal(await page.locator('#result #total-count').innerText(), String(total));
      assert.deepEqual(await result.evaluate((original) => ({
        sameNode: original === document.querySelector('#result'),
        connected: original.isConnected,
        resultCount: document.querySelectorAll('#result').length,
        labelCount: document.querySelectorAll('#total-label').length,
        totalCount: document.querySelectorAll('#total-count').length,
        liveRegions: Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]'), (el) => el.id),
        role: original.getAttribute('role'),
        live: original.getAttribute('aria-live'),
        atomic: original.getAttribute('aria-atomic')
      })), {
        sameNode: true, connected: true, resultCount: 1, labelCount: 1, totalCount: 1,
        liveRegions: ['result'], role: 'status', live: 'polite', atomic: 'true'
      });
    };
    await checkResult(0);
    // Wait for the actual transport and its welcome message before checking again.
    const deadline = Date.now() + 5000;
    while (io.engine.clientsCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(io.engine.clientsCount, 1);
    io.emit('message', { text: 'Welcome again!' });
    io.emit('scores', '{"a":"3","b":1}');
    io.emit('scores', ['{"a":3,"b":1}']);
    await page.waitForTimeout(100);
    await waiting();
    const artifactDir = path.join(__dirname, '../.local-checks/evidence');
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, 'waiting.png') });
    let previous;
    for (const [a, b, expected] of [[0, 0, ['50.0%', '50.0%']], [3, 1, ['75.0%', '25.0%']], [4, 2, ['67.0%', '33.0%']], [4, 2, ['67.0%', '33.0%']]]) {
      if (previous) await page.waitForFunction((value) => Date.now() > Date.parse(value), previous);
      const before = await page.evaluate(() => Date.now());
      io.emit('scores', JSON.stringify({ a, b }));
      await page.waitForFunction((old) => {
        const el = document.querySelector('time#last-updated');
        return el && el.dateTime && el.dateTime !== old;
      }, previous);
      const time = page.locator('time#last-updated');
      assert.equal(await time.count(), 1);
      const stamp = await time.getAttribute('datetime');
      const after = await page.evaluate(() => Date.now());
      assert.equal(new Date(stamp).toISOString(), stamp);
      assert.ok(Date.parse(stamp) >= before && Date.parse(stamp) <= after);
      const expectedVisible = await page.evaluate((iso) => angular.element(document.body).injector().get('$filter')('date')(iso, 'medium'), stamp);
      assert.equal(await time.innerText(), expectedVisible);
      assert.match(await page.locator('#update-status').innerText(), /最近更新/);
      assert.deepEqual(await page.locator('.stat').allTextContents(), expected);
      const counts = (await page.locator('.count').allTextContents()).map((text) => text.trim());
      assert.deepEqual(counts, [String(a), String(b)]);
      await checkResult(a + b);
      evidence.push({ a, b, total: a + b, sameResultNode: true, connected: true, role: 'status', live: 'polite', atomic: 'true', before, datetime: stamp, visible: expectedVisible, after, percentages: expected });
      previous = stamp;
    }
    for (const payload of ['{', '{}', '{"a":-1,"b":2}', '{"a":1.5,"b":2}', '{"a":3,"b":"1"}', '{"a":1e400,"b":0}', ['{"a":3,"b":1}'], { a: 3, b: 1 }]) io.emit('scores', payload);
    io.emit('message', { text: 'Another welcome' });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('time#last-updated').getAttribute('datetime'), previous);
    assert.deepEqual(await page.locator('.stat').allTextContents(), ['67.0%', '33.0%']);
    await page.screenshot({ path: path.join(artifactDir, 'received.png') });
    await checkResult(6);
    await page.screenshot({ path: path.join(artifactDir, 'result-status.png'), fullPage: true });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#update-status').innerText.includes('等待实时数据'));
    await waiting();
    assert.equal(await page.locator('time#last-updated').count(), 0);
    for (const file of ['/app.js', '/angular.min.js', '/socket.io.js']) {
      assert.ok(requests.some((request) => new URL(request.url).pathname === file && request.status === 200), file);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifactDir, 'browser.json'), JSON.stringify({ fixture: 'isolated Socket.IO server serving current views', evidence, requests, errors }, null, 2));
    console.log('PASS real Chromium: waiting, welcome, invalid messages, 0/0, 3/1, 4/2, repeated counts, ISO/visible local time, refresh; HTTP and Socket.IO used.');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => io.close(resolve));
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
