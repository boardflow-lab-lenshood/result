const { defineConfig } = require('@playwright/test');

// Keep downloaded browsers with this worktree's test dependencies.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const port = Number(process.env.RESULT_TEST_PORT || 18773);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 15000,
  expect: { timeout: 7000 },
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } }
  ],
  webServer: {
    command: 'node tests/support/server.mjs',
    url: `${baseURL}/healthz`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
