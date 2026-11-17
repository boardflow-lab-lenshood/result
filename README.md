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

`GET /api/uat/result-summary` is read-only and uses the same PostgreSQL `votes` counts as `GET /api/results`. It returns each option count, the total, the unique leader, and numeric percentages. With no votes, or when `a` and `b` are tied, `leader` is JSON `null`. With no votes, both percentages are zero:

```json
{"counts": {"a": 0, "b": 0}, "total": 0, "leader": null, "percentages": {"a": 0, "b": 0}}
```

For a positive total, `percentages.a` is `counts.a / total * 100` rounded to one decimal place (half up), and `percentages.b` is the complement of that rounded value. Both are JSON numbers with at most one decimal place, not strings or percentages rounded independently. For example:

```json
{"counts": {"a": 1, "b": 15}, "total": 16, "leader": "b", "percentages": {"a": 6.3, "b": 93.7}}
```

A unique highest count sets `leader` to `"a"` or `"b"`. The route does not write votes. If PostgreSQL is unavailable it returns the same HTTP 503 body as `GET /api/results`, with no summary fields. The legacy API and Socket.IO `scores` payload remain counts only; the UI keeps its existing integer percentages and its 50/50 empty state.

Run the real PostgreSQL/HTTP/Socket.IO contract tests against a dedicated test database (the test truncates its `votes` table):

```sh
npm ci
docker run --detach --rm --name result-summary-test --publish 127.0.0.1:55432:5432 --env POSTGRES_PASSWORD=postgres --env POSTGRES_DB=result_summary_test postgres:15-alpine
until docker exec result-summary-test pg_isready -U postgres -d result_summary_test; do sleep 1; done
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/result_summary_test node tests/test_api_results.js
node tests/test_regression_features.js
docker stop result-summary-test
```

The summary fixtures cover counts 0/0, 3/1, 1/2, 1/0, 7/7, 1/15, 0/1, 1/1 and 2/1, including legacy counts, the Socket.IO JSON-string payload, repeat reads, and the exact database-unavailable error body. Never point these fixed-data tests at a shared or deployed voting database.

`GET /api/regression/<name>?x=<integer>` loads `regression_features/<name>.js` and returns `evaluate(x)` as JSON. `name` must match `[a-z][a-z0-9_]{0,31}`. A missing module returns 404 JSON, a non-integer `x` returns 400 JSON, and a module exception returns 500 JSON with a diagnostic that does not include secrets. The built-in `echo` module returns `{"feature":"echo","value":x}`.
