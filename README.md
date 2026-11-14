# Result

## Browser reception time

Before the first valid `scores` event, the page shows “等待实时数据”. Each valid event updates
“最近更新” and `time#last-updated[datetime]` using the current browser's reception time,
even if the counts have not changed. The visible text uses the browser's local time zone;
`datetime` is ISO 8601. Welcome messages, malformed JSON, invalid counts, and idle time do
not update the timestamp. Reloading starts a new wait for data in that page.

The existing JSON string payload (`a`/`b`, with absent counts defaulting to zero), rounded
percentages, totals, and server/database behavior are preserved. The timestamp describes
browser reception, not database write time or server polling time.

## Local regression checks

With Node.js 18 or newer, `npm test` runs the controller regression tests without services
or extra test dependencies. `npm run test:browser` requires the app's Socket.IO dependency,
Playwright, and Chromium to be available to Node (a reusable cache may be supplied through
`NODE_PATH`). Set `RESULT_BROWSER_ARTIFACTS` to an isolated output directory to save screenshots
and a JSON reception log.

The browser check serves the actual page, scripts, and stylesheet through a loopback-only
HTTP/Socket.IO fixture on an ephemeral port. It covers waiting, welcome and malformed messages,
zero scores, 3/1 and 4/2 results, unchanged scores, idle time, reload, mobile visibility, and
local-time display in an Asia/Shanghai browser. An independent browser listener records real
message reception to compare with the `datetime` attribute. The fixture uses no database and
never sends scores into a shared business environment. Remote font stylesheets are omitted
so this check does not depend on external font services.

These are isolated development checks. Verification against real deployed `scores`, including
an independent session submitting a new vote and observing an increased total and reception
time, remains a downstream integration check. The existing `docker-compose.test.yml` database
API test still requires its separate PostgreSQL/container environment.

## Existing routes

Results UI. Existing routes are unchanged:

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
