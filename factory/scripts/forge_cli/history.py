"""Read and print the committed project timeline."""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import repo_root

from .events import append_event, load_events


def _event_line(event: dict) -> str:
    line = f"  {event.get('at', '?')}  {event.get('event', '?')}"
    if event.get("generated_by"):
        line += f"  [{event['generated_by']}]"
    if event.get("detail"):
        line += f"  {event['detail']}"
    return line


def cmd_pr_link(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    append_event(
        base,
        "pr-linked",
        actor="orchestrator",
        story=args.story,
        detail=args.reference,
    )
    print(f"Linked {args.story} to {args.reference}")


def cmd_history(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    events = load_events(
        base, story=args.story, event=args.event,
        since=args.since, until=args.until,
    )
    if not events:
        print("No events found.")
        return

    by_story: dict[str | None, list[dict]] = {}
    for event in events:
        by_story.setdefault(event.get("story") or None, []).append(event)

    sections: list[tuple[str, list[dict]]] = [
        (f"Story: {story}", by_story[story])
        for story in sorted(key for key in by_story if key is not None)
    ]
    if None in by_story:
        sections.append(("Unattributed events (no story)", by_story[None]))

    for index, (heading, story_events) in enumerate(sections):
        if index:
            print()
        print(heading)
        for event in story_events:
            print(_event_line(event))
