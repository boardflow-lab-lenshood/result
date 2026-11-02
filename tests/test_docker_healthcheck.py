"""Real Docker health/recovery test; requires Docker and Python's standard library.

Run: python3 tests/test_docker_healthcheck.py --evidence-dir /absolute/evidence/path
Use --build-network host if Docker's default build network cannot reach npm.
Only uniquely named, ownership-labelled fixtures created by this run are stopped.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
LABEL = "io.boardflow.result-health-test"
HTTP_REQUEST = """
const http = require('http');
const req = http.get({host: '127.0.0.1', port: process.env.PORT,
  path: process.argv[1]}, res => {
  let body = '';
  res.on('data', chunk => { body += chunk; });
  res.on('end', () => {
    process.stdout.write(JSON.stringify({status: res.statusCode, body}));
    process.exit(0);
  });
});
req.on('error', err => { process.stderr.write(err.stack); process.exit(1); });
setTimeout(() => { req.destroy(); process.exit(1); }, 5000);
"""
SNAPSHOT = """{{json .Id}}
{{json .Image}}
{{json .State}}
{{json .RestartCount}}
{{json .Config.Labels}}
"""


class DockerHealthcheckTest(unittest.TestCase):
    evidence_dir: Path
    build_network: str = "default"

    def command(self, *args: str, timeout: int = 30, **kwargs) -> str:
        started = time.time()
        record = {"command": list(args), "started": started}
        try:
            result = subprocess.run(
                args, cwd=ROOT, text=True, capture_output=True, timeout=timeout,
                **kwargs,
            )
        except subprocess.TimeoutExpired as error:
            record.update(exit_code=None, timed_out=True,
                          stdout=(error.stdout or b"").decode(),
                          stderr=(error.stderr or b"").decode())
            raise
        else:
            record.update(exit_code=result.returncode,
                          stdout=result.stdout, stderr=result.stderr)
        finally:
            record["duration_seconds"] = time.time() - started
            with (self.evidence_dir / "commands.jsonl").open("a") as stream:
                stream.write(json.dumps(record) + "\n")
        self.assertEqual(result.returncode, 0, json.dumps(record, indent=2))
        return result.stdout.strip()

    def assert_owned(self, kind: str, name: str) -> None:
        owner = self.command("docker", kind, "inspect", "--format",
                             '{{index .Config.Labels "' + LABEL + '"}}'
                             if kind in ("container", "image") else
                             '{{index .Labels "' + LABEL + '"}}', name)
        self.assertEqual(owner, self.owner)

    def cleanup_container(self, name: str) -> None:
        self.assert_owned("container", name)
        self.command("docker", "logs", name)
        self.command("docker", "rm", "-fv", name)

    def cleanup_network(self) -> None:
        self.assert_owned("network", self.network)
        self.command("docker", "network", "rm", self.network)

    def cleanup_image(self) -> None:
        self.assert_owned("image", self.image)
        self.command("docker", "image", "rm", self.image)

    def snapshot(self, stage: str) -> dict:
        raw = self.command("docker", "inspect", "--format", SNAPSHOT, self.result)
        container_id, image_id, state, restart_count, labels = map(
            json.loads, raw.splitlines())
        process = self.command("docker", "exec", self.result, "node", "-e",
                               'process.stdout.write(require("fs").readFileSync("/proc/1/stat", "utf8"))')
        snapshot = {"container_id": container_id, "image_id": image_id,
                    "state": state, "restart_count": restart_count,
                    "labels": labels, "pid1_stat": process}
        (self.evidence_dir / (stage + ".json")).write_text(
            json.dumps(snapshot, indent=2) + "\n")
        return snapshot

    def wait_health(self, expected: str, timeout: int = 90) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = self.command("docker", "inspect", "--format",
                               "{{json .State}}", self.result)
            state = json.loads(raw)
            self.assertTrue(state["Running"], raw)
            if state.get("Health", {}).get("Status") == expected:
                health = state["Health"]
                self.assertEqual(health["Log"][-1]["ExitCode"],
                                 0 if expected == "healthy" else 1)
                if expected == "unhealthy":
                    self.assertGreaterEqual(health["FailingStreak"], 3)
                return
            time.sleep(1)
        self.fail("Docker health did not become " + expected)

    def request(self, path: str) -> dict:
        return json.loads(self.command("docker", "exec", self.result,
                                      "node", "-e", HTTP_REQUEST, path))

    def assert_json_response(self, path: str, status: int, body: dict) -> None:
        response = self.request(path)
        self.assertEqual(response["status"], status, response)
        self.assertEqual(json.loads(response["body"]), body)

    def assert_serving(self) -> None:
        self.assert_json_response("/healthz", 200, {"status": "ok", "service": "result"})
        self.assert_json_response("/api/results", 200, {"a": 2, "b": 1})
        summary = {"counts": {"a": 2, "b": 1}, "total": 3, "leader": "a"}
        for path in ("/api/uat/result-summary", "/api/arena/20261102/summary",
                     "/api/arena/three-20261102/summary"):
            self.assert_json_response(path, 200, summary)
        homepage = self.request("/")
        self.assertEqual(homepage["status"], 200)
        self.assertIn("<html", homepage["body"].lower())

    def assert_continuity(self, initial: dict, current: dict) -> None:
        for key in ("container_id", "image_id", "restart_count"):
            self.assertEqual(current[key], initial[key], key)
        for key in ("Pid", "StartedAt"):
            self.assertEqual(current["state"][key], initial["state"][key], key)
        self.assertEqual(current["restart_count"], 0)
        # /proc/1/stat field 22 is process start time; remove the (comm) first.
        self.assertEqual(current["pid1_stat"].rsplit(")", 1)[1].split()[19],
                         initial["pid1_stat"].rsplit(")", 1)[1].split()[19])
        self.assertTrue(current["state"]["Running"])

    def test_health_recovers_when_owned_database_restarts(self) -> None:
        self.evidence_dir.mkdir(parents=True, exist_ok=False)
        self.owner = "result-health-" + uuid.uuid4().hex[:12]
        self.network = self.owner
        self.database = self.owner + "-db"
        self.result = self.owner + "-app"
        self.image = self.owner + ":test"
        label = LABEL + "=" + self.owner
        self.command("docker", "version", "--format", "{{json .}}")
        self.command("git", "rev-parse", "HEAD")
        self.command("git", "diff", "--", "Dockerfile", "tests/test_docker_healthcheck.py")
        self.command("docker", "build", "--no-cache", "--network", self.build_network,
                     "--label", label, "-t", self.image, ".", timeout=300)
        self.addCleanup(self.cleanup_image)
        image = json.loads(self.command("docker", "image", "inspect", "--format",
                                        "{{json .Config}}", self.image))
        self.assertEqual(image["Cmd"], ["node", "server.js"])
        self.assertEqual(image["Healthcheck"]["Interval"], 5_000_000_000)
        self.assertEqual(image["Healthcheck"]["Timeout"], 3_000_000_000)
        self.assertEqual(image["Healthcheck"]["Retries"], 3)
        self.assertEqual(image["Healthcheck"]["StartPeriod"], 15_000_000_000)
        self.command("docker", "network", "create", "--internal", "--label", label,
                     self.network)
        self.addCleanup(self.cleanup_network)
        env = dict(os.environ)
        env["POSTGRES_PASSWORD"] = secrets.token_urlsafe(24)
        env["DATABASE_URL"] = ("postgres://postgres:" + env["POSTGRES_PASSWORD"]
                               + "@" + self.database + ":5432/postgres")
        self.command("docker", "run", "-d", "--name", self.database,
                     "--label", label, "--network", self.network,
                     "-e", "POSTGRES_PASSWORD", "postgres:15-alpine",
                     env=env, timeout=120)
        self.addCleanup(self.cleanup_container, self.database)
        self.command("docker", "exec", self.database, "sh", "-c",
                     "for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -U postgres && exit 0; sleep 1; done; exit 1",
                     timeout=70)
        self.command("docker", "exec", "-i", self.database, "psql", "-U", "postgres",
                     "-v", "ON_ERROR_STOP=1", input=(
                         "CREATE TABLE votes (id varchar(255) PRIMARY KEY, vote varchar(255) NOT NULL);\n"
                         "INSERT INTO votes VALUES ('one','a'), ('two','a'), ('three','b');\n"))
        # A non-default port verifies that the probe follows the running service.
        self.command("docker", "run", "-d", "--name", self.result, "--label", label,
                     "--network", self.network, "-e", "DATABASE_URL", "-e", "PORT=8080",
                     self.image, env=env)
        self.addCleanup(self.cleanup_container, self.result)
        self.wait_health("healthy")
        initial = self.snapshot("01-healthy")
        self.assert_serving()

        self.assert_owned("container", self.database)
        self.command("docker", "stop", "--time", "10", self.database)
        self.wait_health("unhealthy")
        failed = self.snapshot("02-unhealthy")
        self.assert_continuity(initial, failed)
        self.assert_json_response("/healthz", 503, {"status": "unavailable", "service": "result"})
        self.assert_json_response("/api/results", 503,
                                  {"error": "database_unavailable", "service": "result"})
        self.assertEqual(self.request("/")["status"], 200)

        self.assert_owned("container", self.database)
        self.command("docker", "start", self.database)
        self.wait_health("healthy")
        recovered = self.snapshot("03-recovered")
        self.assert_continuity(initial, recovered)
        self.assert_serving()
        env["TEST_DATABASE_URL"] = env["DATABASE_URL"]
        self.command("docker", "exec", "-e", "TEST_DATABASE_URL", self.result,
                     "npm", "test", env=env, timeout=120)
        self.command("docker", "logs", self.result)
        (self.evidence_dir / "assertions.json").write_text(json.dumps({
            "result": "PASSED", "owner": self.owner, "health_states": ["healthy", "unhealthy", "healthy"],
            "container_id": initial["container_id"], "image_id": initial["image_id"],
            "same_pid_and_started_at": True, "restart_count": 0,
            "http": "healthz 200/503/200; results 200/503/200; homepage and summaries preserved",
        }, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    parser.add_argument("--build-network", default="default")
    options, remaining = parser.parse_known_args()
    DockerHealthcheckTest.evidence_dir = options.evidence_dir.resolve()
    DockerHealthcheckTest.build_network = options.build_network
    unittest.main(argv=[__file__, *remaining])
