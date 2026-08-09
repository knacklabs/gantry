#!/usr/bin/env python3
"""Fail when a completed roadmap story is missing durable ship evidence."""
from __future__ import annotations

import sys
from pathlib import Path

from factory_lib import repo_root
from forge_cli.events import load_events
from forge_cli.roadmap import load_items


def board_problems(root: Path) -> list[str]:
    linked_stories = {
        event.get("story")
        for event in load_events(root, event="pr-linked")
        if isinstance(event.get("story"), str)
    }
    problems: list[str] = []

    for item in load_items(root):
        if item.get("status") != "done":
            continue
        key = item.get("key", "?")
        predates_contract = item.get("predates_outcome_contract") is True

        if not predates_contract and key not in linked_stories:
            problems.append(f"{key}: missing pr-linked event")
        if not predates_contract and not item.get("outcome"):
            problems.append(f"{key}: missing outcome")
        if not (root / ".factory" / "history" / str(key)).is_dir():
            problems.append(f"{key}: missing .factory/history/{key}/ directory")

    return problems


def main() -> int:
    root = repo_root()
    problems = board_problems(root)
    if problems:
        print("Board completeness check FAILED:")
        for problem in problems:
            print(f"- {problem}")
        return 1
    print("Board completeness check OK: every done story has durable ship evidence.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
