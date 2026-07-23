#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import dump_json, load_json, now_iso, repo_root, run_state_path

parser = argparse.ArgumentParser(description="Update factory run state")
parser.add_argument("--phase")
parser.add_argument("--plan-status")
parser.add_argument("--decomposition-status")
parser.add_argument("--implementation-status")
parser.add_argument("--tests-status")
parser.add_argument("--verify-status")
parser.add_argument("--review-status")
parser.add_argument("--pr-url")
args = parser.parse_args()

GATED_PHASES = {
    "planning",
    "decomposing",
    "awaiting-approval",
    "implementing",
    "testing",
    "reviewing",
    "functional-check",
    "pr-ready",
}

root = repo_root()
path = run_state_path(root)
state = load_json(path, default={})
if not state:
    raise SystemExit("Missing .factory/run.json. Run intake first.")
if args.phase in GATED_PHASES and not state.get("client_signoff"):
    raise SystemExit(
        f"Phase '{args.phase}' requires client sign-off. Get "
        "docs/decisions/NNNN-client-signoff.md accepted (non-empty confirmed_by), "
        "then run `python3 .agents/scripts/record_signoff.py` first."
    )
IMPL_PHASES = {"implementing", "testing", "reviewing", "functional-check", "pr-ready"}

issue = state.get("issue_key", "")
plan_files = list((root / "plans" / "active").glob(f"{issue}-*.md")) if issue else []
if args.plan_status == "approved" and not plan_files:
    raise SystemExit(
        "plan_status 'approved' requires the plan in-repo. Save it first with "
        f"`python3 .agents/scripts/forge.py plan save --from <plan-file>` "
        f"(expected plans/active/{issue or '<issue>'}-*.md). Approval is the plan "
        "file, not this flag."
    )
if args.phase in IMPL_PHASES:
    effective_plan_status = args.plan_status or state.get("plan_status")
    if effective_plan_status != "approved" or not plan_files:
        raise SystemExit(
            f"Phase '{args.phase}' requires an approved, saved plan "
            f"(plans/active/{issue or '<issue>'}-*.md with plan_status approved). "
            "Implementation never starts before plan approval."
        )
    effective_decomp = args.decomposition_status or state.get("decomposition_status")
    if effective_decomp != "recorded" or not (root / ".factory" / "decomposition.json").exists():
        raise SystemExit(
            f"Phase '{args.phase}' requires recorded decomposition "
            "(record_decomposition_from_json.py after plan approval). "
            "Implementation never starts before decomposition."
        )
for key, value in {
    "phase": args.phase,
    "plan_status": args.plan_status,
    "decomposition_status": args.decomposition_status,
    "implementation_status": args.implementation_status,
    "tests_status": args.tests_status,
    "verify_status": args.verify_status,
    "review_status": args.review_status,
    "pr_url": args.pr_url,
}.items():
    if value:
        state[key] = value
state["updated_at"] = now_iso()
dump_json(path, state)
print("Updated factory state")
