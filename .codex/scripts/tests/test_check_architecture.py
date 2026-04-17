from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
CHECK_SCRIPT = SCRIPTS_DIR / "check_architecture.py"
VERIFY_SCRIPT = SCRIPTS_DIR / "verify.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def write_json(path: Path, payload: object) -> None:
    write_text(path, json.dumps(payload, indent=2) + "\n")


def write_lines(path: Path, count: int) -> None:
    body = "\n".join(f"const line_{index} = {index};" for index in range(count))
    write_text(path, body + "\n")


def make_base_fixture(root: Path) -> Path:
    write_text(root / "README.md", "# Fixture\n")
    write_lines(root / "apps/core/src/core/ok.ts", 10)
    write_json(
        root / ".codex/architecture-exceptions.json",
        {"version": 1, "exceptions": []},
    )
    return root


def run_architecture_check(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(CHECK_SCRIPT),
            "--root",
            str(root),
            "--exceptions",
            ".codex/architecture-exceptions.json",
        ],
        capture_output=True,
        text=True,
    )


class CheckArchitectureTests(unittest.TestCase):
    def test_clean_fixture_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertIn("Architecture checks passed.", result.stdout)

    def test_over_budget_file_fails_without_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/core/oversized.ts", 401)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[File Size Budget]", result.stdout)
            self.assertIn("apps/core/src/core/oversized.ts has 401 lines", result.stdout)

    def test_valid_and_expired_exception_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/core/oversized.ts", 401)
            write_json(
                root / ".codex/architecture-exceptions.json",
                {
                    "version": 1,
                    "exceptions": [
                        {
                            "rule": "file_size_budget",
                            "target": "apps/core/src/core/oversized.ts",
                            "owner": "TEST-1",
                            "reason": "Fixture baseline",
                            "expires_on": "2099-12-31",
                            "max_lines": 401,
                        }
                    ],
                },
            )
            passing = run_architecture_check(root)
            self.assertEqual(passing.returncode, 0, msg=passing.stdout + passing.stderr)

            write_json(
                root / ".codex/architecture-exceptions.json",
                {
                    "version": 1,
                    "exceptions": [
                        {
                            "rule": "file_size_budget",
                            "target": "apps/core/src/core/oversized.ts",
                            "owner": "TEST-1",
                            "reason": "Fixture baseline",
                            "expires_on": "2000-01-01",
                            "max_lines": 401,
                        }
                    ],
                },
            )
            expired = run_architecture_check(root)
            self.assertEqual(expired.returncode, 1)
            self.assertIn("[Exception Hygiene]", expired.stdout)
            self.assertIn("expired on 2000-01-01", expired.stdout)

    def test_excepted_file_growth_beyond_max_lines_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/core/oversized.ts", 402)
            write_json(
                root / ".codex/architecture-exceptions.json",
                {
                    "version": 1,
                    "exceptions": [
                        {
                            "rule": "file_size_budget",
                            "target": "apps/core/src/core/oversized.ts",
                            "owner": "TEST-1",
                            "reason": "Fixture baseline",
                            "expires_on": "2099-12-31",
                            "max_lines": 401,
                        }
                    ],
                },
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("max_lines is 401", result.stdout)

    def test_forbidden_import_edge_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/runtime/worker.ts", 5)
            write_text(
                root / "apps/core/src/core/boundary-break.ts",
                'import { run } from "../runtime/worker";\nexport const value = run;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Forbidden Import Edges]", result.stdout)
            self.assertIn("apps/core/src/core/boundary-break.ts imports apps/core/src/runtime/worker.ts", result.stdout)

    def test_forbidden_channel_registration_surface_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/channels/slack.ts",
                "registerChannel('slack', () => null);\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Channel Registration Surface]", result.stdout)
            self.assertIn("legacy channel self-registration API", result.stdout)

    def test_forbidden_ipc_contract_surface_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/ipc.ts",
                'import { MEMORY_IPC_ACTIONS } from "../memory/memory-ipc-contract";\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[IPC Contract Surface]", result.stdout)
            self.assertIn("removed IPC contract import path", result.stdout)

    def test_forbidden_ipc_orchestrator_monolith_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/ipc.ts",
                "export async function processTaskIpc() {\n"
                "  switch (data.type) {\n"
                "    case 'scheduler_once':\n"
                "      return;\n"
                "  }\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[IPC Orchestrator]", result.stdout)
            self.assertIn("in-orchestrator task domain handler", result.stdout)

    def test_stale_doc_reference_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(root / "README.md", "[Missing](docs/not-real.md)\n")
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Active Doc References]", result.stdout)
            self.assertIn("README.md -> docs/not-real.md", result.stdout)

    def test_malformed_exception_missing_owner_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/core/oversized.ts", 401)
            write_json(
                root / ".codex/architecture-exceptions.json",
                {
                    "version": 1,
                    "exceptions": [
                        {
                            "rule": "file_size_budget",
                            "target": "apps/core/src/core/oversized.ts",
                            "reason": "Fixture baseline",
                            "expires_on": "2099-12-31",
                            "max_lines": 401,
                        }
                    ],
                },
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Exception Hygiene]", result.stdout)
            self.assertIn("missing required fields: owner", result.stdout)


class VerifyContractTests(unittest.TestCase):
    def test_verify_print_only_includes_architecture_and_runtime_truth_phases(
        self,
    ) -> None:
        result = subprocess.run(
            [sys.executable, str(VERIFY_SCRIPT), "--print-only"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        phases = [line.split(":", 1)[0] for line in result.stdout.splitlines() if ":" in line]
        self.assertIn("architecture", phases)
        self.assertIn("runtime-truth", phases)
        self.assertLess(phases.index("structural"), phases.index("architecture"))
        self.assertLess(phases.index("architecture"), phases.index("runtime-truth"))
        self.assertLess(phases.index("runtime-truth"), phases.index("factory-python-tests"))
        self.assertLess(phases.index("factory-python-tests"), phases.index("typecheck"))


if __name__ == "__main__":
    unittest.main()
