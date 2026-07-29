"""forge signal — the worker→orchestrator event channel (.factory/signals.jsonl).

Event-driven delegation: a delegated worker (Codex) RAISES a signal the
moment it hits a contradiction between plan/decisions/docs, genuine
ambiguity, a hard blocker, or a scope change — then PAUSES that thread
instead of guessing. The orchestrating Claude session watches the channel
(Monitor tool on this file while a background rescue runs), resolves each
event (an answer, a decision record, a plan revision), and resumes the
worker. Event-sourced: `raised` and `resolved` events append; open = raised
without a matching resolve. `pr_ready` refuses to ship a task with open
signals — an unresolved contradiction cannot ship.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from factory_lib import load_json, now_iso, repo_root, run_state_path, validate_payload

from .common import fail

KINDS = {"contradiction", "confusion", "blocked", "scope-change"}


def signals_path(base: Path) -> Path:
    return base / ".factory" / "signals.jsonl"


def load_events(base: Path) -> list[dict]:
    path = signals_path(base)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def open_signals(base: Path) -> list[dict]:
    events = load_events(base)
    resolved = {e["id"] for e in events if e.get("event") == "resolved"}
    return [e for e in events if e.get("event") == "raised" and e["id"] not in resolved]


def _append(base: Path, event: dict) -> None:
    path = signals_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(event) + "\n")


def cmd_raise(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if args.kind not in KINDS:
        fail(f"--kind must be one of {', '.join(sorted(KINDS))}")
    payload = {"generated_by": args.by, "kind": args.kind, "message": args.message.strip()}
    if not payload["message"]:
        fail("a signal needs a message — one sentence: what contradicts / what is unclear")
    validate_payload(base, "signal", payload)
    events = load_events(base)
    seq = sum(1 for e in events if e.get("event") == "raised") + 1
    # Collision-resistant across concurrent workers: two rescues raising at
    # the same moment must not share an ID (resolution is keyed by it).
    import hashlib
    import os
    suffix = hashlib.sha256(
        f"{os.getpid()}:{now_iso()}:{payload['message']}".encode()
    ).hexdigest()[:4]
    issue = load_json(run_state_path(base), default={}).get("issue_key", "")
    event = {"event": "raised", "id": f"S-{seq:04d}-{suffix}", "task": issue,
             "at": now_iso(), **payload}
    if args.refs:
        event["refs"] = args.refs
    _append(base, event)
    print(f"Signal {event['id']} raised ({args.kind}) for task {issue or '?'} — "
          "PAUSE this thread; the orchestrator resolves and resumes you.")


def cmd_resolve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if not (args.notes or "").strip():
        fail("--notes required: the resolution IS the answer the worker resumes with")
    if args.id not in {e["id"] for e in open_signals(base)}:
        fail(f"{args.id} is not an open signal (./forge signal list --open)")
    _append(base, {"event": "resolved", "id": args.id, "at": now_iso(),
                   "notes": args.notes.strip()})
    print(f"{args.id} resolved — resume the worker with this answer "
          "(/codex:rescue --resume \"<the resolution>\").")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    events = load_events(base)
    if not events:
        print("No signals — workers raise them via "
              "`forge.py signal raise --kind <k> --by <agent> -m \"...\"`.")
        return
    resolutions = {e["id"]: e for e in events if e.get("event") == "resolved"}
    for e in events:
        if e.get("event") != "raised":
            continue
        res = resolutions.get(e["id"])
        if args.open and res:
            continue
        status = f"resolved: {res['notes']}" if res else "OPEN"
        print(f"[{e['kind']:<12}] {e['id']} {e.get('task','?')} ({e['generated_by']}): "
              f"{e['message']} — {status}")
