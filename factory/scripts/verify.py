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
# Required phases: every project must declare these three (no toolchain guess).
REQUIRED_PHASES = (
    ("structural", "FACTORY_STRUCTURAL_CMD"),
    ("typecheck", "FACTORY_TYPECHECK_CMD"),
    ("tests", "FACTORY_TEST_CMD"),
)
# Optional maintainability gate: a project declares its own linter/formatter/
# style command (ESLint, Biome, ruff, golangci-lint, ...). Language-agnostic by
# design — unset means skipped, never a guessed default. Runs AFTER typecheck
# and BEFORE tests, so structure/style problems fail fast and cheap.
OPTIONAL_PHASES = (
    ("quality", "FACTORY_QUALITY_CMD"),
)
if unset := [variable for _, variable in REQUIRED_PHASES
             if not (os.environ.get(variable) or "").strip()]:
    raise SystemExit(
        "verification is not configured: " + ", ".join(unset) + "\n"
        "Set each to the command this project actually runs, e.g.\n"
        "  FACTORY_STRUCTURAL_CMD='python3 factory/scripts/check_dual_runtime.py' \\\n"
        "  FACTORY_TYPECHECK_CMD='python3 factory/scripts/check_factory_scaffold.py' \\\n"
        "  FACTORY_QUALITY_CMD='<your linter, optional>' \\\n"
        "  FACTORY_TEST_CMD='uv run --with pytest --with psutil python -m pytest factory/tests -q' \\\n"
        "  python3 factory/scripts/verify.py\n"
        "Put them in .envrc so every run and every worktree agrees."
    )
# Ordered: structural -> typecheck -> quality (if declared) -> tests.
_ordered = (REQUIRED_PHASES[0], REQUIRED_PHASES[1]) + OPTIONAL_PHASES + (REQUIRED_PHASES[2],)
commands = [(phase, os.environ.get(variable) or "")
            for phase, variable in _ordered
            if (os.environ.get(variable) or "").strip()]

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
dump_json(verify_state_path(root, for_write=True), verify)
# During a stage-done proof run (forge sets FORGE_PROCESS_TOKEN) verify stays
# read-only: mutating run.json or appending an event here churns the protected
# authority and events ledger between the proof's before/after snapshots, so the
# stage refused its own read-only check. Standalone runs still update run-state so
# `forge next` reflects the latest verify result.
if state and not os.environ.get("FORGE_PROCESS_TOKEN"):
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
