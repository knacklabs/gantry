#!/usr/bin/env python3
"""Refactor ratchet: a refactor-tagged story must not GROW product source.

`pr_ready.py` runs this when the active roadmap story has `kind: refactor`:
the net line delta over product source (added minus deleted, vs the merge
base) must be <= 0. Harness machinery, docs, plans, evidence, and test files
are excluded — a refactor that pins invariants with new tests still passes;
one that quietly adds runtime code does not. Never relax the exclusion list
to hide new debt; if the story genuinely must add code, it is not a
refactor — reclassify it on the roadmap by PR.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from factory_lib import repo_root

EXCLUDE_PREFIXES = (
    ".factory/", "plans/", "docs/", ".agents/", ".claude/", ".codex/",
    ".github/", "constitution/", "harness/", "prototype/", ".gstack/",
    "tests/", "test/",
)
EXCLUDE_FILES = {"forge", "CLAUDE.md", "AGENTS.md", "WORKFLOW.md", "README.md",
                 "harness.yaml", ".gitignore", ".gitattributes", ".envrc"}
TEST_MARKERS = (".test.", ".spec.", "_test.", "__tests__/")


def is_product_source(rel: str) -> bool:
    if rel.startswith(EXCLUDE_PREFIXES) or rel in EXCLUDE_FILES:
        return False
    if rel.endswith(".md"):
        return False
    return not any(marker in rel for marker in TEST_MARKERS)


def resolve_base(root: Path) -> str | None:
    for ref in ("origin/main", "main", "origin/master", "master"):
        proc = subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                              cwd=root, capture_output=True, text=True)
        if proc.returncode == 0:
            return ref
    return None


def net_delta(root: Path, base: str) -> tuple[int, list[str]]:
    """Sum of (added - deleted) over product source vs the merge base
    (`base...HEAD`), with a per-file breakdown for the refusal message."""
    proc = subprocess.run(["git", "diff", "--numstat", f"{base}...HEAD"],
                          cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"git diff against {base} failed: {proc.stderr.strip()}")
    total = 0
    detail: list[str] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        added, deleted, rel = parts
        if added == "-" or not is_product_source(rel):
            continue  # binary or non-product — outside the ratchet
        delta = int(added) - int(deleted)
        total += delta
        if delta:
            detail.append(f"{rel}: {delta:+d}")
    detail.sort(key=lambda entry: -int(entry.rsplit(" ", 1)[-1]))
    return total, detail


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="base ref (default: origin/main, main, …)")
    parser.add_argument("--repo")
    args = parser.parse_args()
    root = Path(args.repo).resolve() if args.repo else repo_root()
    base = args.base or resolve_base(root)
    if not base:
        print("No main/master base ref found — nothing to ratchet against.")
        return 0
    total, detail = net_delta(root, base)
    if total > 0:
        print(f"REFACTOR RATCHET: net product-source delta is +{total} lines vs {base} — "
              "refactors must shrink or hold the line.")
        for entry in detail[:10]:
            print(f"  {entry}")
        return 1
    print(f"Refactor ratchet OK: net product-source delta {total:+d} lines vs {base}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
