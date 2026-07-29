"""forge findings — review-finding pattern detection across tasks.

Recurring findings are a design signal, not a fix queue. Review artifacts
accumulate per task under .factory/history/<issue>/reviews/ (plus the active
task's .factory/reviews/); this module clusters their findings by
(category, area) and flags any CLASS that keeps respawning — the trigger to
stop patching individual findings and either CONSOLIDATE (write the
invariant, audit every site) or SPLIT OUT the entangled scope. Doctrine:
WORKFLOW.md "Recurring Findings — a design signal".
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import load_json, repo_root

RECURRING_AT = 3  # same class a third time = stop patching, consolidate
WATCH_AT = 2


def _finding_rows(task: str, aspect: str, data: dict) -> list[dict]:
    rows: list[dict] = []
    for field, blocking in (("blocking_findings", True), ("non_blocking_findings", False)):
        for entry in data.get(field) or []:
            if isinstance(entry, dict):
                rows.append({
                    "task": task, "aspect": aspect, "blocking": blocking,
                    "category": str(entry.get("category", "")).strip(),
                    "area": str(entry.get("area", "")).strip(),
                    "summary": str(entry.get("summary", "")).strip(),
                })
            elif isinstance(entry, str) and entry.strip():
                # Legacy plain-string findings cluster on exact text only.
                rows.append({
                    "task": task, "aspect": aspect, "blocking": blocking,
                    "category": "", "area": "", "summary": entry.strip(),
                })
    return rows


def collect(base: Path) -> list[dict]:
    """Every finding ever recorded: shipped tasks (history) + the active task."""
    rows: list[dict] = []
    history = base / ".factory" / "history"
    if history.is_dir():
        for task_dir in sorted(p for p in history.iterdir() if p.is_dir()):
            for review in sorted((task_dir / "reviews").glob("*.json")):
                data = load_json(review, default={})
                rows += _finding_rows(task_dir.name, review.stem, data)
    active_issue = load_json(base / ".factory" / "run.json", default={}).get("issue_key", "")
    for review in sorted((base / ".factory" / "reviews").glob("*.json")):
        data = load_json(review, default={})
        rows += _finding_rows(active_issue or "<active>", review.stem, data)
    return rows


def clusters(base: Path) -> list[dict]:
    """Findings grouped into classes: (category, area) for structured ones,
    exact text for legacy strings. Sorted most-recurring first."""
    grouped: dict[tuple[str, str], dict] = {}
    for row in collect(base):
        key = (row["category"], row["area"]) if row["category"] \
            else ("", row["summary"].lower())
        cluster = grouped.setdefault(key, {
            "category": row["category"] or "(uncategorized)",
            "area": row["area"], "count": 0, "tasks": [], "examples": [],
        })
        cluster["count"] += 1
        if cluster["count"] == RECURRING_AT:
            # The task at which the class crossed the line — the audit measures
            # how many ships have ignored the escalation since this point.
            cluster["flagged_at"] = row["task"]
        if row["task"] not in cluster["tasks"]:
            cluster["tasks"].append(row["task"])
        if row["summary"] and len(cluster["examples"]) < 3:
            cluster["examples"].append(row["summary"])
    return sorted(grouped.values(), key=lambda c: -c["count"])


def recurring(base: Path) -> list[dict]:
    return [c for c in clusters(base) if c["count"] >= RECURRING_AT]


def cmd_patterns(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    all_clusters = clusters(base)
    if not all_clusters:
        print("No review findings recorded yet (.factory/history/*/reviews/ is empty).")
        return
    flagged = [c for c in all_clusters if c["count"] >= WATCH_AT]
    if not flagged:
        print(f"{len(all_clusters)} finding class(es), none recurring — healthy tail.")
        return
    for cluster in flagged:
        label = "RECURRING" if cluster["count"] >= RECURRING_AT else "watch"
        where = f" @ {cluster['area']}" if cluster["area"] else ""
        example = f' — e.g. "{cluster["examples"][0]}"' if cluster["examples"] else ""
        print(f"[{label} x{cluster['count']}] {cluster['category']}{where} "
              f"(tasks: {', '.join(cluster['tasks'])}){example}")
    if any(c["count"] >= RECURRING_AT for c in flagged):
        print(
            "\nA RECURRING class is a design signal, not a fix queue "
            "(WORKFLOW.md 'Recurring Findings'):\n"
            "  1. Write the invariant the area must satisfy -> ./forge decision new <slug>\n"
            "  2. CONSOLIDATE (self-contained churn): a refactor story on the roadmap that\n"
            "     audits every site against the invariant and pins it with tests, or\n"
            "  3. SPLIT OUT (entangled/cycle-sized): defer with a trigger — "
            "./forge defer add\n"
            "Distinguish it from a converging TAIL (distinct findings, trending down): "
            "a tail is healthy, keep going."
        )
