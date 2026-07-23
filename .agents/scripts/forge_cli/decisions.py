"""forge decision new/accept — decision records with human confirmation."""
from __future__ import annotations

import argparse
import datetime
import re
from pathlib import Path

from factory_lib import repo_root

from .common import fail

DECISION_TEMPLATE = """---
status: proposed
confirmed_by: ""
date: {date}
---

# {title}

## Context
<!-- Why this decision was needed; the forces at play. -->

## Decision
<!-- What was decided, in one or two sentences. -->

## Consequences
<!-- What follows: tradeoffs accepted, doors closed, work implied. -->
"""


def cmd_new(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decisions = base / "docs" / "decisions"
    decisions.mkdir(parents=True, exist_ok=True)
    old_record = None
    if getattr(args, "supersedes", None):
        old_slug = args.supersedes.strip().lower().replace(" ", "-")
        matches = sorted(decisions.glob(f"[0-9][0-9][0-9][0-9]-{old_slug}.md"))
        if not matches:
            fail(f"cannot supersede: no record matching docs/decisions/NNNN-{old_slug}.md")
        old_record = matches[-1]
    taken = set()
    for existing in decisions.glob("[0-9][0-9][0-9][0-9]-*.md"):
        taken.add(int(existing.name[:4]))
    number = 1
    while number in taken:
        number += 1
    slug = args.slug.strip().lower().replace(" ", "-")
    path = decisions / f"{number:04d}-{slug}.md"
    title = args.title or slug.replace("-", " ").title()
    text = DECISION_TEMPLATE.format(date=datetime.date.today().isoformat(), title=title)
    if old_record is not None:
        text = text.replace("---\n\n#", f"supersedes: {old_record.stem}\n---\n\n#", 1)
    path.write_text(text)
    print(f"Created {path}")
    if old_record is not None:
        # A decision is never silently replaced: the old record points forward,
        # keeps its history, and stops counting as active guidance.
        old_text = old_record.read_text()
        old_text = re.sub(r"status: (accepted|proposed)", "status: superseded", old_text, count=1)
        if "superseded_by:" not in old_text:
            old_text = old_text.replace("---\n\n#", f"superseded_by: {path.stem}\n---\n\n#", 1)
        old_record.write_text(old_text)
        print(f"Superseded: {old_record.relative_to(base)} -> {path.stem}")
    print(
        "Reminder: status: accepted requires a non-empty confirmed_by (a human), "
        "and the commit adding it should carry a `Confirmed-by:` trailer."
    )


def cmd_list(args: argparse.Namespace) -> None:
    """The active decision corpus — what agents should actually read.

    Superseded records stay on disk as history but are hidden by default;
    with sprawl, `decision list --active` is the read-order entry point,
    not `ls docs/decisions/`."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decisions = base / "docs" / "decisions"
    records = sorted(decisions.glob("[0-9][0-9][0-9][0-9]-*.md"))
    if not records:
        print("No decision records yet (./forge decision new <slug>).")
        return
    for record in records:
        text = record.read_text()
        status = "proposed"
        match = re.search(r"status:\s*(\S+)", text)
        if match:
            status = match.group(1)
        if args.active and status != "accepted":
            continue
        title_match = re.search(r"^# (.+)$", text, re.MULTILINE)
        title = title_match.group(1) if title_match else record.stem
        superseded = ""
        by = re.search(r"superseded_by:\s*(\S+)", text)
        if by:
            superseded = f" -> {by.group(1)}"
        print(f"[{status:<10}] {record.stem}: {title}{superseded}")


def cmd_accept(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decisions = base / "docs" / "decisions"
    slug = args.slug.strip().lower().replace(" ", "-")
    matches = sorted(decisions.glob(f"[0-9][0-9][0-9][0-9]-{slug}.md"))
    if not matches:
        fail(f"no decision record matching docs/decisions/NNNN-{slug}.md")
    record = matches[-1]
    text = record.read_text()
    if "status: accepted" in text:
        print(f"{record.relative_to(base)} is already accepted.")
        return
    text = text.replace("status: proposed", "status: accepted", 1)
    if 'confirmed_by: ""' in text:
        text = text.replace('confirmed_by: ""', f'confirmed_by: "{args.by}"', 1)
    else:
        text = re.sub(r"confirmed_by: .*", f'confirmed_by: "{args.by}"', text, count=1)
    record.write_text(text)
    rel = record.relative_to(base)
    print(f"Accepted: {rel} (confirmed_by: {args.by})")
    print("Commit it with the audit trailer:")
    print(f'  git add {rel} && git commit -m "docs(decisions): accept {slug}" '
          f'--trailer "Confirmed-by: {args.by}"')
    if slug == "client-signoff":
        print("Then arm the gate: python3 .agents/scripts/record_signoff.py")
