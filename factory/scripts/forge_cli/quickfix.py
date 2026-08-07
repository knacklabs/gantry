"""forge quickfix — bounded, ledgered escape hatch from the planning lock."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from factory_lib import (
    append_ledger_record, dump_json, load_json, now_iso, read_ledger_records,
    repo_root,
)

from .common import fail

MAX_FILES = 5


def quickfix_path(base: Path) -> Path:
    return base / ".factory" / "quickfix.json"


def ledger_path(base: Path) -> Path:
    return base / "plans" / "quickfixes.jsonl"


def load_active(base: Path) -> dict:
    return load_json(quickfix_path(base), default={})


def load_events(base: Path) -> list[dict]:
    # Directory form plus any legacy plans/quickfixes.jsonl (decision 0022).
    # Order comes from each record's own started_at/completed_at, never from
    # file position — position was never information, and the union merge that
    # used to resolve this file rewrote it anyway, which four review rounds
    # then filed as a state bug.
    return read_ledger_records(ledger_path(base))


def _append(base: Path, event: dict) -> None:
    stamp = event.get("completed_at") or event.get("started_at") or now_iso()
    record_id = f"{stamp.replace(':', '').replace('-', '')}-{event.get('id', 'q')}-{event.get('event', '')}"
    append_ledger_record(ledger_path(base), event, record_id)


def _distinct_union(current: list[str], files: list[str]) -> list[str]:
    return list(dict.fromkeys([*current, *files]))


def record_files(base: Path, files: list[str]) -> None:
    """Passively record distinct files touched by an already-authorized write."""
    active = load_active(base)
    if not active:
        return
    current = list(active.get("files", []))
    active["files"] = _distinct_union(current, files)
    dump_json(quickfix_path(base), active)


def claim_files(base: Path, files: list[str]) -> tuple[bool, dict]:
    """Record distinct product files before a quickfix write.

    Returns (False, active) without mutating state when the union would exceed
    the budget, so a denied tool call never claims files it did not touch.
    """
    active = load_active(base)
    if not active:
        return False, {}
    current = list(active.get("files", []))
    combined = _distinct_union(current, files)
    if len(combined) > int(active.get("max_files", MAX_FILES)):
        return False, active
    active["files"] = combined
    dump_json(quickfix_path(base), active)
    return True, active


def cmd_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    reason = args.reason.strip()
    if not reason:
        fail("a quickfix needs a reason")
    if load_active(base):
        fail("a quickfix is already open — finish it with `./forge quickfix done`")
    sequence = sum(1 for event in load_events(base) if event.get("event") == "open") + 1
    # Collision-resistant like signal ids: `roadmap parallel` puts several
    # worktrees on the same ledger, and two opening at once would otherwise
    # both mint Q-0001 — pairing the wrong closure with the wrong window.
    suffix = hashlib.sha256(
        f"{os.getpid()}:{now_iso()}:{reason}".encode()
    ).hexdigest()[:4]
    active = {
        "id": f"Q-{sequence:04d}-{suffix}",
        "reason": reason,
        "started_at": now_iso(),
        "max_files": MAX_FILES,
        "files": [],
    }
    dump_json(quickfix_path(base), active)
    _append(base, {"event": "open", **active})
    print(f"Quickfix {active['id']} open (0/{MAX_FILES} files): {reason}")


def cmd_done(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = load_active(base)
    if not active:
        fail("no quickfix is open")
    event = {
        "event": "done",
        "id": active["id"],
        "reason": active["reason"],
        "started_at": active["started_at"],
        "completed_at": now_iso(),
        "files": active.get("files", []),
    }
    _append(base, event)
    quickfix_path(base).unlink()
    print(f"Quickfix {active['id']} done ({len(event['files'])} file(s)): "
          f"{active['reason']}")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    events = load_events(base)
    active = load_active(base)
    if active:
        print(f"[OPEN] {active['id']} {len(active.get('files', []))}/"
              f"{active.get('max_files', MAX_FILES)} — {active['reason']}")
    closures = {event["id"] for event in events if event.get("event") == "done"}
    for event in events:
        if event.get("event") != "open" or event["id"] not in closures:
            continue
        done = next(item for item in events
                    if item.get("event") == "done" and item["id"] == event["id"])
        print(f"[done] {event['id']} {len(done.get('files', []))} file(s) — "
              f"{event['reason']}")
    if not events:
        print("No quickfixes recorded.")
