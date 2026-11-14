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
  '/candidate-layout': ['../tests/fixtures/result-batch-16016d76.html', 'text/html'],
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
const errors = [];
let browser;

async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  async function openPage(options) {
    // Each page gets a new context, including the mobile emulation settings.
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', ...options });
    const opened = await context.newPage();
    opened.on('pageerror', error => errors.push(error.message));
    // Observe real message reception before the application subscribes to scores.
    await opened.addInitScript(() => {
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
    await opened.route('https://**/*', route => route.fulfill({ body: '' }));
    return opened;
  }
  let page = await openPage({ viewport: { width: 1024, height: 768 } });
  const connection = once(io, 'connection');
  await page.goto(url);
  let [socket] = await connection;
  async function read() {
    return page.evaluate(() => {
      const rect = element => {
        if (!element) return null;
        const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
      };
      const status = document.querySelector('#realtime-status');
      const time = document.querySelector('time#last-updated');
      return {
        status: status.innerText.trim(),
        datetime: time?.getAttribute('datetime') || null,
        counts: [...document.querySelectorAll('.count')].map(element => element.innerText),
        percentages: [...document.querySelectorAll('.stat')].map(element => element.innerText),
        total: document.querySelector('#total-count').innerText,
        receptions: window.browserReceptions.slice(),
        viewport: {
          width: innerWidth, height: innerHeight, scrollX, scrollY,
          documentWidth: document.documentElement.scrollWidth
        },
        statusRect: rect(status),
        statusContentRect: rect(status.querySelector('span')),
        timeRect: rect(time)
      };
    });
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
  async function assertInViewport(label, snapshot) {
    const state = snapshot || await read();
    // Mobile layout viewports can expand to hide overflow through auto-scaling.
    // Compare with the requested device viewport, not that expanded innerWidth.
    const viewport = page.viewportSize();
    assert.equal(await page.locator('#realtime-status').isVisible(), true);
    assert.equal(state.viewport.scrollX, 0, label + ': no horizontal scrolling');
    assert.equal(state.viewport.scrollY, 0, label + ': initial screen');
    for (const name of ['statusRect', 'statusContentRect', 'timeRect']) {
      const box = state[name];
      if (name === 'timeRect' && !state.datetime) continue;
      assert.ok(box && box.width > 0 && box.height > 0, label + ': ' + name + ' has content');
      assert.ok(box.left >= -0.5 && box.top >= -0.5 &&
        box.right <= viewport.width + 0.5 && box.bottom <= viewport.height + 0.5,
      label + ': ' + name + ' outside initial viewport: ' + JSON.stringify(state));
    }
    assert.ok(state.viewport.documentWidth <= viewport.width,
      label + ': document must not overflow horizontally');
  }
  async function waiting() {
    await page.waitForFunction(() => document.querySelector('#realtime-status').innerText.trim() === '等待实时数据');
    assert.equal(await page.locator('#realtime-status').isVisible(), true);
    const state = await read();
    assert.equal(state.datetime, null);
    assert.ok(!state.status.includes('最近更新'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).opacity), '1');
  }
  const invalid = [
    'null', '[]', '{"a":-1}', '{"a":1.5}', '{"a":"bad"}', '{broken',
    '{"a":false,"b":1}', '{"a":null,"b":1}', '{"a":"","b":1}',
    '{"a":1,"b":false}', '{"a":1,"b":null}', '{"a":1,"b":""}'
  ];
  await waiting();
  socket.emit('message', { text: 'Welcome!' });
  for (const payload of invalid) socket.emit('scores', payload);
  await page.waitForFunction(count => window.browserReceptions.length === count, invalid.length);
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
  for (const payload of invalid) socket.emit('scores', payload);
  socket.emit('message', { text: 'Welcome again!' });
  await page.waitForFunction(count => window.browserReceptions.length === count,
    duplicate.receptions.length + invalid.length);
  await page.waitForTimeout(1200);
  assert.equal((await read()).datetime, duplicate.datetime);
  assert.deepEqual((await read()).counts, duplicate.counts);
  await save('invalid-and-idle');
  await scores(4, 2, ['67.0%', '33.0%'], 'four-two');

  const reconnect = once(io, 'connection');
  await page.reload();
  await reconnect;
  await waiting();
  assert.equal((await read()).receptions.length, 0);
  await save('reload-waiting');

  for (const layout of [
    { label: 'candidate', route: '/candidate-layout' },
    { label: 'current', route: '/' }
  ]) {
    for (const scenario of [
      { label: 'mobile-390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
      { label: 'tablet-768', viewport: { width: 768, height: 1024 } },
      { label: 'desktop-1280', viewport: { width: 1280, height: 800 } }
    ]) {
      await page.context().close();
      const { label: device, ...options } = scenario;
      const label = layout.label + '-' + device;
      page = await openPage(options);
      const connected = once(io, 'connection');
      await page.goto(url + layout.route);
      [socket] = await connected;
      await waiting();
      const waitingState = await save(label + '-waiting');
      await scores(3, 1, ['75.0%', '25.0%'], label + '-updated');
      await assertInViewport(label + '-updated');
      await assertInViewport(label + '-waiting', waitingState);
    }
  }
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
  console.log('isolated browser realtime and viewport checks passed');
}

const timeout = setTimeout(() => {
  console.error('browser checks timed out');
  process.exit(1);
}, 45000);
main().catch(error => {
  if (artifacts) {
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'browser-failure.json'), JSON.stringify({
      error: error.message, pageErrors: errors, evidence
    }, null, 2));
  }
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(timeout);
  if (browser) await browser.close();
  await new Promise(resolve => io.close(resolve));
});
