"""Audit project-state gaps and repair legacy story metadata."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Callable

from check_board_complete import board_problems
from check_vendor_integrity import integrity_problems
from factory_lib import load_json, repo_root

from .common import fail
from .events import append_event, load_events
from .history import cmd_pr_link
from .roadmap import load_items, pending_story_problems, save_roadmap
from .specs import spec_records, unreferenced_confirmed_specs


GhSeam = Callable[[Path], list[dict]]
PLAN_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def has_discovery_material(base: Path) -> bool:
    """Whether authored discovery exists that should lead to a roadmap."""
    ledger = load_json(base / "docs" / "context" / "ledger.json",
                       default={})
    files = ledger.get("files", {}) if isinstance(ledger, dict) else {}
    if isinstance(files, dict) and any(
        isinstance(entry, dict) and entry.get("status") == "harvested"
        for entry in files.values()
    ):
        return True
    if any((base / "docs" / "decisions").glob("[0-9]*.md")):
        return True
    return any(
        record.get("status") == "confirmed" for record in spec_records(base)
    )


def alignment_gaps(base: Path) -> list[dict[str, str]]:
    """Gaps between discovery, confirmed capabilities, and the roadmap."""
    path = base / "plans" / "roadmap.json"
    roadmap = load_json(path, default={})
    items = roadmap.get("items", []) if isinstance(roadmap, dict) else []
    epics = roadmap.get("epics", []) if isinstance(roadmap, dict) else []
    gaps: list[dict[str, str]] = []
    has_stories = isinstance(items, list) and bool(items)
    if has_discovery_material(base) and not (path.is_file() and has_stories and epics):
        gaps.append({
            "kind": "no-roadmap",
            "detail": (
                "discovery material exists but plans/roadmap.json is absent, empty, "
                "or has no epics; author capabilities with `forge spec save` and "
                "`forge spec confirm`, then use `forge roadmap derive` or "
                "`forge roadmap epic add` plus `forge roadmap add`"
            ),
        })
    if isinstance(items, list) and items:
        gaps.extend({
            "kind": "spec-coverage",
            "detail": (
                f"{spec}: confirmed spec is not referenced by a roadmap story; "
                f"reference it with `forge roadmap add --spec {spec}`"
            ),
        } for spec in unreferenced_confirmed_specs(base))
    return gaps


def project_gaps(base: Path) -> list[dict[str, str]]:
    """Compose the current local validators into one structured gap list."""
    gaps = alignment_gaps(base)
    gaps.extend([
        {"kind": "done-story", "detail": problem}
        for problem in board_problems(base)
    ])
    gaps.extend(
        {"kind": "pending-story", "detail": problem}
        for problem in pending_story_problems(base)
    )
    gaps.extend(
        {"kind": "vendor-drift", "detail": problem}
        for problem in (integrity_problems(base) or [])
    )
    return gaps


def cmd_audit(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    gaps = project_gaps(base)
    if not gaps:
        print("Project audit OK: no project-state gaps.")
        return

    print(f"Project audit FAILED: {len(gaps)} gap(s).")
    for gap in gaps:
        print(f"- [{gap['kind']}] {gap['detail']}")
    raise SystemExit(1)


def _github_merge_records(base: Path) -> list[dict]:
    """Return merged PR records. Kept as a seam so tests never need GitHub."""
    try:
        proc = subprocess.run(
            [
                "gh", "pr", "list", "--state", "merged", "--limit", "10000",
                "--json", "number,title,url,headRefName,body",
            ],
            cwd=base,
            capture_output=True,
            text=True, encoding="utf-8",
        )
    except OSError as exc:
        raise SystemExit(f"project backfill could not run gh: {exc}") from exc
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or "unknown gh error"
        raise SystemExit(f"project backfill could not read merged PRs: {detail}")
    try:
        records = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"project backfill received invalid JSON from gh: {exc}") from exc
    if not isinstance(records, list):
        raise SystemExit("project backfill expected gh to return a JSON list")
    return [record for record in records if isinstance(record, dict)]


def _git(base: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", *args], cwd=base, capture_output=True, text=True,
        encoding="utf-8", errors="strict",
    )
    return proc.stdout if proc.returncode == 0 else None


def _git_paths(base: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", *args], cwd=base, capture_output=True, text=True,
        encoding="utf-8", errors="surrogateescape",
    )
    return proc.stdout if proc.returncode == 0 else None


def _committed_plan_fields(base: Path, key: str) -> dict:
    paths = _git_paths(
        base, "ls-tree", "-r", "--name-only", "HEAD", "--", "plans/completed",
    )
    if paths is None:
        return {}
    prefix = f"plans/completed/{key}-"
    matches = sorted(
        path for path in paths.splitlines()
        if path.startswith(prefix) and path.endswith(".md")
    )
    if len(matches) != 1:
        return {}
    text = _git(base, "show", f"HEAD:{matches[0]}")
    match = PLAN_FRONTMATTER.match(text or "")
    if not match:
        return {}
    fields = {
        name.strip(): value.strip().strip('"').strip("'")
        for name, _, value in (
            line.partition(":") for line in match.group(1).splitlines()
        )
        if name.strip()
    }
    title = fields.get("title", "").strip()
    return {"title": title} if title else {}


def _committed_decomposition_fields(base: Path, key: str) -> dict:
    path = f".factory/history/{key}/decomposition.json"
    text = _git(base, "show", f"HEAD:{path}")
    if text is None:
        return {}
    try:
        decomposition = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(decomposition, dict):
        return {}
    fields = {}
    for name in ("title", "epic", "acceptance_criteria", "skill", "depends_on", "spec"):
        value = decomposition.get(name)
        if isinstance(value, str) and value.strip():
            fields[name] = value
        elif isinstance(value, list):
            fields[name] = value
    return fields


def _reconstruct_card(base: Path, item: dict) -> bool:
    """Fill only fields that committed evidence states verbatim."""
    key = item.get("key")
    if not isinstance(key, str) or not key:
        return False
    recovered = {
        **_committed_plan_fields(base, key),
        **_committed_decomposition_fields(base, key),
    }
    changed = False
    for name, value in recovered.items():
        if name not in item or item[name] in (None, "", []):
            item[name] = value
            changed = True
    if recovered:
        if item.pop("backfill_evidence_missing", None) is not None:
            changed = True
    elif item.get("backfill_evidence_missing") is not True:
        item["backfill_evidence_missing"] = True
        changed = True
    return changed


def _matches(key: str, records: list[dict]) -> list[dict]:
    branch = re.compile(rf"^(?:feat|fix)/{re.escape(key)}-")
    # A non-conventional PR (title/branch don't match) can still name the story
    # key in its BODY — recover those deterministically (D-0014). This is a
    # best-effort backfill signal, NOT proof of ownership: a lone PR that only
    # mentions the key (a revert / "blocked by" / "supersedes") would mislink, so
    # backfill_project treats 2+ matches as ambiguous and links neither; a wrong
    # single-match link is correctable via manual `forge pr-link`. The trailing
    # \b guards FORGE-BOARD-1 against FORGE-BOARD-10 and ASSUMES namespaced keys —
    # a repo mixing bare (BOARD-1) and namespaced (FORGE-BOARD-1) keys would need
    # (?<![\w-]) / (?![\w-]) instead of \b.
    body_ref = re.compile(rf"\b{re.escape(key)}\b")
    found = []
    seen = set()
    for record in records:
        title = record.get("title")
        head = record.get("headRefName")
        body = record.get("body")
        if not (
            isinstance(title, str) and title.startswith(key)
            or isinstance(head, str) and branch.match(head)
            or isinstance(body, str) and body_ref.search(body)
        ):
            continue
        identity = record.get("url") or record.get("number")
        if identity is None or identity in seen:
            continue
        seen.add(identity)
        found.append(record)
    return found


def _pr_reference(record: dict) -> str | None:
    url = record.get("url")
    if isinstance(url, str) and url.strip():
        return url.strip()
    number = record.get("number")
    if isinstance(number, int) and not isinstance(number, bool) and number > 0:
        return f"#{number}"
    return None


def backfill_project(base: Path, gh: GhSeam = _github_merge_records) -> dict[str, int]:
    """Repair done legacy cards and PR links without guessing."""
    items = load_items(base)
    linked = {
        event.get("story")
        for event in load_events(base, event="pr-linked")
        if isinstance(event.get("story"), str)
    }
    candidates = [
        item for item in items
        if item.get("status") == "done"
        and isinstance(item.get("key"), str)
        and item["key"] not in linked
        and item.get("predates_outcome_contract") is not True
    ]
    records = gh(base) if candidates else []
    counts = {"linked": 0, "unresolved": 0, "ambiguous": 0, "reconstructed": 0}
    changed = False

    for item in candidates:
        key = item["key"]
        if _reconstruct_card(base, item):
            counts["reconstructed"] += 1
            changed = True
        matches = _matches(key, records)
        if len(matches) == 1:
            reference = _pr_reference(matches[0])
            if reference is None:
                print(f"SKIP {key}: unique GitHub match has no PR reference")
                counts["ambiguous"] += 1
                continue
            cmd_pr_link(argparse.Namespace(repo=str(base), story=key, reference=reference))
            counts["linked"] += 1
        elif not matches:
            counts["unresolved"] += 1
            print(f"SKIP {key}: unresolved provenance (no GitHub merge match)")
        else:
            references = [reference for match in matches
                          if (reference := _pr_reference(match))]
            detail = ", ".join(references) if references else f"{len(matches)} matches"
            print(f"SKIP {key}: ambiguous GitHub merge matches: {detail}")
            counts["ambiguous"] += 1

    if changed:
        save_roadmap(base, items)
    return counts


def cmd_backfill(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    counts = backfill_project(base)
    print(
        "Project backfill complete: "
        f"{counts['linked']} linked, {counts['unresolved']} unresolved, "
        f"{counts['ambiguous']} ambiguous, {counts['reconstructed']} card(s) reconstructed."
    )


def cmd_mark_predates(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    reason = args.reason.strip()
    if not reason:
        fail("project mark-predates requires a non-blank --reason")

    items = load_items(base)
    item = next((entry for entry in items if entry.get("key") == args.key), None)
    if item is None:
        fail(f"{args.key} is not on the roadmap")

    item["predates_outcome_contract"] = True
    save_roadmap(base, items)
    append_event(
        base,
        "project-mark-predates",
        actor="human",
        story=args.key,
        detail=reason,
    )
    print(f"Marked {args.key} predates_outcome_contract: {reason}")
