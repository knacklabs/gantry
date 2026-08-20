#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess

from factory_lib import (
    client_signoff,
    decomposition_state_path,
    dump_json,
    head_sha,
    load_json,
    load_review_artifacts,
    now_iso,
    protected_decomposition_state_path,
    repo_root,
    review_dir,
    run_state_path,
    story_dir,
    story_uses_scoped_layout,
    task_marker_on_main,
    task_marker_path,
    task_seal_shared_problems,
    tests_state_path,
    verify_state_path,
    require_closeout_order,
)
from forge_cli.assumptions import load_rows as load_assumptions
from forge_cli.decisions import decision_records
from forge_cli.events import append_event, load_events
from forge_cli.outcome import load_outcome, outcome_path
from forge_cli.roadmap import load_items, mark_status
from forge_cli.readiness import tests_passed
from forge_cli.review_brief import declared_contracts
from forge_cli.signal import signals_path
from forge_cli.stages import load_stages

# Commits touching only these paths after evidence was recorded do not
# invalidate it: evidence/plan/doc records, harness machinery and adapters
# (e.g. a forge upgrade mid-task), canon docs, and the preserved prototype.
# Evidence attests to PRODUCT code; everything listed here is not that.
EVIDENCE_PATHS = (
    ".factory/", "plans/", "docs/", "factory/", ".claude/", ".codex/",
    ".github/", "constitution/", "harness/", "prototype/", ".gstack/",
)
EVIDENCE_FILES = {"forge", "CLAUDE.md", "AGENTS.md", "WORKFLOW.md", "harness.yaml",
                  ".gitignore", ".gitattributes", ".envrc"}


def warn_unaccepted_decisions(root, issue_key: str) -> None:
    unaccepted = [r["id"] for r in decision_records(root)
                  if issue_key in r.get("stories", []) and r["status"] != "accepted"]
    if unaccepted:
        print(f"WARNING: {len(unaccepted)} decision(s) from this story are not accepted: "
              f"{', '.join(unaccepted)} — confirm with the human who decided them "
              "(./forge decision accept <slug> --by \"<name>\"), or they read as "
              "unratified six weeks from now.")


root = repo_root()
run_state = load_json(run_state_path(root), default={})
_active_key = run_state.get("issue_key", "")
if _active_key and story_uses_scoped_layout(root, _active_key) \
        and (story_dir(root, _active_key) / "shipped.json").is_file():
    print(f"PR_READY (already shipped in place: {_active_key})")
    raise SystemExit(0)
# Idempotent rerun: after a ship, task-scoped state is archived AND removed
# (parallel branches must converge without .factory conflicts), and run.json
# is reduced to STABLE project fields — identical across branches, so merges
# collide on nothing. "Shipped before" is evidenced by the history archive.
_history_root = root / ".factory" / "history"
if run_state and not run_state.get("issue_key") and client_signoff(root)[0] \
        and _history_root.is_dir() and any(_history_root.iterdir()):
    shipped = ", ".join(sorted(p.name for p in _history_root.iterdir() if p.is_dir()))
    print(f"PR_READY (nothing active; shipped so far: {shipped})")
    raise SystemExit(0)
decomposition = load_json(protected_decomposition_state_path(root), default={})
tests = load_json(tests_state_path(root), default={})
missing: list[str] = []
if not run_state:
    missing.append(".factory/run.json")
else:
    if not client_signoff(root)[0]:
        missing.append(
            "client sign-off (accepted docs/decisions/NNNN-client-signoff.md pinned as "
            "signoff_record in harness.yaml via record_signoff.py)"
        )
    if run_state.get("plan_status") != "approved":
        missing.append("approved plan status in .factory/run.json")
    if run_state.get("decomposition_status") != "recorded":
        missing.append("recorded decomposition status in .factory/run.json")
issue_key = run_state.get("issue_key", "")
plan_files = list((root / "plans" / "active").glob(f"{issue_key}-*.md")) if issue_key else []
archived_plans = (
    list((root / "plans" / "completed").glob(f"{issue_key}-*.md")) if issue_key else []
)
# Idempotent rerun: a task already gated pr-ready has its plan in plans/completed/.
if not plan_files and not (run_state.get("phase") == "pr-ready" and archived_plans):
    missing.append(
        f"plans/active/{issue_key or '<issue>'}-*.md (save the approved plan with "
        "`forge.py plan save`)"
    )
