"""forge note — agent working notes on the compaction scratchpad.

.factory/scratchpad.md has two zones: the FACTS above (owned by the
PreCompact hook, rewritten every snapshot) and the working-notes section
below (agent-appended during development, PRESERVED across snapshots).
Notes are for context worth surviving a compaction that no ledger owns yet
— a hypothesis being tested, a gotcha found mid-stage, the reason behind an
in-flight detour. Anything durable belongs in the real ledgers instead
(lesson, assumption, decision, deferral); session noise: gitignored, wiped
when the task ships.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import now_iso, repo_root

from .common import fail

NOTES_HEADER = "## Working notes (agent-maintained, survives snapshots)"


def scratchpad_path(base: Path) -> Path:
    return base / ".factory" / "scratchpad.md"


def notes_section(text: str) -> str | None:
    """The notes zone, header to EOF — the part every snapshot must keep."""
    idx = text.find(NOTES_HEADER)
    return text[idx:].rstrip("\n") + "\n" if idx != -1 else None


def cmd_note(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    path = scratchpad_path(base)
    if args.list:
        if not path.exists() or notes_section(path.read_text()) is None:
            print("No working notes (.factory/scratchpad.md) — jot one: "
                  "./forge note \"<one line>\"")
            return
        print(notes_section(path.read_text()), end="")
        return
    text = (args.text or "").strip()
    if not text:
        fail("nothing to note — ./forge note \"<one line>\" (or --list)")
    entry = f"- {now_iso()}: {text}\n"
    existing = path.read_text() if path.exists() else ""
    path.parent.mkdir(parents=True, exist_ok=True)
    if NOTES_HEADER in existing:
        path.write_text(existing.rstrip("\n") + "\n" + entry)
    else:
        prefix = existing.rstrip("\n") + "\n\n" if existing.strip() else ""
        path.write_text(prefix + NOTES_HEADER + "\n\n" + entry)
    print("noted -> .factory/scratchpad.md (survives compaction snapshots; "
          "promote anything durable to a lesson/assumption/decision/deferral)")
