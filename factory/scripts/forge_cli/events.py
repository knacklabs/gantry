"""The story timeline (.factory/events/ plus legacy events.jsonl)."""
from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from factory_lib import now_iso, validate_payload


def events_path(base: Path) -> Path:
    return base / ".factory" / "events.jsonl"


def events_dir(base: Path) -> Path:
    return base / ".factory" / "events"


def load_events(base: Path, story: str | None = None,
                event: str | None = None, since: str | None = None,
                until: str | None = None) -> list[dict]:
    path = events_path(base)
    events = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # A torn legacy line costs one event, never the whole timeline.
                continue
    per_file_events = []
    directory = events_dir(base)
    if directory.is_dir():
        for event_path in sorted(directory.glob("*.json")):
            try:
                per_file_events.append(json.loads(
                    event_path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
    events.extend(per_file_events)
    events.sort(key=lambda item: (
        not bool(item.get("at")), item.get("at", ""),
        json.dumps(item, sort_keys=True),
    ))
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
    """Write one transition. Never raises on a write failure: the timeline is a
    record, and losing an event must not fail the gate that was doing real work.

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
        directory = events_dir(base)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{uuid4().hex}.json"
        with path.open("x", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")
    except OSError:
        return
