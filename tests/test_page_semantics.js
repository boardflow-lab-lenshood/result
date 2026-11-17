const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.html'), 'utf8');

test('Chinese results page has one main containing its heading and all live counts', () => {
  assert.match(html, /<html\b[^>]*\blang="zh-CN"/);
  const mains = [...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/g)];
  assert.equal(mains.length, 1);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  const main = mains[0][1];
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(headings.length, 1);
  assert.equal(headings[0][1], '实时投票结果');
  assert.ok(main.includes(headings[0][0]));
  for (const [id, binding] of [['count-a', 'aCount'], ['count-b', 'bCount'], ['total-count', 'total']]) {
    const count = new RegExp('<(div|span)\\b[^>]*\\bid="' + id + '"[^>]*>\\{\\{' + binding + '\\}\\}</\\1>');
    assert.match(main, count);
    assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1);
  }
});

test('document title, Angular controller and live connection scripts stay available', () => {
  assert.match(html, /<title>猫派 vs 狗派 -- Result<\/title>/);
  assert.match(html, /<html\b[^>]*\bng-app="catsvsdogs"/);
  assert.match(html, /<body\b[^>]*\bng-controller="statsCtrl"/);
  for (const script of ['socket.io.js', 'angular.min.js', 'app.js']) {
    assert.ok(html.includes('<script src="' + script + '"></script>'));
  }
});
