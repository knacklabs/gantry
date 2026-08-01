"""forge outcome — what the story actually delivered (.factory/outcome.json).

Every other field in the harness is authored BEFORE the work: objectives,
acceptance criteria, reviewer focus. Nothing recorded what was built. Six
weeks later "what shipped in March?" had only titles and timestamps to answer
with, so this is the one artifact written after the fact, at the moment the
author still has the context — and `pr_ready` lists it as missing until it
exists.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import (dump_json, head_sha, load_json, now_iso, repo_root,
                         run_state_path, validate_payload)

from .common import fail

MIN_WORDS = 12
MAX_CHARS = 800


def outcome_path(base: Path) -> Path:
    return base / ".factory" / "outcome.json"


def load_outcome(base: Path) -> dict | None:
    return load_json(outcome_path(base), default=None)


def cmd_set(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    text = (Path(args.from_file).read_text() if args.from_file else (args.text or "")).strip()
    if not text:
        fail("an outcome needs text: what changed, and what a user can now do")
    # A shell command or a pasted diff line clears "non-empty" but is not a
    # sentence; an essay is a plan, not an outcome. Both are refused here so
    # the rule lives in code rather than in a prompt an agent may skip.
    if len(text.split()) < MIN_WORDS:
        fail(f"outcome is {len(text.split())} words — write at least {MIN_WORDS}: "
             "what changed and what someone can now do, in a reader's language")
    if len(text) > MAX_CHARS:
        fail(f"outcome is {len(text)} chars (max {MAX_CHARS}) — one paragraph, "
             "not the plan; the plan and reviews are already archived")
    issue = load_json(run_state_path(base), default={}).get("issue_key", "")
    payload = {"generated_by": args.by, "outcome": text}
    validate_payload(base, "outcome", payload)
    payload["issue"] = issue
    payload["commit"] = head_sha(base) or ""
    payload["recorded_at"] = now_iso()
    dump_json(outcome_path(base), payload)
    print(f"Outcome recorded for {issue or 'the active task'} "
          f"-> .factory/outcome.json ({len(text.split())} words)")


def cmd_show(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    record = load_outcome(base)
    if not record:
        print("No outcome recorded — `forge.py outcome set \"<what shipped>\"` "
              "before pr_ready.")
        return
    print(f"{record.get('issue') or '?'}: {record.get('outcome', '')}")
