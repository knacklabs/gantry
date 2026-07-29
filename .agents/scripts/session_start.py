#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from factory_lib import load_json, read_hook_input, repo_root, run_state_path

payload = read_hook_input()
root = repo_root()
run_state = load_json(run_state_path(root), default={})

# Per-clone, idempotent: register the JSONL union merge driver that
# .gitattributes references, so two devs appending to .gstack stores merge
# cleanly. Quiet — configuration, not conversation.
attributes = root / ".gitattributes"
if attributes.exists() and "merge=jsonl-append" in attributes.read_text():
    have = subprocess.run(
        ["git", "config", "merge.jsonl-append.driver"],
        cwd=root, capture_output=True, text=True,
    )
    driver = Path.home() / ".claude" / "skills" / "gstack" / "bin" / "gstack-jsonl-merge"
    if have.returncode != 0 and driver.is_file():
        subprocess.run(
            ["git", "config", "merge.jsonl-append.driver", f"{driver} %O %A %B"],
            cwd=root, capture_output=True,
        )
context = []
# Machine readiness, EVERY session (milliseconds — existence checks only):
# a teammate who just cloned/pulled learns their machine is not ready at the
# first session, not at the first mid-task delegation failure.
from forge_cli.doctor import fast_status  # noqa: E402
required_missing, advisory_missing = fast_status()
if required_missing:
    context.append(
        f"MACHINE NOT READY: missing {', '.join(required_missing)} — say "
        "\"set up my machine\" (runs `./forge doctor --fix`; only logins stay "
        "manual). Delegation, review, and discovery will fail until fixed."
    )
elif advisory_missing:
    context.append(
        f"Machine: advisory tooling missing ({', '.join(advisory_missing)}) — "
        "user-facing tasks REQUIRE the design skills (recorders refuse "
        "unattested artifacts); `./forge doctor` lists the installs."
    )
# Frozen-gate integrity: surface drift at session start, not at ship time —
# the fix (re-vendor or upstream) is cheapest before work piles onto it.
from check_vendor_integrity import integrity_problems  # noqa: E402
gate_drift = integrity_problems(root)
if gate_drift:
    context.append(
        f"GATE SURFACE DRIFTED: {len(gate_drift)} vendored gate file(s) differ from "
        "constitution/VENDOR_MANIFEST.json — pr_ready will refuse. Re-vendor via "
        "`forge upgrade` or upstream the fix; never patch gates in place "
        "(python3 .agents/scripts/check_vendor_integrity.py)."
    )
if run_state.get("issue_key"):
    context += [
        f"Active issue: {run_state.get('issue_key')} — {run_state.get('title')}",
        f"Current phase: {run_state.get('phase')}",
        f"Plan status: {run_state.get('plan_status')}",
        f"Decomposition status: {run_state.get('decomposition_status')}",
        f"Client sign-off: {run_state.get('client_signoff', False)}",
    ]
    if run_state.get("client_signoff") and run_state.get("plan_status") != "approved":
        context.append(
            "PLANNING IS MANDATORY: enter PLAN MODE now (shift+tab) and plan per "
            ".agents/prompts/planner.md — the PreToolUse hook blocks product-code "
            "edits and non-read-only codex exec until the plan is saved and approved. "
            "The plan must be GRILLED before approval (/grill-me; record via "
            "record_grill_from_json.py --gate plan) — plan save refuses without it. "
            "Codex alternative: the planner-high agent."
        )
ledger = load_json(root / "docs" / "context" / "ledger.json", default={"files": {}})
pending = sum(1 for e in ledger.get("files", {}).values() if e.get("status") == "pending")
if pending:
    context.append(
        f"Unharvested context: {pending} file(s) in docs/context/ — harvest before planning."
    )
from forge_cli.signal import open_signals  # noqa: E402
signals = open_signals(root)
if signals:
    context.append(
        f"OPEN WORKER SIGNALS: {len(signals)} — paused worker(s) awaiting resolution "
        "(forge.py signal list --open; resolve, then resume the rescue)."
    )
from forge_cli.assumptions import open_count  # noqa: E402
assumptions_open = open_count(root)
if assumptions_open:
    context.append(
        f"Assumptions awaiting orchestrator guidance: {assumptions_open} "
        "(plans/assumptions.md — `forge.py assumptions list --open`)."
    )
scratchpad = root / ".factory" / "scratchpad.md"
if payload.get("source") == "compact" and scratchpad.exists():
    context.append(
        "COMPACTION SCRATCHPAD: .factory/scratchpad.md was snapshotted moments "
        "before this compaction — read it to re-anchor on recorded state "
        "(open signals, stages, assumptions) before trusting the summary."
    )
lessons_file = root / "plans" / "lessons.jsonl"
if lessons_file.exists():
    lesson_count = sum(1 for line in lessons_file.read_text().splitlines() if line.strip())
    if lesson_count:
        context.append(
            f"Lessons ledger: {lesson_count} — run `forge lesson relevant` against the "
            "paths you touch before planning/implementing."
        )
proposed = len(list((root / ".agents" / "skills" / "proposed").glob("*.md")))
if proposed:
    context.append(
        f"Proposed skills awaiting human review: {proposed} in .agents/skills/proposed/."
    )
if not context:
    print(json.dumps({}))
    raise SystemExit(0)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n".join(context)
    }
}))
