#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from factory_lib import (
    active_task_id, branch_diff_digest, dump_json, gate, head_sha, load_json, now_iso,
    effective_review_base, evidence_path, proof_path,
    protected_decomposition_state_path, repo_root,
    product_delta_digest, publish_review_generation, require_skills,
    read_stdin_utf8, run_state_path, story_dir, validate_payload,
    validate_review_document,
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
kind = parser.add_mutually_exclusive_group(required=True)
kind.add_argument(
    "--aspect",
    choices=["quality", "performance", "security", "stage-local"],
)
kind.add_argument("--set", action="store_true", help="publish one complete review generation")
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
if not args.task:
    args.task = active_task_id(root)
if not args.task:
    active = [
        str(stage.get("id") or "")
        for stage in load_stages(root).get("stages", [])
        if isinstance(stage, dict) and stage.get("status") == "active"
    ]
    if len(active) == 1:
        args.task = active[0]
if args.set:
    if not args.task:
        raise SystemExit("--set requires --task")
    if payload.get("origin") != "combined":
        raise SystemExit("public --set only accepts origin=combined")
    validate_review_document(root, payload, allow_missing_generation_id=True)
    story = state.get("issue_key") or state.get("story")
    if payload.get("story") != story or payload.get("task_id") != args.task:
        raise SystemExit("review generation story/task does not match the active task")
    task = task_for(root, args.task)
    stage = next((entry for entry in load_stages(root).get("stages", [])
                  if entry.get("id") == args.task), {})
    if not task or stage.get("status") not in {"active", "done"}:
        raise SystemExit("review generation requires an active or done recorded task")
    expected_delta = product_delta_digest(
        root, effective_review_base(root, args.task, str(payload.get("inspected_commit") or "")),
    )
    if payload.get("delta_id") != expected_delta:
        raise SystemExit("review generation delta_id is stale for the active task")
    token = load_json(story_dir(root, story) / "review-run.json", default={})
    if token.get("task_id") != args.task:
        raise SystemExit("review-run token does not match the reviewed task")
    if token.get("branch_diff_digest") != expected_delta:
        raise SystemExit("review-run token does not match the current task delta")
    expected_run_id = hashlib.sha256(
        (str(token.get("brief_sha256") or "") + expected_delta).encode()
    ).hexdigest()
    if token.get("review_run_id") != expected_run_id:
        raise SystemExit("review-run token id does not bind the current task delta")
    for field in ("review_run_id", "brief_sha256"):
        if payload.get(field) != token.get(field):
            raise SystemExit(f"review generation {field} does not match review-run.json")
    if payload.get("inspected_commit") != head_sha(root):
        raise SystemExit("review generation inspected_commit is not current HEAD")
    from forge_cli.review import (
        _combined_prompt, _helper_identity, rederive_combined_lenses, resolve_skill,
    )
    expected_helper, _helper_file = _helper_identity(resolve_skill(None))
    if payload.get("helper") != expected_helper:
        raise SystemExit("review generation helper does not match the installed helper")
    # The brief has two forms: the reviewer read the tree it judged, or it saw
    # only the diff bundle (another engine, codex off PATH, or
    # FORGE_REVIEW_EMPTY_WORKSPACE). Either is the current combined prompt.
    accepted_inputs = []
    for repo_readable in (True, False):
        prompt = _combined_prompt(task, repo_readable=repo_readable)
        accepted_inputs.append({
            "sha256": hashlib.sha256(prompt).hexdigest(), "bytes": len(prompt),
        })
    if payload.get("input") not in accepted_inputs:
        raise SystemExit("review generation input does not match the current combined prompt")
    if payload.get("lenses") != rederive_combined_lenses(root, payload):
        raise SystemExit("review generation lenses do not match the raw helper result")
    generation, selection = publish_review_generation(
        root, story, args.task, payload, update_stamp=True,
    )
    print(
        f"Published review generation {generation['generation_id']} and selected it "
        f"for {args.task} ({selection['delta_id'][:12]})."
    )
    raise SystemExit(0)
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
    if token.get("task_id") != args.task:
        raise SystemExit("Review task does not match the current review-run token.")
    stage = next((entry for entry in load_stages(root).get("stages", [])
                  if entry.get("id") == args.task), {})
    current_digest = (
        product_delta_digest(root, stage_review_binding(root, stage, {})["base_sha"])
        if stage else branch_diff_digest(root)
    )
    if token["branch_diff_digest"] != current_digest:
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
        # With --task the stamp lands on THAT stage (active or done, so a
        # review that closed after `stage done` can still seal it); without
        # it, on the single active stage — two active stages (parallel tasks)
        # need the task named.
        if args.task:
            named = [stage for stage in stages.get("stages", [])
                     if stage.get("id") == args.task]
            if not named or named[0].get("status") not in ("active", "done"):
                raise SystemExit(
                    f"stage-local review: task {args.task} is not an active or "
                    "done stage")
            active = named
        else:
            active = [stage for stage in stages.get("stages", [])
                      if stage.get("status") == "active"]
        if len(active) != 1:
            raise SystemExit(
                "stage-local review requires exactly one active stage "
                f"(found {len(active)}); name it with --task. Restamping a done "
                "stage after review fixes: `forge task reopen <id> --review-fix` "
                "first, or pass --task <id>."
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
