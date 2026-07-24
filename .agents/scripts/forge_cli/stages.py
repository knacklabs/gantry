"""forge stage — per-task execution tracker (.factory/stages.json).

The recorded decomposition is immutable evidence; this file is the mutable
execution state derived from it (one stage per leaf task, list order =
execution order). The loop per stage (WORKFLOW.md "Stage Loop", decision
0007): implement via /codex:rescue → inspect the diff → validate assumption
rows → smallest checks → LOCAL autoreview until clean → commit →
`forge stage done`. `pr_ready` refuses while any stage is not done. Task-
scoped: archived to .factory/history/<issue>/ and cleaned at ship.
"""
from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

from factory_lib import (
    dump_json, factory_dir, head_sha, load_json, now_iso, repo_root,
)

from .common import fail


# Build/backup artifacts that legitimately live in the worktree and are not
# stage implementation. Everything else — tracked changes AND untracked source —
# counts as unreviewed work the stage gate must reject.
#
# Matched as DIRECTORY CONTENTS only (a path component followed by "/"), so a
# crafted root source file like `dist.bakdoor.ts` is NOT mistaken for the
# `dist.bak-*/` backup dirs — it has no trailing slash and stays counted as
# unreviewed work. `dist.bak(-<tag>)?/` covers the backup dirs the ship flow
# creates (e.g. `dist.bak-perm2test/`).
_WORKTREE_NOISE_RE = re.compile(
    r"^(?:dist|node_modules|coverage|dist\.bak(?:-[\w.]+)?)/")


def _is_worktree_noise(path: str) -> bool:
    return bool(_WORKTREE_NOISE_RE.match(path))


