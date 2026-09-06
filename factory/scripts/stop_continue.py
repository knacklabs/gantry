#!/usr/bin/env python3
"""The Stop hook: from plan approval to PR, the run does not stop for us.

This hook used to be advisory by design — it printed a reminder and always
returned continue. That left the real exit open: a pre-tool gate can refuse the
question TOOL, but nothing stops an agent ending its turn and asking in prose.
One story took 26 interruptions that way, 19 of them for a review-budget
ceiling, a write scope short by a file the work implied, or a sandbox block
with a documented path — every one answerable without a human.

So while a stage is open and the task is unfinished, ending the turn is
refused, and the refusal says what to do instead. The escape is one command:
name the decision that does not exist. That is cheap when the question is real
and impossible to write honestly when it is not.

Fails OPEN on anything unexpected: a missed interruption costs one question, a
hook that traps the session costs everything.
"""
from __future__ import annotations

import json
import sys

CONTINUE = {"continue": True}


def emit(payload: dict) -> None:
    print(json.dumps(payload))
    raise SystemExit(0)


# factory_lib first: its strict UTF-8 reader is the only sanctioned way to take
# stdin, so the hook cannot inherit a host locale and mis-decode the payload.
try:
    from factory_lib import may_interrupt, read_stdin_utf8, repo_root
except (ImportError, SyntaxError):
    emit(CONTINUE)

try:
    raw = read_stdin_utf8()
    event = json.loads(raw) if raw.strip() else {}
except Exception:
    emit(CONTINUE)

# Claude Code sets this when the hook already blocked once this turn. Honour it
# or the session loops forever on an agent that cannot satisfy the gate.
if event.get("stop_hook_active"):
    emit(CONTINUE)

try:
    root = repo_root()
    allowed, reason = may_interrupt(root, spend=True)
except Exception:
    emit(CONTINUE)

if allowed:
    emit(CONTINUE)

emit({
    "decision": "block",
    "reason": (
        "Do not stop here.\n\n" + reason + "\n\n"
        "Continue the task: delegate the remaining work, run verify, record "
        "the tests, run the three-lens review, fix what it finds, then "
        "pr-ready. `./forge next` prints the exact step you are on."
    ),
})
