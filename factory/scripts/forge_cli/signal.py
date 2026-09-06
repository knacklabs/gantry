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
import uuid
from pathlib import Path

from factory_lib import load_json, now_iso, repo_root, run_state_path, validate_payload

from .common import fail
from .events import append_event

# host-exception: the orchestrator logs a MINIMAL host-side product change that
# is provably impossible to make or verify inside the companion sandbox (no
# network/database/Docker the change or its verification needs) — WORKFLOW.md
# "Who authors what". Bounded and always ledgered; paired with a degraded window
# for the actual write. Not a worker pause like the other kinds.
KINDS = {"contradiction", "confusion", "blocked", "scope-change", "host-exception"}


def signals_path(base: Path) -> Path:
    return base / ".factory" / "signals.jsonl"


def load_events(base: Path) -> list[dict]:
    path = signals_path(base)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def open_signals(base: Path) -> list[dict]:
    events = load_events(base)
    resolved = {e["id"] for e in events if e.get("event") == "resolved"}
    return [e for e in events if e.get("event") == "raised" and e["id"] not in resolved]


def _append(base: Path, event: dict) -> None:
    path = signals_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")


# Where a decision already lives. An agent that has not looked here has not
# earned an interruption.
DECISION_SOURCES = ("contract", "plan", "constitution", "decisions", "lessons")

# Interruptions that are answerable without a human, with the reason each is.
# Matched against the escalation text, so a stop dressed in these words is
# refused with the answer rather than passed on.
SELF_RESOLVABLE_RULES = [
    (("review budget", "budget", "file ceiling", "max_changed_files",
      "review_budget"),
     "A review budget is a ceiling on runaway scope, measured by `stage done` "
     "when the work is complete. Raise it with a recorded reason and continue "
     "— changing it no longer re-grills, and splitting can only be judged "
     "against a finished diff."),
    (("write scope", "write_scope", "out of scope", "outside the scope"),
     "A file the work mechanically implies — a lockfile, a module "
     "registration, a barrel, a doc reference — is a scope completion, not a "
     "scope decision. Extend it, name each file and why the work implies it, "
     "and continue."),
    (("pnpm", "npm registry", "corepack", "sandbox", "network policy",
      "registry access"),
     "An environment block has a documented path: docs/degraded-mode.md, a "
     "binding lesson, or a pinned mirror. Take that path. If none exists, say "
     "which one you looked for."),
]


def _self_resolvable(text: str) -> str:
    lowered = (text or "").lower()
    for needles, answer in SELF_RESOLVABLE_RULES:
        if any(needle in lowered for needle in needles):
            return answer
    return ""


def escalations_path(base: Path) -> Path:
    """Per-worktree and uncommitted: an escalation is a fact about this run."""
    from factory_lib import git_control_dir
    return git_control_dir(base) / "escalations.jsonl"


def open_escalation(base: Path) -> dict:
    """The escalation authorising the next interruption, if one is recorded."""
    path = escalations_path(base)
    if not path.exists():
        return {}
    records = [json.loads(line) for line in
               path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for record in records:
        if not record.get("spent"):
            return record
    return {}


def spend_escalation(base: Path, record: dict) -> None:
    """One escalation authorises ONE interruption."""
    path = escalations_path(base)
    if not path.exists():
        return
    lines = [json.loads(line) for line in
             path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for entry in lines:
        if entry.get("id") and entry.get("id") == record.get("id"):
            entry["spent"] = True
            break
    path.write_text("".join(json.dumps(e) + "\n" for e in lines),
                    encoding="utf-8")


def cmd_escalate(args: argparse.Namespace) -> None:
    """Record that a decision genuinely does not exist, then allow the ask."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    missing = (args.missing_decision or "").strip()
    if len(missing) < 15:
        fail("--missing-decision must NAME the decision nobody has made, in a "
             "sentence. \"Need input\" is not a decision.")

    answer = _self_resolvable(missing)
    if answer:
        fail(f"escalation refused — this is answerable without the human.\n\n"
             f"  {answer}\n\n"
             "  Do that, record it, and continue.")

    checked = {c.strip().lower() for c in (args.checked or "").split(",")
               if c.strip()}
    missing_sources = [s for s in DECISION_SOURCES if s not in checked]
    if missing_sources:
        fail("escalation refused — say where you already looked: "
             f"--checked \"{','.join(DECISION_SOURCES)}\".\n"
             f"  Not yet checked: {', '.join(missing_sources)}.\n"
             "  A decision that exists in any of these is not missing.")

    record = {
        "id": uuid.uuid4().hex,
        "at": now_iso(),
        "missing_decision": missing,
        "checked": sorted(checked),
        "story": load_json(run_state_path(base), default={}).get("issue_key", ""),
        "task": (getattr(args, "task", "") or "").strip(),
        "spent": False,
    }
    path = escalations_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    append_event(base, "signal-escalated", actor="orchestrator",
                 story=record["story"], detail=missing[:200])
    print("Escalation recorded — the next question to the human is allowed.\n"
          f"  missing decision: {missing}")


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
    append_event(base, f"signal-{args.kind}", actor=args.by, story=issue,
                 detail=payload["message"][:200])
    print(f"Signal {event['id']} raised ({args.kind}) for task {issue or '?'}")
    print("PAUSE this thread; the orchestrator resolves and resumes you.")


def cmd_resolve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if not (args.notes or "").strip():
        fail("--notes required: the resolution IS the answer the worker resumes with")
    if args.id not in {e["id"] for e in open_signals(base)}:
        fail(f"{args.id} is not an open signal (./forge signal list --open)")
    _append(base, {"event": "resolved", "id": args.id, "at": now_iso(),
                   "notes": args.notes.strip()})
    issue = load_json(run_state_path(base), default={}).get("issue_key", "")
    append_event(base, "signal-resolved", actor="orchestrator", story=issue,
                 detail=f"{args.id}: {args.notes.strip()[:200]}")
    print(f"Signal {args.id} resolved")


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
