#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from factory_lib import load_json, read_hook_input, repo_root, run_state_path
from stage_playbook import render_stage_context

payload = read_hook_input()
prompt = (payload.get("prompt") or "").lower()
run_state = load_json(run_state_path(repo_root()), default={})
enforce_intake = os.environ.get("FACTORY_ENFORCE_INTAKE", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
needs_build = any(word in prompt for word in ["implement", "build", "code", "fix", "ship"])


def emit_context(extra: str = "") -> None:
    context = (
        "If the request is vague, convert it into acceptance criteria and capability-driven task decomposition before coding. "
        "Use the planner and decomposer prompts rather than improvising the task graph inline.\n"
        + render_stage_context(run_state)
    )
    if extra:
        context = f"{extra}\n{context}"
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }))


if needs_build and not run_state and enforce_intake:
    print(json.dumps({"decision": "block", "reason": "No factory state found. Run intake, planning, and decomposition before implementation."}))
    raise SystemExit(0)
if needs_build and not run_state:
    emit_context(
        "No factory state found. Bootstrap now:\n"
        "- python3 .codex/scripts/intake.py --issue ENG-123 --title \"Feature title\"\n"
        "- run planner-high and approve the plan\n"
        "- run docs-decomposer and record decomposition",
    )
    raise SystemExit(0)
if needs_build and run_state.get("plan_status") in {"needs-plan", "awaiting-approval"}:
    print(json.dumps({"decision": "block", "reason": "Implementation is blocked until the plan is approved."}))
    raise SystemExit(0)
if needs_build and run_state.get("decomposition_status") != "recorded":
    print(json.dumps({"decision": "block", "reason": "Implementation is blocked until decomposition is recorded."}))
    raise SystemExit(0)
emit_context()
