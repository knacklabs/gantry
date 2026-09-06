#!/usr/bin/env python3
"""Require a PR that ships a task to carry that task's recorded proof.

The per-task flow already produces proof — deterministic verify, the recorded
automated tests, and one three-lens review (0049) — but nothing outside the
`stage done` / `pr-ready` commands checked it. A task merged through a direct or
story-level PR therefore shipped green with no verify, no tests and no reviews
recorded, and nothing noticed until someone looked at the board (observed in
R1-FOUND-2A, 2026-09-03). Gates that live only inside the happy path are
advisory; this one is on the PR, so skipping the flow cannot merge.

A marker written by `forge task reconcile` is exempt: it ADOPTS work that is
already on the trunk (the command refuses otherwise), so demanding proof for it
would only block repairing history — and it cannot be used to skip proof for new
work, because new work is by definition not yet on the trunk.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Reuse the sibling gate's lossless path reader rather than adding a second
# surrogateescape site: a changed path may legitimately not be UTF-8, and that
# capture is already reviewed and content-pinned in check_encoding_hygiene.
from check_pr_ticket import git_paths

TASK_MARKER_PATH = re.compile(
    r"^\.factory/stories/([^/]+)/tasks/([^/]+)/pr-ready\.json$"
)
LENSES = ("quality", "performance", "security")
MIN_SCORE = 8


def read_at_head(root: Path, path: str) -> dict | None:
    """The committed artifact, or None when the PR does not carry it.

    Strict decoding: these are the harness's own JSON artifacts, so anything
    that is not valid UTF-8 is a real defect, not a path to preserve losslessly.
    """
    proc = subprocess.run(
        ["git", "show", f"HEAD:{path}"], cwd=root, capture_output=True,
        text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        return None
    try:
        value = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} at HEAD is not valid JSON: {exc}") from exc
    return value if isinstance(value, dict) else None


def evidence(root: Path, key: str, name: str, task_id: str = "") -> dict | None:
    """This TASK's proof, falling back to older layouts.

    Proof used to be a story-scoped singleton, so every task in a story wrote
    over the previous task's record: `reviews/quality.json` described whichever
    task was reviewed last, and this gate could pass a task on another task's
    evidence. Task-scoped proof is therefore preferred.

    The two fallbacks are what keep work already in flight from stranding: a
    story recorded before task scoping, and one recorded before story scoping,
    both still satisfy the gate on the evidence they legitimately have.
    """
    candidates = []
    if task_id:
        candidates.append(f".factory/stories/{key}/tasks/{task_id}/{name}")
    candidates += [f".factory/stories/{key}/{name}", f".factory/{name}"]
    for path in candidates:
        found = read_at_head(root, path)
        if found is not None:
            return found
    return None


def added_markers(root: Path, base: str) -> list[tuple[str, str, dict]]:
    markers = []
    for line in git_paths(root, "diff", "--name-status", f"{base}..HEAD").splitlines():
        fields = line.split("\t")
        if len(fields) < 2 or fields[0] != "A":
            continue
        match = TASK_MARKER_PATH.fullmatch(fields[-1])
        if not match:
            continue
        marker = read_at_head(root, fields[-1])
        if marker is None:
            continue
        markers.append((match.group(1), match.group(2), marker))
    return markers


def proof_problems(root: Path, key: str, task_id: str) -> list[str]:
    problems: list[str] = []

    verify = evidence(root, key, "verify.json", task_id)
    if verify is None:
        problems.append(
            "verify.json is not recorded — run `python3 factory/scripts/verify.py`")
    elif verify.get("ok") is not True:
        problems.append("verify.json records ok=false — fix the failures and re-run verify")

    tests = evidence(root, key, "tests.json", task_id)
    automated = (tests or {}).get("automated")
    if tests is None or not isinstance(automated, dict):
        problems.append(
            "tests.json has no automated record — run "
            "`record_test_from_json.py --kind automated`")
    elif automated.get("status") != "passed":
        problems.append(
            f"tests.json records automated status={automated.get('status')!r}, not 'passed'")

    for lens in LENSES:
        review = evidence(root, key, f"reviews/{lens}.json", task_id)
        if review is None:
            problems.append(
                f"reviews/{lens}.json is not recorded — run `./forge review {task_id}` "
                "(one three-lens pass, run by Codex, 0049)")
            continue
        if review.get("blocking_findings"):
            problems.append(
                f"reviews/{lens}.json still has {len(review['blocking_findings'])} "
                "blocking finding(s) — fix them and re-review")
        score = review.get("score")
        if not isinstance(score, (int, float)) or score < MIN_SCORE:
            problems.append(
                f"reviews/{lens}.json scores {score!r}; a shipped task needs >= {MIN_SCORE}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base commit for base..HEAD")
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()
    root = Path(args.repo).resolve()

    markers = added_markers(root, args.base)
    if not markers:
        print("Task-proof check OK: this PR ships no task marker.")
        return 0

    failures: list[str] = []
    adopted: list[str] = []
    checked: list[str] = []
    for key, task_id, marker in markers:
        if marker.get("reconciled") is True:
            adopted.append(f"{key}/{task_id}")
            continue
        problems = proof_problems(root, key, task_id)
        checked.append(f"{key}/{task_id}")
        for problem in problems:
            failures.append(f"{key}/{task_id}: {problem}")

    for name in adopted:
        print(f"Task-proof check: {name} is an adopted reconcile marker "
              "(work already on the trunk) — proof not required.")
    if failures:
        print("Task-proof check FAILED: a PR that ships a task must carry that "
              "task's recorded proof (0049).", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    if checked:
        print("Task-proof check OK: verify, automated tests and all three review "
              f"lenses are recorded and clean for {', '.join(checked)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
