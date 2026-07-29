"""forge audit — loop-health: the improvement loops are themselves watched.

The harness is a graph of improvement loops (findings escalation, lessons,
deferrals, structured reviews). Each emits advisories — and an advisory
nobody acts on decays into theater: the warning fires forever, the trigger
never re-checks, the lesson's globs rot after a rename. This audit is the
loop that watches the watchers (decision record: loop-health-audit). It is
ADVISORY, never a ship gate — audit output routes work to the roadmap; it
does not hold an unrelated task hostage.

Checks:
- ignored escalations: a RECURRING finding class with ships since it was
  flagged and no consolidating decision or refactor story
- stale deferrals: open rows past the age threshold — re-check the trigger
- decayed lessons: applies_to globs matching zero tracked files
- review drift: the latest shipped task's findings carry no structure, so
  they can never cluster
"""
from __future__ import annotations

import argparse
import datetime
import subprocess
from pathlib import Path

from factory_lib import repo_root

from .deferrals import load_rows
from .findings import collect, recurring
from .lessons import _matches, load_lessons
from .roadmap import load_items

DEFERRAL_STALE_DAYS = 60


def _shipped(base: Path) -> list[str]:
    history = base / ".factory" / "history"
    if not history.is_dir():
        return []
    return sorted(p.name for p in history.iterdir() if p.is_dir())


def ignored_escalations(base: Path) -> list[str]:
    flagged = recurring(base)
    if not flagged:
        return []
    shipped = _shipped(base)
    decision_text = " ".join(
        p.read_text().lower() for p in sorted((base / "docs" / "decisions").glob("*.md"))
    ) if (base / "docs" / "decisions").is_dir() else ""
    refactor_text = " ".join(
        f"{i.get('title', '')} {i.get('epic', '')}"
        for i in load_items(base) if i.get("kind") == "refactor"
    ).lower()
    out = []
    for cluster in flagged:
        needle = (cluster["category"] if cluster["category"] != "(uncategorized)"
                  else (cluster["examples"][0] if cluster["examples"] else "")).lower()
        if needle and (needle in decision_text or needle in refactor_text):
            continue  # routed: a decision or refactor story names the class
        flag_task = cluster.get("flagged_at", "")
        ships_since = sum(1 for t in shipped if t > flag_task) if flag_task in shipped else 0
        if ships_since >= 1:
            out.append(
                f"IGNORED ESCALATION: {cluster['category']}"
                f"{' @ ' + cluster['area'] if cluster['area'] else ''} went RECURRING at "
                f"{flag_task}; {ships_since} ship(s) since with no consolidating decision "
                "or refactor story — the escalation loop is being ignored"
            )
    return out


def stale_deferrals(base: Path) -> list[str]:
    today = datetime.date.today()
    out = []
    for row in load_rows(base):
        if row["status"] != "open":
            continue
        try:
            age = (today - datetime.date.fromisoformat(row["added"])).days
        except ValueError:
            age = DEFERRAL_STALE_DAYS + 1  # unparseable date is stale by definition
        if age > DEFERRAL_STALE_DAYS:
            out.append(
                f"STALE DEFERRAL: {row['id']} open {age} day(s) ({row['item']}) — "
                f"re-check its trigger ({row['trigger']}) or resolve it"
            )
    return out


def decayed_lessons(base: Path) -> list[str]:
    lessons = load_lessons(base)
    if not lessons:
        return []
    proc = subprocess.run(["git", "ls-files"], cwd=base, capture_output=True, text=True)
    tracked = [line for line in proc.stdout.splitlines() if line] \
        if proc.returncode == 0 else []
    out = []
    for lesson in lessons:
        globs = lesson.get("applies_to", [])
        if not any(_matches(rel, pat) for pat in globs for rel in tracked):
            out.append(
                f"DECAYED LESSON: '{lesson.get('topic')}' matches zero tracked files "
                f"({', '.join(globs)}) — its sensor rotted (rename?); retarget the "
                "globs or retire it, or it can never resurface"
            )
    return out


def review_drift(base: Path) -> list[str]:
    """Only the LATEST shipped task with findings is judged — early tasks may
    predate structured findings; current drift is what matters."""
    rows_by_task: dict[str, list[dict]] = {}
    for row in collect(base):
        rows_by_task.setdefault(row["task"], []).append(row)
    shipped_with_findings = [t for t in _shipped(base) if rows_by_task.get(t)]
    if not shipped_with_findings:
        return []
    latest = shipped_with_findings[-1]
    if any(r["category"] for r in rows_by_task[latest]):
        return []
    return [
        f"REVIEW DRIFT: every finding on {latest} (the latest shipped task with "
        "findings) is an unstructured string — they can never cluster, so the "
        "escalation loop is blind; re-align reviews with .agents/prompts/reviewer.md"
    ]


def issues(base: Path) -> list[str]:
    return (ignored_escalations(base) + stale_deferrals(base)
            + decayed_lessons(base) + review_drift(base))


def cmd_audit(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    problems = issues(base)
    if not problems:
        print("Loop health: clean — escalations routed, deferrals fresh, lessons "
              "live, reviews clustering.")
        return
    for problem in problems:
        print(f"- {problem}")
    print(f"\n{len(problems)} loop-health issue(s). These are advisory: route the "
          "work (refactor story, defer resolve, lesson edit via PR) — do not "
          "silence the audit.")
