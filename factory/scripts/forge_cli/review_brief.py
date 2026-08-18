"""Compose plan-contract prompts for per-task and branch-wide review."""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import (
    load_json, protected_decomposition_state_path, repo_root,
    safe_factory_write_bytes,
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


def _task_section(task: dict) -> list[str]:
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
    lines.extend([
        "", "### Reviewer focus", "",
        task.get("reviewer_focus") or "No task-specific reviewer focus declared.",
        "",
    ])
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
        lines.extend(_task_section(task))
    relative = f"review-briefs/{filename}"
    body = ("\n".join(lines).rstrip() + "\n").encode()
    if not safe_factory_write_bytes(base, relative, body):
        raise SystemExit(f"Could not safely write .factory/{relative}")
    print(f".factory/{relative}")
