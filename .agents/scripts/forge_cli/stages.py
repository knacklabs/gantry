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
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root

from .common import fail


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
    if args.parallel:
        stage["parallel"] = True
    dump_json(stages_path(base), data)
    print(f"Stage {args.id} active — {stage.get('title')}")
    print("Loop: implement via /codex:rescue → inspect diff → validate assumptions → "
          "smallest checks → LOCAL autoreview until clean → commit → forge stage done "
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
