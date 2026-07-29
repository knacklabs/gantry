#!/usr/bin/env python3
"""Record a handover grill (.factory/grills/<gate>.json).

A grill is the adversarial gap/contradiction interrogation run BEFORE a
handover gate (.agents/prompts/griller.md): `signoff` protects the client->PM
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
    dump_json, head_sha, load_json, now_iso, repo_root, run_state_path,
    sha256_of, validate_payload,
)

VERDICTS = {"pass", "blocked"}

parser = argparse.ArgumentParser(description="Record a handover/plan grill from structured JSON")
parser.add_argument("--gate", required=True, choices=["signoff", "epics", "plan"])
parser.add_argument("--input", help="Path to grill JSON. If omitted, read from stdin.")
parser.add_argument("--input-digest", dest="input_digest",
                    help="Path to the artifact this grill interrogated (roadmap input for "
                         "--gate epics, the plan draft for --gate plan); its sha256 binds "
                         "the grill to THAT version. Required for epics and plan gates.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text())
else:
    raw = sys.stdin.read().strip()
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
if args.gate in ("epics", "plan"):
    if not args.input_digest:
        raise SystemExit(
            f"--gate {args.gate} requires --input-digest <artifact>: the grill must be "
            "bound to the exact roadmap input / plan draft it interrogated."
        )
    digest_target = Path(args.input_digest).expanduser()
    if not digest_target.is_file():
        raise SystemExit(f"--input-digest {digest_target} not found")
    payload["input_sha256"] = sha256_of(digest_target)
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
dest = root / ".factory" / "grills" / f"{args.gate}.json"
dump_json(dest, payload)
print(f"Recorded {args.gate} grill: {payload['verdict']} "
      f"({len(payload['gaps'])} gap(s), {len(payload['contradictions'])} contradiction(s), "
      f"{len(payload['resolutions'])} resolution(s))")
