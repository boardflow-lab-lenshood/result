// Run with Socket.IO (the app dependency) and Playwright available to Node.
// This isolated server controls scores; it never connects to a business database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { Server } = require('socket.io');
const { chromium } = require('playwright');

const views = path.join(__dirname, '../views');
const artifacts = process.env.RESULT_BROWSER_ARTIFACTS;
const routes = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'application/javascript'],
  '/angular.min.js': ['angular.min.js', 'application/javascript'],
  '/socket.io.js': ['socket.io.js', 'application/javascript'],
  '/stylesheets/style.css': ['stylesheets/style.css', 'text/css']
};
const server = http.createServer((request, response) => {
  const route = routes[request.url];
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': route[1] + '; charset=utf-8' });
  response.end(fs.readFileSync(path.join(views, route[0])));
});
const io = new Server(server);
const evidence = [];
let browser;

async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 }, timezoneId: 'Asia/Shanghai'
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // The observer is installed before the application subscribes to scores.
  // The message and clock are real; no browser clock or app state is replaced.
  await page.addInitScript(() => {
    window.browserReceptions = [];
    Object.defineProperty(window, 'io', {
      configurable: true,
      set(client) {
        const connect = client.connect;
        client.connect = function (...args) {
          const connection = connect.apply(this, args);
          connection.on('scores', payload => {
            window.browserReceptions.push({ payload, receivedAt: Date.now() });
          });
          return connection;
        };
        Object.defineProperty(window, 'io', { value: client, writable: true, configurable: true });
      }
    });
  });
  // Font stylesheets are unrelated to this behavior; keep the fixture offline.
  await page.route('https://**/*', route => route.fulfill({ body: '' }));

  const connection = once(io, 'connection');
  await page.goto(url);
  const [socket] = await connection;
  async function read() {
    return page.evaluate(() => ({
      status: document.querySelector('#realtime-status').innerText.trim(),
      datetime: document.querySelector('time#last-updated')?.getAttribute('datetime') || null,
      counts: [...document.querySelectorAll('.count')].map(element => element.innerText),
      percentages: [...document.querySelectorAll('.stat')].map(element => element.innerText),
      total: document.querySelector('#total-count').innerText,
      receptions: window.browserReceptions.slice()
    }));
  }
  async function save(label) {
    const state = await read();
    evidence.push({ label, ...state });
    if (artifacts) {
      fs.mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, label + '.png') });
    }
    return state;
  }
  async function waiting() {
    await page.waitForFunction(() => document.querySelector('#realtime-status').innerText.trim() === '等待实时数据');
    assert.equal(await page.locator('#realtime-status').isVisible(), true);
    const state = await read();
    assert.equal(state.datetime, null);
    assert.ok(!state.status.includes('最近更新'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).opacity), '1');
  }
  await waiting();
  socket.emit('message', { text: 'Welcome!' });
  socket.emit('scores', '{broken');
  await page.waitForFunction(() => window.browserReceptions.length === 1);
  await waiting();
  await save('waiting');

  async function scores(a, b, expectedPercentages, label) {
    const previous = await read();
    // Ensure distinct real clock milliseconds before testing strict advancement.
    await page.waitForFunction(before => Date.now() > Date.parse(before || '1970-01-01'), previous.datetime);
    const payload = JSON.stringify({ a, b });
    socket.emit('scores', payload);
    await page.waitForFunction(before => {
      const time = document.querySelector('time#last-updated');
      return time && time.getAttribute('datetime') !== before && time.getAttribute('datetime');
    }, previous.datetime);
    const state = await save(label);
    assert.deepEqual(state.counts, [String(a), String(b)]);
    assert.deepEqual(state.percentages, expectedPercentages);
    assert.equal(state.total, String(a + b));
    assert.ok(state.status.startsWith('最近更新：'));
    const localTime = await page.evaluate(iso => {
      const date = new Date(iso);
      const pad = value => String(value).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }, state.datetime);
    assert.equal(await page.locator('time#last-updated').innerText(), localTime);
    const received = state.receptions.at(-1);
    assert.equal(received.payload, payload);
    const displayedTime = Date.parse(state.datetime);
    assert.ok(Number.isFinite(displayedTime));
    assert.ok(displayedTime >= received.receivedAt && displayedTime <= received.receivedAt + 20,
      'datetime must match the independent browser reception record');
    if (previous.datetime) assert.ok(displayedTime > Date.parse(previous.datetime));
    return state;
  }
  await scores(0, 0, ['50.0%', '50.0%'], 'zero');
  await scores(3, 1, ['75.0%', '25.0%'], 'three-one');
  const duplicate = await scores(3, 1, ['75.0%', '25.0%'], 'unchanged-counts');
  for (const payload of ['null', '[]', '{"a":-1}', '{"a":1.5}', '{"a":"bad"}', '{broken']) {
    socket.emit('scores', payload);
  }
  socket.emit('message', { text: 'Welcome again!' });
  await page.waitForFunction(count => window.browserReceptions.length === count + 6, duplicate.receptions.length);
  await page.waitForTimeout(1200);
  assert.equal((await read()).datetime, duplicate.datetime);
  assert.deepEqual((await read()).counts, duplicate.counts);
  await save('invalid-and-idle');
  await scores(4, 2, ['67.0%', '33.0%'], 'four-two');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#realtime-status').isVisible(), true);
  await save('mobile');

  const reconnect = once(io, 'connection');
  await page.reload();
  await reconnect;
  await waiting();
  assert.equal((await read()).receptions.length, 0);
  await save('reload-waiting');
  assert.deepEqual(errors, []);
  const report = {
    kind: 'isolated-browser-socketio',
    browser: browser.version(),
    url,
    pageErrors: errors,
    evidence
  };
  if (artifacts) fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('isolated browser realtime checks passed');
}

const timeout = setTimeout(() => {
  console.error('browser checks timed out');
  process.exit(1);
}, 45000);
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(timeout);
  if (browser) await browser.close();
  await new Promise(resolve => io.close(resolve));
});