if not decomposition:
    missing.append(".factory/decomposition.json")
if bool(run_state.get("base_main_sha")) and decomposition:
    missing_markers = [
        task_marker_path(issue_key, task["id"]).as_posix()
        for task in decomposition.get("tasks", [])
        if not task_marker_on_main(root, issue_key, task["id"])
    ]
    if missing_markers:
        missing.append(
            "all task markers on origin/main before story closeout: "
            + ", ".join(missing_markers)
        )
missing.extend(require_closeout_order(root))

# Automated proof remains a separate readiness requirement; functional proof
# belongs to the ordered closeout chain above.
automated = tests.get("automated", {}) if tests else {}
if not automated:
    missing.append(".factory/tests.json:automated")
elif not tests_passed(automated):
    missing.append("automated testing must have no blockers, no failed status")
reviews, _review_problems = load_review_artifacts(root)

# Independent of the review recorder: existing artifacts may predate contract
# enforcement, so readiness reads the quality evidence and checks every id.
contracts = declared_contracts(decomposition)
if contracts:
    verdicts_by_id: dict[str, list[str]] = {}
    recorded_verdicts = reviews.get("quality", {}).get("contract_verdicts")
    if not isinstance(recorded_verdicts, list):
        recorded_verdicts = []
    for verdict in recorded_verdicts:
        if not isinstance(verdict, dict):
            continue
        contract_id = verdict.get("contract_id")
        value = verdict.get("verdict")
        if isinstance(contract_id, str) and isinstance(value, str):
            verdicts_by_id.setdefault(contract_id, []).append(value)
    unverified = [contract["id"] for contract in contracts
                  if verdicts_by_id.get(contract["id"]) != ["implemented"]]
    if unverified:
        missing.append(
            "quality review must verify every plan contract as implemented; "
            f"unverified: {', '.join(unverified)} — compose the reviewer prompt "
            "with `./forge review-brief --all`"
        )

# The refactor ratchet: a refactor-tagged story that GREW product source is
# not a refactor — it must shrink or hold the line (decision 0005 doctrine).
story = next((i for i in load_items(root) if i.get("key") == issue_key), None) \
    if issue_key else None
if story and story.get("kind") == "refactor":
    from check_refactor_delta import net_delta, resolve_base
    ratchet_base = resolve_base(root)
    if ratchet_base:
        delta, detail = net_delta(root, ratchet_base)
        if delta > 0:
            missing.append(
                f"refactor ratchet: net product-source delta is +{delta} lines vs "
                f"{ratchet_base} ({'; '.join(detail[:3])}) — shrink it, or reclassify "
                "the story by roadmap PR if it genuinely must add code "
                "(check_refactor_delta.py shows the breakdown)"
            )

# Frozen-gate integrity: a tampered gate invalidates every other gate, so a
# drifted vendored surface is the one audit finding that DOES block a ship.
# No manifest (pre-manifest vendoring, or the harness repo itself) = unarmed.
from check_vendor_integrity import integrity_problems  # noqa: E402
gate_drift = integrity_problems(root)
if gate_drift:
    head_problems = "; ".join(gate_drift[:3])
    more = f" (+{len(gate_drift) - 3} more)" if len(gate_drift) > 3 else ""
    missing.append(
        f"vendor integrity: gate surface drifted from constitution/VENDOR_MANIFEST.json "
        f"— {head_problems}{more}. Locally edited gates make evidence unverifiable; "
        "re-vendor via `forge upgrade` or upstream the fix "
        "(python3 factory/scripts/check_vendor_integrity.py)"
    )

# Task sealing and story closeout share the no-open-state and clean-tree
# predicates. Story closeout adds its verify/review/outcome chain above.
missing.extend(task_seal_shared_problems(root, issue_key))

# Assumptions are guided before shipping: the orchestrator confirms, demands
# a fix, or promotes each one — an unguided assumption is an unreviewed call.
# The only artifact written after the work: without it the record can say a
# story shipped but never what it delivered, which is the question a reader
# asks six weeks later. Recorded via `forge outcome set`, never hand-written.
outcome_record = load_outcome(root)

