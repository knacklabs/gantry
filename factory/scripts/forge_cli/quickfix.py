"""forge quickfix — bounded, ledgered escape hatch from the planning lock."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from factory_lib import (
    append_ledger_record, clean_git_env, dump_json, head_sha, load_json, now_iso,
    load_review_artifacts, read_ledger_records, repo_root,
)

from .common import fail
from .repo_kind import is_harness_source_repo

MAX_FILES = 5
QUICKFIX = "quickfix"
LITE = "lite"
DEGRADED = "degraded"


def quickfix_path(base: Path) -> Path:
    return base / ".factory" / "quickfix.json"


def ledger_path(base: Path) -> Path:
    return base / "plans" / "quickfixes.jsonl"


def load_active(base: Path) -> dict:
    return load_json(quickfix_path(base), default={})


def profile_of(window: dict) -> str:
    """Return the window profile, including legacy quickfix records."""
    return window.get("profile", QUICKFIX)


def load_events(base: Path) -> list[dict]:
    # Directory form plus any legacy plans/quickfixes.jsonl (decision 0022).
    # Order comes from each record's own started_at/completed_at, never from
    # file position — position was never information, and the union merge that
    # used to resolve this file rewrote it anyway, which four review rounds
    # then filed as a state bug.
    return read_ledger_records(ledger_path(base))


def _append(base: Path, event: dict) -> None:
    stamp = event.get("completed_at") or event.get("started_at") or now_iso()
    record_id = f"{stamp.replace(':', '').replace('-', '')}-{event.get('id', 'q')}-{event.get('event', '')}"
    append_ledger_record(ledger_path(base), event, record_id)


def _distinct_union(current: list[str], files: list[str]) -> list[str]:
    return list(dict.fromkeys([*current, *files]))


def record_files(base: Path, files: list[str]) -> None:
    """Passively record distinct files touched by an already-authorized write."""
    active = load_active(base)
    if not active:
        return
    current = list(active.get("files", []))
    active["files"] = _distinct_union(current, files)
    dump_json(quickfix_path(base), active)


def claim_files(base: Path, files: list[str]) -> tuple[bool, dict]:
    """Record distinct product files before a quickfix write.

    Returns (False, active) without mutating state when the union would exceed
    the budget, so a denied tool call never claims files it did not touch.
    """
    active = load_active(base)
    if not active:
        return False, {}
    current = list(active.get("files", []))
    combined = _distinct_union(current, files)
    if len(combined) > int(active.get("max_files", MAX_FILES)):
        return False, active
    active["files"] = combined
    dump_json(quickfix_path(base), active)
    return True, active


def _open(base: Path, *, profile: str, reason: str, by: str | None = None) -> dict:
    reason = reason.strip()
    if not reason:
        fail(f"a {profile} window needs a reason")
    active_window = load_active(base)
    if active_window:
        active_profile = profile_of(active_window)
        closer = "quickfix done" if active_profile == QUICKFIX else "mode done"
        fail(f"a {active_profile} window is already open — finish it with `./forge {closer}`")
    sequence = sum(1 for event in load_events(base) if event.get("event") == "open") + 1
    # Collision-resistant like signal ids: `roadmap parallel` puts several
    # worktrees on the same ledger, and two opening at once would otherwise
    # both mint Q-0001 — pairing the wrong closure with the wrong window.
    suffix = hashlib.sha256(
        f"{os.getpid()}:{now_iso()}:{reason}".encode()
    ).hexdigest()[:4]
    active = {
        "id": f"Q-{sequence:04d}-{suffix}",
        "profile": profile,
        "reason": reason,
        "started_at": now_iso(),
        "max_files": MAX_FILES,
        "files": [],
        # Pin the repo kind for the window's lifetime: the planning lock reads
        # this instead of the live marker while a quickfix is open, so deleting
        # the harness-source marker mid-window (by ANY means) cannot flip the
        # repo to client-mode and let machinery writes escape the file budget.
        "harness_source": is_harness_source_repo(base),
    }
    if profile == DEGRADED:
        active["kind"] = DEGRADED
    if by is not None:
        active["by"] = by
    if profile == LITE:
        active["base_sha"] = head_sha(base)
        if not active["base_sha"]:
            fail("lite mode needs a Git HEAD to record its opening boundary")
    dump_json(quickfix_path(base), active)
    _append(base, {"event": "open", **active})
    return active


def cmd_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = _open(base, profile=QUICKFIX, reason=args.reason)
    print(f"Quickfix {active['id']} open (0/{MAX_FILES} files): {active['reason']}")


def cmd_lite(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    by = args.by.strip()
    if not by:
        fail("lite mode needs --by")
    active = _open(base, profile=LITE, reason=args.reason, by=by)
    print(f"Lite mode {active['id']} open at {active['base_sha'][:8]}: {active['reason']}")


def cmd_degraded_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = _open(base, profile=DEGRADED, reason=args.reason)
    print(f"Degraded mode {active['id']} open (0/{MAX_FILES} files): {active['reason']}")


def cmd_done(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = load_active(base)
    if not active:
        fail("no quickfix is open")
    if profile_of(active) != QUICKFIX:
        fail("a lite window is open — finish it with `./forge mode done`")
    _require_harness_marker(base, active)
    event = {
        "event": "done",
        "id": active["id"],
        "profile": QUICKFIX,
        "reason": active["reason"],
        "started_at": active["started_at"],
        "completed_at": now_iso(),
        "files": active.get("files", []),
    }
    _append(base, event)
    quickfix_path(base).unlink()
    print(f"Quickfix {active['id']} done ({len(event['files'])} file(s)): "
          f"{active['reason']}")


def _require_harness_marker(base: Path, active: dict) -> None:
    """Keep a harness-pinned window from laundering marker deletion."""
    if active.get("harness_source") and not is_harness_source_repo(base):
        fail("this window was opened as the harness source repo, but "
             ".factory/harness-source.json is now missing — restore it before "
             "closing, or the repo would silently become a client and unlock all "
             "machinery.")


def cmd_mode_abandon(args: argparse.Namespace) -> None:
    """Close a crashed mode window without claiming completion."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = load_active(base)
    if not active:
        fail("no mode window is open")
    reason = args.reason.strip()
    if not reason:
        fail("abandoning a mode window needs --reason")
    _require_harness_marker(base, active)
    event = {
        "event": "abandoned",
        "id": active["id"],
        "profile": profile_of(active),
        "reason": reason,
        "opened_reason": active["reason"],
        "started_at": active["started_at"],
        "completed_at": now_iso(),
        "files": active.get("files", []),
    }
    for field in ("by", "base_sha"):
        if field in active:
            event[field] = active[field]
    _append(base, event)
    quickfix_path(base).unlink()
    print(f"Mode window {active['id']} abandoned: {reason}")


