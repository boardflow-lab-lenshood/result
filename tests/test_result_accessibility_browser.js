'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var fork = require('child_process').fork;
var root = path.resolve(__dirname, '..');

// Keep the browser download and generated evidence inside this worktree.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache', 'ms-playwright');
var chromium = require('playwright').chromium;

function messageFrom(child, type) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      finish(new Error('Timed out waiting for fixture message: ' + type));
    }, 10000);
    function finish(error, message) {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve(message);
    }
    function onMessage(message) {
      if (message.type === type) finish(null, message);
    }
    function onExit(code, signal) {
      finish(new Error('Fixture exited early: ' + code + ' / ' + signal));
    }
    function onError(error) { finish(error); }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { child.kill('SIGKILL'); }, 3000);
    child.once('exit', function () {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function rememberNodes(page) {
  await page.waitForFunction(function () {
    return window.socket && socket.connected && document.body.style.opacity === '1' &&
      document.querySelector('#total-count').textContent.trim() !== '{{total}}';
  });
  await page.evaluate(function () {
    window.resultStatusTest = {
      result: document.querySelector('#result'),
      count: document.querySelector('#total-count'),
      scores: []
    };
    socket.on('scores', function (json) {
      window.resultStatusTest.scores.push(JSON.parse(json));
    });
  });
}

async function assertStatus(page, counts) {
  var total = counts.a + counts.b;
  await page.waitForFunction(function (expected) {
    return document.querySelector('#total-count').textContent.trim() === String(expected.a + expected.b) &&
      window.resultStatusTest.scores.some(function (scores) {
        return scores.a === expected.a && scores.b === expected.b;
      });
  }, counts);

  var state = await page.evaluate(function () {
    var result = document.querySelector('#result');
    var count = document.querySelector('#total-count');
    return {
      resultCount: document.querySelectorAll('#result').length,
      labelCount: document.querySelectorAll('#total-label').length,
      countCount: document.querySelectorAll('#total-count').length,
      labelCopies: document.body.textContent.split('总票数').length - 1,
      role: result.getAttribute('role'),
      live: result.getAttribute('aria-live'),
      atomic: result.getAttribute('aria-atomic'),
      label: document.querySelector('#total-label').textContent.trim(),
      total: count.textContent.trim(),
      a: document.querySelector('#count-a').textContent.trim(),
      b: document.querySelector('#count-b').textContent.trim(),
      sameResult: result === window.resultStatusTest.result && result.isConnected,
      sameCount: count === window.resultStatusTest.count && count.isConnected,
      containsLabel: result.contains(document.querySelector('#total-label')),
      containsCount: result.contains(count)
    };
  });
  assert.deepStrictEqual(state, {
    resultCount: 1, labelCount: 1, countCount: 1, labelCopies: 1,
    role: 'status', live: 'polite', atomic: 'true', label: '总票数',
    total: String(total), a: String(counts.a), b: String(counts.b),
    sameResult: true, sameCount: true, containsLabel: true, containsCount: true
  });
  assert.strictEqual(await page.locator('#total-label').isVisible(), true);
  assert.strictEqual(await page.locator('#total-count').isVisible(), true);
  var response = await page.request.get('/api/results');
  assert.strictEqual(response.status(), 200);
  assert.deepStrictEqual(await response.json(), counts);
  console.log('PASS: real scores ' + JSON.stringify(counts) + ', total=' + total +
    ', live-region attributes and both DOM references preserved');
}

async function main() {
  var child = fork(path.join(__dirname, 'result_status_server.js'), [], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: '0', DATABASE_URL: 'postgres://isolated-fixture@127.0.0.1:1/unused'
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  var output = '';
  child.stdout.on('data', function (data) { output += data; });
  child.stderr.on('data', function (data) { output += data; });
  var browser;
  try {
    var ready = await messageFrom(child, 'ready');
    browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ baseURL: 'http://127.0.0.1:' + ready.port });
    var page = await context.newPage();
    page.setDefaultTimeout(10000);
    var pageErrors = [];
    page.on('pageerror', function (error) { pageErrors.push(error.message); });
    var response = await page.goto('/');
    assert.strictEqual(response.status(), 200);
    await rememberNodes(page);
    await assertStatus(page, { a: 0, b: 0 });

    for (var counts of [{ a: 2, b: 3 }, { a: 2, b: 4 }]) {
      var applied = messageFrom(child, 'counts-set');
      child.send({ type: 'counts', counts: counts });
      await applied;
      await assertStatus(page, counts);
    }
    var evidence = path.join(root, '.cache', 'result-status.png');
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    await page.screenshot({ path: evidence, fullPage: true });

    await page.reload();
    await rememberNodes(page);
    await assertStatus(page, { a: 2, b: 4 });
    assert.deepStrictEqual(pageErrors, []);
    console.log('PASS: refreshed page retains status semantics and reads total=6');
    console.log('Screenshot: ' + evidence);
    console.log('Coverage: actual result server + Angular + Chromium + Socket.IO; PostgreSQL only is stubbed.');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await stop(child);
    }
  }
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
