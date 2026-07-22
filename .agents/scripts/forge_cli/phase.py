"""forge next — the deterministic 'you are here, do this' phase engine."""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import load_json, repo_root, run_state_path

from .context import pending_context
from .roadmap import load_items, ready_pending
from .signal import open_signals


def cmd_next(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    factory = base / ".factory"
    pending_ctx = len(pending_context(base))
    steps: list[str] = []

    def phase(label: str) -> None:
        issue = state.get("issue_key")
        suffix = f" ({issue} — {state.get('title')})" if issue else ""
        print(f"PHASE: {label}{suffix}")

    open_sigs = open_signals(base)
    if open_sigs:
        ids = ", ".join(s["id"] for s in open_sigs[:3])
        steps.append(f"[orchestrator] {len(open_sigs)} OPEN worker signal(s) ({ids}) — a "
                     "paused worker is waiting: forge.py signal list --open, then "
                     "signal resolve <id> --notes \"...\" and resume the rescue")
    if pending_ctx:
        steps.append(
            f"Harvest {pending_ctx} pending docs/context/ file(s) first "
            "(.agents/prompts/harvester.md; then forge.py context mark ...)"
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
                     "run: python3 .agents/scripts/intake.py --issue <KEY> --title \"<title>\"")
    elif not state.get("client_signoff"):
        phase("discovery/prototype (0a/0b)")
        steps.append("[PM] Fill docs/product/DISCOVERY.md and BRIEF.md; prototype freely (no ceremony)")
        steps.append("[PM] Capture client decisions: forge.py decision new <slug>")
        signoff_grill = load_json(factory / "grills" / "signoff.json", default={})
        if signoff_grill.get("verdict") != "pass":
            steps.append("[PM] Before sign-off: grill the handover for gaps/contradictions "
                         "(.agents/prompts/griller.md), resolve findings, record: "
                         "record_grill_from_json.py --gate signoff")
        steps.append("[PM] When the client confirms: forge.py decision new client-signoff, "
                     "then forge.py decision accept client-signoff --by <name> (human), "
                     "then run record_signoff.py")
    elif not state.get("issue_key"):
        phase("signed off — no active task")
        items = load_items(base)
        pending_items = [i for i in items if i.get("status", "pending") == "pending"]
        ready_items, _ = ready_pending(items)
        if ready_items:
            import shlex
            nxt = ready_items[0]  # suggest only DEPENDENCY-READY work
            owner = f" (assigned: @{nxt['assignee']})" if nxt.get("assignee") else ""
            steps.append(f"[dev] Next on the roadmap: {nxt['key']} — {nxt['title']}{owner}. "
                         f"Start it: python3 .agents/scripts/intake.py --issue "
                         f"{shlex.quote(nxt['key'])} --title {shlex.quote(nxt['title'])}")
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
                         "python3 .agents/scripts/intake.py --issue <KEY> --title \"<title>\"")
        else:
            epics_grill = load_json(factory / "grills" / "epics.json", default={})
            if epics_grill.get("verdict") != "pass":
                steps.append("[PM] Grill the epics handover for coverage gaps/contradictions "
                             "(.agents/prompts/griller.md), record: "
                             "record_grill_from_json.py --gate epics")
            steps.append("[PM] Approve the epics: forge.py decision new epics-approved, then "
                         "a human runs decision accept epics-approved --by <PM>")
            steps.append("[EM] Then record the backlog: ./forge roadmap import --input <json> "
                         "(project-level decomposition, .agents/prompts/decomposer.md); "
                         "distribute with ./forge roadmap assign")
            steps.append("[dev] Or start a task directly: python3 .agents/scripts/intake.py "
                         "--issue <KEY> --title \"<title>\"")
    elif state.get("plan_status") != "approved":
        phase("planning")
        steps.append("[dev] MANDATORY: switch to PLAN MODE (shift+tab) and plan per "
                     ".agents/prompts/planner.md — product-code edits are hook-blocked "
                     "until the plan is approved (Codex alternative: planner-high; "
                     "exploration: codex exec --profile explore -s read-only)")
        steps.append("[dev] Record new decisions as you go: forge.py decision new <slug>")
        plan_grill = load_json(factory / "grills" / "plan.json", default={})
        if plan_grill.get("verdict") != "pass" or plan_grill.get("issue") != state.get("issue_key"):
            steps.append("[dev] MANDATORY before approval: grill the plan (/grill-me, or "
                         ".agents/prompts/griller.md --gate plan) and record: "
                         "record_grill_from_json.py --gate plan — plan save refuses without it")
        steps.append("[dev] On approval: forge.py plan save --from <plan-file>")
    elif state.get("decomposition_status") != "recorded":
        phase("decomposing")
        steps.append("[dev] Run docs-decomposer (.agents/prompts/decomposer.md), then "
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
            stages = load_json(factory / "stages.json", default={}).get("stages", [])
            done_n = sum(1 for s in stages if s.get("status") == "done")
            current = next((s for s in stages if s.get("status") != "done"), None)
            if stages and current:
                if current.get("status") == "active":
                    action = f"{current['id']} is ACTIVE — {current.get('title')}"
                else:
                    action = (f"start {current['id']} ({current.get('title')}): "
                              f"forge stage start {current['id']}")
                steps.append(f"[dev] Stage progress: {done_n}/{len(stages)} done — {action}")
                steps.append("[dev] Stage Loop (WORKFLOW.md): /codex:rescue implements → "
                             "inspect diff → validate assumptions → smallest checks → "
                             "LOCAL autoreview until clean → commit → forge stage done — "
                             "then start the next stage WITHOUT asking; gates are the "
                             "permission (conduct §7)")
            steps.append("[dev] Implement the next bounded leaf task via /codex:rescue --background "
                         "(.agents/prompts/implementer.md)")
            if user_facing:
                steps.append("User-facing task: emil-design-eng + frontend-design are "
                             "MANDATORY (recorder refuses the artifact without them in "
                             "skills_used); apple-design advisory for gesture/motion — "
                             "harness.yaml required_skills")
            steps.append("[dev] The implementer writes/runs the tests and records: "
                         "record_test_from_json.py --kind automated --input <json>")
        elif not verify.get("ok"):
            phase("verifying")
            steps.append("[dev] Run: python3 .agents/scripts/verify.py")
        elif reviews_missing:
            phase("reviewing")
            steps.append("[dev] Run ONE autoreview pass in Codex, three lenses "
                         f"(.agents/prompts/reviewer.md); still to record: {', '.join(reviews_missing)} "
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
            steps.append("[dev] Run: python3 .agents/scripts/pr_ready.py (archives the task; merge stays manual)")
            steps.append("[EM] Next task afterwards: pick from ./forge roadmap list --pending, "
                         "then intake.py --issue <KEY> --title \"<title>\"")
    proposed = len(list((base / ".agents" / "skills" / "proposed").glob("*.md")))
    if proposed:
        steps.append(f"(Also: {proposed} proposed skill(s) await human review in "
                     ".agents/skills/proposed/)")
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
