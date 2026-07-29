#!/usr/bin/env python3
"""Repo budget watchdog: the backstop against the repo turning into a landfill.

Checks TRACKED files only (git ls-files) so gitignored machine noise never
counts. Budgets are deliberately generous — this catches the categories
nobody predicted (a committed video, a runaway export, a cache that slipped
past .gitignore), not normal growth.

Usage: python3 .agents/scripts/check_repo_budget.py [target-dir]
Exit codes: 0 within budget, 1 violations.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

MAX_FILE_BYTES = 5_000_000            # any single tracked file
DIR_BUDGETS = {                        # cumulative tracked bytes per tree
    "docs/context": 50_000_000,
    ".gstack": 20_000_000,
    "prototype": 100_000_000,
}
WARN_RATIO = 0.7


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(
        subprocess.run(["git", "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True, check=True).stdout.strip())
    proc = subprocess.run(["git", "ls-files", "-z"], cwd=root,
                          capture_output=True, text=True, check=True)
    tracked = [f for f in proc.stdout.split("\0") if f]
    violations: list[str] = []
    warnings: list[str] = []
    dir_totals = {prefix: 0 for prefix in DIR_BUDGETS}
    # Build/tool noise must never be TRACKED regardless of size — gitignore
    # only guards untracked files, so anything committed once (e.g. vendored
    # bytecode before the vendor-ignore fix) silently stays until a check
    # refuses it.
    noise = [rel for rel in tracked
             if "__pycache__/" in rel or rel.endswith((".pyc", ".pyo"))
             or Path(rel).name == ".DS_Store"]
    if noise:
        violations.append(
            f"{len(noise)} tracked build/tool noise file(s) (e.g. {noise[0]}) — "
            "bytecode and OS droppings never belong in git: "
            "`git rm --cached <paths>` and keep __pycache__/, *.pyc, .DS_Store ignored."
        )
    for rel in tracked:
        path = root / rel
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            violations.append(
                f"{rel}: {size / 1_000_000:.1f}MB tracked file (max "
                f"{MAX_FILE_BYTES // 1_000_000}MB) — large blobs do not belong in git; "
                "summarize, split, or store externally and link."
            )
        for prefix in DIR_BUDGETS:
            if rel.startswith(prefix + "/"):
                dir_totals[prefix] += size
    for prefix, budget in DIR_BUDGETS.items():
        total = dir_totals[prefix]
        if total > budget:
            violations.append(
                f"{prefix}/: {total / 1_000_000:.1f}MB tracked (budget "
                f"{budget // 1_000_000}MB) — the inbox/store needs curation, "
                "not a bigger budget."
            )
        elif total > budget * WARN_RATIO:
            warnings.append(
                f"WARNING: {prefix}/ at {total / 1_000_000:.1f}MB of its "
                f"{budget // 1_000_000}MB budget — curate before it gates."
            )
    for line in warnings:
        print(line)
    if violations:
        print("Repo budget exceeded:")
        for line in violations:
            print(f"- {line}")
        return 1
    print("check_repo_budget: within budget.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
