# Result

Results UI. Existing routes are unchanged:

- `GET /` serves the results page.
- `GET /healthz` reports PostgreSQL readiness.
- Socket.IO continues to emit live scores.
- The existing total-votes container is a polite, atomic status region for assistive technology.

## Total-votes browser regression

Use Node.js 18 or later. Install dependencies and Chromium inside this checkout:

```sh
npm ci --cache .cache/npm
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" node node_modules/playwright/cli.js install chromium --only-shell
npm run test:result-status
```

The test starts the actual result server on an ephemeral port and uses Chromium,
Angular and the real Socket.IO transport. It checks the status attributes, visible
Chinese label and counts, and that the original `#result` and `#total-count` nodes
survive updates from total 0 to 5 to 6. It reloads the page to check the saved
fixture counts and writes a screenshot to `.cache/result-status.png`. Browser
binaries and caches stay under this checkout.

Only the child server's PostgreSQL pool is replaced with controlled vote counts;
no real database is accessed. This verifies the result UI update path, not the
vote/worker/PostgreSQL pipeline or screen-reader speech. A deployed integration
check must still submit a new anonymous vote and observe the resulting live count.
The test closes the browser and child server when it finishes.

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
