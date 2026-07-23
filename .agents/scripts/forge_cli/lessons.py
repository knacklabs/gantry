"""forge lesson — the durable lessons ledger (plans/lessons.jsonl).

The learn→apply loop: after a repeated failure or an accepted review finding,
the worker records a lesson (`forge lesson add`); before the next task
touches the same paths, `forge lesson relevant` surfaces it. Lessons are
committed (they are project knowledge, not task state), schema-validated
(.agents/schemas/lesson.json), and deduplicated on lesson text. The
skill-miner curates them at retro cadence: recurring lessons promote into
decisions or constitution changes; stale ones retire.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from fnmatch import fnmatch
from pathlib import Path

from factory_lib import now_iso, repo_root, validate_payload

from .common import fail

SEVERITIES = {"low", "medium", "high"}


def lessons_path(base: Path) -> Path:
    return base / "plans" / "lessons.jsonl"


def load_lessons(base: Path) -> list[dict]:
    """Strict parse: a malformed line is a merge artifact or hand edit and
    FAILS loudly — a silently-dropped lesson is a repeated mistake waiting."""
    path = lessons_path(base)
    if not path.exists():
        return []
    lessons = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            fail(f"plans/lessons.jsonl line {lineno} is not valid JSON "
                 f"(merge artifact or hand edit?): {line[:80]!r} — repair it; "
                 "lines are managed by `forge lesson add`.")
        if not isinstance(entry, dict):
            fail(f"plans/lessons.jsonl line {lineno} must be a JSON object")
        lessons.append(entry)
    return lessons


def _matches(rel: str, pattern: str) -> bool:
    pattern = pattern.strip()
    if not pattern:
        return False
    if pattern.endswith("/**"):
        return rel.startswith(pattern[:-3].rstrip("/") + "/") or fnmatch(rel, pattern)
    if pattern.endswith("/"):
        return rel.startswith(pattern)
    return fnmatch(rel, pattern)


def relevant_lessons(base: Path, files: list[str]) -> list[dict]:
    rels = [f.strip().lstrip("./") for f in files if f.strip()]
    hits = []
    for lesson in load_lessons(base):
        if any(_matches(rel, pat) for pat in lesson.get("applies_to", []) for rel in rels):
            hits.append(lesson)
    return hits


def changed_files(base: Path) -> list[str]:
    """Default relevance scope: everything different from HEAD plus untracked."""
    out: set[str] = set()
    for cmd in (["git", "diff", "--name-only", "HEAD"],
                ["git", "ls-files", "--others", "--exclude-standard"]):
        proc = subprocess.run(cmd, cwd=base, capture_output=True, text=True)
        if proc.returncode == 0:
            out.update(line.strip() for line in proc.stdout.splitlines() if line.strip())
    return sorted(out)


def cmd_add(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    payload = {
        "topic": (args.topic or "").strip(),
        "lesson": (args.lesson or "").strip(),
        "source": (args.source or "").strip(),
        "applies_to": args.applies_to or [],
        "severity": (args.severity or "").strip(),
        "generated_by": (args.by or "").strip(),
    }
    validate_payload(base, "lesson", payload)
    if payload["severity"] not in SEVERITIES:
        fail(f"--severity must be one of {', '.join(sorted(SEVERITIES))}")
    if not all(isinstance(p, str) and p.strip() for p in payload["applies_to"]):
        fail("--applies-to takes path globs (e.g. 'src/api/**' '*.sql')")
    for field in ("topic", "lesson", "source"):
        if not payload[field]:
            fail(f"--{field} must be non-empty")
    existing = load_lessons(base)
    if any(l.get("lesson", "").strip().lower() == payload["lesson"].lower()
           for l in existing):
        fail("this lesson text is already ledgered — refine the existing entry "
             "via PR instead of duplicating it")
    payload["added_at"] = now_iso()
    path = lessons_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(payload) + "\n")
    print(f"Lesson ledgered ({len(existing) + 1} total) -> plans/lessons.jsonl")


def cmd_relevant(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    files = args.files or changed_files(base)
    if not files:
        print("No files given and no working-tree changes — pass the paths you "
              "are about to touch: forge lesson relevant --files src/api/ ...")
        return
    hits = relevant_lessons(base, files)
    if not hits:
        print(f"No ledgered lessons match {len(files)} file(s).")
        return
    for lesson in hits:
        print(f"[{lesson.get('severity', '?'):<6}] {lesson.get('topic')}: "
              f"{lesson.get('lesson')} (source: {lesson.get('source')})")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    lessons = load_lessons(base)
    if not lessons:
        print("No lessons ledgered yet (plans/lessons.jsonl) — record one after a "
              "repeated failure or accepted review finding: forge lesson add.")
        return
    for lesson in lessons:
        globs = ", ".join(lesson.get("applies_to", []))
        print(f"[{lesson.get('severity', '?'):<6}] {lesson.get('topic')}: "
              f"{lesson.get('lesson')} ({globs})")
