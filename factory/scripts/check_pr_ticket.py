#!/usr/bin/env python3
"""Require a pull request to complete exactly one roadmap story or work window."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from factory_lib import repo_root

ROADMAP = "plans/roadmap.json"
TICKET_LINE = re.compile(
    r"^\s*Ticket:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*$",
    re.MULTILINE,
)


def git(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def roadmap_at(root: Path, ref: str) -> dict[str, dict]:
    try:
        data = json.loads(git(root, "show", f"{ref}:{ROADMAP}"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{ROADMAP} at {ref} is not valid JSON: {exc}") from exc
    return {
        item["key"]: item
        for item in data.get("items", [])
        if isinstance(item, dict) and isinstance(item.get("key"), str)
    }


def added_paths(root: Path, base: str) -> set[str]:
    added: set[str] = set()
    for line in git(root, "diff", "--name-status", f"{base}..HEAD").splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        status = fields[0]
        path = fields[-1]
        if status == "A":
            added.add(path)
    return added


def branch_ticket(branch: str, story_keys: set[str]) -> str | None:
    matches = [
        key for key in story_keys
        if branch.startswith(f"feat/{key}-")
    ]
    return max(matches, key=len) if matches else None


def completed_windows(root: Path, added: set[str]) -> set[str]:
    completed: set[str] = set()
    for path in sorted(added):
        if not path.startswith("plans/quickfixes/") or not path.endswith(".json"):
            continue
        try:
            record = json.loads(git(root, "show", f"HEAD:{path}"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path} at HEAD is not valid JSON: {exc}") from exc
        if record.get("event") == "done" and isinstance(record.get("id"), str):
            completed.add(record["id"])
    return completed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base commit for base..HEAD")
    parser.add_argument("--head-branch", required=True)
    parser.add_argument("--pr-body", default="")
    parser.add_argument("--repo")
    args = parser.parse_args()

    root = Path(args.repo).resolve() if args.repo else repo_root()
    base_items = roadmap_at(root, args.base)
    head_items = roadmap_at(root, "HEAD")
    added = added_paths(root, args.base)

    candidates = set(TICKET_LINE.findall(args.pr_body))
    if inferred := branch_ticket(args.head_branch, set(head_items)):
        candidates.add(inferred)

    completed_stories = {
        key for key, head_item in head_items.items()
        if (key not in base_items or base_items[key].get("status") != "done")
        and head_item.get("status") == "done"
        and any(path.startswith(f".factory/history/{key}/") for path in added)
    }
    completed_window_ids = completed_windows(root, added)

    # A PR must declare EVERY work record it completes — not exactly one. A
    # single review-driven effort legitimately spans more than one window (do
    # the work, close it, review, reopen a window to apply the fixes), and every
    # such window must be accounted for, not just one with the rest left
    # undeclared. Declaring all of them keeps the PR fully traceable.
    completed = (
        {("story", key) for key in completed_stories}
        | {("window", wid) for wid in completed_window_ids}
    )
    undeclared = {(kind, key) for kind, key in completed if key not in candidates}

    if not completed:
        print(
            "PR ticket check FAILED: no completed work record in "
            f"{args.base}..HEAD — a PR must complete a roadmap story (done-flip "
            "with added history) or a work window (added done record)."
        )
        return 1
    if undeclared:
        missing = ", ".join(f"{kind}:{key}" for kind, key in sorted(undeclared))
        if not candidates:
            print(
                "PR ticket check FAILED: no ticket was found in the branch or PR "
                f"body. Declare every completed work record: {missing}."
            )
        else:
            print(
                "PR ticket check FAILED: every completed work record must be "
                f"declared, but these are not: {missing}. Add a `Ticket:` line "
                "for each (or a feat/<key>- branch)."
            )
        return 1

    names = ", ".join(f"{kind} {key}" for kind, key in sorted(completed))
    print(
        f"PR ticket check OK: {len(completed)} work record(s) complete and "
        f"declared in {args.base}..HEAD: {names}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
