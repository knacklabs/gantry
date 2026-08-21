"""Compose repo hygiene checks and apply only explicitly safe repairs."""
from __future__ import annotations

import argparse
import io
import json
import subprocess
from contextlib import redirect_stdout
from pathlib import Path

from check_repo_budget import tracked_cruft
from factory_lib import clean_git_env, repo_root
from intake import stale_task_state

from . import context, doctor, project, quickfix, roadmap
from .common import fail


def _git_paths(base: Path, command: list[str]) -> list[str]:
    proc = subprocess.run(
        command, cwd=base, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    if proc.returncode != 0:
        fail(f"could not inspect repo hygiene: {proc.stderr.strip()}")
    return [entry for entry in proc.stdout.split("\0") if entry]


def source_secret_findings(base: Path) -> list[str]:
    """Report secret-shaped content in tracked, regular text files."""
    findings: list[str] = []
    for relative in _git_paths(base, ["git", "ls-files", "-z"]):
        path = base / relative
        if path.is_symlink() or not path.is_file():
            continue
        findings.extend(
            f"{relative}: {finding}" for finding in context.secret_findings(path)
        )
    return findings


def _is_dropping(relative: str) -> bool:
    path = Path(relative.rstrip("/"))
    if path.name == ".DS_Store" or "__pycache__" in path.parts:
        return True
    if path.suffix in {".pyc", ".pyo"}:
        return True
    return (
        path.parts[:1] == (".factory",)
        and path.name.endswith((".tmp", ".tmp.json", ".log"))
    )


def untracked_droppings(base: Path) -> list[str]:
    """List ignored or untracked machine droppings without removing them."""
    records = _git_paths(
        base,
        ["git", "status", "--porcelain=v1", "--ignored", "-z", "--untracked-files=all"],
    )
    return sorted({
        record[3:]
        for record in records
        if record[:2] in {"??", "!!"} and _is_dropping(record[3:])
    })


def secret_cruft_findings(base: Path) -> dict[str, list[str]]:
    """Return repo-wide secret and untracked-cruft findings without mutation."""
    return {
        "secrets": source_secret_findings(base),
        "untracked_droppings": untracked_droppings(base),
    }


def _roadmap_drift(base: Path) -> bool:
    path = roadmap.roadmap_path(base)
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False  # malformed JSON: surfaced by project_gaps, never auto-healed
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return False  # unexpected shape: report via project_gaps, never heal garbage
    _, duplicates = roadmap.heal_items(items)
    return duplicates > 0


def _doctor_report(base: Path) -> tuple[bool, list[str]]:
    output = io.StringIO()
    failed = False
    with redirect_stdout(output):
        try:
            doctor.cmd_doctor(argparse.Namespace(
                fix=False, fast=False, repo=str(base),
            ))
        except SystemExit as exc:
            failed = exc.code not in (None, 0)
    return failed, output.getvalue().splitlines()


def _untrack_cruft(base: Path, paths: list[str]) -> str | None:
    proc = subprocess.run(
        ["git", "rm", "--cached", "--", *paths], cwd=base,
        capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    if proc.returncode != 0:
        return proc.stderr.strip() or proc.stdout.strip() or "git rm --cached failed"
    return None


def cmd_sanitise(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    check = bool(getattr(args, "check", False))
    resolved: list[tuple[str, str]] = []
    unresolved: list[tuple[str, str]] = []

    if _roadmap_drift(base):
        if check:
            unresolved.append(("roadmap-drift", "plans/roadmap.json needs roadmap heal"))
        else:
            try:
                roadmap.cmd_heal(argparse.Namespace(repo=str(base)))
            except SystemExit as exc:
                unresolved.append(("roadmap-drift", str(exc)))
            else:
                resolved.append(("roadmap-drift", "healed plans/roadmap.json"))

    cruft = tracked_cruft(base)
    if cruft:
        detail = f"{len(cruft)} tracked cruft file(s): {', '.join(cruft)}"
        if check:
            unresolved.append(("tracked-cruft", detail))
        else:
            error = _untrack_cruft(base, cruft)
            if error:
                unresolved.append(("tracked-cruft", error))
            else:
                resolved.append((
                    "tracked-cruft",
                    f"untracked with git rm --cached: {', '.join(cruft)}",
                ))

    try:
        gaps = project.project_gaps(base)
    except (json.JSONDecodeError, SystemExit, TypeError, AttributeError, KeyError) as exc:
        gaps = []
        unresolved.append(("board-audit", str(exc)))
    for gap in gaps:
        unresolved.append((f"board-{gap['kind']}", gap["detail"]))

    hygiene = secret_cruft_findings(base)
    unresolved.extend(("secret", finding) for finding in hygiene["secrets"])
    unresolved.extend(
        ("untracked-cruft", finding) for finding in hygiene["untracked_droppings"]
    )
    unresolved.extend(
        ("stale-task-state", str(path.relative_to(base)))
        for path in stale_task_state(base)
    )

    window = quickfix.load_active(base)
    if window:
        unresolved.append((
            "open-window",
            f"{window.get('id', '?')}: {window.get('reason', 'no reason recorded')}",
        ))

    doctor_failed, doctor_lines = _doctor_report(base)
    if doctor_failed:
        detail = next(
            (line for line in reversed(doctor_lines) if line.strip()),
            "doctor checks failed",
        )
        unresolved.append(("doctor", detail))

    if not resolved and not unresolved:
        print("Sanitise report: [OK] no issues found")
        return
    print("\nSanitise report:")
    for kind, detail in resolved:
        print(f"- [FIXED] [{kind}] {detail}")
    for kind, detail in unresolved:
        status = "ISSUE" if check else "UNRESOLVED"
        print(f"- [{status}] [{kind}] {detail}")
    if doctor_failed:
        # Advisories (doctor exit 0) are informational, not issues: surface the
        # full doctor detail only when doctor actually failed, so --check does
        # not dump a scary report and then exit 0.
        print("- [doctor-report]")
        for line in doctor_lines:
            print(f"    {line}")
    issue_count = len(resolved) + len(unresolved) if check else len(unresolved)
    if issue_count:
        raise SystemExit(1)
