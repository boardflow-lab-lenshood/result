# Result page receipt-time checks

Install dependencies with `npm install`. Run `npm test` for controller tests.
They check the initial waiting state, invalid payloads before and after a valid
message, repeated counts, zero counts, existing rounding and a fresh page.

For real browser checks:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local-checks/browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.local-checks/browsers npm run test:browser
```

The browser test starts its own HTTP/Socket.IO server on a loopback ephemeral
port and serves the current `views` assets. It sends controlled `scores`
samples only to that isolated server. Chromium checks actual DOM text, the
unique `time#last-updated`, its ISO `datetime` and local visible time, asset
requests, repeated messages, invalid messages and reload. Evidence and
screenshots go under `.local-checks/evidence/`, which is ignored by Git.
The test closes its browser and server on success or failure.

These controlled samples are development evidence, not evidence of votes in a
deployed environment. Real deployment acceptance must use the deployed voting
chain and record its own browser messages and versions. The receipt time is
local to each page session and is not a server timestamp, persistence record,
or transport-delay measurement.
