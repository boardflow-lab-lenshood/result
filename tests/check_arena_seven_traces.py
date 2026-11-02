#!/usr/bin/env python3
"""Owned, real PostgreSQL suite and A -> Redis -> B -> PostgreSQL -> C check.

Only clones/checkouts supplied by the caller are read. All Docker resources are
unique to this run. No shared candidate is stopped, migrated or truncated.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

CARD = "c25bff7ada4f467395a7981132dee8f4"
VOTE_SHA = "5bce02e39a3d8b2c06bba37731c8bb6ae16f9e61"
WORKER_SHA = "36d5f71fd38f9c194b0650fdd5268015e7377083"
RESULT_BASE = "65b9eccdddff2c1e938259e60ffb175c52458294"
VOTE_BASE = "de00436924ec030b08cba2724efb3a21b590dfd5"
WORKER_BASE = "c955288f250cfc4edf74675e106859aff56c6c60"
TRACE_PATH = "/api/arena/seven-20261103/traces/"


class OwnedCheck:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = Path(__file__).resolve().parents[1]
        self.evidence = Path(args.evidence_dir).resolve()
        self.evidence.mkdir(parents=True, exist_ok=False)
        self.prefix = "seven-c-" + uuid.uuid4().hex[:12]
        self.network = self.prefix + "-net"
        self.containers: list[str] = []
        self.images: list[str] = []
        self.network_created = False
        self.receipts: list[dict] = []
        self.metadata: dict = {"card_id": CARD, "data_scope": args.data_scope,
                               "trace_id": "c-" + hashlib.sha256(args.data_scope.encode()).hexdigest()[:32],
                               "resource_prefix": self.prefix, "status": "RUNNING"}

    def command(self, argv: list[str], *, cwd: Path | None = None,
                timeout: int = 30, input_text: str | None = None) -> str:
        with (self.evidence / "commands.log").open("a") as log:
            log.write("\n$ " + json.dumps(argv, ensure_ascii=False) + "\n")
            log.flush()
            result = subprocess.run(argv, cwd=cwd, text=True, input=input_text,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
            log.write(result.stdout + "\nexit=" + str(result.returncode) + "\n")
        if result.returncode:
            raise RuntimeError("command failed: " + json.dumps(argv) + "\n" + result.stdout[-6000:])
        return result.stdout.strip()

    def source(self, directory: Path, expected: str | None, baseline: str) -> str:
        sha = self.command(["git", "-C", str(directory), "rev-parse", "HEAD"])
        if expected and sha != expected:
            raise AssertionError("unexpected source commit: " + sha)
        status = self.command(["git", "-C", str(directory), "status", "--porcelain"])
        if status and not self.args.allow_dirty_result:
            raise AssertionError("source must be clean: " + str(directory))
        if status and expected:
            raise AssertionError("upstream checkout must always be clean")
        self.command(["git", "-C", str(directory), "merge-base", "--is-ancestor", baseline, sha])
        self.metadata[directory.name] = {"sha": sha, "baseline": baseline, "dirty": bool(status)}
        return sha

    def container(self, name: str, image: str, options: list[str], command: list[str] | None = None) -> None:
        self.containers.append(name)
        self.command(["docker", "run", "-d", "--init", "--name", name,
                      "--label", "boardflow.card=" + CARD, "--network", self.network,
                      *options, image, *(command or [])])

    def wait_command(self, argv: list[str], expected: str, timeout: int = 30) -> None:
        deadline = time.monotonic() + timeout
        last_error: RuntimeError | None = None
        while time.monotonic() < deadline:
            try:
                if expected in self.command(argv):
                    return
            except RuntimeError as error:
                last_error = error
            time.sleep(0.25)
        raise TimeoutError("readiness timed out: " + str(last_error))

    def http(self, origin: str, pathname: str, payload: dict | None = None) -> tuple[int, dict]:
        # Run an actual HTTP client within the internal network; no published ports.
        program = """const [url, data] = process.argv.slice(1);
