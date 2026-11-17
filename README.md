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

`GET /api/regression/<name>?x=<integer>` loads `regression_features/<name>.js` and returns `evaluate(x)` as JSON. `name` must match `[a-z][a-z0-9_]{0,31}`. A missing module returns 404 JSON, a non-integer `x` returns 400 JSON, and a module exception returns 500 JSON with a diagnostic that does not include secrets. The built-in `echo` module returns `{"feature":"echo","value":x}`.

## Local regression tests

Use Node.js 22 or later and a non-root account (PostgreSQL does not run as root):

```sh
npm ci --cache .npm-cache
PLAYWRIGHT_BROWSERS_PATH=0 npm --cache .npm-cache exec -- playwright install chromium
npm test
```

The test command first runs the existing `tests/test_api_results.js` regression against an isolated PostgreSQL instance, then starts the unchanged `server.js` and drives it with Chromium. Desktop (1280×800) and mobile (375×812) cases check the exact, unique, visible native `h1` above the vote region; the original document title and labels; zero and nonzero counts and percentages; real Socket.IO updates; and reloads. Screenshots are saved in `test-results/`.

No Docker or shared database is used. PostgreSQL binaries, browsers, dependencies, temporary database files, and reports stay in this worktree under `node_modules/`, `.npm-cache/`, `.test-runtime/`, and `test-results/`. PostgreSQL uses a dynamically allocated loopback port; the app uses port 18773, overridable with `RESULT_TEST_PORT`. The test server stops its app and database when Playwright exits. Test credentials and fixtures are local and disposable; tests never connect to the deployed voting system.

These checks are local development evidence. Validation against the batch deployment and real vote/worker services remains the downstream test lane's responsibility.
