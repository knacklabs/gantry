"""forge story resume — rebuild an in-flight story's git-local run pointer.

Decision 0045 makes `run.json` a DERIVED pointer to the active story:
worktree-local, not committed, not merge-contested authority. Being derived, it
is meant to be reconstructable — but the harness only ever wrote it once (at
intake) and never re-derived it, so when the worktree-local copy is absent (a
fresh trunk checkout or clone between tasks, or after `clear_story_authority`
drops it at ship) every gate reports "no active task" even though the committed
record — roadmap-active status, the recorded `.factory/stories/<key>/
decomposition.json`, and the approved plan in `plans/active/<key>-*.md` — is
intact and sufficient to rebuild it.

This module closes that gap two ways, sharing one derivation:
  * `ensure_active_pointer` re-derives the pointer automatically wherever a
    missing one would otherwise strand the caller (`forge next`, `task start`,
    `task plan`, `reopen`) — the self-heal, mirroring how `next` already runs
    `roadmap heal` after a merge.
  * `forge story resume <key>` is the explicit, validated form for when the
    in-flight story is ambiguous or a human wants to name it.

Unlike `intake`, neither RESETS the story: recorded plan/decomposition status is
preserved and the surviving stage tracker is adopted, never discarded.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import (
    client_signoff, dump_json, load_json, now_iso,
    protected_decomposition_state_path, repo_root, run_state_path, slugify,
    story_dir, task_marker_path,
)

from .common import fail
from .delegate import delegation_exclusion
from .events import append_event
from .roadmap import activation_state, load_items
from .stages import stages_path, write_stages


def _approved_plan(base: Path, key: str) -> Path | None:
    plans = sorted((base / "plans" / "active").glob(f"{key}-*.md"))
    return plans[0] if plans else None


def derive_inflight_story(base: Path) -> str | None:
    """The single in-flight story whose pointer can be re-derived, or None.

    In-flight means the roadmap marks it `active`, its decomposition is
    recorded, and its approved plan is present. Zero or more than one such
    story is ambiguous: the caller keeps the honest "no active task" and a
    human names the story with `forge story resume <key>`.
    """
    candidates = [
        key for key in (
            item.get("key") for item in load_items(base)
            if item.get("status") == "active"
        )
        if isinstance(key, str) and key
        and (story_dir(base, key) / "decomposition.json").is_file()
        and _approved_plan(base, key) is not None
    ]
    return candidates[0] if len(candidates) == 1 else None


def _derive_done_ids(base: Path, key: str, tasks: list[dict]) -> set[str]:
    """Which tasks have already shipped, from committed evidence only (no fetch).

    A task is done if the last stage snapshot says so, or its committed
    per-task marker is present in this checkout (shipped markers ride the
    trunk you cloned). This stays offline so it is safe to run inside `next`.
    """
    prior = load_json(stages_path(base), default={})
    snapshot_done = (
        {stage.get("id") for stage in prior.get("stages", [])
         if stage.get("status") == "done"}
        if prior.get("issue") == key else set()
    )
    done: set[str] = set()
    for task in tasks:
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            continue
        if task_id in snapshot_done:
            done.add(task_id)
            continue
        try:
            if (base / task_marker_path(key, task_id)).is_file():
                done.add(task_id)
        except ValueError:
            continue
    return done


def rebuild_story_authority(base: Path, key: str, decomposition: dict) -> tuple[int, int]:
    """Write the derived git-local authority for `key` from committed state.

    Non-destructive: recorded status is preserved, done-state is adopted from
    committed evidence. Returns (done_count, total_tasks). Callers guarantee
    `key` is roadmap-active with a recorded decomposition and an approved plan.
    """
    tasks = decomposition.get("tasks") or []
    plan = _approved_plan(base, key)
    plan_rel = plan.relative_to(base).as_posix() if plan else ""
    existing = load_json(run_state_path(base), default={})
    roadmap_item = next((item for item in load_items(base)
                         if item.get("key") == key), {})
    title = (roadmap_item.get("title") or decomposition.get("story_title")
             or existing.get("title") or key)
    signed = client_signoff(base)[0]
    state = {
        "issue_key": key,
        "story": key,
        "title": title,
        "tracker": existing.get("tracker", "linear"),
        "branch": existing.get("branch") or f"feat/{key}-{slugify(title)}",
        # Intake never bypasses the sign-off gate; a derived pointer mirrors that.
        "phase": "implementing" if signed else "discovery",
        "plan_status": "approved",
        "plan_file": plan_rel,
        "decomposition_status": "recorded",
        "implementation_status": "pending",
        "tests_status": "pending",
        "verify_status": "pending",
        "review_status": "pending",
        "project": existing.get("project") or decomposition.get("project", ""),
        "created_at": existing.get("created_at") or now_iso(),
        "updated_at": now_iso(),
    }
    done_ids = _derive_done_ids(base, key, tasks)
    stages = [
        {
            "id": task["id"],
            "title": task.get("title", task["id"]),
            "status": "done" if task.get("id") in done_ids else "pending",
        }
        for task in tasks if isinstance(task.get("id"), str)
    ]
    with delegation_exclusion(base, "stages", kind="stage-state", namespace="state"):
        dump_json(run_state_path(base, key, for_write=True), state)
        dump_json(protected_decomposition_state_path(base), decomposition)
        write_stages(base, {"issue": key, "stages": stages})
    return len(done_ids), len(stages)


def ensure_active_pointer(base: Path) -> str | None:
    """Self-heal: re-derive the run pointer if it is missing but unambiguous.

    Returns the active story key (existing or freshly rebuilt), or None when
    there is genuinely no single in-flight story to point at. A no-op — no
    write, no event — whenever the pointer already names a story.
    """
    state = load_json(run_state_path(base), default={})
    current = state.get("issue_key") or state.get("story")
    if isinstance(current, str) and current:
        return current
    key = derive_inflight_story(base)
    if not key:
        return None
    decomposition = load_json(story_dir(base, key) / "decomposition.json", default={})
    if not decomposition.get("tasks"):
        return None
    done, total = rebuild_story_authority(base, key, decomposition)
    append_event(base, "story-pointer-rederived", actor="orchestrator", story=key,
                 detail=f"auto-rehydrated ({done}/{total} shipped) from committed state")
    return key


def cmd_resume(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    key = args.id

    outcome, waiting = activation_state(base, key)
    if outcome == "absent":
        fail(f"{key} is not on plans/roadmap.json — there is no story to resume.")
    if outcome == "blocked":
        fail(f"{key} is BLOCKED on the roadmap — waiting on: {', '.join(waiting)}. "
             "Resume rebuilds an already-startable story's pointer, not a blocked one.")
    if outcome == "done":
        fail(f"{key} is already done on the roadmap — nothing to resume.")

    decomposition_file = story_dir(base, key) / "decomposition.json"
    if not decomposition_file.is_file():
        fail(f"no recorded decomposition at "
             f"{decomposition_file.relative_to(base).as_posix()} — resume rebuilds "
             "the pointer for a DECOMPOSED story. A story with no decomposition is "
             "started with intake, not resumed.")
    decomposition = load_json(decomposition_file, default={})
    if not (decomposition.get("tasks") or []):
        fail(f"the recorded decomposition for {key} has no tasks.")

    if _approved_plan(base, key) is None:
        fail(f"no approved plan at plans/active/{key}-*.md — resume needs the "
             "story's approved plan in place (it is what task start hydrates).")

    existing = load_json(run_state_path(base), default={})
    existing_key = existing.get("issue_key") or existing.get("story")
    if existing_key and existing_key != key:
        fail(f"a different story ({existing_key}) is active in the run pointer. "
             f"Finish or clear it before resuming {key}.")

    done, total = rebuild_story_authority(base, key, decomposition)
    append_event(base, "story-resumed", actor="orchestrator", story=key,
                 detail=f"{done}/{total} task(s) already shipped")
    print(f"Resumed {key}: restored the run pointer, protected decomposition, and "
          f"stage tracker ({done}/{total} done) from committed state.")
