#!/usr/bin/env python3
"""Require a PR that ships a task to carry that task's recorded proof.

The per-task flow already produces proof — deterministic verify, the recorded
automated tests, and one three-lens review (0049) — but nothing outside the
`stage done` / `pr-ready` commands checked it. A task merged through a direct or
story-level PR therefore shipped green with no verify, no tests and no reviews
recorded, and nothing noticed until someone looked at the board (observed in
R1-FOUND-2A, 2026-09-03). Gates that live only inside the happy path are
advisory; this one is on the PR, so skipping the flow cannot merge.

A marker written by `forge task reconcile` is exempt: it ADOPTS work that is
already on the trunk (the command refuses otherwise), so demanding proof for it
would only block repairing history — and it cannot be used to skip proof for new
work, because new work is by definition not yet on the trunk.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from factory_lib import (
    _read_git_json,
    task_proof_problems,
)

# Reuse the sibling gate's lossless path reader rather than adding a second
# surrogateescape site: a changed path may legitimately not be UTF-8, and that
# capture is already reviewed and content-pinned in check_encoding_hygiene.
from check_pr_ticket import git_paths

TASK_MARKER_PATH = re.compile(
    r"^\.factory/stories/([^/]+)/tasks/([^/]+)/pr-ready\.json$"
)
def read_at_head(root: Path, path: str) -> dict | None:
    """The committed artifact, or None when the PR does not carry it."""
    return _read_git_json(root, path, "HEAD")


def added_markers(root: Path, base: str) -> list[tuple[str, str, dict]]:
    markers = []
    for line in git_paths(root, "diff", "--name-status", f"{base}..HEAD").splitlines():
        fields = line.split("\t")
        if len(fields) < 2 or fields[0] != "A":
            continue
        match = TASK_MARKER_PATH.fullmatch(fields[-1])
        if not match:
            continue
        marker = read_at_head(root, fields[-1])
        if marker is None:
            continue
        markers.append((match.group(1), match.group(2), marker))
    return markers


def proof_problems(root: Path, key: str, task_id: str) -> list[str]:
    """Run the same task-aware predicate used by local and board gates.

    The reader is pinned to HEAD so CI cannot accidentally inspect a working
    tree artifact. The decomposition supplies the task's user-facing flag;
    selected task proof is required, with only the explicit marker-bound
    origin=upgrade exception for migrated fixed proof.
    """
    def reader(path: str) -> dict | None:
        return read_at_head(root, path)

    marker_path = f".factory/stories/{key}/tasks/{task_id}/pr-ready.json"
    marker = reader(marker_path)
    return task_proof_problems(
        root, key, {"id": task_id}, reader=reader, marker=marker,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base commit for base..HEAD")
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()
    root = Path(args.repo).resolve()

    markers = added_markers(root, args.base)
    if not markers:
        print("Task-proof check OK: this PR ships no task marker.")
        return 0

    failures: list[str] = []
    adopted: list[str] = []
    checked: list[str] = []
    for key, task_id, marker in markers:
        if marker.get("reconciled") is True:
            adopted.append(f"{key}/{task_id}")
            continue
        problems = proof_problems(root, key, task_id)
        checked.append(f"{key}/{task_id}")
        for problem in problems:
            failures.append(f"{key}/{task_id}: {problem}")

    for name in adopted:
        print(f"Task-proof check: {name} is an adopted reconcile marker "
              "(work already on the trunk) — proof not required.")
    if failures:
        print("Task-proof check FAILED: a PR that ships a task must carry that "
              "task's recorded proof (0049).", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    if checked:
        print("Task-proof check OK: verify, automated tests and all three review "
              f"lenses are recorded and clean for {', '.join(checked)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
