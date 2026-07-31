"""forge decision new/accept — decision records with human confirmation."""
from __future__ import annotations

import argparse
import datetime
import re
from pathlib import Path

from factory_lib import load_json, repo_root, run_state_path

from .common import fail

DECISION_TEMPLATE = """---
status: proposed
confirmed_by: ""
date: {date}
stories: [{stories}]
---

# {title}

## Context
<!-- Why this decision was needed; the forces at play. -->

## Decision
<!-- What was decided, in one or two sentences. -->

## Consequences
<!-- What follows: tradeoffs accepted, doors closed, work implied. -->
"""
FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def parse_stories(raw: str) -> list[str]:
    """`stories: [AGS-1, AGS-7]` — a flow list on one line, so the scalar
    frontmatter parser stays a two-line split and merges cleanly."""
    inner = raw.strip().strip("[]")
    return [part.strip().strip("\"'") for part in inner.split(",") if part.strip()]


def decision_records(base: Path) -> list[dict]:
    records = []
    for path in sorted((base / "docs" / "decisions").glob("[0-9][0-9][0-9][0-9]-*.md")):
        text = path.read_text()
        match = FRONTMATTER.match(text)
        fields: dict[str, str] = {}
        if match:
            for line in match.group(1).splitlines():
                if ":" in line:
                    key, _, value = line.partition(":")
                    fields[key.strip()] = value.strip().strip("\"'")
        title_match = re.search(r"^# (.+)$", text, re.MULTILINE)
        records.append({"id": path.stem, "status": fields.get("status", "proposed"),
                        "title": title_match.group(1) if title_match else path.stem,
                        "stories": parse_stories(fields.get("stories", "")),
                        "supersedes": fields.get("supersedes", ""),
                        "superseded_by": fields.get("superseded_by", ""),
                        "confirmed_by": fields.get("confirmed_by", ""),
                        "date": fields.get("date", ""),
                        "path": path})
    return records


def active_decision_ids(base: Path) -> list[str]:
    return [str(record["id"]) for record in decision_records(base)
            if record["status"] == "accepted"]


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
    story = load_json(run_state_path(base), default={}).get("issue_key", "")
    text = DECISION_TEMPLATE.format(date=datetime.date.today().isoformat(), title=title,
                                    stories=story)
    if old_record is not None:
        text = text.replace("---\n\n#", f"supersedes: {old_record.stem}\n---\n\n#", 1)
    path.write_text(text)
    print(f"Created {path}" + (f" (governs {story})" if story else ""))
    if old_record is not None:
        # The predecessor stays ACTIVE until this record is accepted: marking it
        # superseded now would leave a window where neither version governs, and
        # plan attestation would require neither. cmd_accept performs the flip.
        print(f"Supersedes {old_record.stem} — it stays active until "
              f"`forge decision accept {slug} --by \"<human>\"` flips both.")
    print(
        "Reminder: status: accepted requires a non-empty confirmed_by (a human), "
        "and the commit adding it should carry a `Confirmed-by:` trailer."
    )


def cmd_link(args: argparse.Namespace) -> None:
    """One decision often governs several stories (a shared invariant found
    while building three of them); the backlink is a list, appended here."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    slug = args.slug.strip().lower().replace(" ", "-")
    matches = sorted((base / "docs" / "decisions").glob(f"[0-9][0-9][0-9][0-9]-{slug}.md"))
    if not matches:
        fail(f"no decision record matching docs/decisions/NNNN-{slug}.md")
    record = matches[-1]
    text = record.read_text()
    match = FRONTMATTER.match(text)
    if match is None:
        fail(f"{record.name} has no frontmatter to link into")
        return
    current = ""
    for line in match.group(1).splitlines():
        if line.startswith("stories:"):
            current = line.partition(":")[2]
    stories = parse_stories(current)
    if args.story in stories:
        print(f"{record.stem} already governs {args.story}.")
        return
    stories.append(args.story)
    joined = f"stories: [{', '.join(stories)}]"
    text = (re.sub(r"^stories: .*$", joined, text, count=1, flags=re.MULTILINE)
            if current else text.replace("---\n\n#", f"{joined}\n---\n\n#", 1))
    record.write_text(text)
    print(f"{record.stem} now governs {', '.join(stories)}")


def cmd_list(args: argparse.Namespace) -> None:
    """The active decision corpus — what agents should actually read.

    Superseded records stay on disk as history but are hidden by default;
    with sprawl, `decision list --active` is the read-order entry point,
    not `ls docs/decisions/`."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decisions = base / "docs" / "decisions"
    records = decision_records(base)
    if not records:
        print("No decision records yet (./forge decision new <slug>).")
        return
    for record in records:
        status = str(record["status"])
        if args.active and status != "accepted":
            continue
        superseded = f" -> {record['superseded_by']}" if record["superseded_by"] else ""
        governs = f" [{', '.join(record['stories'])}]" if record["stories"] else ""
        print(f"[{status:<10}] {record['id']}: {record['title']}{superseded}{governs}")


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
    # The replacement is live now, so retire the predecessor in the same step:
    # between `decision new --supersedes` and here, the old record kept governing.
    supersedes = re.search(r"^supersedes:\s*(\S+)", text, re.MULTILINE)
    if supersedes:
        old = decisions / f"{supersedes.group(1)}.md"
        if old.is_file():
            old_text = old.read_text()
            old_text = re.sub(r"status: (accepted|proposed)", "status: superseded",
                              old_text, count=1)
            if "superseded_by:" not in old_text:
                old_text = old_text.replace("---\n\n#",
                                            f"superseded_by: {record.stem}\n---\n\n#", 1)
            old.write_text(old_text)
            print(f"Superseded: {old.relative_to(base)} -> {record.stem}")
    print("Commit it with the audit trailer:")
    print(f'  git add {rel} && git commit -m "docs(decisions): accept {slug}" '
          f'--trailer "Confirmed-by: {args.by}"')
    if slug == "client-signoff":
        print("Then arm the gate: python3 factory/scripts/record_signoff.py")
