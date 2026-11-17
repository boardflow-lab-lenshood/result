# Results page structure test

For card `122a26d9d9224c1da71110e026f0dfc5` (requirement revision
`ce8eab82ef9948c2b51f50f2e8dbea54`).

Prerequisites: Node.js 18 or newer and npm. From the result repository root:

```sh
npm ci --include=dev
npm run test:structure
```

`npm test` runs the same structure suite. It parses the current checkout's
`views/index.html` as a DOM with jsdom; it does not start the server, load remote
assets, connect to PostgreSQL, or read/write shared votes.

The suite checks the unique H1 and exact text `实时投票结果`, its location before
`#choice`, the original document title, both option labels, count/percentage/total
bindings, and runtime script references. In-memory mutations also verify that a
missing heading, duplicate heading, incorrect text, misplaced heading, changed
document title, and missing count binding fail the relevant assertions. These
mutations never change files on disk.

This is a source structure test, not a browser layout or deployment acceptance
test. jsdom does not measure visual layout or establish a real Socket.IO
connection. For this card's batch candidate, the TEST stage must use Chromium
against the actual result deployment, wait for Socket.IO initialization and
rendered numbers (not a fixed delay), then record:

- Card ID, batch/candidate version, deployed result commit, actual URL and time.
- Exactly one visible H1, tag/text, DOM order, bounding rectangles, and checks for
  clipping/overlap with the choice region and counts.
- Original document title, visible labels/counts/percentages/total, absence of raw
  template bindings, and total equal to the sum of both counts.
- Receipt of real `scores` updates and continued correct display with the heading
  still unique and visible. No fixed vote sample or shared-database reset is needed.

No batch candidate or deployment URL has been assigned at development time;
local structure test output must not be reported as that deployment evidence.
