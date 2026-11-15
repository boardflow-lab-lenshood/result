# Result

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

`GET /api/uat/result-summary` is read-only and uses the same PostgreSQL `votes` counts as `GET /api/results`. It returns each option count, the total, the unique leader, and numeric percentages. With no votes, both percentages are zero. With no votes, or when `a` and `b` are tied, `leader` is JSON `null`:

```json
{"counts": {"a": 0, "b": 0}, "total": 0, "leader": null, "percentages": {"a": 0, "b": 0}}
```

For a positive total, `percentages.a` is `counts.a / total * 100` rounded to one decimal place. `percentages.b` is the complement of that rounded value, also at most one decimal place, so the percentages sum to 100. For example, counts `{"a":1,"b":2}` produce `{"a":33.3,"b":66.7}`. These are JSON numbers, without percent signs or a required trailing `.0`.

A unique highest count sets `leader` to `"a"` or `"b"`. The route does not write votes. If PostgreSQL is unavailable it returns the same HTTP 503 body as `GET /api/results`, without percentages. The original counts endpoint, Socket.IO scores, and results UI retain their existing format and behavior, including the UI's empty-vote 50/50 display.

`GET /api/regression/<name>?x=<integer>` loads `regression_features/<name>.js` and returns `evaluate(x)` as JSON. `name` must match `[a-z][a-z0-9_]{0,31}`. A missing module returns 404 JSON, a non-integer `x` returns 400 JSON, and a module exception returns 500 JSON with a diagnostic that does not include secrets. The built-in `echo` module returns `{"feature":"echo","value":x}`.

## Isolated tests

Run `npm ci` and `npm test` with Node.js 20 or later. The summary suite starts the real HTTP/Socket.IO server on ephemeral ports with a controlled `pg.Pool` loaded only in child test processes. It never connects to a database for successful fixed samples or injected query errors. Connection errors use the real PostgreSQL client against an unavailable loopback port. Each sample starts fresh, reads twice, checks the summary and original counts endpoint, and logs inputs and responses. Empty and non-empty Socket.IO scores are checked as raw count JSON strings.

Samples include counts `0/0`, `3/1`, `1/2`, `1/0`, `7/7`, `0/1`, `1/1`, the complement-rounding boundary `1/15 → 6.3/93.7`, and the floating-point boundary `59/1941 → 3/97`. These tests cover application behavior; they do not prove successful PostgreSQL connectivity or SQL execution. `tests/test_api_results.js` remains an optional real-PostgreSQL integration test and requires `TEST_DATABASE_URL` pointing to a dedicated disposable database: it creates/truncates `votes` and must never target a shared database. Browser regression setup is in `tests/README-live-updates.md`.

After deployment, verify percentages read-only against `counts` and `total` from the same actual summary response, and record the deployed version. Do not require fixed samples in shared data or write/reset shared data to create them.
