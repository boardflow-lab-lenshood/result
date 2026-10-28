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