# Provenance: every evidence artifact carries the commit it was recorded at;
# all must agree, and no code may have changed since (evidence-only commits ok).
# Decomposition is a plan-side artifact — recorded BEFORE implementation by
# design — so it must be stamped but is exempt from same-commit/freshness.
head = head_sha(root)
if decomposition and not decomposition.get("commit") and head:
    missing.append(
        "commit provenance on: decomposition (re-record with current tooling)"
    )
stamps: dict[str, str | None] = {}
if tests:
    stamps["tests"] = tests.get("commit")
unstamped = [label for label, sha in stamps.items() if not sha]
if unstamped and head:
    missing.append(
        f"commit provenance on: {', '.join(unstamped)} (re-record with current tooling — "
        "artifacts without a commit stamp are unverifiable evidence)"
    )
elif head and stamps:
    distinct = {sha for sha in stamps.values()}
    if len(distinct) > 1:
        missing.append(
            f"consistent evidence: artifacts span commits {sorted(s[:8] for s in distinct)} — "
            "re-record so all evidence reflects one code state"
        )
    else:
        stamp = distinct.pop()
        if stamp != head:
            proc = subprocess.run(
                ["git", "diff", "--name-only", f"{stamp}..{head}"],
                cwd=root, capture_output=True, text=True,
                encoding="utf-8", errors="surrogateescape",
            )
            if proc.returncode != 0:
                missing.append(
                    f"evidence commit {stamp[:8]} is unknown to this repo — re-record"
                )
            else:
                code_changes = [
                    f for f in proc.stdout.splitlines()
                    if f and not f.startswith(EVIDENCE_PATHS) and f not in EVIDENCE_FILES
                ]
                if code_changes:
                    missing.append(
                        f"fresh evidence: code changed since it was recorded at {stamp[:8]} "
                        f"({', '.join(code_changes[:5])}) — rerun verify/tests/reviews"
                    )

if missing:
    print("PR not ready:")
    for item in missing:
        print(f"- {item}")
    raise SystemExit(1)

# The compaction scratchpad is session noise, never evidence — a shipped
# task starts the next one with a clean pad in either layout.
scratchpad_file = root / ".factory" / "scratchpad.md"
if scratchpad_file.exists():
    scratchpad_file.unlink()

# Scoped stories already own durable evidence paths. Shipping is a state
# transition inside that directory: no plan/evidence move and no cleanup that
# could strand a reader on the old location. Legacy stories continue through
# the archive block below unchanged.
if story_uses_scoped_layout(root, issue_key):
    shipped_at = now_iso()
    run_state["phase"] = "shipped"
    run_state["review_status"] = "passed"
    run_state["tests_status"] = "passed"
    run_state["updated_at"] = shipped_at
    dump_json(run_state_path(root), run_state)
    dump_json(story_dir(root, issue_key) / "shipped.json", {
        "generated_by": "orchestrator",
        "story": issue_key,
        "phase": "shipped",
        "shipped_at": shipped_at,
    })
    append_event(root, "shipped", actor="orchestrator", story=issue_key,
                 detail=(outcome_record or {}).get("outcome", "")[:200])
    roadmap_done = mark_status(
        root, issue_key, "done", completed_at=shipped_at,
        history=f".factory/stories/{issue_key}/",
        outcome=(outcome_record or {}).get("outcome", ""),
    )
    warn_unaccepted_decisions(root, issue_key)
    roadmap_result = f"; Roadmap: {issue_key} marked done" if roadmap_done else ""
    print(f"PR_READY (shipped in place at .factory/stories/{issue_key}/; "
          f"evidence paths unchanged){roadmap_result}")
    raise SystemExit(0)

# Move the plan to plans/completed/ FIRST, so the run state we persist and
# archive references the plan's final location, not a path about to vanish.
completed = root / "plans" / "completed"
completed.mkdir(parents=True, exist_ok=True)
for plan_file in plan_files:
    shutil.move(str(plan_file), completed / plan_file.name)
    run_state["plan_file"] = (completed / plan_file.name).relative_to(root).as_posix()

run_state["phase"] = "pr-ready"
run_state["review_status"] = "passed"
run_state["tests_status"] = "passed"
run_state["updated_at"] = now_iso()
dump_json(run_state_path(root), run_state)

# Archive what was decided and built: run artifacts to .factory/history/<issue>.
# This is the durable "what was built" record.
history = root / ".factory" / "history" / issue_key
history.mkdir(parents=True, exist_ok=True)
for artifact in (run_state_path(root), decomposition_state_path(root),
                 verify_state_path(root), tests_state_path(root)):
    if artifact.exists():
        shutil.copy2(artifact, history / artifact.name)
