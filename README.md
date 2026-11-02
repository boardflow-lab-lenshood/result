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

`GET /api/uat/result-summary` is read-only and uses the same PostgreSQL `votes` counts as `GET /api/results`. It returns each option count, the total, and the unique leader. With no votes, or when `a` and `b` are tied, `leader` is JSON `null`:

```json
{"counts": {"a": 0, "b": 0}, "total": 0, "leader": null}
```

A unique highest count sets `leader` to `"a"` or `"b"`. The route does not write votes. If PostgreSQL is unavailable it returns the same HTTP 503 body as `GET /api/results`.

`GET /api/arena/three-20261102/summary` reads the current PostgreSQL vote counts on every request and returns HTTP 200 JSON. The existing `/api/arena/20261102/summary` remains available with the same behavior:

```json
{"total": 0, "leader": "tie", "counts": {"a": 0, "b": 0}}
```

`total` is the sum of the actual `a` and `b` counts. `leader` is `"tie"` for zero votes or equal counts, otherwise `"a"` or `"b"`. Responses include `Cache-Control: no-store`. Database failures return HTTP 503 JSON with `{"error":"database_unavailable","service":"result"}`. The existing `/api/uat/result-summary` keeps its `null` tie value.

Run the HTTP/database integration tests with Node.js 18+ and a disposable PostgreSQL database:

```sh
npm ci
TEST_DATABASE_URL="$RESULT_TEST_DATABASE_URL" npm test
```

Set `RESULT_TEST_DATABASE_URL` to the test database connection string. The existing API tests create and truncate its `votes` table, so use a dedicated test database. The arena tests use a unique schema and remove it and their server processes on completion. They disconnect only their own database sessions, identified by a unique PostgreSQL application name. They cover zero votes, nonzero ties, both leaders, inserts, vote changes, deletions, database connection/query failures, recovery, and existing HTTP/Socket.IO compatibility. Live score broadcasts acquire a pooled connection on each tick so database disconnects do not terminate the HTTP service and broadcasts resume after recovery.

`GET /api/regression/<name>?x=<integer>` loads `regression_features/<name>.js` and returns `evaluate(x)` as JSON. `name` must match `[a-z][a-z0-9_]{0,31}`. A missing module returns 404 JSON, a non-integer `x` returns 400 JSON, and a module exception returns 500 JSON with a diagnostic that does not include secrets. The built-in `echo` module returns `{"feature":"echo","value":x}`.