const payload = JSON.parse(data);
fetch(url, {method: payload === null ? 'GET' : 'POST',
  headers: {'Content-Type': 'application/json', Connection: 'close'},
  body: payload === null ? undefined : JSON.stringify(payload),
  signal: AbortSignal.timeout(6000)
}).then(async response => {
  process.stdout.write(JSON.stringify({status: response.status, response: await response.json(),
    content_type: response.headers.get('content-type')}));
}).catch(error => { process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });"""
        receipt = json.loads(self.command(["docker", "exec", self.prefix + "-result", "node", "-e",
                                          program, origin + pathname, json.dumps(payload)]))
        receipt.update(url=origin + pathname, method="POST" if payload is not None else "GET",
                       request=payload, at=time.time())
        self.receipts.append(receipt)
        with (self.evidence / "http.jsonl").open("a") as log:
            log.write(json.dumps(receipt, ensure_ascii=False) + "\n")
        return receipt["status"], receipt["response"]

    def wait_http(self, origin: str, pathname: str, expected: dict, timeout: int = 30) -> dict:
        deadline = time.monotonic() + timeout
        last: tuple | None = None
        while time.monotonic() < deadline:
            try:
                last = self.http(origin, pathname)
                if last == (200, expected):
                    return last[1]
            except RuntimeError as error:
                # Only bounded startup connection failures are retried and recorded.
                with (self.evidence / "http-startup.log").open("a") as log:
                    log.write(type(error).__name__ + ": " + str(error) + "\n")
            time.sleep(0.2)
        raise AssertionError("HTTP propagation timed out: " + repr(last))

    def database_rows(self, trace: str) -> list[dict]:
        # trace is the local SHA-256-derived ASCII id, never arbitrary input.
        if not trace.startswith("c-") or len(trace) != 34 or not all(c in "0123456789abcdef" for c in trace[2:]):
            raise AssertionError("unexpected owned trace")
        sql = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT id AS voter_id, vote, trace_id FROM votes WHERE trace_id = '" + trace + "' ORDER BY id COLLATE \"C\") t;"
        return json.loads(self.command(["docker", "exec", self.prefix + "-db", "psql", "-U", "postgres",
                                       "-d", "postgres", "-At", "-c", sql]))

    def run(self) -> None:
        vote_dir = Path(self.args.vote_dir).resolve()
        worker_dir = Path(self.args.worker_dir).resolve()
        self.source(vote_dir, VOTE_SHA, VOTE_BASE)
        self.source(worker_dir, WORKER_SHA, WORKER_BASE)
        result_sha = self.source(self.root, None, RESULT_BASE)
        self.metadata["upstream_prs"] = {
            "A": "https://github.com/boardflow-lab-lenshood/vote/pull/44",
            "B": "https://github.com/boardflow-lab-lenshood/worker/pull/4"}
        result_image = self.prefix + "-result:test"
        vote_image = self.prefix + "-vote:test"
        worker_image = self.prefix + "-worker:test"
        self.images.extend([result_image, vote_image, worker_image])
        self.command(["docker", "build", "-f", "tests/Dockerfile.trace", "-t", result_image, "."], cwd=self.root, timeout=120)
        self.command(["docker", "build", "-f", "-", "-t", vote_image, "."], cwd=vote_dir, timeout=120,
                     input_text="FROM boardflow-real-uat/vote:" + VOTE_BASE + "\nWORKDIR /usr/local/app\nCOPY . .\nCMD [\"gunicorn\", \"app:app\", \"-b\", \"0.0.0.0:80\", \"--workers\", \"1\", \"--access-logfile\", \"-\"]\n")
        self.command(["docker", "build", "-f", "tests/Dockerfile.offline", "-t", worker_image, "."], cwd=worker_dir, timeout=180)
        self.metadata["images"] = {"result": self.command(["docker", "image", "inspect", result_image, "--format", "{{.Id}}"]),
                                    "vote": self.command(["docker", "image", "inspect", vote_image, "--format", "{{.Id}}"]),
                                    "worker": self.command(["docker", "image", "inspect", worker_image, "--format", "{{.Id}}"])}
        self.command(["docker", "network", "create", "--internal", "--label", "boardflow.card=" + CARD, self.network])
        self.network_created = True
        database_url = "postgresql://postgres@db/postgres"
        # tmpfs avoids persistent volumes; only this owned internal fixture trusts peers.
        self.container(self.prefix + "-db", "postgres:15-alpine", ["--network-alias", "db",
            "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust"])
        self.wait_command(["docker", "exec", self.prefix + "-db", "pg_isready", "-U", "postgres"], "accepting connections")
        self.command(["docker", "run", "--rm", "--init", "--label", "boardflow.card=" + CARD,
                      "--network", self.network, "-e", "TEST_DATABASE_URL=" + database_url,
                      result_image, "npm", "test"], timeout=100)
        # Existing suites intentionally create a pre-migration table; B must migrate it.
        self.container(self.prefix + "-redis", "redis:7-alpine", ["--network-alias", "redis", "--tmpfs", "/data"])
        self.wait_command(["docker", "exec", self.prefix + "-redis", "redis-cli", "ping"], "PONG")
        self.container(self.prefix + "-worker", worker_image, ["-e",
            "DATABASE_CONNECTION_STRING=Host=db;Username=postgres;Database=postgres;Timeout=3"])
        self.container(self.prefix + "-vote", vote_image, ["--network-alias", "vote"])
        self.container(self.prefix + "-result", result_image, ["-e", "DATABASE_URL=" + database_url, "--network-alias", "result"])
        vote_origin = "http://vote:80"
        result_origin = "http://result:80"
        self.wait_http(vote_origin, "/healthz", {"status": "ok", "service": "vote"})
        self.wait_http(result_origin, "/healthz", {"status": "ok", "service": "result"})
        trace = self.metadata["trace_id"]
        trace_path = TRACE_PATH + trace
        self.wait_http(result_origin, trace_path, {"trace_id": trace, "total": 0, "counts": {"a": 0, "b": 0}, "voters": []})
        voters = ["c-" + trace[2:] + "-z", "c-" + trace[2:] + "-a"]
        self.metadata["voters"] = voters
        for voter, choice in zip(voters, ["a", "b"]):
            payload = {"voter_id": voter, "vote": choice, "trace_id": trace}
            assert self.http(vote_origin, "/api/arena/seven-20261103/votes", payload) == (202, {"accepted": True, **payload})
        initial_voters = sorted([{"voter_id": voters[0], "vote": "a"}, {"voter_id": voters[1], "vote": "b"}], key=lambda v: v["voter_id"])
        expected = {"trace_id": trace, "total": 2, "counts": {"a": 1, "b": 1}, "voters": initial_voters}
        self.wait_http(result_origin, trace_path, expected)
        initial_rows = self.database_rows(trace)
        assert initial_rows == [{**v, "trace_id": trace} for v in initial_voters]
        payload = {"voter_id": voters[0], "vote": "b", "trace_id": trace}
        assert self.http(vote_origin, "/api/arena/seven-20261103/votes", payload) == (202, {"accepted": True, **payload})
        final_voters = [{"voter_id": voter, "vote": "b"} for voter in sorted(voters)]
        expected = {"trace_id": trace, "total": 2, "counts": {"a": 0, "b": 2}, "voters": final_voters}
        self.wait_http(result_origin, trace_path, expected)
        final_rows = self.database_rows(trace)
        assert final_rows == [{**v, "trace_id": trace} for v in final_voters]
        assert len({v["voter_id"] for v in final_rows}) == 2
        (self.evidence / "database.json").write_text(json.dumps({"initial": initial_rows, "final": final_rows}, indent=2) + "\n")
        # Deliberate outage is limited to this run's owned database.
        self.command(["docker", "stop", "-t", "3", self.prefix + "-db"])
        assert self.http(result_origin, trace_path) == (503, {"error": "database_unavailable", "service": "result"})
        assert self.http(result_origin, "/healthz") == (503, {"status": "unavailable", "service": "result"})
        self.command(["docker", "start", self.prefix + "-db"])
        self.wait_command(["docker", "exec", self.prefix + "-db", "pg_isready", "-U", "postgres"], "accepting connections")
        # tmpfs is reset on restart; recreate the owned schema and test readiness recovery.
        self.wait_http(result_origin, "/healthz", {"status": "ok", "service": "result"})
        self.metadata.update(status="PASSED", result_sha=result_sha,
                             assertions=["full npm test with real PostgreSQL", "three real POST 202 receipts",
                                         "HTTP counts 1/1 then 0/2 with exactly two sorted voters",
                                         "matching current database rows before and after change",
                                         "real owned database outage: GET and healthz 503; healthz recovery"])

    def cleanup(self) -> None:
        errors: list[str] = []
        for name in reversed(self.containers):
            try:
                logs = self.command(["docker", "logs", name])
                (self.evidence / (name + ".log")).write_text(logs + "\n")
                self.command(["docker", "rm", "-f", "-v", name])
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                errors.append(str(error))
        if self.network_created:
            try:
                self.command(["docker", "network", "rm", self.network])
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                errors.append(str(error))
        for image in self.images:
            try:
                self.command(["docker", "image", "rm", image])
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                errors.append(str(error))
        self.metadata["cleanup_errors"] = errors
        if errors:
            self.metadata["status"] = "FAILED"
        (self.evidence / "summary.json").write_text(json.dumps(self.metadata, indent=2, ensure_ascii=False) + "\n")
        if errors:
            raise RuntimeError("owned resource cleanup failed: " + repr(errors))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vote-dir", required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--data-scope", required=True, help="owned development scope, or authorized candidate scope")
    parser.add_argument("--evidence-dir", required=True, help="new directory; refuses overwrite")
    parser.add_argument("--allow-dirty-result", action="store_true", help="local iteration only; final evidence must be clean")
    args = parser.parse_args()
    check = OwnedCheck(args)
    try:
        check.run()
    except Exception as error:
        # Global runner boundary: preserve failure status and let Python print the stack.
        check.metadata.update(status="FAILED", error=type(error).__name__ + ": " + str(error))
        raise
    finally:
        check.cleanup()
    print(json.dumps(check.metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
