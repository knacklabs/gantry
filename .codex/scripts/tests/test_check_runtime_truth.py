from __future__ import annotations

import subprocess
import sys
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / ".codex" / "scripts" / "check_runtime_truth.py"


class RuntimeTruthScriptTests(unittest.TestCase):
    def test_runtime_truth_script_passes_for_repo(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Runtime truth checks passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
