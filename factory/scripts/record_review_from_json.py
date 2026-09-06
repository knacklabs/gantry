#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from factory_lib import (
    branch_diff_digest, dump_json, gate, head_sha, load_json, now_iso,
    evidence_path, proof_path, protected_decomposition_state_path, repo_root,
    require_skills,
    read_stdin_utf8, run_state_path, story_dir, validate_payload,
)
from forge_cli.events import append_event
from forge_cli.readiness import review_passed
from forge_cli.review_brief import declared_contracts
from forge_cli.stages import (
    load_stages, stage_review_binding, task_for, write_stages,
)


def ensure_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(value)]


def ensure_findings(field: str, value):
    """Findings may be plain strings or structured {category, area, summary}
    objects — structure is what lets `forge findings patterns` cluster the
    same defect class across tasks. A malformed object is refused, not
    silently stringified into an unclusterable repr."""
    findings = []
    for pos, entry in enumerate(value if isinstance(value, list) else ensure_list(value), 1):
        if isinstance(entry, dict):
            if not isinstance(entry.get("category"), str) or not entry["category"].strip() \
                    or not isinstance(entry.get("summary"), str) or not entry["summary"].strip():
                raise SystemExit(
                    f"{field}[{pos}]: a structured finding needs non-empty string "
                    "'category' and 'summary' (optional string 'area') — see "
                    "factory/schemas/review.json findings_note."
                )
            if "area" in entry and not isinstance(entry["area"], str):
                raise SystemExit(f"{field}[{pos}]: 'area' must be a string")
            findings.append(entry)
        elif isinstance(entry, str) and entry.strip():
            findings.append(entry)
    return findings


parser = argparse.ArgumentParser(description="Record a review artifact from structured JSON")
parser.add_argument(
    "--aspect", required=True,
    choices=["quality", "performance", "security", "stage-local"],
)
parser.add_argument(
    "--task", default="",
    help="task this review covers; defaults to the task this worktree runs")