if review_dir(root).is_dir():
    shutil.copytree(review_dir(root), history / "reviews", dirs_exist_ok=True)

# Archived means REMOVED from the working tree: task-scoped state left behind
# is exactly what conflicts when parallel story branches merge (decision 0002
# follow-up from the parallel pilot). History keeps the full record.
if signals_path(root).exists():
    shutil.copy2(signals_path(root), history / "signals.jsonl")
stages_file = root / ".factory" / "stages.json"
if stages_file.exists():
    shutil.copy2(stages_file, history / "stages.json")
# The interrogation record of this story: what contradictions the plan grill
# surfaced and how they were answered. Only plan.json is task-scoped — the
# epics and signoff grills are project-level and stay put.
plan_grill = root / ".factory" / "grills" / "plan.json"
if plan_grill.exists():
    (history / "grills").mkdir(exist_ok=True)
    shutil.copy2(plan_grill, history / "grills" / "plan.json")
# Task grills are task-scoped like plan.json (the JIT per-task grill, 0032/0025):
# archive the whole tasks/ dir so a story's per-task interrogation is preserved,
# not cleaned away. (D-0013.)
task_grills = root / ".factory" / "grills" / "tasks"
if task_grills.is_dir() and any(task_grills.iterdir()):
    (history / "grills").mkdir(exist_ok=True)
    shutil.copytree(task_grills, history / "grills" / "tasks", dirs_exist_ok=True)
# Recorded before the archive below, or the ship event is left behind.
append_event(root, "shipped", actor="orchestrator", story=issue_key,
             detail=(outcome_record or {}).get("outcome", "")[:200])
# COPIED, never moved: a union-merged file cannot be pruned (decision 0017).
story_events = load_events(root, story=issue_key)
if story_events:
    (history / "events.jsonl").write_text(
        "".join(json.dumps(e) + "\n" for e in story_events), encoding="utf-8")
# The assumptions made while building this story explain behaviour that later
# reads as a bug; they live in a cross-project table that gets archived on its
# own cadence, so the story keeps its own copy.
story_assumptions = [r for r in load_assumptions(root) if r.get("issue") == issue_key]
if story_assumptions:
    dump_json(history / "assumptions.json", story_assumptions)
if outcome_path(root).exists():
    shutil.copy2(outcome_path(root), history / "outcome.json")
# The stage baselines go with the stage state they belong to (decision 0023).
# They are refs, so nothing else prunes them, and a stale one would still
# resolve for a task id the next story happens to reuse.
for stage in (load_stages(root) or {}).get("stages", []):
    subprocess.run(
        ["git", "update-ref", "-d", f"refs/forge/stage/{stage.get('id', '')}"],
        cwd=root, capture_output=True,
    )
for artifact in (decomposition_state_path(root), verify_state_path(root),
                 tests_state_path(root), root / ".factory" / "grills" / "plan.json",
                 signals_path(root), stages_file, outcome_path(root)):
    if artifact.exists():
        artifact.unlink()
if review_dir(root).is_dir():
    shutil.rmtree(review_dir(root))
task_grills_dir = root / ".factory" / "grills" / "tasks"
if task_grills_dir.is_dir():
    shutil.rmtree(task_grills_dir)  # archived above (D-0013)
# STABLE content only: no per-task fields, no timestamps — two story
# branches shipping in parallel write byte-identical run.json.
project_state = {
    k: run_state[k]
    for k in ("project",)
    if k in run_state
}
project_state["phase"] = "shipped"
dump_json(run_state_path(root), project_state)

roadmap_done = mark_status(root, issue_key, "done", completed_at=now_iso(),
                           history=f".factory/history/{issue_key}/",
                           outcome=(outcome_record or {}).get("outcome", ""))
# Advisory: a decision this story created that no human ever confirmed still
# governs the code that shipped. Blocking would freeze legacy corpora, so this
# names them instead — an unaccepted record is a question left open.
warn_unaccepted_decisions(root, issue_key)
roadmap_result = f"; Roadmap: {issue_key} marked done" if roadmap_done else ""
print(f"PR_READY (archived to .factory/history/{issue_key}/, plan moved to plans/completed/, "
      f"task-scoped .factory state cleaned){roadmap_result}")
