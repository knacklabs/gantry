"""forge defer — the deferral ledger (plans/deferrals.md).

Scope removed deliberately must not vanish silently: SPLIT OUT outcomes from
the recurring-findings rule, parked grill `open_items`, and Deferred rows
from a plan's Surface Impact land here — each with an EXPLICIT trigger for
when to revisit ("Fleet storage pressure", "second tenant onboards"), so
scope decisions self-surface instead of relying on memory. Markdown so
humans read it in the PR; strict rows so tooling can manage it (same
contract as the assumptions ledger).
"""
from __future__ import annotations

import argparse
import datetime
import re
from pathlib import Path

from factory_lib import repo_root

from .common import fail

HEADER = """# Deferral Ledger

Deliberately-removed scope with explicit revisit triggers (`forge defer add`).
When a trigger fires, the item goes back on the roadmap and its row is
resolved: `./forge defer resolve <id> --notes "<what happened>"`.

| id | added | item | why deferred | trigger to revisit | status |
|----|-------|------|--------------|--------------------|--------|
"""

STATUSES = {"open", "done"}
ROW = re.compile(r"^\| (D-\d{4}) \| ([^|]*) \| (.*) \| (.*) \| (.*) \| ([a-z-]+) \|$")


def ledger_path(base: Path) -> Path:
    return base / "plans" / "deferrals.md"


def _clean(text: str) -> str:
    return text.replace("|", "/").replace("\n", " ").strip()


def load_rows(base: Path) -> list[dict]:
    """Strict parse, like the assumptions ledger: a malformed or unknown-status
    row FAILS — a silently-dropped deferral is scope that never comes back."""
    path = ledger_path(base)
    if not path.exists():
        return []
    rows = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if not line.startswith("| D-"):
            continue
        match = ROW.match(line)
        if not match:
            fail(f"plans/deferrals.md line {lineno} is a malformed data row "
                 f"(merge artifact or hand edit?): {line[:80]!r} — repair it; "
                 "rows are managed by forge commands.")
        row = {
            "id": match.group(1), "added": match.group(2).strip(),
            "item": match.group(3).strip(), "why": match.group(4).strip(),
            "trigger": match.group(5).strip(), "status": match.group(6).strip(),
        }
        if row["status"] not in STATUSES:
            fail(f"plans/deferrals.md line {lineno}: unknown status "
                 f"{row['status']!r} — allowed: {', '.join(sorted(STATUSES))}.")
        rows.append(row)
    return rows


def save_rows(base: Path, rows: list[dict]) -> None:
    lines = [f"| {r['id']} | {r['added']} | {r['item']} | {r['why']} "
             f"| {r['trigger']} | {r['status']} |" for r in rows]
    ledger_path(base).parent.mkdir(parents=True, exist_ok=True)
    ledger_path(base).write_text(HEADER + "\n".join(lines) + ("\n" if lines else ""))


def open_count(base: Path) -> int:
    return sum(1 for r in load_rows(base) if r["status"] == "open")


def cmd_add(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    for flag, value in (("--why", args.why), ("--trigger", args.trigger)):
        if not (value or "").strip():
            fail(f"{flag} required — a deferral without "
                 f"{'a reason' if flag == '--why' else 'a revisit trigger'} is scope "
                 "silently dropped")
    rows = load_rows(base)
    next_id = max((int(r["id"][2:]) for r in rows), default=0) + 1
    rows.append({
        "id": f"D-{next_id:04d}", "added": datetime.date.today().isoformat(),
        "item": _clean(args.item), "why": _clean(args.why),
        "trigger": _clean(args.trigger), "status": "open",
    })
    save_rows(base, rows)
    print(f"Deferred as {rows[-1]['id']} (plans/deferrals.md) — revisit when: "
          f"{rows[-1]['trigger']}")


def cmd_resolve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if not (args.notes or "").strip():
        fail("--notes required: say what happened (back on the roadmap as <KEY>, "
             "or why it is permanently out of scope)")
    rows = load_rows(base)
    row = next((r for r in rows if r["id"] == args.id), None)
    if row is None:
        fail(f"{args.id} is not in plans/deferrals.md")
    row["status"] = "done"
    row["trigger"] = f"{row['trigger']} -> {_clean(args.notes)}"
    save_rows(base, rows)
    print(f"{args.id}: done — {row['trigger']}")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    rows = load_rows(base)
    if not rows:
        print("No deferrals ledgered (plans/deferrals.md) — removed scope lands "
              "here via `forge defer add` with an explicit revisit trigger.")
        return
    for r in rows:
        if getattr(args, "open", False) and r["status"] != "open":
            continue
        print(f"[{r['status']:<4}] {r['id']} {r['item']} — why: {r['why']}; "
              f"revisit when: {r['trigger']}")
