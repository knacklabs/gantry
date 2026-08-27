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
