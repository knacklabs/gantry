#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys

from factory_lib import read_hook_input


DESTRUCTIVE_PATTERNS = [
    (
        re.compile(
            r"(?<![\w/.-])(?:/[\w./-]+/)?rm\s+"
            r"(?=[^;&|]*(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|"
            r"--recursive\b[^;&|]*--force\b|--force\b[^;&|]*--recursive\b))",
            re.IGNORECASE,
        ),
        "recursive force deletion",
    ),
    (
        re.compile(r"(?<![\w/.-])(?:/[\w./-]+/)?git\b[^;&|]*\breset\s+--hard\b", re.IGNORECASE),
        "git hard reset",
    ),
    (
        re.compile(
            r"(?<![\w/.-])(?:/[\w./-]+/)?git\b[^;&|]*\bpush\b[^;&|]*(?:--force(?:-with-lease)?\b|(?:^|\s)-f(?:\s|$))",
            re.IGNORECASE,
        ),
        "git force push",
    ),
    (
        re.compile(r"(?<![\w/.-])(?:/[\w./-]+/)?terraform\s+(?:destroy\b|apply\b[^;&|]*\s-destroy\b)", re.IGNORECASE),
        "terraform destroy",
    ),
    (
        re.compile(r"(?<![\w/.-])(?:/[\w./-]+/)?kubectl\s+delete\b", re.IGNORECASE),
        "kubectl delete",
    ),
]


def deny(command: str, reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"Blocked destructive command policy ({reason}). "
                        "Ask the user for an explicit operator workflow before running this command."
                    ),
                }
            }
        )
    )


def main() -> int:
    payload = read_hook_input()
    command = str(((payload.get("tool_input") or {}).get("command") or "")).strip()
    if not command:
        return 0

    for pattern, reason in DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            deny(command, reason)
            return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
