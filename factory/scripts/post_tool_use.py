#!/usr/bin/env python3
"""Fail-open provenance recorder for successful Claude tool calls."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from factory_lib import (
    _active_story_key,
    dump_json,
    evidence_path,
    plan_body_digest,
    read_ceremony_target,
    read_stdin_utf8,
    repo_root,
    validate_payload,
)


WRITE_TOOLS = {"Write", "Edit", "MultiEdit"}


def _write_record(root: Path, story: str | None, kind: str, record: dict) -> None:
    directory = evidence_path(root, story, kind, for_write=True)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid.uuid4()}.json"
    temporary = path.with_suffix(".tmp")
    try:
        dump_json(temporary, record)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _written_path(root: Path, payload: dict) -> Path | None:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    raw = tool_input.get("file_path")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        cwd = payload.get("cwd")
        path = (Path(cwd) if isinstance(cwd, str) else Path.cwd()) / path
    path = path.resolve()
    return path if path.is_file() else None


def _plan_marker(root: Path, payload: dict) -> dict | None:
    path = _written_path(root, payload)
    session_id = payload.get("session_id")
    if path is None or (session_id is not None and not isinstance(session_id, str)):
        return None
    record = {
        "generated_by": "claude-code:plan-mode",
        "path": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "sha256_body": plan_body_digest(path),
        "at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id or "",
    }
    validate_payload(root, "plan-mode-marker", record)
    return record


def _option_labels(raw: object) -> list[str] | None:
    if not isinstance(raw, list):
        return None
    labels = []
    for option in raw:
        label = option.get("label") if isinstance(option, dict) else option
        if not isinstance(label, str) or not label:
            return None
        labels.append(label)
    return labels or None


def _grill_round(root: Path, payload: dict) -> dict | None:
    tool_input = payload.get("tool_input")
    response = payload.get("tool_response")
    if not isinstance(tool_input, dict):
        return None
    raw_questions = tool_input.get("questions")
    if not isinstance(raw_questions, list):
        return None
    answers = response.get("answers") if isinstance(response, dict) else {}
    if not isinstance(answers, dict):
        answers = {}
    questions = []
    for raw in raw_questions:
        if not isinstance(raw, dict) or not isinstance(raw.get("question"), str) \
                or not raw["question"]:
            return None
        question = raw["question"]
        options = _option_labels(raw.get("options"))
        chosen = answers.get(question)
        if options is None:
            return None
        if not isinstance(chosen, str) or chosen not in options:
            chosen = None
        questions.append({"question": question, "options": options, "chosen": chosen})
    if not questions:
        return None
    session_id = payload.get("session_id")
    if session_id is not None and not isinstance(session_id, str):
        return None
    record = {
        "generated_by": "claude-code:plan-mode",
        "questions": questions,
        "at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id or "",
    }
    validate_payload(root, "grill-round", record)
    return record


def main() -> None:
    try:
        payload = json.loads(read_stdin_utf8())
        if not isinstance(payload, dict):
            return
        root = repo_root()
        # An orchestrator-declared ceremony target (a sibling worktree being
        # driven from this session) receives the rounds/markers natively so its
        # own gate recorders can validate them; a stale or invalid pointer
        # falls back to this checkout rather than dropping evidence.
        root = read_ceremony_target(root) or root
        story = _active_story_key(root) or None
        tool = payload.get("tool_name")
        if tool in WRITE_TOOLS and payload.get("permission_mode") == "plan":
            record = _plan_marker(root, payload)
            if record is not None:
                _write_record(root, story, "plan-mode", record)
        elif tool == "AskUserQuestion":
            record = _grill_round(root, payload)
            if record is not None:
                _write_record(root, story, "grill-rounds", record)
    except (Exception, SystemExit):
        return


if __name__ == "__main__":
    main()
