from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
VERIFY_SCRIPT = REPO_ROOT / ".codex" / "scripts" / "verify.py"

PHASES = [
    "structural",
    "build",
    "architecture",
    "runtime-truth",
    "factory-python-tests",
    "typecheck",
    "tests",
    "e2e",
]


def py_cmd(code: str) -> str:
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def make_repo(root: Path) -> None:
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True, text=True)
    factory = root / ".factory"
    factory.mkdir()
    (factory / "run.json").write_text(
        json.dumps(
            {
                "issue_key": "TEST-1",
                "phase": "testing",
                "verify_status": "pending",
            },
        )
        + "\n",
    )


def default_env() -> dict[str, str]:
    success = py_cmd("print('ok')")
    env = os.environ.copy()
    env.update(
        {
            "FACTORY_STRUCTURAL_CMD": success,
            "FACTORY_ARCHITECTURE_CMD": success,
            "FACTORY_RUNTIME_TRUTH_CMD": success,
            "FACTORY_PYTHON_TEST_CMD": success,
            "FACTORY_BUILD_CMD": success,
            "FACTORY_TYPECHECK_CMD": success,
            "FACTORY_TEST_CMD": success,
            "FACTORY_E2E_CMD": success,
        },
    )
    return env


def run_verify(root: Path, *, env: dict[str, str], args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT), *(args or [])],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )


class VerifyRunnerTests(unittest.TestCase):
    def test_verify_records_progress_and_phase_timings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)

            result = run_verify(root, env=default_env())

            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertNotIn("parallel group start", result.stdout)
            self.assertIn("[verify] structural start:", result.stdout)
            self.assertIn("[verify] e2e ok", result.stdout)
            self.assertIn("Verification passed", result.stdout)

            verify = json.loads((root / ".factory" / "verify.json").read_text())
            self.assertTrue(verify["ok"])
            self.assertEqual([item["phase"] for item in verify["results"]], PHASES)
            for item in verify["results"]:
                self.assertIsInstance(item["duration_seconds"], float)
                self.assertGreaterEqual(item["duration_seconds"], 0)
                self.assertIn("started_at", item)
                self.assertIn("completed_at", item)

            run_state = json.loads((root / ".factory" / "run.json").read_text())
            self.assertEqual(run_state["verify_status"], "passed")

    def test_default_mode_stops_at_first_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            marker = root / "factory-tests-ran"
            env = default_env()
            env["FACTORY_RUNTIME_TRUTH_CMD"] = py_cmd(
                "import sys; print('bad stdout'); print('bad stderr', file=sys.stderr); sys.exit(7)",
            )
            env["FACTORY_PYTHON_TEST_CMD"] = py_cmd(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("[verify] runtime-truth failed", result.stdout)
            self.assertIn("bad stdout", result.stdout)
            self.assertIn("bad stderr", result.stdout)
            self.assertIn("Verification failed at runtime-truth", result.stdout)
            self.assertFalse(marker.exists())

            verify = json.loads((root / ".factory" / "verify.json").read_text())
            self.assertFalse(verify["ok"])
            phases = [item["phase"] for item in verify["results"]]
            self.assertEqual(phases, PHASES[:4])
            self.assertNotIn("factory-python-tests", phases)

    def test_failure_tail_redacts_common_secret_assignments(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            env = default_env()
            env["FACTORY_RUNTIME_TRUTH_CMD"] = py_cmd(
                "import sys; print('OPENAI_API_KEY=sk-test-secret'); sys.exit(7)",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("OPENAI_API_KEY=[REDACTED]", result.stdout)
            self.assertNotIn("sk-test-secret", result.stdout)

    def test_parallel_safe_mode_preserves_order_and_stops_after_group(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            env = default_env()
            env["FACTORY_ARCHITECTURE_CMD"] = py_cmd(
                "import sys, time; time.sleep(0.02); print('bad stdout'); "
                "print('bad stderr', file=sys.stderr); sys.exit(7)",
            )
            env["FACTORY_RUNTIME_TRUTH_CMD"] = py_cmd("print('runtime ok')")
            env["FACTORY_PYTHON_TEST_CMD"] = py_cmd("print('factory ok')")

            result = run_verify(root, env=env, args=["--parallel-safe"])

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("[verify] read-only parallel group start", result.stdout)
            self.assertIn("Verification failed at architecture", result.stdout)
            verify = json.loads((root / ".factory" / "verify.json").read_text())
            self.assertFalse(verify["ok"])
            self.assertEqual(
                [item["phase"] for item in verify["results"]],
                PHASES[:5],
            )
            self.assertNotIn("typecheck", [item["phase"] for item in verify["results"]])

    def test_default_preflight_preserves_strict_fail_fast(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            marker = root / "architecture-ran"
            env = default_env()
            env["FACTORY_STRUCTURAL_CMD"] = py_cmd("import sys; sys.exit(3)")
            env["FACTORY_ARCHITECTURE_CMD"] = py_cmd(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertFalse(marker.exists())
            verify = json.loads((root / ".factory" / "verify.json").read_text())
            self.assertEqual([item["phase"] for item in verify["results"]], ["structural"])

    def test_timed_out_phase_records_timeout_and_stops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            marker = root / "build-ran"
            env = default_env()
            env["FACTORY_VERIFY_TIMEOUT_SECONDS"] = "0.1"
            env["FACTORY_STRUCTURAL_CMD"] = py_cmd("import time; time.sleep(60)")
            env["FACTORY_BUILD_CMD"] = py_cmd(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("Verification phase timed out", result.stdout)
            self.assertFalse(marker.exists())
            verify = json.loads((root / ".factory" / "verify.json").read_text())
            self.assertFalse(verify["ok"])
            self.assertEqual(verify["results"][0]["phase"], "structural")
            self.assertEqual(verify["results"][0]["exit_code"], 124)
            self.assertTrue(verify["results"][0]["timed_out"])

    def test_failure_tail_redacts_authorization_bearer_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            env = default_env()
            env["FACTORY_STRUCTURAL_CMD"] = py_cmd(
                "import sys; print('Authorization: Bearer sk-live-token'); sys.exit(2)",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("Authorization: Bearer [REDACTED]", result.stdout)
            self.assertNotIn("sk-live-token", result.stdout)

    def test_failure_tail_redacts_json_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            env = default_env()
            env["FACTORY_STRUCTURAL_CMD"] = py_cmd(
                "import sys; print('{\"OPENAI_API_KEY\":\"sk-live-json\",\"token\":\"tok-live-json\"}'); sys.exit(2)",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn('"OPENAI_API_KEY":"[REDACTED]"', result.stdout)
            self.assertIn('"token":"[REDACTED]"', result.stdout)
            self.assertNotIn("sk-live-json", result.stdout)
            self.assertNotIn("tok-live-json", result.stdout)

    def test_failure_tail_redacts_non_bearer_authorization_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            env = default_env()
            env["FACTORY_STRUCTURAL_CMD"] = py_cmd(
                "import sys; print('Authorization: Basic dXNlcjpwYXNz'); sys.exit(2)",
            )

            result = run_verify(root, env=env)

            self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
            self.assertIn("Authorization: [REDACTED]", result.stdout)
            self.assertNotIn("dXNlcjpwYXNz", result.stdout)


if __name__ == "__main__":
    unittest.main()
