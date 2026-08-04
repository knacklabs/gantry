"""forge assumptions — the structured ledger (plans/assumptions.md).

Every call an implementer makes that the plan does not cover lands here as a
row the ORCHESTRATOR (the coordinating session / EM) can scan and guide:
confirm it, demand a fix, or promote it to a decision record. `forge plan
assume` appends rows during implementation; `pr_ready.py` refuses to ship a
task while any of its assumptions are still `open` or `fix-needed` — guidance
is a gate, not a hope. The file is markdown so humans read it in the PR; the
row format is strict so the tooling can manage it.
"""
from __future__ import annotations

import argparse
import datetime
import re
from pathlib import Path

from factory_lib import load_json, repo_root, run_state_path

from .common import fail

HEADER = """# Implementation Assumptions Ledger

One row per assumption made during implementation (`forge plan assume`).
The orchestrator reviews open rows and guides:
`./forge assumptions resolve <id> --status confirmed|fix-needed|promoted --notes "..."`.
`pr_ready.py` refuses while the task has rows at `open` or `fix-needed`.

| id | date | issue | assumption | status | guidance |
|----|------|-------|------------|--------|----------|
"""

STATUSES = {"open", "confirmed", "fix-needed", "promoted"}
BLOCKING = {"open", "fix-needed"}
ROW = re.compile(r"^\| (A-\d{4}) \| ([^|]*) \| ([^|]*) \| (.*) \| ([a-z-]+) \| (.*) \|$")


def ledger_path(base: Path) -> Path:
    return base / "plans" / "assumptions.md"


def _clean(text: str) -> str:
    return text.replace("|", "/").replace("\n", " ").strip()


def load_rows(base: Path) -> list[dict]:
    """Strict parse: a data row that doesn't match the format, or carries an
    unknown status, FAILS — a silently-dropped row is an assumption that
    ships unguided (merge artifacts and hand edits are the realistic cause)."""
    path = ledger_path(base)
    if not path.exists():
        return []
    rows = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if not line.startswith("| A-"):
            continue  # header/prose lines are not data rows
        match = ROW.match(line)
        if not match:
            fail(f"plans/assumptions.md line {lineno} is a malformed data row "
                 f"(merge artifact or hand edit?): {line[:80]!r} — repair it; "
                 "rows are managed by forge commands.")
        row = {
            "id": match.group(1), "date": match.group(2).strip(),
            "issue": match.group(3).strip(), "assumption": match.group(4).strip(),
            "status": match.group(5).strip(), "guidance": match.group(6).strip(),
        }
        if row["status"] not in STATUSES:
            fail(f"plans/assumptions.md line {lineno}: unknown status "
                 f"{row['status']!r} — allowed: {', '.join(sorted(STATUSES))}.")
        rows.append(row)
    return rows


def save_rows(base: Path, rows: list[dict]) -> None:
    lines = [f"| {r['id']} | {r['date']} | {r['issue']} | {r['assumption']} "
             f"| {r['status']} | {r['guidance']} |" for r in rows]
    ledger_path(base).parent.mkdir(parents=True, exist_ok=True)
    ledger_path(base).write_text(HEADER + "\n".join(lines) + ("\n" if lines else ""))


def append_row(base: Path, issue: str, assumption: str) -> str:
    rows = load_rows(base)
    next_id = max((int(r["id"][2:]) for r in rows), default=0) + 1
    rows.append({
        "id": f"A-{next_id:04d}", "date": datetime.date.today().isoformat(),
        "issue": _clean(issue), "assumption": _clean(assumption),
        "status": "open", "guidance": "",
    })
    save_rows(base, rows)
    return rows[-1]["id"]


def blocking_for_issue(base: Path, issue: str) -> list[dict]:
    return [r for r in load_rows(base) if r["issue"] == issue and r["status"] in BLOCKING]


def open_count(base: Path) -> int:
    return sum(1 for r in load_rows(base) if r["status"] in BLOCKING)


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    rows = load_rows(base)
    if not rows:
        print("No assumptions recorded (plans/assumptions.md) — "
              "implementers add them via `forge plan assume`.")
        return
    for r in rows:
        if args.open and r["status"] not in BLOCKING:
            continue
        guidance = f" — {r['guidance']}" if r["guidance"] else ""
        print(f"[{r['status']:<10}] {r['id']} {r['issue']}: {r['assumption']}{guidance}")


def cmd_archive(args: argparse.Namespace) -> None:
    """Milestone compaction: resolved rows from finished tasks move to
    plans/assumptions-archive.md, keeping the working ledger scannable.
    Open/fix-needed rows and the active task's rows never move."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active_issue = load_json(run_state_path(base), default={}).get("issue_key", "")
    rows = load_rows(base)
    keep = [r for r in rows if r["status"] in BLOCKING or r["issue"] == active_issue]
    moved = [r for r in rows if r not in keep]
    if not moved:
        print("Nothing to archive — all rows are open or belong to the active task.")
        return
    archive = ledger_path(base).with_name("assumptions-archive.md")
    if not archive.exists():
        archive.write_text(
            "# Assumptions Archive\n\nResolved rows compacted from "
            "plans/assumptions.md at milestones (`forge assumptions archive`).\n\n"
            "| id | date | issue | assumption | status | guidance |\n"
            "|----|------|-------|------------|--------|----------|\n"
        )
    with archive.open("a") as fh:
        for r in moved:
            fh.write(f"| {r['id']} | {r['date']} | {r['issue']} | {r['assumption']} "
                     f"| {r['status']} | {r['guidance']} |\n")
    save_rows(base, keep)
    print(f"Archived {len(moved)} resolved assumption(s) -> {archive.relative_to(base)}")


def cmd_resolve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if args.status not in STATUSES - {"open"}:
        fail(f"--status must be one of {', '.join(sorted(STATUSES - {'open'}))}")
    if not (args.notes or "").strip():
        fail("--notes required: the guidance IS the record "
             "(what to do about it / why it stands / which decision it became)")
    rows = load_rows(base)
    row = next((r for r in rows if r["id"] == args.id), None)
    if row is None:
        fail(f"{args.id} is not in plans/assumptions.md")
    guidance = _clean(args.notes)
    if args.status == "promoted":
        # Promotion MEANS a decision record exists — not a promise to write one.
        if not getattr(args, "decision", None):
            fail("--status promoted requires --decision <slug>: promotion means the "
                 "assumption became a docs/decisions/ record, not that it might.")
        slug = args.decision.strip().lower().replace(" ", "-")
        matches = sorted((base / "docs" / "decisions").glob(f"[0-9]*-{slug}.md"))
        if not matches:
            fail(f"no decision record matching docs/decisions/NNNN-{slug}.md — "
                 "create it first (./forge decision new).")
        guidance = f"{guidance} -> {matches[-1].name}"
    row["status"] = args.status
    row["guidance"] = guidance
    save_rows(base, rows)
    print(f"{args.id}: {args.status} — {row['guidance']}")