parser.add_argument("--input", help="Path to a JSON file. If omitted, read JSON from stdin.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
else:
    raw = read_stdin_utf8().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
state = gate(
    root,
    signoff=True,
    approved_plan=True,
    decomposition=True,
    lite_window_ok=True,
)
validate_payload(root, "review", payload)
require_skills(root, "review", payload)
# A review is ALWAYS about one task's diff, so it is stored under that task.
# Story-scoped storage meant every task overwrote the last one's review, and a
# story's recorded review described whichever task happened to run last.
path = proof_path(
    root, state.get("issue_key"), f"reviews/{args.aspect}.json",
    task_id=args.task, for_write=True,
)
review = dict(payload)
review["aspect"] = args.aspect
for key in ("blocking_findings", "non_blocking_findings"):
    review[key] = ensure_findings(key, payload.get(key))

# The protected decomposition twin survives a ship (pr_ready cleans only .factory/),
# so a shipped story's contracts must not demand later quickfix quality-review verdicts.
if args.aspect == "quality" and state.get("decomposition_status") == "recorded":
    decomposition = load_json(protected_decomposition_state_path(root), default={})
    contracts = declared_contracts(decomposition)
    # Per-task proof (0049): a task's review verdicts the contracts of tasks
    # that have started or shipped — its own and the done ones — never those
    # of tasks that have not begun. When every stage is done (story closeout)
    # this is still the full union.
    started = {
        stage.get("id") for stage in load_stages(root).get("stages", [])
        if isinstance(stage, dict) and stage.get("status") in {"active", "done"}
    }
    if started:
        owner: dict[str, str] = {}
        for task in decomposition.get("tasks") or []:
            if isinstance(task, dict) and isinstance(task.get("id"), str):
                for contract in task.get("plan_contracts") or []:
                    if isinstance(contract, dict) and isinstance(contract.get("id"), str):
                        owner[contract["id"]] = task["id"]
        contracts = [c for c in contracts if owner.get(c["id"]) in started]
    if contracts:
        expected = {contract["id"]: contract for contract in contracts}
        verdicts = payload.get("contract_verdicts")
        if not isinstance(verdicts, list):
            raise SystemExit(
                "quality review contract_verdicts must be a list covering every "
                "declared plan contract"
            )
        seen: set[str] = set()
        for pos, verdict in enumerate(verdicts, 1):
            if not isinstance(verdict, dict) or set(verdict) != {
                    "contract_id", "verdict", "evidence"}:
                raise SystemExit(
                    f"contract_verdicts[{pos}] needs exactly contract_id, verdict "
                    "and evidence"
                )
            contract_id = verdict.get("contract_id")
            if not isinstance(contract_id, str) or contract_id not in expected:
                raise SystemExit(
                    f"contract_verdicts[{pos}]: unknown contract id "
                    f"{contract_id!r}"
                )
            if contract_id in seen:
                raise SystemExit(
                    f"contract_verdicts[{pos}]: duplicate contract id "
                    f"{contract_id!r}"
                )
            seen.add(contract_id)
            value = verdict.get("verdict")
            if value not in {"implemented", "partial", "missing"}:
                raise SystemExit(
                    f"contract_verdicts[{pos}] for {contract_id}: verdict must be "
                    "implemented, partial, or missing"
                )
            evidence = verdict.get("evidence")
            if not isinstance(evidence, str) or not evidence.strip():
                raise SystemExit(
                    f"contract_verdicts[{pos}] for {contract_id}: evidence must "
                    "be a non-empty string"
                )
            if value in {"partial", "missing"}:
                contract = expected[contract_id]
                review["blocking_findings"].append({
                    "category": f"plan-contract-{value}",
                    "area": contract["source"],
                    "summary": f"{contract_id}: {contract['statement']}",
                })
        missing_ids = [contract["id"] for contract in contracts
                       if contract["id"] not in seen]
        if missing_ids:
            raise SystemExit(
                "quality review contract_verdicts missing declared contract ids: "
                + ", ".join(missing_ids)
            )
if args.aspect != "stage-local" and state.get("issue_key"):
    token_path = story_dir(root, state["issue_key"]) / "review-run.json"
    token = load_json(token_path, default={})
    fields = ("review_run_id", "brief_sha256", "branch_diff_digest")
    if any(not isinstance(token.get(field), str) or not token[field]
           for field in fields):
        raise SystemExit(
            "Missing current branch review run; run `./forge review-brief --all` first."
        )
    expected_run_id = hashlib.sha256(
        (token["brief_sha256"] + token["branch_diff_digest"]).encode()
    ).hexdigest()
    if token["review_run_id"] != expected_run_id:
        raise SystemExit(
            "Invalid review-run token; rerun `./forge review-brief --all`."
        )
    if token["branch_diff_digest"] != branch_diff_digest(root):
        raise SystemExit(
            "Branch changed after the review run was minted; rerun "
            "`./forge review-brief --all`."
        )
    review.update({field: token[field] for field in fields})
for key in ("residual_risks", "reviewed_scope"):
    review[key] = ensure_list(payload.get(key))
review.setdefault("recommendation", "approve-with-caveats")
review["recorded_at"] = now_iso()
review["commit"] = head_sha(root)
if args.aspect == "stage-local":
    if not review_passed(review):
        raise SystemExit(
            "stage-local review must be clean: score >= 8 and no blocking findings"
        )
    from forge_cli.delegate import delegation_exclusion
    with delegation_exclusion(root, "stages", kind="stage-state", namespace="state"):
        stages = load_stages(root)
        active = [stage for stage in stages.get("stages", [])
                  if stage.get("status") == "active"]
        if len(active) != 1:
            raise SystemExit(
                "stage-local review requires exactly one active stage "
                f"(found {len(active)})"
            )
        stage = active[0]
        task = task_for(root, stage.get("id", ""))
        if not task:
            raise SystemExit(
                f"active stage {stage.get('id')} has no recorded task contract"
            )
        stage["local_review_stamp"] = {
            **stage_review_binding(root, stage, task),
            "recorded_at": review["recorded_at"],
            "generated_by": review.get("generated_by", "autoreview"),
        }
        write_stages(root, stages)
    append_event(
        root, "review-stage-local",
        actor=review.get("generated_by", "autoreview"),
        story=state.get("issue_key", ""), detail=stage.get("id", ""),
    )
    print(f"Recorded clean stage-local review stamp for {stage.get('id')}")
    raise SystemExit(0)
dump_json(path, review)
if state.get("issue_key"):
    state["review_status"] = "in-progress"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
    append_event(root, f"review-{args.aspect}", actor=review.get("generated_by", "autoreview"),
                 story=state.get("issue_key", ""), detail=review.get("status", ""))
print(f"Recorded {args.aspect} review from structured JSON")
