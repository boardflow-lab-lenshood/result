# Seven C trace query and real integration verification

C: `c25bff7ada4f467395a7981132dee8f4`, [delivery#53](https://github.com/boardflow-lab-lenshood/delivery/issues/53).
Specification `c9c94e7be24540b0aee8c9291d329798`, development execution
`755b74062ce24c1fbb03f46341564438`, round 1, baseline epoch 1.
Only result is modified. The integration target is
`codex/arena-seven-20261103-latest`; actual `main` is not updated.
Fixed result baseline: `65b9eccdddff2c1e938259e60ffb175c52458294`.

## API

`GET /api/arena/seven-20261103/traces/:trace_id` returns JSON:

```json
{"trace_id":"example","total":2,"counts":{"a":1,"b":1},"voters":[{"voter_id":"first","vote":"a"},{"voter_id":"second","vote":"b"}]}
```

The identifier must completely match `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`.
The implementation also checks that JavaScript's match consumes the whole
string, rejecting a trailing newline. Empty identifiers, malformed percent
escapes, non-ASCII, NUL, excess length and forbidden characters return 400 JSON.
The input is decoded once by Express; it is never trimmed or normalized.

The database query uses `$1` with a parameter array. All rows and counts come
from the same query snapshot. Only current rows for the exact trace are read;
`voters` use PostgreSQL `COLLATE "C"` ordering of voter IDs. Unknown valid traces
return 200 with zero counts and an empty list. Failed database access, missing
votes table or missing B migration returns 503 JSON, with a structured server
error and stack. Responses use `Cache-Control: no-store`.

The existing result/summary APIs, homepage, live score broadcasts, health check
and regression features remain available. The health check still queries the
real database. This card does not implement the separate E/G features.

## Verified real upstream references

These are the references actually read from external Issues/PRs. Development
MCP reads only C; it is not used to read A/B cards.

| Upstream | Exact commit | External implementation and evidence |
| --- | --- | --- |
| A: `054b8ac1afd8488d8acc87777ee51679` | `5bce02e39a3d8b2c06bba37731c8bb6ae16f9e61` | [delivery#51 handoff](https://github.com/boardflow-lab-lenshood/delivery/issues/51#issuecomment-6584288366), [vote PR #44](https://github.com/boardflow-lab-lenshood/vote/pull/44), [actual commands/output](https://github.com/boardflow-lab-lenshood/vote/pull/44#issuecomment-6584277075) |
| B: `5c9d713506a0481c9987c941f5725862` | `36d5f71fd38f9c194b0650fdd5268015e7377083` | [delivery#52 developed status](https://github.com/boardflow-lab-lenshood/delivery/issues/52#issuecomment-6584426733), [worker PR #4](https://github.com/boardflow-lab-lenshood/worker/pull/4), [committed report](https://github.com/boardflow-lab-lenshood/worker/blob/36d5f71fd38f9c194b0650fdd5268015e7377083/tests/evidence/seven-b/REPORT.md) |

A's handoff explicitly reports 130 unit tests plus 4 healthy HTTP/Redis tests
and 4 outage tests passing on its clean exact commit. B's PR reports its 16 real
Redis/PostgreSQL/worker tests passing again on the final exact head. B's report
also explains the earlier source commit and evidence-only commit. C checks out
these two final commits with detached HEADs and does not change their branches.
Their baselines are respectively `de00436924ec030b08cba2724efb3a21b590dfd5`
and `c955288f250cfc4edf74675e106859aff56c6c60`; the runner checks ancestry.

## Reproducible owned verification

On a new, owned PostgreSQL fixture, with dependencies installed:

```sh
TEST_DATABASE_URL=postgresql://postgres@owned-db/postgres npm test
```

`tests/test_api_arena_traces.js` adds real HTTP/PostgreSQL tests for exact
filtering, ordering, counts, unknown traces, current-vote updates, valid limits,
invalid identifiers, malformed paths, migration failures, database failures and
legacy compatibility. Each trace suite uses its own random schema and drops it.
The original API and regression suites also run. Never point these suites at a
shared candidate: existing suites intentionally prepare/truncate fixture tables.

Full isolated development test, from this repository:

```sh
python3 tests/check_arena_seven_traces.py \
  --vote-dir /absolute/path/to/read-only-vote-5bce02e \
  --worker-dir /absolute/path/to/read-only-worker-36d5f71 \
  --data-scope development:c25bff7ada4f467395a7981132dee8f4:755b74062ce24c1fbb03f46341564438 \
  --evidence-dir /absolute/path/to/new-evidence-directory
```

This DEVELOP input has `context.data_scope_ref=null`. The command therefore uses
an explicit C-owned **local development scope** shown above; it does not invent
or write a platform/candidate data scope. `trace_id` is `c-` plus the first 32 hex
characters of SHA-256 of that scope. It creates two exclusive voters, POSTs a/b
through A, polls C for 2 / 1:1, POSTs the first voter as b, then polls for
2 / 0:2 with exactly two sorted voters. PostgreSQL snapshots verify the same
current rows at both stages. Neither propagation assertion depends on global
counts or other cards remaining idle.

The runner builds current C and the exact A sources using the unchanged locked
dependencies in the locally cached fixed-baseline images. It recompiles B using
B's checked-in `tests/Dockerfile.offline`, its original dependency assemblies
and the cached .NET SDK. It does not claim a fresh download/restore from public
package registries. Production recipes/dependency versions remain unchanged.

All live resources have unique names and C ownership labels. The Redis and
PostgreSQL fixtures use tmpfs and an internal Docker network; no host port is
published. A real HTTP client runs inside that network. Only these owned
resources are stopped for the database outage/health 503 test. At exit, the
runner saves logs and deletes its containers, temporary volumes, network and
image tags, including on failure. Every external command has a timeout.

Evidence contains `summary.json` (exact commits, image IDs and cleanup result),
`commands.log` (actual commands, output and exit status), `http.jsonl` (actual
requests/responses) and `database.json` (initial/final propagation snapshots).
Final runs require clean source checkouts. `--allow-dirty-result` is only for
local iteration and records the dirty state, never final delivery evidence.

## Candidate and baseline-sync boundary

This development runner operates only its own fixtures and is **not** a shared
candidate runner. Candidate validation still needs the authorized candidate's
real A/B/C revision references, its supplied data scope and exclusive voters.
It must perform the same a/b then b HTTP propagation assertions and scoped
PostgreSQL observations, without restarting/migrating/truncating shared services.
Development evidence does not stand in for that later candidate validation.

On SYNC_MAIN, retain the A/B PR and exact SHA references and all joint evidence.
Verify that the dependency implementations are present in the new precise
baseline/candidate. Rerun joint verification when source/contracts change, and
record actual ancestry rather than claiming an unrelated baseline.
