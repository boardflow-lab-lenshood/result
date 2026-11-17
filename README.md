# Result

Results UI. The page has one heading, `实时投票结果`, above the live scores.

## Page tests

Requires Node.js 18+ and npm. From the result repository:

```sh
npm ci
npm test
```

`npm test` runs `node --test tests/page.test.js`. It parses the page with the
HTML5 parser `parse5` to check the unique native h1, exact text and order before
`#choice`, the original document title, option labels, count/percentage/total
bindings, and script initialization order. It also executes the existing
`app.js` with Angular and Socket.IO test doubles to check message initialization,
successive score updates, totals, and the existing zero-vote percentage rule.
No server, database, browser, or shared-data changes are required.

These tests do not measure browser visibility or layout and do not replace
Chromium acceptance on the current batch deployment. After initialization and
the opacity transition complete, that check must confirm the h1 is visible above
the score region without overlap or clipping, and that the original title,
labels, counts, one-decimal percentages, and total render correctly using the
current shared counts. Record the deployment URL, batch/candidate or commit,
verification time, and actual DOM/layout/count assertions.

## Routes

Existing routes are unchanged:

- `GET /` serves the results page.
- `GET /healthz` reports PostgreSQL readiness.
- Socket.IO continues to emit live scores.

`GET /api/results` returns integer PostgreSQL vote counts, including zeros:

```json
{"a": 0, "b": 0}
```

If PostgreSQL is unavailable, the route returns HTTP 503:

```json
{"error": "database_unavailable", "service": "result"}
```

The server logs the database error message and code. It does not invent counts.

`GET /api/uat/result-summary` is read-only and uses the same PostgreSQL `votes` counts as `GET /api/results`. It returns each option count, the total, and the unique leader. With no votes, or when `a` and `b` are tied, `leader` is JSON `null`:

```json
{"counts": {"a": 0, "b": 0}, "total": 0, "leader": null}
```

A unique highest count sets `leader` to `"a"` or `"b"`. The route does not write votes. If PostgreSQL is unavailable it returns the same HTTP 503 body as `GET /api/results`.

`GET /api/regression/<name>?x=<integer>` loads `regression_features/<name>.js` and returns `evaluate(x)` as JSON. `name` must match `[a-z][a-z0-9_]{0,31}`. A missing module returns 404 JSON, a non-integer `x` returns 400 JSON, and a module exception returns 500 JSON with a diagnostic that does not include secrets. The built-in `echo` module returns `{"feature":"echo","value":x}`.
