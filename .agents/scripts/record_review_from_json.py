#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from factory_lib import (
    dump_json, gate, head_sha, load_json, now_iso, repo_root, require_skills,
    review_dir, run_state_path, validate_payload,
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
                    ".agents/schemas/review.json findings_note."
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
    payload = json.loads(Path(args.input).read_text())
else:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
gate(root, signoff=True, approved_plan=True, decomposition=True)
validate_payload(root, "review", payload)
require_skills(root, "review", payload)
path = review_dir(root) / f"{args.aspect}.json"
review = dict(payload)
review["aspect"] = args.aspect
for key in ("blocking_findings", "non_blocking_findings"):
    review[key] = ensure_findings(key, payload.get(key))
for key in ("residual_risks", "reviewed_scope"):
    review[key] = ensure_list(payload.get(key))
review.setdefault("recommendation", "approve-with-caveats")
review["recorded_at"] = now_iso()
review["commit"] = head_sha(root)
dump_json(path, review)
state = load_json(run_state_path(root), default={})
if state:
    state["review_status"] = "in-progress"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
print(f"Recorded {args.aspect} review from structured JSON")
