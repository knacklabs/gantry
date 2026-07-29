"""forge gstack migrate — move a dev's PERSONAL gstack store into the repo.

Going forward, `.envrc` pins GSTACK_HOME to `<repo>/.gstack`, so gstack
(office-hours design docs, decision store, learnings) writes into the repo
directly — committed, shared, merge-safe (JSONL files use the jsonl-append
union merge driver from .gitattributes). This command is the one-time
migration for exhaust already stranded in `~/.gstack/projects/<slug>/` on a
dev's machine. Idempotent per dev; safe to run on every machine that holds
history:
- .jsonl files are UNION-merged line-wise into the repo store (no clobber)
- other files are copied if missing or identical; a differing same-name file
  lands alongside as <stem>.from-<dev><suffix> so nothing is overwritten
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path

from factory_lib import repo_root

from .common import fail

MIGRATE_SUFFIXES = {".md", ".markdown", ".json", ".jsonl", ".txt"}
MIGRATE_MAX_BYTES = 2_000_000
# Derived caches and per-session churn are noise, not record — never migrate.
MIGRATE_SKIP_DIRS = {"brain-cache", "tmp", "sessions", "analytics"}
MIGRATE_SKIP_NAMES = {"timeline.jsonl"}


def slug_candidates(base: Path) -> list[str]:
    """gstack keys its store by <owner>-<repo> (from the origin URL); the
    directory name is the fallback for remoteless repos."""
    candidates: list[str] = []
    proc = subprocess.run(
        ["git", "remote", "get-url", "origin"], cwd=base, capture_output=True, text=True
    )
    if proc.returncode == 0 and proc.stdout.strip():
        parts = [p for p in re.split(r"[:/]", proc.stdout.strip().removesuffix(".git")) if p]
        if len(parts) >= 2:
            candidates.append(re.sub(r"[^A-Za-z0-9._-]", "-", f"{parts[-2]}-{parts[-1]}"))
    candidates.append(base.name)
    return candidates


def dev_slug(base: Path) -> str:
    proc = subprocess.run(
        ["git", "config", "user.email"], cwd=base, capture_output=True, text=True
    )
    local = proc.stdout.strip().split("@")[0] if proc.returncode == 0 else ""
    return re.sub(r"[^A-Za-z0-9._-]", "-", local) or "local"


def union_merge_jsonl(src: Path, dest: Path) -> int:
    """Append src lines missing from dest; returns how many were added."""
    src_lines = [ln for ln in src.read_text().splitlines() if ln.strip()]
    if not dest.exists():
        dest.write_text("\n".join(src_lines) + "\n" if src_lines else "")
        return len(src_lines)
    existing = set(ln for ln in dest.read_text().splitlines() if ln.strip())
    new = [ln for ln in src_lines if ln not in existing]
    if new:
        with dest.open("a") as fh:
            for ln in new:
                fh.write(ln + "\n")
    return len(new)


def cmd_migrate(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    personal = Path(args.source).expanduser() if args.source else Path.home() / ".gstack"
    projects = personal / "projects"
    repo_store = base / ".gstack" / "projects"
    if projects.resolve() == repo_store.resolve():
        fail(
            "the personal store IS the repo store (GSTACK_HOME already points here) — "
            "nothing to migrate. Pass --source <dir> to migrate from another location."
        )
    slugs = [args.slug] if args.slug else slug_candidates(base)
    sources: list[Path] = []
    seen: set[Path] = set()
    for slug in slugs:
        src = projects / slug
        if src.is_dir() and src.resolve() not in seen:
            seen.add(src.resolve())
            sources.append(src)
        # The bare directory name is a FALLBACK for remoteless repos — when an
        # origin-derived store matched, a same-named store from some OTHER
        # project must not ride along (it may hold another client's designs).
        if sources and not args.slug:
            break
    if not sources:
        available = sorted(p.name for p in projects.glob("*") if p.is_dir()) \
            if projects.is_dir() else []
        hint = f" Available: {', '.join(available[:10])}." if available else ""
        fail(
            f"no personal gstack store for {', '.join(slugs)} under {projects}.{hint} "
            "Pass --slug <name> (or --source <gstack-home>)."
        )
    dev = dev_slug(base)
    copied = merged = skipped = 0
    for src in sources:
        dest_root = repo_store / src.name
        for path in sorted(src.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            rel_parts = set(path.relative_to(src).parts[:-1])
            if rel_parts & MIGRATE_SKIP_DIRS or path.name in MIGRATE_SKIP_NAMES:
                skipped += 1
                continue
            if path.suffix.lower() not in MIGRATE_SUFFIXES \
                    or path.stat().st_size > MIGRATE_MAX_BYTES:
                skipped += 1
                continue
            dest = dest_root / path.relative_to(src)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix.lower() == ".jsonl":
                merged += union_merge_jsonl(path, dest)
            elif not dest.exists():
                shutil.copy2(path, dest)
                copied += 1
            elif dest.read_bytes() == path.read_bytes():
                skipped += 1
            else:
                alongside = dest.with_name(f"{dest.stem}.from-{dev}{dest.suffix}")
                shutil.copy2(path, alongside)
                copied += 1
    print(f"Migrated {', '.join(str(s) for s in sources)} -> "
          f"{repo_store.relative_to(base)}/ "
          f"({copied} file(s) copied, {merged} jsonl line(s) merged, {skipped} skipped)")
    print("Commit the result — the repo store is the shared record. "
          "Your personal ~/.gstack copy can stay; with .envrc active it is no longer written to.")
