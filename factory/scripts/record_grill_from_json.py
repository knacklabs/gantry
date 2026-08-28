#!/usr/bin/env python3
"""Record a handover grill (.factory/grills/<gate>.json).

A grill is the adversarial gap/contradiction interrogation run BEFORE a
handover gate (factory/prompts/griller.md): `signoff` protects the client->PM
gate, `epics` protects the PM->EM gate. The downstream gate scripts
(record_signoff.py, forge roadmap import) refuse without a fresh, passing
grill — recording a verdict here is what makes "we checked for gaps" a fact
instead of a claim. A `blocked` verdict is recordable (it is the audit trail
of what blocked) but never satisfies a gate.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from factory_lib import (
    plan_digest_without_assumptions,
    dump_json, evidence_path, git_control_dir, grounding_digest, head_sha,
    load_json, now_iso, protected_decomposition_state_path, read_stdin_utf8,
    repo_root, requirements_digest, run_state_path, sha256_of,
    task_frontier_state, validate_payload,
)
from forge_cli.specs import resolve_spec_reference

VERDICTS = {"pass", "blocked"}
TASK_DECISIONS = {"keep", "split", "block"}
GATE_ROUND_FLOORS = {"spec": 2, "requirements": 1, "plan": 2, "task": 1}


def _non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_round_provenance(
    root: Path, payload: dict, gate: str, story: str, task_id: str = "",
) -> None:
    floor = GATE_ROUND_FLOORS[gate]
    rounds = payload.get("rounds")
    if not isinstance(rounds, list) or len(rounds) < floor:
        raise SystemExit(f"{gate} grill requires at least {floor} logged round(s)")

    ledger_rounds: list[dict] = []
    directories = (
        evidence_path(root, story, "grill-rounds"),
        evidence_path(root, None, "grill-rounds"),
    )
    for directory in dict.fromkeys(directories):
        if not directory.is_dir():
            continue
        for record_path in sorted(directory.glob("*.json")):
            record = load_json(record_path, default={})
            ledger_rounds.extend(
                entry for entry in record.get("questions", [])
                if isinstance(entry, dict)
            )

    current_name = f"grills/tasks/{task_id}.json" if gate == "task" \
        else f"grills/{gate}.json"
    current_story = story if gate in ("requirements", "plan", "task") else ""
    current_path = evidence_path(root, current_story, current_name)
    grill_directories = (
        evidence_path(root, story, "grills"),
        evidence_path(root, None, "grills"),
    )
    used_rounds: list[dict] = []
    for directory in dict.fromkeys(grill_directories):
        if not directory.is_dir():
            continue
        paths = [*directory.glob("*.json"), *directory.glob("tasks/*.json")]
        for grill_path in paths:
            saved = load_json(grill_path, default={})
            saved_rounds = saved.get("rounds")
            if grill_path == current_path and saved_rounds == rounds:
                continue
            if isinstance(saved_rounds, list):
                used_rounds.extend(
                    entry for entry in saved_rounds if isinstance(entry, dict)
                )

    available = list(ledger_rounds)
    for used in used_rounds:
        claimed = next((
            logged for logged in available
            if logged.get("question") == used.get("question")
            and logged.get("options") == used.get("options")
            and (
                logged.get("chosen") is None
                or logged.get("chosen") == used.get("chosen")
            )
        ), None)
        if claimed is not None:
            available.remove(claimed)
    for round_entry in rounds:
        if not isinstance(round_entry, dict):
            raise SystemExit(f"{gate} grill rounds entries must be objects")
        question = round_entry.get("question")
        options = round_entry.get("options")
        chosen = round_entry.get("chosen")
        match = next((
            logged for logged in available
            if logged.get("question") == question
            and logged.get("options") == options
            and (
                logged.get("chosen") is None
                or logged.get("chosen") == chosen
            )
        ), None)
        if match is None:
            raise SystemExit(
                f"{gate} grill round does not match an AskUserQuestion ledger record: "
                f"{question!r}"
            )
        available.remove(match)
    if rounds[-1].get("frontier_empty") is not True:
        raise SystemExit(f"{gate} grill final round requires frontier_empty true")


def _validate_task_grill(root: Path, payload: dict, task_id: str) -> dict:
    required = {
        "inspected_refs": list,
        "current_flow": str,
        "criteria_map": dict,
        "decision": str,
        "new_abstractions": list,
        "rounds": list,
        "citations": list,
    }
    for field, expected in required.items():
        if field not in payload:
            raise SystemExit(f"task grill missing required proof field {field!r}")
        if not isinstance(payload[field], expected):
            raise SystemExit(
                f"task grill proof field {field!r} must be {expected.__name__}"
            )

    if not payload["inspected_refs"]:
        raise SystemExit("task grill inspected_refs must name at least one working-tree path")
    for ref in payload["inspected_refs"]:
        if not _non_empty_string(ref):
            raise SystemExit("task grill inspected_refs entries must be non-empty strings")
        path_text = ref
        candidate = (root / path_text).resolve()
        if not candidate.exists() and ":" in path_text:
            path_text = path_text.rsplit(":", 1)[0]
            candidate = (root / path_text).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            raise SystemExit(f"task grill inspected ref escapes the working tree: {ref!r}")
        if not candidate.exists():
            raise SystemExit(f"task grill inspected ref path does not exist: {path_text!r}")

    if not payload["current_flow"].strip():
        raise SystemExit("task grill current_flow must not be empty")
    if payload["decision"] not in TASK_DECISIONS:
        raise SystemExit("task grill decision must be one of: keep, split, block")
    if payload["verdict"] == "pass" and payload["decision"] != "keep":
        raise SystemExit("task grill verdict 'pass' requires decision 'keep'")
    if any(not _non_empty_string(item) for item in payload["new_abstractions"]):
        raise SystemExit("task grill new_abstractions entries must be non-empty strings")
    if any(not _non_empty_string(gap) for gap in payload["gaps"]):
        raise SystemExit("task grill gaps entries must be non-empty strings")

    frontier = task_frontier_state(root)
    stage = next(
        (s for s in load_json(
            git_control_dir(root) / "stages.json", default={}
        ).get("stages", []) if s.get("id") == task_id),
        {},
    )
    # The frontier task grills before it starts; but an ACTIVE or DONE task may
    # be legitimately RE-grilled — a re-decomposition or a post-approval plan
    # edit stales its grill, and by then the frontier has moved past it. Accept
    # the target task itself in that case (validated against ITS OWN contract,
    # mirroring the seal check), and refuse only a task that is neither the
    # frontier nor active/done.
    if frontier is not None and frontier[1].get("id") == task_id:
        target = frontier[1]
    elif stage.get("status") in ("active", "done"):
        target = next(
            (t for t in load_json(
                protected_decomposition_state_path(root), default={}
            ).get("tasks", []) if t.get("id") == task_id),
            None,
        )
        if target is None:
            raise SystemExit(
                f"task grill target {task_id} is not in the protected decomposition"
            )
    else:
        frontier_id = frontier[1].get("id") if frontier else "none"
        raise SystemExit(
            f"task grill must cover the frontier task ({frontier_id}) or an "
            f"active/done task; {task_id} is neither"
        )
    criteria = target.get("acceptance_criteria") or []
    if set(payload["criteria_map"]) != set(criteria):
        missing = sorted(set(criteria) - set(payload["criteria_map"]))
        extra = sorted(set(payload["criteria_map"]) - set(criteria))
        raise SystemExit(
            "task grill criteria_map must cover every task acceptance "
            f"criterion exactly (missing={missing}, extra={extra})"
        )
    if any(not _non_empty_string(value) for value in payload["criteria_map"].values()):
        raise SystemExit("task grill criteria_map values must be non-empty strings")
    plan_contracts = target.get("plan_contracts")
    if not isinstance(plan_contracts, list) or not plan_contracts:
        raise SystemExit(
            "task grill requires the task's plan_contracts whose statements "
            "match criteria_map keys"
        )
    contract_statements = {
        contract.get("statement")
        for contract in plan_contracts
        if isinstance(contract, dict)
    }
    if contract_statements != set(payload["criteria_map"]):
        missing = sorted(set(payload["criteria_map"]) - contract_statements)
        extra = sorted(contract_statements - set(payload["criteria_map"]))
        raise SystemExit(
            "task grill criteria_map keys must equal protected plan_contracts "
            f"statements (missing={missing}, extra={extra})"
        )

    covered: set[str] = set()
    for entry in payload["rounds"]:
        if not isinstance(entry, dict):
            raise SystemExit("task grill rounds entries must be objects")
        question = entry.get("question")
        options = entry.get("options")
        chosen = entry.get("chosen")
        if (
            not _non_empty_string(question)
            or not isinstance(options, list)
            or not 2 <= len(options) <= 4
            or any(not _non_empty_string(option) for option in options)
            or not _non_empty_string(chosen)
            or chosen not in options
        ):
            raise SystemExit(
                "task grill rounds entries require {question, options, chosen}; "
                "options must contain two to four strings and chosen must be one of them"
            )
        covered.add(question)
    for entry in payload["citations"]:
        if not isinstance(entry, dict):
            raise SystemExit("task grill citations entries must be objects")
        finding = entry.get("finding")
        source = entry.get("source")
        if not _non_empty_string(finding) or not _non_empty_string(source):
            raise SystemExit(
                "task grill citations entries require a finding and named source document"
            )
        covered.add(finding)
    uncovered = [gap for gap in payload["gaps"] if gap not in covered]
    if uncovered:
        raise SystemExit(
            f"task grill gap(s) lack a rounds entry or citation: {uncovered}"
        )

    if payload["decision"] == "block":
        packet = payload.get("escalation_packet")
        packet_fields = {
            "issue", "evidence", "recommendation", "alternatives", "rollback",
        }
        if (
            not isinstance(packet, dict)
            or set(packet) != packet_fields
            or any(not _non_empty_string(packet[field]) for field in packet_fields)
        ):
            raise SystemExit(
                "task grill decision 'block' requires escalation_packet with exactly "
                "these non-empty string fields: issue, evidence, recommendation, "
                "alternatives, rollback"
            )
    return target


if any(
    arg == "--task-digest" or arg.startswith("--task-digest=")
    for arg in sys.argv[1:]
):
    raise SystemExit(
        "--task-digest is no longer accepted; the digest is derived from the "
        "protected contract, approved plan, and product tree"
    )

parser = argparse.ArgumentParser(description="Record a handover/plan grill from structured JSON")
parser.add_argument("--gate", required=True,
                    choices=["signoff", "spec", "epics", "requirements", "plan", "task"])
parser.add_argument("--input", help="Path to grill JSON. If omitted, read from stdin.")
parser.add_argument("--input-digest", dest="input_digest",
                    help="Path to the artifact this grill interrogated (roadmap input for "
                         "--gate spec/epics, the plan draft for --gate plan); its sha256 binds "
                         "the grill to THAT version. Required for epics and plan gates.")
parser.add_argument("--task", help="Task id for --gate task.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
else:
    raw = read_stdin_utf8().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
validate_payload(root, "grill", payload)
if payload.get("gate") != args.gate:
    raise SystemExit(f"payload gate {payload.get('gate')!r} does not match --gate {args.gate}")
if payload.get("verdict") not in VERDICTS:
    raise SystemExit(f"verdict must be one of {', '.join(sorted(VERDICTS))}")
# Parked findings count: an entry explicitly carried in open_items is a
# documented non-blocking park, not an unresolved blocker.
parked = len(payload.get("open_items") or [])
unresolved = (len(payload["gaps"]) + len(payload["contradictions"])
              - len(payload["resolutions"]) - parked)
if payload["verdict"] == "pass" and unresolved > 0:
    raise SystemExit(
        f"verdict 'pass' with {unresolved} unresolved finding(s) — every gap/contradiction "
        "needs a resolution (doc edit or decision record), an explicit open_items park, "
        "or the verdict is 'blocked'."
    )
if args.gate in ("spec", "epics", "plan"):
    if not args.input_digest:
        raise SystemExit(
            f"--gate {args.gate} requires --input-digest <artifact>: the grill must be "
            "bound to the exact spec / roadmap input / plan draft it interrogated."
        )
    digest_target = Path(args.input_digest).expanduser()
    if not digest_target.is_file():
        raise SystemExit(f"--input-digest {digest_target} not found")
    payload["input_sha256"] = (
        plan_digest_without_assumptions(digest_target)
        if args.gate == "plan" else sha256_of(digest_target)
    )
if args.gate == "requirements":
    if args.input_digest:
        raise SystemExit(
            "--gate requirements self-derives its digest; do not pass --input-digest"
        )
    issue = load_json(run_state_path(root), default={}).get("issue_key", "")
    if not issue:
        raise SystemExit("no active story — run intake before the requirements grill")
    items = load_json(root / "plans" / "roadmap.json", default={}).get("items", [])
    item = next((entry for entry in items if entry.get("key") == issue), None)
    spec_ref = item.get("spec") if isinstance(item, dict) else None
    if not isinstance(spec_ref, str) or not spec_ref.strip():
        raise SystemExit(f"active story {issue!r} has no confirmed spec")
    spec = resolve_spec_reference(root, spec_ref, confirmed=True)
    if payload.get("issue") and payload["issue"] != issue:
        raise SystemExit(
            f"payload issue {payload['issue']!r} does not match the active story {issue!r}"
        )
    payload["issue"] = issue
    payload["input_sha256"] = requirements_digest(root, spec)
if args.gate == "task":
    if not args.task:
        raise SystemExit("--gate task requires --task <id>")
    if Path(args.task).name != args.task or args.task in (".", ".."):
        raise SystemExit("--task must be a single task id, not a path")
    if payload.get("task_id") and payload["task_id"] != args.task:
        raise SystemExit(
            f"payload task_id {payload['task_id']!r} does not match --task {args.task!r}"
        )
    issue = load_json(run_state_path(root), default={}).get("issue_key", "")
    task_plan = evidence_path(root, issue, f"task-plans/{args.task}.md")
    if not task_plan.is_file():
        raise SystemExit(
            f"task grill requires a saved task plan first: run `./forge task plan "
            f"save {args.task} --from <path>`"
        )
    task = _validate_task_grill(root, payload, args.task)
    for field in ("approved_task_plan_sha256", "approved_by", "approved_at"):
        payload.pop(field, None)
    payload["task_id"] = args.task
    # Ground on the SAME treeish the seal (require_ready_task) uses: a DONE
    # task's grill seals against its stage baseline, so grounding the record on
    # the moving working tree would read perpetually stale and the re-grill of an
    # approved/completed task could never be seen fresh. A frontier/active task
    # still grounds on the working tree ("").
    _stage = next(
        (s for s in load_json(
            git_control_dir(root) / "stages.json", default={}
        ).get("stages", []) if s.get("id") == args.task),
        {},
    )
    if _stage.get("status") == "done":
        from forge_cli.stages import stage_baseline
        _treeish = stage_baseline(root, _stage)
    else:
        _treeish = ""
    payload["input_sha256"] = grounding_digest(root, task, treeish=_treeish)
    payload["task_plan_sha256"] = plan_digest_without_assumptions(task_plan)
if args.gate == "plan":
    # Plan grills are per task: stamp the active issue so a stale grill from
    # a previous task can never satisfy this one's plan save.
    issue = load_json(run_state_path(root), default={}).get("issue_key", "")
    if not issue:
        raise SystemExit("no active task (.factory/run.json issue_key) — run intake first")
    if payload.get("issue") and payload["issue"] != issue:
        raise SystemExit(
            f"payload issue {payload['issue']!r} does not match the active task {issue!r}"
        )
    payload["issue"] = issue
payload["recorded_at"] = now_iso()
payload["commit"] = head_sha(root)
active_story = load_json(run_state_path(root), default={}).get("issue_key", "")
if args.gate in GATE_ROUND_FLOORS:
    _validate_round_provenance(
        root, payload, args.gate, active_story, args.task or "",
    )
story = active_story \
    if args.gate in ("requirements", "plan", "task") else ""
if args.gate == "task":
    name = f"grills/tasks/{args.task}.json"
else:
    name = f"grills/{args.gate}.json"
dest = evidence_path(root, story, name, for_write=True)
dump_json(dest, payload)
print(f"Recorded {args.gate} grill: {payload['verdict']} "
      f"({len(payload['gaps'])} gap(s), {len(payload['contradictions'])} contradiction(s), "
      f"{len(payload['resolutions'])} resolution(s))")
