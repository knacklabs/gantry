#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import (
    client_signoff, dump_json, ensure_issue_key, load_json, now_iso, repo_root,
    run_state_path, slugify, story_dir,
)
from forge_cli.events import append_event
from forge_cli.roadmap import activation_state, mark_status


def stale_task_state(base: Path) -> list[Path]:
    """Report task-scoped factory artifacts left in the working state."""
    previous = load_json(run_state_path(base), default={})
    key = previous.get("issue_key") or previous.get("story")
    factory = story_dir(base, key) if key and story_dir(base, key).is_dir() \
        else base / ".factory"
    return [
        path for path in (
            factory / "decomposition.json",
            factory / "verify.json",
            factory / "tests.json",
            factory / "grills" / "plan.json",
            factory / "signals.jsonl",
            factory / "stages.json",
        )
        if path.exists()
    ] + list((factory / "reviews").glob("*.json"))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Initialize factory run state")
    parser.add_argument("--issue", help="Linear issue key, e.g. ENG-123")
    parser.add_argument("--title", required=True, help="Issue or feature title")
    parser.add_argument("--tracker", default="linear")
    parser.add_argument("--branch")
    parser.add_argument(
        "--discard-active", action="store_true",
        help="deliberately abandon the previous task's unarchived artifacts",
    )
    args = parser.parse_args(argv)

    root = repo_root()
    issue_key = ensure_issue_key(args.issue, root)
    # depends_on is enforced at activation, not just displayed in the frontier.
    outcome, waiting = activation_state(root, issue_key)
    if outcome == "absent":
        raise SystemExit(
            f"{issue_key} is not on plans/roadmap.json. "
            "Add it first through the `roadmap add --no-spec` path."
        )
    if outcome == "blocked":
        raise SystemExit(
            f"{issue_key} is BLOCKED on the roadmap — waiting on: {', '.join(waiting)}. "
            "Ship the dependencies first (./forge roadmap parallel shows the ready frontier)."
        )
    if outcome == "done":
        print(f"Roadmap: {issue_key} is already done")
        return
    branch = args.branch or f"feat/{issue_key}-{slugify(args.title)}"
    previous = load_json(run_state_path(root), default={})
    signed_off = client_signoff(root)[0]
    state = {
        "issue_key": issue_key,
        "title": args.title,
        "tracker": args.tracker,
        "branch": branch,
        # Intake must never bypass or erase the sign-off gate.
        "phase": "planning" if signed_off else "discovery",
        "plan_status": "needs-plan",
        "decomposition_status": "pending",
        "implementation_status": "pending",
        "tests_status": "pending",
        "verify_status": "pending",
        "review_status": "pending",
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    if "project" in previous:
        state["project"] = previous["project"]
    # Task-scoped artifacts belong to the previous task. Clear them only when that
    # task was archived (pr_ready/done); otherwise they are unrecovered evidence.
    # The approved plan in plans/active/ is an artifact too — abandonment moves it
    # to plans/debt/ rather than orphaning it.
    prev_issue = previous.get("issue_key", "")
    active_plans = (
        list((root / "plans" / "active").glob(f"{prev_issue}-*.md"))
        if prev_issue else []
    )
    stale_files = stale_task_state(root)
    if stale_files or active_plans:
        # "shipped" is what pr_ready.py writes after it archives (pr_ready.py:327);
        # omitting it made every post-ship intake claim unarchived work and demand
        # --discard-active, which deletes the evidence pr_ready just preserved.
        prev_archived = previous.get("phase") in {"pr-ready", "shipped", "done"}
        if not prev_archived and not args.discard_active:
            raise SystemExit(
                f"Task {prev_issue or '?'} has unarchived work "
                f"({len(stale_files)} .factory artifact(s), {len(active_plans)} active plan(s)). "
                "Finish it (pr_ready.py archives the evidence) or pass --discard-active "
                "to abandon it deliberately."
            )
        if not prev_archived:
            for stale in stale_files:
                stale.unlink()
        if active_plans and not prev_archived:
            debt = root / "plans" / "debt"
            debt.mkdir(parents=True, exist_ok=True)
            for plan in active_plans:
                plan.rename(debt / plan.name)
                print(f"Abandoned plan moved to plans/debt/{plan.name}")
    # Directory existence is the atomic layout marker. Create it only after
    # every intake refusal/legacy cleanup has completed, then all subsequent
    # story writes route through the scoped layout.
    story_dir(root, issue_key).mkdir(parents=True, exist_ok=True)
    dump_json(run_state_path(root, issue_key, for_write=True), state)
    append_event(root, "intake", actor="orchestrator", story=issue_key, detail=args.title)
    if outcome == "activate" and mark_status(root, issue_key, "active"):
        print(f"Initialized factory state for {issue_key} -> {branch}; "
              f"Roadmap: {issue_key} marked active (plans/roadmap.json)")
    else:
        print(f"Initialized factory state for {issue_key} -> {branch}")


if __name__ == "__main__":
    main()
