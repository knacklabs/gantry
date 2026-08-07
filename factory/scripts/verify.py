#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from factory_lib import head_sha, gate, dump_json, now_iso, repo_root, run_cmd, run_state_path, verify_state_path, load_json
from forge_cli.events import append_event

parser = argparse.ArgumentParser(description="Run deterministic validation sequence")
parser.add_argument("--print-only", action="store_true", help="Only print the commands that would run")
args = parser.parse_args()

root = repo_root()
gate(root, signoff=True, approved_plan=True, decomposition=True)

# A default toolchain is a guess about someone else's project. When these are
# unset the old defaults ran pnpm, so a Python repo recorded a RED verify
# against a package.json it does not have — a gate failing for a reason that
# has nothing to do with the code. Worse in the other direction: a project
# whose pnpm scripts are no-ops would record green having tested nothing.
# Refuse instead, and say what to set.
PHASES = (
    ("structural", "FACTORY_STRUCTURAL_CMD"),
    ("typecheck", "FACTORY_TYPECHECK_CMD"),
    ("tests", "FACTORY_TEST_CMD"),
)
commands = [(phase, os.environ.get(variable) or "") for phase, variable in PHASES]
if unset := [variable for (_, variable), (_, command) in zip(PHASES, commands)
             if not command.strip()]:
    raise SystemExit(
        "verification is not configured: " + ", ".join(unset) + "\n"
        "Set each to the command this project actually runs, e.g.\n"
        "  FACTORY_STRUCTURAL_CMD='python3 factory/scripts/check_dual_runtime.py' \\\n"
        "  FACTORY_TYPECHECK_CMD='python3 factory/scripts/check_factory_scaffold.py' \\\n"
        "  FACTORY_TEST_CMD='uv run --with pytest python -m pytest factory/tests -q' \\\n"
        "  python3 factory/scripts/verify.py\n"
        "Put them in .envrc so every run and every worktree agrees."
    )

results = []
all_ok = True
for phase, command in commands:
    if args.print_only:
        print(f"{phase}: {command}")
        continue
    result = run_cmd(command, root)
    result["phase"] = phase
    results.append(result)
    if result["exit_code"] != 0:
        all_ok = False
        break

if args.print_only:
    raise SystemExit(0)

state = load_json(run_state_path(root), default={})
verify = {
    "ok": all_ok,
    "completed_at": now_iso(),
    "commit": head_sha(root),
    "results": results,
}
dump_json(verify_state_path(root), verify)
if state:
    state["verify_status"] = "passed" if all_ok else "failed"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
    append_event(root, "verify-passed" if all_ok else "verify-failed", actor="orchestrator",
                 story=state.get("issue_key", ""))

if not all_ok:
    failed = next((item for item in results if item["exit_code"] != 0), None)
    print(f"Verification failed at {failed['phase']}: {failed['command']}")
    raise SystemExit(1)

print("Verification passed")
