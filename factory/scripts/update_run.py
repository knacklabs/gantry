#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import (
    client_signoff, dump_json, load_json, now_iso, repo_root, review_dir, run_state_path,
    tests_state_path, verify_state_path,
)

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
PHASE_PREREQS = {
    "reviewing": (
        ("successful .factory/verify.json",
         lambda base: load_json(verify_state_path(base), default={}).get("ok") is True),
        (".factory/tests.json",
         lambda base: tests_state_path(base).is_file()),
    ),
    "functional-check": tuple(
        (f".factory/reviews/{aspect}.json",
         lambda base, name=aspect: (review_dir(base) / f"{name}.json").is_file())
        for aspect in ("quality", "performance", "security")
    ),
}

root = repo_root()
path = run_state_path(root)
state = load_json(path, default={})
if not state:
    raise SystemExit("Missing .factory/run.json. Run intake first.")
if args.phase == "pr-ready":
    raise SystemExit(
        "Phase 'pr-ready' is reachable only through "
        "`python3 factory/scripts/pr_ready.py`; update_run.py cannot set it directly."
    )
if args.phase in GATED_PHASES:
    ok, why = client_signoff(root)
    if not ok:
        raise SystemExit(f"Phase '{args.phase}' requires client sign-off. {why}")
IMPL_PHASES = {"implementing", "testing", "reviewing", "functional-check", "pr-ready"}

issue = state.get("issue_key", "")
plan_files = list((root / "plans" / "active").glob(f"{issue}-*.md")) if issue else []
# Approval is `forge plan save` and nothing else. Accepting the flag here let
# a locked worker hand-write plans/active/<issue>-x.md (plans/ is writable
# during planning), flip this field, and skip every gate plan save enforces —
# grill digest, decisions_reviewed coverage, contradiction signals, Surface
# Impact. Same treatment as --phase pr-ready.
if args.plan_status == "approved":
    raise SystemExit(
        "plan_status 'approved' is set only by "
        "`python3 factory/scripts/forge.py plan save --from <plan-file>`, which "
        "runs the approval gates. update_run.py cannot set it: approval is the "
        "saved plan, not this flag."
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
missing_prereqs = [
    label for label, ready in PHASE_PREREQS.get(args.phase, ())
    if not ready(root)
]
if missing_prereqs:
    raise SystemExit(
        f"Phase '{args.phase}' requires: {', '.join(missing_prereqs)}. "
        "Complete the preceding artifact gates first."
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
if args.phase:
    from forge_cli.events import append_event
    append_event(root, args.phase, actor="orchestrator",
                 story=state.get("issue_key", ""))
print("Updated factory state")
