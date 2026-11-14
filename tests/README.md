# Result score receive-time regressions

Use Node.js 18 or later and install the application dependencies with `npm ci`.

- `npm test` checks score handling, browser receive times, repeated scores, malformed input, reconnect events, and the legacy empty-array payload without a database.
- `npm run test:browser` loads the real HTML, Angular controller and styles in Chromium, served from an ephemeral localhost HTTP/Socket.IO fixture. Install the optional browser tooling first with `npm install --no-save --package-lock=false --ignore-scripts playwright` and `npx playwright install chromium`. A preinstalled Playwright/Chromium environment also works. `CHROMIUM_EXECUTABLE_PATH` may point to an existing compatible Chromium executable.

The browser test observes actual Socket.IO deliveries in the browser and compares their receive times with `time#last-updated[datetime]`. It checks the initial waiting state, `[]` and 0/0, 3/1 and 4/2, counts, totals, one-decimal percentages, background widths, malformed messages, identical scores, reconnect and refresh. Set `SCORES_EVIDENCE_DIR` to save the browser observations and waiting/updated screenshots.

These tests use isolated synthetic Socket.IO messages and never connect to a database or a deployed application. They do not establish that the deployed vote/worker/result pipeline works. Deployment acceptance must separately use real browser observations and a real vote submitted from an independent browser session. Do not clear shared votes or inject fixture messages into that environment.

The existing `tests/test_regression_feature_c.js` and `tests/test_api_results.js` cover the earlier count feature; the API check needs a running result service and its configured database. The existing Docker Compose test configuration describes that environment. This change does not alter the server, database or wire format.
