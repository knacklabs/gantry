"""Shared CLI helpers.

Successful commands print one line: the state change and its identifiers.
Coaching belongs in ``forge next``; failure messages stay complete.
"""
from __future__ import annotations

import subprocess
import sys


def fail(msg: str) -> None:
    print(f"ERROR: {msg}")
    sys.exit(1)


def run_quiet(cmd: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15,
            encoding="utf-8", errors="replace",
        )
        return proc.returncode, (proc.stdout + proc.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
