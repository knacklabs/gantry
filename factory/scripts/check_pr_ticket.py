#!/usr/bin/env python3
"""Require a pull request to declare every completed work record.

Client repos: a PR must complete a roadmap story, task, or work window. The
harness-SOURCE repo (which defines that machinery) is exempt from needing a
completed record — its own development PRs complete no client story and are
tracked by a `Ticket:` line or a feat/<key>- branch instead.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from factory_lib import repo_root
from forge_cli.repo_kind import is_harness_source_repo
from forge_cli.scaffold import (
    COPY_CLAUDE, COPY_TREES, COPY_WORKFLOWS, DOC_CONTRACTS,
)

ROADMAP = "plans/roadmap.json"
TICKET_LINE = re.compile(
    r"^\s*Ticket:\s*([A-Za-z0-9][A-Za-z0-9._-]*"
    r"(?:/[A-Za-z0-9][A-Za-z0-9._-]*)?)\s*$",
    re.MULTILINE,
)
TASK_MARKER_PATH = re.compile(
    r"^\.factory/stories/([^/]+)/tasks/([^/]+)/pr-ready\.json$"
)
TASK_MARKER_FIELDS = frozenset({
    "task_id", "branch", "base_main_sha", "commit", "sealed_at",
})

# A harness re-vendor (`forge upgrade`) replaces only vendored, harness-owned
# paths and ALWAYS rewrites the vendor manifest. It completes no roadmap story,
# so the ticket requirement cannot apply to it. The ownership lists below are
# the SAME ones the upgrader replaces (imported from forge_cli.scaffold, never
# duplicated), so this exemption can never drift wider than what the harness
# actually owns — and requiring a manifest marker in the diff keeps it to real
# re-vendors, not hand-edits of gate machinery (which vendor-integrity refuses).
HARNESS_TOP_FILES = frozenset({"forge", "forge.cmd", "CLAUDE.md", "WORKFLOW.md"})
HARNESS_DOC_FILES = frozenset(dst for _, dst in DOC_CONTRACTS)
HARNESS_CLAUDE_FILES = frozenset(f".claude/{name}" for name in COPY_CLAUDE)
VENDOR_MARKERS = frozenset({
    "constitution/VENDOR_MANIFEST.json",
    "constitution/VENDORED_FROM",
})


def is_harness_owned(path: str) -> bool:
    if path in HARNESS_TOP_FILES or path in HARNESS_DOC_FILES:
        return True
    if path in HARNESS_CLAUDE_FILES or path in COPY_WORKFLOWS:
        return True
    return any(path == tree or path.startswith(f"{tree}/") for tree in COPY_TREES)


def _git_result(proc: subprocess.CompletedProcess[str], args: tuple[str, ...]) -> str:
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def git(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, encoding="utf-8",
        errors="strict",
    )
    return _git_result(proc, args)


def git_paths(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, encoding="utf-8",
        errors="surrogateescape",
    )
    return _git_result(proc, args)


def roadmap_at(root: Path, ref: str) -> dict[str, dict]:
    try:
        raw = git(root, "show", f"{ref}:{ROADMAP}")
    except SystemExit as exc:
        message = str(exc)
        missing_at_ref = (
            f"path '{ROADMAP}' does not exist in '{ref}'" in message
            or f"path '{ROADMAP}' exists on disk, but not in '{ref}'" in message
        )
        if ref != "HEAD" and missing_at_ref:
            return {}
        raise
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{ROADMAP} at {ref} is not valid JSON: {exc}") from exc
    return {
        item["key"]: item
        for item in data.get("items", [])
        if isinstance(item, dict) and isinstance(item.get("key"), str)
    }


def added_paths(root: Path, base: str) -> set[str]:
    added: set[str] = set()
    for line in git_paths(
        root, "diff", "--name-status", f"{base}..HEAD",
    ).splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        status = fields[0]
        path = fields[-1]
        if status == "A":
            added.add(path)
    return added


def changed_paths(root: Path, base: str) -> set[str]:
    changed: set[str] = set()
    for line in git_paths(
        root, "diff", "--name-only", f"{base}..HEAD",
    ).splitlines():
        path = line.strip()
        if path:
            changed.add(path)
    return changed


def is_harness_revendor(root: Path, base: str) -> bool:
    """A PR that changes only harness-owned paths AND rewrites the vendor
    manifest is a re-vendor: it completes no roadmap story and needs no ticket."""
    changed = changed_paths(root, base)
    return bool(changed) and bool(changed & VENDOR_MARKERS) and all(
        is_harness_owned(path) for path in changed
    )


def branch_ticket(
    branch: str, story_keys: set[str], task_records: set[str] = frozenset(),
) -> str | None:
    # task_records defaults to empty so a two-arg caller keeps working. The
    # pr-link workflow_run job runs the DEFAULT-BRANCH copy of pr-link.yml (its
    # inline call) against the PR's checked-out code, so until a signature
    # change lands on the default branch, that job would otherwise crash on any
    # open PR. Only iterated, never mutated — an immutable empty default is safe.
    task_matches = [
        record for record in task_records
        if branch == f"feat/{record.replace('/', '-', 1)}"
    ]
    if task_matches:
        return max(task_matches, key=len)
    matches = [
        key for key in story_keys
        if any(branch.startswith(f"{prefix}/{key}-")
               for prefix in ("feat", "feature"))
    ]
    return max(matches, key=len) if matches else None


def completed_task_markers(root: Path, added: set[str]) -> set[str]:
    completed: set[str] = set()
    for path in sorted(added):
        match = TASK_MARKER_PATH.fullmatch(path)
        if not match:
            continue
        key, task_id = match.groups()
        try:
            marker = json.loads(git(root, "show", f"HEAD:{path}"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path} at HEAD is not valid JSON: {exc}") from exc
        if (
            isinstance(marker, dict)
            and TASK_MARKER_FIELDS <= marker.keys()
            and marker.get("task_id") == task_id
        ):
            completed.add(f"{key}/{task_id}")
    return completed


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
    completed_tasks = completed_task_markers(root, added)

    candidates = set(TICKET_LINE.findall(args.pr_body))
    if inferred := branch_ticket(
        args.head_branch, set(head_items), completed_tasks,
    ):
        candidates.add(inferred)

    completed_stories = {
        key for key, head_item in head_items.items()
        if (key not in base_items or base_items[key].get("status") != "done")
        and head_item.get("status") == "done"
        and (
            any(path.startswith(f".factory/history/{key}/") for path in added)
            or f".factory/stories/{key}/shipped.json" in added
        )
    }
    completed_window_ids = completed_windows(root, added)

    # A PR must declare EVERY work record it completes — not exactly one. A
    # single review-driven effort legitimately spans more than one window (do
    # the work, close it, review, reopen a window to apply the fixes), and every
    # such window must be accounted for, not just one with the rest left
    # undeclared. Declaring all of them keeps the PR fully traceable.
    completed = (
        {("story", key) for key in completed_stories}
        | {("task", record) for record in completed_tasks}
        | {("window", wid) for wid in completed_window_ids}
    )
    undeclared = {(kind, key) for kind, key in completed if key not in candidates}

    if not completed:
        if is_harness_revendor(root, args.base):
            print(
                "PR ticket check OK: harness re-vendor — only vendored "
                "harness-owned paths changed and the vendor manifest was "
                "rewritten, so this PR completes no roadmap story and needs "
                "no ticket."
            )
            return 0
        # The harness-SOURCE repo defines the roadmap/quickfix machinery, so its
        # own development PRs complete no CLIENT roadmap story — the premise this
        # gate enforces everywhere else. Track them by ticket reference instead
        # (a `Ticket:` line — a PR number or issue key — or a feat/<key>- branch),
        # mirroring the re-vendor exemption. Client repos are unchanged: they
        # still need a completed work record below.
        if is_harness_source_repo(root):
            if candidates:
                print(
                    "PR ticket check OK: harness-source development PR — this "
                    "repo defines the roadmap/quickfix machinery, so its own PRs "
                    "complete no client story; tracked by ticket(s): "
                    f"{', '.join(sorted(candidates))}."
                )
                return 0
            print(
                "PR ticket check FAILED: a harness-source development PR needs a "
                "`Ticket:` line (a PR number or issue key) in the body, or a "
                "feat/<key>- branch — this repo completes no client roadmap story."
            )
            return 1
        print(
            "PR ticket check FAILED: no completed work record in "
            f"{args.base}..HEAD — a PR must complete a roadmap story (done-flip "
            "with added history), task (added validated marker), or work window "
            "(added done record)."
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
                "for each (or use its canonical feature branch)."
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
