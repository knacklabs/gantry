#!/usr/bin/env python3
"""Record client sign-off: flips client_signoff in .factory/run.json once an
accepted client-signoff decision record exists."""
from __future__ import annotations

import re
import sys
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root, require_grill, run_state_path

FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


def main() -> int:
    root = repo_root()
    # The handover must be grilled for gaps/contradictions BEFORE it becomes
    # the contract downstream work builds on. Fresh = product docs unchanged
    # since the grill (the sign-off record itself is expected exhaust).
    require_grill(
        root, "signoff",
        ("docs/product/", "docs/decisions/", "prototype/"),
        ignore_names=("client-signoff", "epics-approved"),
    )
    decisions = root / "docs" / "decisions"
    candidates = sorted(decisions.glob("[0-9][0-9][0-9][0-9]-client-signoff.md"))
    if not candidates:
        print(
            "VIOLATION: no client sign-off decision record found.\n"
            f"  Expected: {decisions.relative_to(root)}/NNNN-client-signoff.md\n"
            "  Create one with `python3 .agents/scripts/forge.py decision new client-signoff`,\n"
            "  get the client's confirmation, set status: accepted and confirmed_by, then re-run."
        )
        return 1
    record = candidates[-1]
    fields = parse_frontmatter(record.read_text())
    if fields.get("status") != "accepted":
        print(
            f"VIOLATION: {record.relative_to(root)} has status "
            f"'{fields.get('status', 'missing')}', expected 'accepted'.\n"
            "  Set status: accepted once the client has confirmed."
        )
        return 1
    if not fields.get("confirmed_by"):
        print(
            f"VIOLATION: {record.relative_to(root)} has empty confirmed_by.\n"
            "  Record WHO confirmed (a human name); agents must not self-confirm —"
            "  an explicit human confirmation in chat authorizes recording it."
        )
        return 1
    state = load_json(run_state_path(root), default={})
    state["client_signoff"] = True
    state["client_signoff_record"] = record.relative_to(root).as_posix()
    state["client_signoff_at"] = now_iso()
    dump_json(run_state_path(root), state)
    print(f"client_signoff recorded from {record.relative_to(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
