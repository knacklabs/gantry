import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "production_benchmark_gates.py"


def startup_event(sandbox_ms: int, visible_ms: int, code: int | None = 0) -> dict:
    return {
        "eventType": "run.startup_diagnostic",
        "payload": {
            "diagnostic": "runner_process_timing",
            "exit": {
                "code": code,
                "signal": None,
                "timedOut": False,
                "hadStreamingOutput": True,
            },
            "startupTiming": {
                "sandboxStartCallMs": sandbox_ms,
                "firstVisibleOutputMs": visible_ms,
            },
        },
    }


def startup_failure_without_timing() -> dict:
    return {
        "eventType": "run.startup_diagnostic",
        "payload": {
            "diagnostic": "runner_process_timing",
            "exit": {
                "code": 1,
                "signal": None,
                "timedOut": False,
                "hadStreamingOutput": False,
            },
        },
    }


def summary(**patch: object) -> dict:
    value = {
        "kind": "production_benchmark_summary",
        "worker": {"cpu": 8, "memoryGb": 8},
        "queue": {"maxMessageRuns": 6, "maxJobRuns": 2},
        "sandbox": {"memoryMb": 512, "maxProcesses": 64, "startupFailures": 0},
        "mixedLoad": {
            "chatRuns": 20,
            "jobRuns": 8,
            "delegatedAgentRuns": 4,
            "asyncBashRuns": 6,
            "duplicateActiveTurns": 0,
            "orphanChildProcesses": 0,
            "terminalTaskFailures": 0,
            "nonTerminalTasks": 0,
            "liveChatStarved": False,
        },
        "lockedPublicDenialFlood": {
            "denialCount": 500,
            "unboundedBacklog": False,
            "baselineLiveChatP95Ms": 900,
            "floodLiveChatP95Ms": 970,
        },
    }
    value.update(patch)
    return value


def run_gate(records: list[dict]) -> subprocess.CompletedProcess[str]:
    with tempfile.NamedTemporaryFile("w", delete=False) as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
        path = handle.name
    try:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--input", path, "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        Path(path).unlink(missing_ok=True)


class ProductionBenchmarkGateTests(unittest.TestCase):
    def test_passes_when_runtime_evidence_meets_scale_up_gates(self) -> None:
        result = run_gate(
            [
                startup_event(500, 2_000),
                startup_event(900, 3_000),
                startup_event(1_200, 7_000),
                summary(),
            ]
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["passed"])
        self.assertTrue(
            all(check["passed"] for check in report["checks"]),
            report["checks"],
        )

    def test_fails_when_locked_public_denial_moves_live_chat_p95_too_much(self) -> None:
        result = run_gate(
            [
                startup_event(500, 2_000),
                summary(
                    lockedPublicDenialFlood={
                        "denialCount": 500,
                        "unboundedBacklog": False,
                        "baselineLiveChatP95Ms": 1_000,
                        "floodLiveChatP95Ms": 1_200,
                    }
                ),
            ]
        )

        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        failures = {
            check["name"]
            for check in report["checks"]
            if check["passed"] is False
        }
        self.assertIn("locked_public_denial_live_p95_regression", failures)

    def test_fails_without_mixed_load_coverage(self) -> None:
        bad_mixed = {
            "chatRuns": 10,
            "jobRuns": 0,
            "delegatedAgentRuns": 1,
            "asyncBashRuns": 1,
            "duplicateActiveTurns": 0,
            "orphanChildProcesses": 0,
            "terminalTaskFailures": 0,
            "nonTerminalTasks": 0,
            "liveChatStarved": False,
        }
        result = run_gate([startup_event(500, 2_000), summary(mixedLoad=bad_mixed)])

        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        failures = {
            check["name"]
            for check in report["checks"]
            if check["passed"] is False
        }
        self.assertIn("mixed_load_coverage", failures)

    def test_counts_startup_failures_without_timing(self) -> None:
        result = run_gate([startup_failure_without_timing(), summary()])

        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        failures = {
            check["name"]
            for check in report["checks"]
            if check["passed"] is False
        }
        self.assertIn("sandbox_startup_failures_zero", failures)


if __name__ == "__main__":
    unittest.main()
