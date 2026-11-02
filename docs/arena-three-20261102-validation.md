# Realtime summary validation — 2026-11-02

Card: `2ea7eb9008a84594878edcd3e9531db3`  
Execution: `0d621af572714f0f868abf4133a206f8`  
Fixed result baseline: `8e69725df98370e89fb738395a1bc1d4931d2e6c`  
PR target: `codex/arena-three-20261102-latest`

## Environment and commands

The application and a disposable PostgreSQL 16 database ran on a dedicated Docker network. The validation image reused the existing result image at the exact baseline, then copied this worktree's application and tests:

```dockerfile
FROM boardflow-real-uat/result:8e69725df98370e89fb738395a1bc1d4931d2e6c
WORKDIR /usr/local/app
COPY . .
```

The baseline image and worktree have the same `package-lock.json` SHA-256:
`25a12ea483c05e32f0f480a66457428d80ab18461397ea1d6fff864491806116`.
The container runtime was Node.js `v18.20.8`. No dependency files changed.

Commands executed from the development workspace included:

```sh
docker build --file evidence/Dockerfile.validation --tag arena-three-20261102-card-b-result:0d621af5 repos/result
python3 evidence/run-container-verification.py
```

The driver ran the following test command after starting its dedicated database:

```sh
docker run --rm --name arena-three-20261102-card-b-0d621af5-tests \
  --network arena-three-20261102-card-b-0d621af5 \
  -e TEST_DATABASE_URL=postgresql://postgres@arena-three-20261102-card-b-0d621af5-db/result_summary_test \
  arena-three-20261102-card-b-result:0d621af5 npm test
```

## Automated test result

`npm test` exited 0:

```text
result api self-tests passed
# tests 15
# suites 1
# pass 15
# fail 0
# cancelled 0
# skipped 0
result regression self-tests passed
```

The 15 integration tests launch real HTTP server processes and query a real PostgreSQL database. They cover zero votes, nonzero ties, each leader, insert/update/delete freshness, unrelated vote values, `/api/results`, the existing arena route, the legacy null tie value, the homepage, healthz, Socket.IO, lost-connection recovery, unreachable PostgreSQL, and query failure/recovery. Existing checks and expected responses were preserved.

## Independent HTTP smoke result

After the test suite, the driver launched the actual application container using `node server.js`, sent HTTP requests from the dedicated network, changed the database with `psql`, then stopped PostgreSQL with `docker stop --time 5 arena-three-20261102-card-b-0d621af5-db`.

All nine assertions passed:

| Assertion | Expected and observed response |
| --- | --- |
| Empty summary | 200, `{"total":0,"leader":"tie","counts":{"a":0,"b":0}}` |
| Two inserted a votes | 200, `{"total":2,"leader":"a","counts":{"a":2,"b":0}}` |
| Change one vote to b | 200, `{"total":2,"leader":"tie","counts":{"a":1,"b":1}}` |
| Existing `/api/results` | 200, `{"a":1,"b":1}` |
| Existing `/api/arena/20261102/summary` | 200, tie summary with a=1, b=1 |
| Existing `/api/uat/result-summary` | 200, a=1, b=1, total=2, leader=null |
| `/healthz` | 200, `{"status":"ok","service":"result"}` |
| `/` | 200 HTML with existing Chinese labels and count elements |
| PostgreSQL stopped after successful reads | 503, `{"error":"database_unavailable","service":"result"}` |

All new summary responses also had JSON content type and `Cache-Control: no-store`. The driver removed its database, result and test containers and dedicated network in cleanup. Raw commands, test output, HTTP responses, and server logs are retained in the registered worktree owner's sibling `evidence/` directory.

## Environment limitations encountered

The first host-side `npm test` attempt failed before API tests because the host could not reach the database's mapped loopback port (`ECONNREFUSED`). The initial default Dockerfile build was cancelled while waiting on dependency installation inside Docker. Neither attempt is counted as passing. The successful run used container-to-container networking and the fixed baseline image's matching dependencies.