def cmd_mode_done(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    active = load_active(base)
    if not active:
        fail("no mode window is open")
    if profile_of(active) == QUICKFIX:
        cmd_done(args)
        return
    if profile_of(active) == DEGRADED:
        _require_harness_marker(base, active)
        event = {
            "event": "done",
            "id": active["id"],
            "profile": DEGRADED,
            "kind": DEGRADED,
            "reason": active["reason"],
            "started_at": active["started_at"],
            "completed_at": now_iso(),
            "files": active.get("files", []),
        }
        _append(base, event)
        quickfix_path(base).unlink()
        print(f"Degraded mode {active['id']} done ({len(event['files'])} file(s)): "
              f"{active['reason']}")
        return
    dirty = _lite_dirty_product_files(base)
    if dirty:
        fail(
            "lite mode has uncommitted product changes — commit the fix first: "
            + ", ".join(dirty[:5])
        )
    files = _lite_manifest(base, active["base_sha"])
    if not files:
        fail("lite mode has no committed product files to close")
    bound = int(active.get("max_files", MAX_FILES))
    if len(files) > bound:
        fail(
            f"lite mode committed diff touches {len(files)} product files; "
            f"the bound is {bound}"
        )
    reviews, review_problems = load_review_artifacts(
        base, require_head=True, blockers_only=True,
    )
    if review_problems:
        fail("lite mode needs clean reviews at HEAD:\n- " + "\n- ".join(review_problems))
    event = {
        "event": "done",
        "id": active["id"],
        "profile": LITE,
        "by": active["by"],
        "reason": active["reason"],
        "base_sha": active["base_sha"],
        "started_at": active["started_at"],
        "completed_at": now_iso(),
        "files": files,
        "reviews": reviews,
    }
    _append(base, event)
    shutil.rmtree(base / ".factory" / "reviews")
    quickfix_path(base).unlink()
    print(f"Lite mode {active['id']} done ({len(event['files'])} file(s)): "
          f"{active['reason']}")


def _lite_manifest(base: Path, base_sha: str) -> list[str]:
    """Return committed product paths changed since the lite window opened."""
    return _lite_product_files(
        base,
        _git_paths(base, ["git", "diff", "--name-only", "-z", f"{base_sha}..HEAD", "--"]),
    )


def _lite_dirty_product_files(base: Path) -> list[str]:
    tracked = _git_paths(base, ["git", "diff", "--name-only", "-z", "HEAD", "--"])
    untracked = _git_paths(
        base, ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    )
    return _lite_product_files(base, [*tracked, *untracked])


def _git_paths(base: Path, command: list[str]) -> list[str]:
    proc = subprocess.run(
        command, cwd=base, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    if proc.returncode != 0:
        fail(f"could not inspect the lite diff: {proc.stderr.strip()}")
    return [path for path in proc.stdout.split("\0") if path]


def _lite_product_files(base: Path, paths: list[str]) -> list[str]:
    """Apply the planning-lock product boundary to repo-relative Git paths."""
    exempt_prefixes = ("plans/", "docs/", ".gstack/", ".github/", "prototype/", ".factory/")
    if not is_harness_source_repo(base):
        exempt_prefixes += ("factory/", "constitution/", "harness/", ".claude/", ".codex/")
    exempt_files = {
        "AGENTS.md", "CLAUDE.md", "WORKFLOW.md", "harness.yaml", "README.md",
        ".gitignore", ".gitattributes", ".envrc",
    }
    return sorted({
        path for path in paths
        if path not in exempt_files and not path.startswith(exempt_prefixes)
    })


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    events = load_events(base)
    active = load_active(base)
    if active and profile_of(active) == QUICKFIX:
        print(f"[OPEN] {active['id']} {len(active.get('files', []))}/"
              f"{active.get('max_files', MAX_FILES)} — {active['reason']}")
    closures = {
        event["id"]: event
        for event in events if event.get("event") in {"done", "abandoned"}
    }
    for event in events:
        if (event.get("event") != "open" or event["id"] not in closures
                or profile_of(event) != QUICKFIX):
            continue
        closure = closures[event["id"]]
        print(f"[{closure['event']}] {event['id']} "
              f"{len(closure.get('files', []))} file(s) — {closure['reason']}")
    if not any(profile_of(event) == QUICKFIX for event in events):
        print("No quickfixes recorded.")


def cmd_mode_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    events = load_events(base)
    active = load_active(base)
    if active:
        profile = profile_of(active).upper()
        print(f"[OPEN {profile}] {active['id']} {len(active.get('files', []))}/"
              f"{active.get('max_files', MAX_FILES)} — {active['reason']}")
    closures = {
        event["id"]: event
        for event in events if event.get("event") in {"done", "abandoned"}
    }
    for event in events:
        if event.get("event") != "open" or event["id"] not in closures:
            continue
        closure = closures[event["id"]]
        print(f"[{closure['event']} {profile_of(event)}] {event['id']} "
              f"{len(closure.get('files', []))} file(s) — {closure['reason']}")
    if not active and not events:
        print("No mode windows recorded.")
