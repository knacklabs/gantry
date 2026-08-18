#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from factory_lib import (
    dump_json, gate, head_sha, load_json, now_iso,
    protected_decomposition_state_path, repo_root, require_skills, review_dir,
    read_stdin_utf8, run_state_path, validate_payload,
)
from forge_cli.events import append_event
from forge_cli.review_brief import declared_contracts


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
parser.add_argument("--aspect", required=True, choices=["quality", "performance", "security"])
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
path = review_dir(root) / f"{args.aspect}.json"
review = dict(payload)
review["aspect"] = args.aspect
for key in ("blocking_findings", "non_blocking_findings"):
    review[key] = ensure_findings(key, payload.get(key))

# The protected decomposition twin survives a ship (pr_ready cleans only .factory/),
# so a shipped story's contracts must not demand later quickfix quality-review verdicts.
if args.aspect == "quality" and state.get("decomposition_status") == "recorded":
    decomposition = load_json(protected_decomposition_state_path(root), default={})
    contracts = declared_contracts(decomposition)
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
for key in ("residual_risks", "reviewed_scope"):
    review[key] = ensure_list(payload.get(key))
review.setdefault("recommendation", "approve-with-caveats")
review["recorded_at"] = now_iso()
review["commit"] = head_sha(root)
dump_json(path, review)
if state.get("issue_key"):
    state["review_status"] = "in-progress"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
    append_event(root, f"review-{args.aspect}", actor=review.get("generated_by", "autoreview"),
                 story=state.get("issue_key", ""), detail=review.get("status", ""))
print(f"Recorded {args.aspect} review from structured JSON")
