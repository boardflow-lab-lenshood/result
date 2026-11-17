const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const title = '实时投票结果';
let database;
let pageErrors;

test.beforeAll(() => {
  const { databaseUrl } = JSON.parse(readFileSync(
    path.join(__dirname, '../../.test-runtime/connection.json'), 'utf8'
  ));
  database = new Pool({ connectionString: databaseUrl });
});

test.afterAll(async () => {
  if (database) await database.end();
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await database.query('TRUNCATE votes');
  await page.goto('/');
  await expect(page.locator('body')).toHaveCSS('opacity', '1');
  await expect(page.locator('#total-count')).toHaveText('0');
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

async function expectHeading(page) {
  await expect(page).toHaveTitle('猫派 vs 狗派 -- Result');
  const heading = page.locator('h1');
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeVisible();
  expect(await heading.textContent()).toBe(title);
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toHaveCount(1);
  expect((await page.locator('body').innerText()).split(title).length - 1).toBe(1);

  // Native structure and rendered coordinates must both put it above the scores.
  expect(await heading.evaluate((element) => Boolean(
    element.compareDocumentPosition(document.querySelector('#choice')) & Node.DOCUMENT_POSITION_FOLLOWING
  ))).toBe(true);
  const box = await heading.boundingBox();
  const choices = await page.locator('#choice').boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(choices.y);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

async function expectCounts(page, a, b, aPercent, bPercent) {
  await expect(page.locator('.cats .label')).toHaveText('猫派');
  await expect(page.locator('.dogs .label')).toHaveText('狗派');
  await expect(page.locator('#count-a')).toHaveText(String(a));
  await expect(page.locator('#count-b')).toHaveText(String(b));
  await expect(page.locator('#total-label')).toHaveText('总票数');
  await expect(page.locator('#total-count')).toHaveText(String(a + b));
  await expect(page.locator('.cats .stat')).toHaveText(aPercent);
  await expect(page.locator('.dogs .stat')).toHaveText(bPercent);
  for (const selector of ['.cats .label', '.dogs .label', '#count-a', '#count-b', '#total-count']) {
    await expect(page.locator(selector)).toBeVisible();
  }
}

test('has one visible native h1 with exact text above the score region', async ({ page }, testInfo) => {
  await expectHeading(page);
  await page.screenshot({ path: testInfo.outputPath('heading.png'), fullPage: true });
});

test('keeps the heading and zero-vote UI through a reload', async ({ page }) => {
  await expectHeading(page);
  await expectCounts(page, 0, 0, '50.0%', '50.0%');
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('opacity', '1');
  await expectHeading(page);
  await expectCounts(page, 0, 0, '50.0%', '50.0%');
});

test('keeps the heading through real Socket.IO updates and reloads', async ({ page }, testInfo) => {
  await expectHeading(page);
  await page.evaluate(() => {
    window.scoreEvents = [];
    socket.on('scores', (json) => window.scoreEvents.push(JSON.parse(json)));
  });
  await database.query(
    "INSERT INTO votes (id, vote) VALUES ('cat-1', 'a'), ('cat-2', 'a'), ('cat-3', 'a'), ('dog-1', 'b')"
  );
  await expect.poll(() => page.evaluate(() => window.scoreEvents.some(
    (scores) => Number(scores.a) === 3 && Number(scores.b) === 1
  ))).toBe(true);
  await expectCounts(page, 3, 1, '75.0%', '25.0%');
  await expectHeading(page);

  const response = await page.request.get('/api/results');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ a: 3, b: 1 });
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('opacity', '1');
  await expectCounts(page, 3, 1, '75.0%', '25.0%');
  await expectHeading(page);
  await page.screenshot({ path: testInfo.outputPath('live-results.png'), fullPage: true });
});
