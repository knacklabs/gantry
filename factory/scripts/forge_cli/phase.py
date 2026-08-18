"""forge next — the deterministic 'you are here, do this' phase engine."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from factory_lib import (
    client_signoff, load_json, repo_root, run_state_path, task_frontier_state,
)

from .context import pending_context
from .quickfix import load_active, profile_of
from .roadmap import leverage, load_items, ready_pending
from .signal import open_signals


def cmd_next(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    factory = base / ".factory"
    pending_ctx = len(pending_context(base))
    steps: list[str] = []
    signed_off = client_signoff(base)[0]
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=base, capture_output=True, text=True, encoding="utf-8",
        errors="surrogateescape",
    )
    dirty_paths = {
        line[3:].split(" -> ")[-1].strip().strip('"')
        for line in status.stdout.splitlines()
        if len(line) >= 4
    } if status.returncode == 0 else set()

    def phase(label: str) -> None:
        issue = state.get("issue_key")
        suffix = f" ({issue} — {state.get('title')})" if issue else ""
        print(f"PHASE: {label}{suffix}")

    from .doctor import fast_hook_status
    hooks_ok, hook_detail = fast_hook_status(base)
    if not hooks_ok:
        steps.append(
            f"[dev] Hook launcher is broken ({hook_detail}) — run `./forge doctor --fix` first"
        )

    open_sigs = open_signals(base)
    if open_sigs:
        ids = ", ".join(s["id"] for s in open_sigs[:3])
        steps.append(f"[orchestrator] {len(open_sigs)} OPEN worker signal(s) ({ids}) — a "
                     "paused worker is waiting: forge.py signal list --open, then "
                     "signal resolve <id> --notes \"...\" and resume the rescue")
    active_window = load_active(base)
    if active_window and profile_of(active_window) == "lite":
        steps.append(
            f"[dev] OPEN LITE WINDOW {active_window['id']} — {active_window['reason']}; "
            "one review is required to close it with `./forge mode done`"
        )
    if pending_ctx:
        steps.append(
            f"Harvest {pending_ctx} pending docs/context/ file(s) first "
            "(factory/prompts/harvester.md; then forge.py context mark ...)"
        )
    from .findings import recurring
    recurring_classes = recurring(base)
    if recurring_classes:
        worst = recurring_classes[0]
        steps.append(f"[EM] {len(recurring_classes)} RECURRING finding class(es) — e.g. "
                     f"{worst['category']} x{worst['count']} — a design signal, not a fix "
                     "queue: ./forge findings patterns, then consolidate via a refactor "
                     "story + decision record")
    if not state:
        phase("uninitialized")
        steps.append("New project? scaffold with: forge.py init --name <project> --target <dir>")
        steps.append("Existing project, new feature? this repo has no .factory/run.json — "
                     "run: python3 factory/scripts/intake.py --issue <KEY> --title \"<title>\"")
    elif not signed_off:
        phase("discovery/prototype/specs/roadmap (0a/0b/0c)")
        steps.append("[PM] Capture discovery and the product brief — ask for them; "
                     "prototype freely meanwhile (no ceremony)")
        steps.append("[PM] Record each client decision as it is made — ask, then confirm it in chat")
        from .specs import spec_records
        specs = spec_records(base)
        if not specs:
            steps.append("[PM] Save capability specs as they emerge — ask to save each one "
                         "from its draft, then confirm it")
        drafts = [spec["slug"] for spec in specs if spec.get("status") != "confirmed"]
        if drafts:
            steps.append("[PM] Grill and confirm every draft spec: "
                         f"{', '.join(drafts)} (`record_grill_from_json.py --gate spec "
                         "--input-digest docs/specs/<slug>.md`, then `forge spec confirm <slug>`)")
        if specs and not drafts and not load_items(base):
            steps.append("[PM/EM] Derive the spec-linked roadmap before sign-off: "
                         "./forge roadmap derive --input <json> "
                         "(factory/prompts/decomposer.md)")
        signoff_grill = load_json(factory / "grills" / "signoff.json", default={})
        if signoff_grill.get("verdict") != "pass":
            steps.append("[PM] Before sign-off: grill the handover for gaps/contradictions "
                         "(factory/prompts/griller.md), resolve findings, record: "
                         "record_grill_from_json.py --gate signoff")
        steps.append("[PM] When the client confirms: forge.py decision new client-signoff, "
                     "then forge.py decision accept client-signoff --by <name> (human), "
                     "then run record_signoff.py")
    elif not state.get("issue_key"):
        phase("signed off — no active task")
        if state.get("phase") == "shipped" and any(
                path.startswith((".factory/history/", "plans/completed/"))
                for path in dirty_paths):
            steps.append("[dev] Commit the archive — evidence that isn't committed isn't "
                         "merged: git add -A && git commit -m \"chore: ship — evidence "
                         "archived\"")
        if "harness.yaml" in dirty_paths:
            steps.append("[dev] Commit harness.yaml — every gate reads the client sign-off "
                         "pin from committed state")
        items = load_items(base)
        pending_items = [i for i in items if i.get("status", "pending") == "pending"]
        ready_items, _ = ready_pending(items)
        if ready_items:
            import shlex
            # DEPENDENCY-READY, then most-unblocking: roadmap order says what was
            # written first, not what frees the most work next.
            unblocks = leverage(items)
            ready_items = sorted(ready_items,
                                 key=lambda i: (-unblocks.get(i["key"], 0), i.get("order", 0)))
            nxt = ready_items[0]
            owner = f" (assigned: @{nxt['assignee']})" if nxt.get("assignee") else ""
            frees = unblocks.get(nxt["key"], 0)
            why = f" — unblocks {frees} more" if frees else ""
            steps.append(f"[dev] Next on the roadmap: {nxt['key']} — {nxt['title']}{owner}{why}. "
                         f"Start it: python3 factory/scripts/intake.py --issue "
                         f"{shlex.quote(nxt['key'])} --title {shlex.quote(nxt['title'])}")
            stuck = sorted((i for i in items if i.get("status") == "active"
                            and unblocks.get(i["key"], 0) > frees),
                           key=lambda i: -unblocks[i["key"]])
            if stuck:
                steps.append(f"[EM] {stuck[0]['key']} is already in flight and unblocks "
                             f"{unblocks[stuck[0]['key']]} — finishing it frees more work "
                             "than starting anything on the frontier")
            unassigned = sum(1 for i in pending_items if not i.get("assignee"))
            if unassigned and (base / "plans" / "team.json").exists():
                steps.append(f"[EM] {unassigned} pending item(s) unassigned — distribute: "
                             "./forge roadmap assign <KEY> --to <dev>")
            if len(ready_items) > 1:
                steps.append(f"[EM] {len(ready_items)} stories are independent — PARALLELIZE: "
                             "./forge roadmap parallel (one worktree per story, "
                             "background rescue per story)")
            elif len(pending_items) > 1:
                steps.append(f"({len(pending_items) - 1} more pending — "
                             "./forge roadmap list --pending)")
        elif pending_items:
            steps.append(f"[EM] All {len(pending_items)} pending stor"
                         f"{'y is' if len(pending_items) == 1 else 'ies are'} BLOCKED on "
                         "dependencies — ship those first (./forge roadmap parallel shows "
                         "what each waits on)")
        elif items:
            steps.append("[EM] Roadmap is fully built or in flight (./forge roadmap list) — "
                         "extend it, or start an off-roadmap task: "
                         "python3 factory/scripts/intake.py --issue <KEY> --title \"<title>\"")
        else:
            steps.append("[PM/EM] This sign-off predates a roadmap or it was removed. "
                         "Confirm capability specs, then derive it: "
                         "./forge roadmap derive --input <json>")
            steps.append("[dev] Or start a task directly: python3 factory/scripts/intake.py "
                         "--issue <KEY> --title \"<title>\"")
    elif state.get("plan_status") != "approved":
        phase("planning")
        steps.append("[dev] MANDATORY: enter plan mode (shift+tab) and plan per "
                     "factory/prompts/planner.md, or deliberately open a bounded "
                     "`./forge quickfix start \"<reason>\"` window. Product writes are "
                     "hook-blocked otherwise (Codex planning alternative: planner-high; "
                     "exploration via /codex:rescue read-only).")
        steps.append("[dev] Record new decisions as you go: forge.py decision new <slug>")
        plan_grill = load_json(factory / "grills" / "plan.json", default={})
        if plan_grill.get("verdict") != "pass" or plan_grill.get("issue") != state.get("issue_key"):
            steps.append("[dev] MANDATORY before approval: grill the plan (/grill-me, or "
                         "factory/prompts/griller.md --gate plan) and record: "
                         "record_grill_from_json.py --gate plan — plan save refuses without it")
        steps.append("[dev] On approval: forge.py plan save --from <plan-file> "
                     f"--story {state.get('issue_key')}")
    elif state.get("decomposition_status") != "recorded":
        phase("decomposing")
        steps.append("[dev] Run docs-decomposer (factory/prompts/decomposer.md), then "
                     "record_decomposition_from_json.py and "
                     "update_run.py --phase implementing --decomposition-status recorded")
    else:
        tests = load_json(factory / "tests.json", default={})
        verify = load_json(factory / "verify.json", default={})
        decomp = load_json(factory / "decomposition.json", default={})
        user_facing = bool(decomp.get("user_facing", True))
        reviews_missing = [
            a for a in ("quality", "performance", "security")
            if not load_json(factory / "reviews" / f"{a}.json", default={})
        ]
        if not tests.get("automated"):
            phase("implementing")
            frontier_state = task_frontier_state(base)
            if frontier_state:
                frontier, task = frontier_state
                task_id = task["id"]
                if frontier == "author-contract":
                    steps.append(
                        f"[dev] Enter plan mode for {task_id} per "
                        "factory/prompts/planner.md; author its JIT contract against "
                        "completed work, then re-record with "
                        "record_decomposition_from_json.py (decisions 0029/0032)"
                    )
                elif frontier == "grill":
                    steps.append(
                        f"[dev] Grill {task_id} with factory/prompts/griller.md --gate "
                        "task; resolve findings and record the digest-bound pass"
                    )
                elif frontier == "stage-start":
                    steps.append(f"[dev] Start {task_id}: ./forge stage start {task_id}")
                elif frontier == "delegate":
                    steps.append(f"[dev] Delegate {task_id}: ./forge delegate {task_id}")
                if user_facing:
                    steps[-1] += (
                        " — User-facing task: emil-design-eng + frontend-design are "
                        "MANDATORY (recorder refuses the artifact without them in "
                        "skills_used); apple-design advisory for gesture/motion — "
                        "harness.yaml required_skills"
                    )
        elif not verify.get("ok"):
            phase("verifying")
            steps.append("[dev] Run: python3 factory/scripts/verify.py")
        elif reviews_missing:
            phase("reviewing")
            steps.append("[dev] Run ONE autoreview pass in Codex, three lenses "
                         f"(factory/prompts/reviewer.md); still to record: {', '.join(reviews_missing)} "
                         "via record_review_from_json.py")
        elif not tests.get("functional") and user_facing:
            phase("functional-check")
            steps.append("[dev] Task is user-facing: run functional-checker and record: "
                         "record_test_from_json.py --kind functional --input <json>")
        else:
            phase("ready for PR gate")
            from .assumptions import blocking_for_issue
            unguided = blocking_for_issue(base, state.get("issue_key", ""))
            if unguided:
                steps.append(f"[EM] Guide {len(unguided)} open assumption(s) first "
                             "(pr_ready refuses them): forge.py assumptions list --open, "
                             "then assumptions resolve <id> --status ... --notes ...")
            steps.append("[dev] Run: python3 factory/scripts/pr_ready.py (archives the task; merge stays manual)")
            steps.append("[EM] Next task afterwards: pick from ./forge roadmap list --pending, "
                         "then intake.py --issue <KEY> --title \"<title>\"")
    from .decisions import decision_records
    records = decision_records(base)
    accepted_dirty = [
        record for record in records
        if record["status"] == "accepted"
        and record["path"].relative_to(base).as_posix() in dirty_paths
    ]
    if accepted_dirty:
        record = accepted_dirty[0]
        rel = record["path"].relative_to(base).as_posix()
        slug = str(record["id"]).split("-", 1)[-1]
        confirmer = record.get("confirmed_by") or "<human>"
        steps.append(f"[PM] Commit accepted decision {record['id']} with its human "
                     f"confirmed_by and audit trailer: git add {rel} && git commit -m "
                     f"\"docs(decisions): accept {slug}\" --trailer "
                     f"\"Confirmed-by: {confirmer}\"")
    superseding = [
        record for record in records
        if record.get("supersedes") and record["status"] != "accepted"
    ]
    if superseding:
        record = superseding[0]
        slug = str(record["id"]).split("-", 1)[-1]
        steps.append(f"[PM] {record['id']} supersedes {record['supersedes']} — the predecessor "
                     "stays active until `forge decision accept "
                     f"{slug} --by \"<human>\"` flips both")
    spec_debt = [
        item for item in load_items(base)
        if signed_off and item.get("spec_debt_reason") and not item.get("spec")
    ]
    if spec_debt:
        item = spec_debt[0]
        steps.append("[PM] Clear spec debt before planning "
                     f"{item['key']}: ./forge spec confirm <slug> && ./forge roadmap "
                     f"link-spec {item['key']} --spec docs/specs/<slug>.md")
    proposed = len(list((base / "factory" / "skills" / "proposed").glob("*.md")))
    if proposed:
        steps.append(f"(Also: {proposed} proposed skill(s) await human review in "
                     "factory/skills/proposed/)")
    from .deferrals import open_count as deferrals_open
    open_defers = deferrals_open(base)
    if open_defers:
        steps.append(f"({open_defers} deferred item(s) with revisit triggers — "
                     "./forge defer list --open; reopen any whose trigger fired)")
    from .audit import issues as audit_issues
    loop_health = len(audit_issues(base))
    if loop_health:
        steps.append(f"(loop-health audit: {loop_health} issue(s) — a watcher is "
                     "decaying: ./forge audit)")
    print("NEXT:")
    for i, step in enumerate(steps, 1):
        print(f"  {i}. {step}")
