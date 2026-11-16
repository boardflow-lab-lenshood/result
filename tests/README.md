# Result-page realtime tests

Use Node 18 or newer (matching the app Dockerfile). Install dependencies and the
headless browser with caches owned by this checkout:

```sh
npm ci --cache .cache/npm
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npm exec --cache .cache/npm -- playwright install chromium --only-shell
npm test
npm run test:browser
```

`npm test` exercises the actual Angular controller with a controlled browser clock:
valid zero and nonzero scores, unchanged counts arriving later, invalid messages,
connection/welcome events, and the existing vote totals and percentage rounding.

`npm run test:browser` opens the actual result HTML, CSS and JavaScript in Chromium.
It uses a separate loopback HTTP/Socket.IO fixture on an ephemeral port, sends only
synthetic local score events, and checks rendered waiting/update text, ISO datetime,
readable local time, totals and percentages. It also reloads the page, tests a page
before JavaScript, and starts the actual `server.js` with `PORT=0` and a deliberately
unavailable loopback database (`127.0.0.1:1`) to verify that connection/welcome and
DB failure leave the page waiting. All servers and browser contexts are closed.
Screenshots, a browser trace and the actual server log are saved in ignored
`test-results/realtime/`. No deployment or shared database is accessed.

The timestamp means **this browser's latest valid scores receipt**, including a
repeated score pair. It is not a voting time or a server-side update time. Refresh
starts a new waiting state until another valid score event arrives.

Existing `node tests/test_regression_features.js` and
`node tests/test_regression_feature_a.js` (and corresponding feature files) remain
standalone regression tests. `tests/test_api_results.js` additionally needs a
caller-provided **dedicated** `TEST_DATABASE_URL`: it creates/truncates/inserts into
`votes`. Never point it at shared data. The browser fixture above does not replace
that database integration test or candidate-deployment acceptance using a real new
voter; those require their own isolated/authorized environments.
