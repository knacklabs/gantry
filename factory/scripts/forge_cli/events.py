"""The story timeline (.factory/events.jsonl).

One append-only line per state transition — what, when, and who. The scripts
that change state call this themselves, so a timeline cannot be skipped.
Lines are COPIED into a story's ship archive, never pruned: the file is
union-merged and a removal does not survive a parallel branch (decision 0017).
"""
from __future__ import annotations

import json
from pathlib import Path

from factory_lib import now_iso, validate_payload


def events_path(base: Path) -> Path:
    return base / ".factory" / "events.jsonl"


def load_events(base: Path, story: str | None = None,
                event: str | None = None, since: str | None = None,
                until: str | None = None) -> list[dict]:
    path = events_path(base)
    if not path.exists():
        return []
    events = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # A JSONL merge tear across worktrees costs one line, never the
            # whole timeline: the union driver can interleave a partial write.
            continue
    return [
        item for item in events
        if (story is None or item.get("story") == story)
        and (event is None or item.get("event") == event)
        and ((since is None and until is None) or bool(item.get("at")))
        and (since is None or item.get("at", "")[:len(since)] >= since)
        and (until is None or item.get("at", "")[:len(until)] <= until)
    ]


def append_event(base: Path, event: str, actor: str, story: str = "",
                 detail: str = "") -> None:
    """Append one transition. Never raises on a write failure: the ledger is a
    record, and losing a line must not fail the gate that was doing real work.

    `actor` lands as `generated_by` — the harness's one attribution vocabulary,
    so the schema's pinned allowlist applies to events too."""
    payload = {"event": event, "generated_by": actor, "at": now_iso()}
    if story:
        payload["story"] = story
    if detail:
        payload["detail"] = detail
    # Validation is NOT swallowed: an unpinned generated_by is a contract
    # breach, and a schema that can be silently skipped is not a gate. Only
    # the write is best-effort — a full disk must not fail the gate that was
    # doing the real work.
    validate_payload(base, "event", payload)
    try:
        path = events_path(base)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(json.dumps(payload) + "\n")
    except OSError:
        return
