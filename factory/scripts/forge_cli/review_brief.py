"""Compose plan-contract prompts for per-task and branch-wide review."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from factory_lib import (
    branch_diff_digest, load_json, now_iso, protected_decomposition_state_path,
    repo_root, run_state_path, safe_factory_write_bytes,
)


VERDICT_INSTRUCTION = (
    "For each contract, emit a verdict — implemented | partial | missing — "
    "with file:line evidence, recorded as contract_verdicts in the quality "
    "artifact. Then review the diff normally; the contract check does not "
    "replace the quality/performance/security lenses."
)


def declared_contracts(decomposition: dict) -> list[dict]:
    """Return the validated decomposition-wide contract union in task order."""
    contracts: list[dict] = []
    for task in decomposition.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        entries = task.get("plan_contracts", [])
        if not isinstance(entries, list):
            continue
        contracts.extend(
            contract for contract in entries
            if isinstance(contract, dict) and isinstance(contract.get("id"), str)
        )
    return contracts


def _lessons_section(base: Path, task: dict) -> list[str]:
    """Lessons whose `applies_to` globs hit the task's write scope — the
    reviewer must not re-raise a finding the ledger already settled (the
    2026-09-04 case: a per-task review re-flagged as P1 the exact behaviour a
    recorded lesson pins as deliberate, because the brief never carried it)."""
    from .lessons import relevant_lessons
    scope = [p for p in task.get("write_scope", []) if isinstance(p, str)]
    if not scope:
        return []
    try:
        hits = relevant_lessons(base, scope)
    except SystemExit:
        return []
    if not hits:
        return []
    lines = ["### Lessons in force", "",
             "Recorded lessons that apply to this task's paths. A finding that "
             "contradicts one is not a defect unless it shows the lesson itself "
             "is wrong; say so explicitly instead of re-raising it.", ""]
    for lesson in hits:
        topic = str(lesson.get("topic", "")).strip()
        body = str(lesson.get("lesson", "")).strip()
        severity = str(lesson.get("severity", "")).strip()
        lines.append(f"- [{severity}] {topic}: {body}")
    lines.append("")
    return lines


def _evidence_section(base: Path) -> list[str]:
    """The story's recorded verification evidence, summarised for the reviewer.

    The review bundle is the product delta only (bookkeeping paths sit at the
    task base), so the reviewer no longer sees `verify.json` / `tests.json`
    in the diff — and a contract like "suites pass; tsc and architecture
    green" was recorded `partial` for lack of execution evidence (issue #171).
    The brief carries the summary instead: what verify ran and whether it was
    green, and what the automated-test record says."""
    from factory_lib import evidence_path
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        return []
    lines: list[str] = []
    verify = load_json(evidence_path(base, story, "verify.json"), default={})
    if verify:
        ok = "ok" if verify.get("ok") is True else "FAILED"
        commit = str(verify.get("commit", ""))[:12]
        lines.append(f"- verify.py: {ok}" + (f" at {commit}" if commit else ""))
        for result in verify.get("results") or []:
            if isinstance(result, dict) and result.get("command"):
                code = result.get("exit_code")
                lines.append(f"  - `{result['command']}` -> exit {code}")
    tests = load_json(evidence_path(base, story, "tests.json"), default={})
    automated = (tests or {}).get("automated")
    if isinstance(automated, dict):
        lines.append(f"- automated tests: {automated.get('status', 'unknown')}")
        summary = str(automated.get("summary", "")).strip()
        if summary:
            lines.append(f"  - {summary}")
        commands = automated.get("commands_run") or []
        if commands:
            lines.append(f"  - {len(commands)} command(s) recorded, e.g. `{commands[0]}`")
    if not lines:
        return []
    return ["### Recorded evidence", "",
            "Recorded by the harness for this story (not in the diff). Use it to "
            "verdict verification contracts; do not mark them partial for lack "
            "of execution evidence in the bundle.", "", *lines, ""]


def _task_section(task: dict, base: Path | None = None) -> list[str]:
    task_id = task.get("id", "")
    lines = [f"## Task {task_id}", "", "### Plan contracts", ""]
    contracts = task.get("plan_contracts", [])
    if contracts:
        for contract in contracts:
            lines.extend([
                f"- **{contract['id']}**",
                f"  - Source: {contract['source']}",
                f"  - Statement: {contract['statement']}",
            ])
    else:
        lines.append("- None declared.")
    reviewer_focus = task.get("reviewer_focus") \
        or "No task-specific reviewer focus declared."
    if isinstance(reviewer_focus, list):
        # The decomposition records reviewer_focus as a LIST; render bullets.
        reviewer_focus = "\n".join(f"- {item}" for item in reviewer_focus)
    lines.extend([
        "", "### Reviewer focus", "",
        reviewer_focus,
        "",
    ])
    if base is not None:
        lines.extend(_lessons_section(base, task))
        lines.extend(_evidence_section(base))
    return lines


def cmd_review_brief(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decomposition = load_json(protected_decomposition_state_path(base), default={})
    if not decomposition:
        raise SystemExit(
            "No recorded decomposition. Record it before composing a review brief."
        )
    if bool(args.id) == bool(args.all):
        raise SystemExit("review-brief requires exactly one task id or --all")

    tasks = decomposition.get("tasks") or []
    if args.all:
        selected = tasks
        filename = "all.md"
        title = "# Branch-wide plan-contract review brief"
    else:
        selected = [task for task in tasks if task.get("id") == args.id]
        if not selected:
            raise SystemExit(f"Unknown decomposition task id: {args.id}")
        filename = f"{args.id}.md"
        title = f"# Plan-contract review brief — {args.id}"

    lines = [title, "", VERDICT_INSTRUCTION, ""]
    for task in selected:
        lines.extend(_task_section(task, base))
    relative = f"review-briefs/{filename}"
    body = ("\n".join(lines).rstrip() + "\n").encode()
    if not safe_factory_write_bytes(base, relative, body):
        raise SystemExit(f"Could not safely write .factory/{relative}")
    if args.all:
        state = load_json(run_state_path(base), default={})
        story = state.get("issue_key")
        if not isinstance(story, str) or not story:
            raise SystemExit("Cannot mint a branch review run without an active story.")
        brief_sha256 = hashlib.sha256(body).hexdigest()
        diff_digest = branch_diff_digest(base)
        token = {
            "review_run_id": hashlib.sha256(
                (brief_sha256 + diff_digest).encode()
            ).hexdigest(),
            "brief_sha256": brief_sha256,
            "branch_diff_digest": diff_digest,
            "minted_at": now_iso(),
        }
        token_relative = f"stories/{story}/review-run.json"
        token_body = (json.dumps(token, indent=2) + "\n").encode()
        if not safe_factory_write_bytes(base, token_relative, token_body):
            raise SystemExit(f"Could not safely write .factory/{token_relative}")
    print(f".factory/{relative}")