def _worktree_dirty(base: Path) -> list[str]:
    """Uncommitted work — TRACKED changes AND UNTRACKED files — excluding known
    build/backup noise.

    A clean review binds to a commit SHA, but uncommitted edits to tracked files
    (or newly created untracked source/test files) do not move HEAD — so a
    review can be stale even when reviewed_sha == HEAD. `stage done` must reject
    those. Fail CLOSED: a `git status` error returns a sentinel so the gate
    refuses rather than attesting a stage it cannot verify."""
    # -z is NUL-separated and unquoted; a rename/copy (status R/C) is emitted as
    # `XY <new>\0<old>\0`, so BOTH sides are inspected — a move of a source file
    # INTO an excluded build dir (e.g. `git mv src/x dist/x`) still counts.
    proc = subprocess.run(
        ["git", "status", "--porcelain", "-z", "--untracked-files=normal"],
        cwd=base, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return ["<git status failed — cannot verify worktree cleanliness>"]
    tokens = [t for t in proc.stdout.split("\0") if t]
    dirty = []
    i = 0
    while i < len(tokens):
        entry = tokens[i]
        status, new_path = entry[:2], entry[3:]
        paths = [new_path]
        if "R" in status or "C" in status:  # rename/copy: old path is next token
            i += 1
            if i < len(tokens):
                paths.append(tokens[i])
        # No .strip(): porcelain -z is unquoted and delimiter-safe, so a path
        # like " dist/x.ts" (leading space) is a real, distinct filename —
        # trimming it would let it masquerade as excluded build noise.
        for p in paths:
            if p and not _is_worktree_noise(p):
                dirty.append(p)
        i += 1
    return dirty


def _require_clean_stage_review(base: Path, stage_id: str) -> None:
    """Gate: `stage done` refuses unless the latest stage review is `clean`
    AND bound to the current HEAD. A fix after a clean review advances HEAD →
    the review goes stale → the gate refuses until the final commit is
    re-reviewed. This enforces "LOCAL autoreview until clean before done"
    (WORKFLOW.md Stage Loop) instead of trusting the operator to remember it."""
    path = factory_dir(base) / "stage-reviews" / f"{stage_id}.json"
    if not path.exists():
        fail(f"{stage_id} has no recorded stage review — LOCAL autoreview until "
             "clean is the gate for done. Review the COMMITTED diff, then record: "
             f"record_stage_review_from_json.py --stage {stage_id} (verdict clean).")
    review = load_json(path) or {}
    if str(review.get("verdict", "")).lower() != "clean":
        fail(f"{stage_id} stage review verdict is "
             f"{review.get('verdict', 'missing')!r}, not 'clean' — fix the "
             "findings, re-review the new commit, and record again before done.")
    head = head_sha(base)
    reviewed = str(review.get("reviewed_sha") or "").strip()
    if not reviewed:
        fail(f"{stage_id} stage review has no reviewed_sha — it cannot attest "
             "which commit was reviewed. Re-review the current HEAD and record "
             f"again: record_stage_review_from_json.py --stage {stage_id}.")
    if head and reviewed != head:
        fail(f"{stage_id} stage review is STALE — HEAD moved since the clean "
             f"review (reviewed {reviewed[:12]}, HEAD {head[:12]}). A fix "
             "after review is unreviewed; re-review the final commit and record "
             f"again: record_stage_review_from_json.py --stage {stage_id}.")
    dirty = _worktree_dirty(base)
    if dirty:
        fail(f"{stage_id} has uncommitted changes to tracked files "
             f"({', '.join(dirty[:5])}) — these are unreviewed even though HEAD "
             "matches the review. Commit them and re-review the new HEAD before "
             "done.")
    # reviewed_sha == HEAD only proves the review's TIP commit is HEAD; a
    # `--mode commit HEAD` review of a multi-commit stage passes that check while
    # leaving earlier stage commits unreviewed. Bind the review to the full stage
    # RANGE: it must attest reviewed_scope.base == the stage's start_sha, i.e. it
    # covered start_sha..HEAD. (Stages recorded before start_sha stamping skip
    # this — nothing to bind against.)
    stage = next((s for s in load_stages(base).get("stages", [])
                  if s.get("id") == stage_id), None)
    start_sha = str((stage or {}).get("start_sha") or "").strip()
    if start_sha:
        scope = review.get("reviewed_scope")
        scope_base = str(
            (scope.get("base") if isinstance(scope, dict) else "") or "").strip()
        if scope_base != start_sha:
            fail(f"{stage_id} stage review does not attest the full stage range "
                 f"(reviewed_scope.base {scope_base[:12] or 'missing'} != stage "
                 f"start {start_sha[:12]}) — a latest-commit review can pass the "
                 "HEAD check yet skip earlier stage commits. Re-run the autoreview "
                 f"helper with --mode branch --base {start_sha[:12]} and record its "
                 "reviewed_scope.base before done.")


def stages_path(base: Path) -> Path:
    return base / ".factory" / "stages.json"


def write_skeleton(base: Path, issue: str, tasks: list[dict]) -> None:
    dump_json(stages_path(base), {
        "issue": issue,
        "stages": [{"id": t["id"], "title": t["title"], "status": "pending"}
                   for t in tasks],
    })


def load_stages(base: Path) -> dict:
    return load_json(stages_path(base), default={})


def pending_stages(base: Path) -> list[dict]:
    return [s for s in load_stages(base).get("stages", [])
            if s.get("status") != "done"]


def _find(data: dict, stage_id: str) -> dict:
    stage = next((s for s in data.get("stages", []) if s.get("id") == stage_id), None)
    if stage is None:
        known = ", ".join(s.get("id", "?") for s in data.get("stages", []))
        fail(f"stage {stage_id!r} is not in .factory/stages.json ({known or 'empty'})")
    return stage


def cmd_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_stages(base)
    if not data:
        fail("no .factory/stages.json — record the decomposition first "
             "(record_decomposition_from_json.py creates the stage tracker)")
    stage = _find(data, args.id)
    if stage.get("status") == "done":
        fail(f"{args.id} is already done — stages don't reopen; a follow-up is a "
             "new stage in a re-recorded decomposition")
    # Order is the execution contract: earlier stages must be done first.
    # --parallel opts out ONLY for provably disjoint write scopes
    # (WORKFLOW.md Concurrency) — the caller asserts that, on the record.
    if not args.parallel:
        earlier = [s for s in data["stages"] if s is not stage]
        earlier = earlier[:data["stages"].index(stage)]
        not_done = [s["id"] for s in earlier if s.get("status") != "done"]
        if not_done:
            fail(f"{args.id} follows unfinished stage(s): {', '.join(not_done)} — "
                 "finish them, or pass --parallel if write scopes are disjoint "
                 "(WORKFLOW.md Concurrency).")
    stage["status"] = "active"
    stage["started_at"] = now_iso()
    # Pin the base so the stage's LOCAL autoreview covers the CUMULATIVE range,
    # not just the terminal commit. A stage can accrue several commits (a fix
    # after a clean review advances HEAD); `--mode commit HEAD` would review
    # only the last one yet still attest reviewed_sha == HEAD and pass the gate.
    start_sha = head_sha(base)
    if start_sha:
        stage["start_sha"] = start_sha
    if args.parallel:
        stage["parallel"] = True
    dump_json(stages_path(base), data)
    base_ref = start_sha[:12] if start_sha else "<stage start commit>"
    print(f"Stage {args.id} active — {stage.get('title')}")
    print("Loop: implement via /codex:rescue → inspect diff → validate assumptions → "
          "smallest checks → commit → LOCAL autoreview of the WHOLE stage range "
          "UNTIL CLEAN (run the autoreview SKILL HELPER directly: \"$AUTOREVIEW\" "
          f"--mode branch --base {base_ref} — range mode covers every stage commit; "
          "NOT --mode commit HEAD, which reviews only the latest commit, and NOT a "
          "/codex:rescue review job, which hangs; then "
          f"record_stage_review_from_json.py --stage {args.id}, verdict clean; a fix "
          "moves HEAD and staleness-fails the gate → re-review) → forge stage done "
          f"{args.id}")


def cmd_done(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_stages(base)
    if not data:
        fail("no .factory/stages.json — record the decomposition first")
    stage = _find(data, args.id)
    if stage.get("status") != "active":
        fail(f"{args.id} is {stage.get('status', 'pending')!r}, not active — "
             "`forge stage start` it first; done attests a stage that actually ran.")
    _require_clean_stage_review(base, args.id)
    stage["status"] = "done"
    stage["completed_at"] = now_iso()
    dump_json(stages_path(base), data)
    remaining = [s for s in data["stages"] if s.get("status") != "done"]
    if remaining:
        print(f"Stage {args.id} done. Next: forge stage start {remaining[0]['id']} "
              f"— {remaining[0].get('title')} ({len(remaining)} to go)")
    else:
        print(f"Stage {args.id} done — all {len(data['stages'])} stage(s) complete. "
              "Continue the task loop: verify, then the ONE branch autoreview.")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_stages(base)
    if not data:
        print("No stage tracker (.factory/stages.json) — it is created when the "
              "decomposition is recorded.")
        return
    marks = {"pending": " ", "active": ">", "done": "x"}
    for stage in data.get("stages", []):
        status = stage.get("status", "pending")
        par = " [parallel]" if stage.get("parallel") else ""
        print(f"[{marks.get(status, '?')}] {stage['id']} — {stage.get('title')}{par}")
