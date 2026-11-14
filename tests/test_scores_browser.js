// Isolated UI regression using the actual page and real Socket.IO transport.
// These fixture messages are not evidence of a deployed vote/worker pipeline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { chromium } = require('playwright');

async function main() {
  const app = express();
  app.get('/favicon.ico', (req, res) => res.sendStatus(204));
  app.use(express.static(path.join(__dirname, '../views')));
  const server = http.createServer(app);
  const io = new Server(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const evidence = { kind: 'isolated-ui-socket-fixture', samples: [] };
  const evidenceDir = process.env.SCORES_EVIDENCE_DIR;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox']
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ body: '', contentType: 'text/css' }));
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.waitForFunction(() => window.socket && socket.connected);
    await page.waitForFunction(() => document.body.style.opacity === '1');

    async function snapshot() {
      return page.evaluate(() => ({
        status: document.querySelector('#update-status').innerText,
        datetime: document.querySelector('#last-updated')?.getAttribute('datetime') || null,
        renderedTime: document.querySelector('#last-updated')?.innerText || null,
        counts: ['count-a', 'count-b'].map((id) => document.getElementById(id).innerText),
        percentages: [...document.querySelectorAll('.stat')].map((node) => node.innerText),
        total: document.querySelector('#total-count').innerText,
        totalLabel: document.querySelector('#total-label').innerText,
        backgrounds: ['background-stats-1', 'background-stats-2'].map((id) => document.getElementById(id).style.width)
      }));
    }
    async function observeScores() {
      await page.evaluate(() => {
        window.observedScores = [];
        socket.onAny((event, payload) => {
          if (event === 'scores') observedScores.push({ payload, receivedAt: Date.now() });
        });
      });
    }
    async function receive(payload) {
      const previousCount = await page.evaluate(() => observedScores.length);
      io.emit('scores', payload);
      await page.waitForFunction((n) => observedScores.length === n + 1, previousCount);
      const received = await page.evaluate(() => observedScores[observedScores.length - 1]);
      const dom = await snapshot();
      evidence.samples.push({ received, dom });
      return { received, dom };
    }
    function assertReceiveTime(sample) {
      assert.match(sample.dom.status, /^最近更新：/);
      assert.match(sample.dom.datetime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
      const delta = Date.parse(sample.dom.datetime) - sample.received.receivedAt;
      assert.ok(delta >= 0 && delta < 100, 'datetime must match this browser reception: ' + delta + 'ms');
      assert.match(sample.dom.renderedTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    }

    const waiting = await snapshot();
    assert.equal(waiting.status, '等待实时数据');
    assert.equal(waiting.datetime, null);
    io.emit('message', { text: 'Welcome!' });
    await page.waitForTimeout(100);
    assert.deepEqual(await snapshot(), waiting);
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, 'waiting.png') });
    }
    await observeScores();
    for (const invalid of ['bad json', 'null', '{"a":"invalid","b":1}']) {
      assert.deepEqual((await receive(invalid)).dom, waiting);
    }

    for (const [payload, counts, percentages, total, widths] of [
      ['[]', ['0', '0'], ['50.0%', '50.0%'], '0', ['50%', '50%']],
      ['{"a":0,"b":0}', ['0', '0'], ['50.0%', '50.0%'], '0', ['50%', '50%']],
      ['{"a":3,"b":1}', ['3', '1'], ['75.0%', '25.0%'], '4', ['75%', '25%']],
      ['{"a":4,"b":2}', ['4', '2'], ['67.0%', '33.0%'], '6', ['67%', '33%']]
    ]) {
      await page.waitForTimeout(150);
      const sample = await receive(payload);
      assertReceiveTime(sample);
      assert.deepEqual(sample.dom.counts, counts);
      assert.deepEqual(sample.dom.percentages, percentages);
      assert.equal(sample.dom.total, total);
      assert.deepEqual(sample.dom.backgrounds, widths);
    }
    const previous = await snapshot();
    await page.waitForTimeout(150);
    io.emit('message', { text: 'Welcome again!' });
    assert.deepEqual((await receive('not json')).dom, previous);
    assert.deepEqual((await receive('null')).dom, previous);
    await page.waitForTimeout(150);
    assert.deepEqual(await snapshot(), previous);
    const repeated = await receive('{"a":4,"b":2}');
    assertReceiveTime(repeated);
    assert.ok(Date.parse(repeated.dom.datetime) > Date.parse(previous.datetime));
    assert.deepEqual(repeated.dom.counts, previous.counts);
    assert.deepEqual(repeated.dom.percentages, previous.percentages);

    // A real reconnect/welcome must preserve the last receive time.
    await page.evaluate(() => socket.disconnect());
    await page.evaluate(() => socket.connect());
    await page.waitForFunction(() => socket.connected);
    io.emit('message', { text: 'Welcome after reconnect!' });
    await page.waitForTimeout(150);
    assert.deepEqual(await snapshot(), repeated.dom);
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'updated.png') });

    // Refresh starts a new page receive history; the fixture sends no initial score.
    await page.reload();
    await page.waitForFunction(() => window.socket && socket.connected);
    assert.equal((await snapshot()).status, '等待实时数据');
    assert.equal((await snapshot()).datetime, null);
    await observeScores();
    assertReceiveTime(await receive('{"a":3,"b":1}'));
    assert.deepEqual(errors, []);
    evidence.browser = await browser.version();
    evidence.result = 'PASS';
    if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, 'scores-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => io.close(resolve));
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
