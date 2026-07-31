#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

from factory_lib import (
    decomposition_state_path, dump_json, gate, head_sha, load_json, now_iso,
    protected_decomposition_state_path, repo_root, run_state_path,
    safe_factory_write_json, validate_payload,
)
from forge_cli.doctor import unrunnable_reason

parser = argparse.ArgumentParser(description="Record decomposition from structured JSON")
parser.add_argument("--input", help="Path to decomposition JSON. If omitted, read from stdin.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text())
else:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
state = gate(root, signoff=True, approved_plan=True)
validate_payload(root, "decomposition", payload)
tasks = payload.get("tasks") or []
if not tasks:
    raise SystemExit(
        "decomposition needs at least one leaf task — an empty task graph opens the "
        "implementation gates with nothing bounded to implement."
    )
OBJECTIVE_MAX = 500
for pos, task in enumerate(tasks, 1):
    if not isinstance(task, dict) or not isinstance(task.get("id"), str) \
            or not isinstance(task.get("title"), str) or not task["id"].strip():
        raise SystemExit(
            f"decomposition task {pos} must be an object with string 'id' and 'title' "
            "(plus write_scope/acceptance_criteria per the decomposer contract)."
        )
    # The narrative fields were prompt-convention and silently droppable, so a
    # task could reach the board as an id and a title. They are the contract now.
    objective = task.get("objective")
    if not isinstance(objective, str) or not objective.strip():
        raise SystemExit(
            f"decomposition task {task['id']}: 'objective' is required — one or two "
            "sentences of what this task changes and why, in a reader's language."
        )
    if len(objective) > OBJECTIVE_MAX:
        raise SystemExit(
            f"decomposition task {task['id']}: 'objective' is {len(objective)} chars "
            f"(max {OBJECTIVE_MAX}) — it is the summary a human reads, not the "
            "implementation transcript; put the detail in the plan."
        )
    for proof_pos, proof in enumerate(task.get("required_tests") or [], 1):
        if not isinstance(proof, dict):
            raise SystemExit(
                f"decomposition task {task['id']}: required_tests entry "
                f"{proof_pos} must be an object with id, path and command; "
                "opaque test names are not executable proof."
            )
        if set(proof) != {"id", "path", "command"} or not all(
            isinstance(proof.get(key), str) and proof[key].strip()
            for key in ("id", "path", "command")
        ):
            raise SystemExit(
                f"decomposition task {task['id']}: required_tests entry "
                f"{proof_pos} needs exactly non-empty id, path and command strings."
            )
        rel = Path(proof["path"])
        if rel.is_absolute() or ".." in rel.parts or os.path.normpath(proof["path"]) != proof["path"]:
            raise SystemExit(
                f"decomposition task {task['id']}: required test path "
                f"{proof['path']!r} must be a normalized repo-relative path."
            )
        try:
            tokens = shlex.split(proof["command"])
        except ValueError as exc:
            raise SystemExit(
                f"decomposition task {task['id']}: required test command is not "
                f"parseable as argv ({exc})."
            )
        forbidden = {";", "&&", "||", "|", "&", ">", ">>", "<", "<<", "#"}
        if any(token in forbidden or token.startswith("#") for token in tokens):
            raise SystemExit(
                f"decomposition task {task['id']}: required test command must be "
                "one shell-free runner invocation, not a compound/commented command."
            )
        executable_pos = 0
        while (
            executable_pos < len(tokens)
            and "=" in tokens[executable_pos]
            and not tokens[executable_pos].startswith("=")
        ):
            executable_pos += 1
        executable = (
            Path(tokens[executable_pos]).name.lower()
            if executable_pos < len(tokens) else ""
        )
        if executable in {
            "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
            "pwsh", "powershell", "cmd", "cmd.exe", "env",
        }:
            raise SystemExit(
                f"decomposition task {task['id']}: required test command must "
                f"invoke the runner directly; shell/env wrapper {executable!r} "
                "is not shell-free."
            )
        if not any("{report}" in token for token in tokens):
            raise SystemExit(
                f"decomposition task {task['id']}: required test command "
                "must include a {report} placeholder for fresh JUnit proof."
            )
        if not any("{path}" in token for token in tokens):
            raise SystemExit(
                f"decomposition task {task['id']}: required test command "
                "must include a runner-native {path} placeholder."
            )
        if not any("{id}" in token for token in tokens):
            raise SystemExit(
                f"decomposition task {task['id']}: required test command "
                "must include a runner-native {id} placeholder."
            )
        reason = unrunnable_reason(proof["command"])
        if reason:
            raise SystemExit(
                f"decomposition task {task['id']}: required test command "
                f"{proof['command']!r} {reason}."
            )
    # `stage done` runs these. An entry that cannot execute is not a check, and
    # in practice it was prose ("package test script") nobody ever ran.
    for command in task.get("verify_commands") or []:
        reason = unrunnable_reason(str(command))
        if reason:
            raise SystemExit(
                f"decomposition task {task['id']}: verify_commands entry "
                f"{str(command)!r} {reason}. `forge stage done` executes every "
                "entry, so an unrunnable one is a gate that can never pass — "
                "write the command that proves this task, not a description of it."
            )
    criteria = task.get("acceptance_criteria")
    if not isinstance(criteria, list) or not criteria or not all(
        isinstance(c, str) and c.strip() for c in criteria
    ):
        raise SystemExit(
            f"decomposition task {task['id']}: 'acceptance_criteria' must be a "
            "non-empty list of non-empty strings — a task nobody can check is done "
            "cannot be reviewed."
        )
from forge_cli.delegate import delegation_exclusion  # noqa: E402
from forge_cli.stages import (  # noqa: E402
    load_stages, task_digest, write_skeleton, write_stages,
)

# Stage transitions and decomposition publication share one protected state
# lock. A re-record may amend an active task, but never rewrite the contract a
# completed stage already attested or race that stage's done transition.
with delegation_exclusion(
        root, "stages", kind="stage-state", namespace="state"):
    state = gate(root, signoff=True, approved_plan=True)
    current_tasks = {
        task.get("id"): task for task in tasks if isinstance(task, dict)
    }
    prior_decomposition = load_json(
        protected_decomposition_state_path(root), default={})
    prior_tasks = {
        task.get("id"): task
        for task in prior_decomposition.get("tasks") or []
        if isinstance(task, dict)
    }
    stages_data = load_stages(root)
    backfilled_stage_digest = False
    for stage in stages_data.get("stages") or []:
        if stage.get("status") not in {"active", "done"}:
            continue
        task_id = stage.get("id")
        new = current_tasks.get(task_id)
        if new is None:
            raise SystemExit(
                f"decomposition task {task_id}: an {stage.get('status')} stage "
                "cannot be removed or renamed; finish it or record it incomplete "
                "before changing the task list."
            )
        if stage.get("status") == "done":
            recorded_digest = stage.get("task_sha256")
            new_digest = task_digest(new)
            if not recorded_digest:
                prior = prior_tasks.get(task_id)
                if prior is None or task_digest(prior) != new_digest:
                    raise SystemExit(
                        f"decomposition task {task_id}: a completed stage's "
                        "legacy contract cannot be changed or removed; add a "
                        "new follow-up task instead."
                    )
                stage["task_sha256"] = new_digest
                backfilled_stage_digest = True
            elif new_digest != recorded_digest:
                raise SystemExit(
                    f"decomposition task {task_id}: a completed stage's contract "
                    "cannot be changed or removed; add a new follow-up task instead."
                )
    if backfilled_stage_digest:
        write_stages(root, stages_data)
    payload["commit"] = head_sha(root)
    dump_json(protected_decomposition_state_path(root), payload)
    safe_factory_write_json(root, decomposition_state_path(root).name, payload)
    # The decomposition is immutable evidence; the stage tracker is its mutable
    # execution twin (decision 0007) — pr_ready refuses while stages are open.
    write_skeleton(root, state.get("issue_key", ""), tasks)
    state["decomposition_status"] = "recorded"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
    from forge_cli.events import append_event  # noqa: E402
    append_event(root, "decomposed", actor="docs-decomposer",
                 story=state.get("issue_key", ""), detail=f"{len(tasks)} task(s)")
print(f"Recorded decomposition ({len(tasks)} stage(s) -> .factory/stages.json; "
      "work them with `forge stage start/done`)")
