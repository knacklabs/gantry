#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


SOURCE_EXTENSIONS = {".cjs", ".js", ".mjs", ".ts", ".tsx"}
DEFAULT_PATHS = ["apps/core/src"]
DEFAULT_BASE_REF = "origin/main"


LineDelta = tuple[int, int]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def run_git(args: list[str], root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def count_source_lines(paths: list[str], root: Path) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"files": 0, "lines": 0, "nonblank": 0},
    )
    for raw_path in paths:
        base = root / raw_path
        if not base.exists():
            continue
        files = [base] if base.is_file() else sorted(base.rglob("*"))
        for file_path in files:
            if not file_path.is_file() or file_path.suffix not in SOURCE_EXTENSIONS:
                continue
            rel = file_path.relative_to(root)
            bucket = bucket_for(rel, raw_path)
            text = file_path.read_text("utf-8", errors="replace")
            lines = text.splitlines()
            counts[bucket]["files"] += 1
            counts[bucket]["lines"] += len(lines)
            counts[bucket]["nonblank"] += sum(1 for line in lines if line.strip())
    return dict(sorted(counts.items()))


def bucket_for(path: Path, root_path: str) -> str:
    root_parts = Path(root_path).parts
    parts = path.parts
    if len(parts) == len(root_parts) + 1:
        return str(Path(*root_parts))
    if len(parts) > len(root_parts) + 1:
        return str(Path(*parts[: len(root_parts) + 1]))
    return str(Path(*root_parts))


def print_baseline(paths: list[str], root: Path) -> int:
    counts = count_source_lines(paths, root)
    total = {"files": 0, "lines": 0, "nonblank": 0}
    print("| Directory | Files | Lines | Nonblank lines |")
    print("| --- | ---: | ---: | ---: |")
    for directory, values in counts.items():
        total["files"] += values["files"]
        total["lines"] += values["lines"]
        total["nonblank"] += values["nonblank"]
        print(
            f"| `{directory}` | {values['files']} | {values['lines']} | {values['nonblank']} |",
        )
    print(
        f"| **Total** | {total['files']} | {total['lines']} | {total['nonblank']} |",
    )
    return 0


def source_path_from_numstat(raw_path: str) -> Path:
    if "\t" in raw_path:
        raw_path = raw_path.rsplit("\t", 1)[-1]
    if " => " in raw_path:
        raw_path = raw_path.split(" => ", 1)[1]
    raw_path = raw_path.strip()
    if raw_path.endswith("}"):
        raw_path = raw_path[:-1]
    return Path(raw_path.strip("{}"))


def is_source_numstat_path(raw_path: str) -> bool:
    return source_path_from_numstat(raw_path).suffix in SOURCE_EXTENSIONS


def parse_numstat_delta(numstat: str) -> LineDelta:
    additions = 0
    deletions = 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        add_raw, delete_raw = parts[0], parts[1]
        changed_path = "\t".join(parts[2:])
        if not is_source_numstat_path(changed_path):
            continue
        if add_raw == "-" or delete_raw == "-":
            continue
        additions += int(add_raw)
        deletions += int(delete_raw)
    return additions, deletions


def committed_line_delta(base_ref: str, paths: list[str], root: Path) -> LineDelta:
    diff = run_git(["diff", "--numstat", f"{base_ref}...HEAD", "--", *paths], root)
    if diff.returncode != 0:
        print(diff.stderr.strip(), file=sys.stderr)
        raise SystemExit(diff.returncode)
    return parse_numstat_delta(diff.stdout)


def tracked_worktree_line_delta(paths: list[str], root: Path) -> LineDelta:
    diff = run_git(["diff", "--numstat", "HEAD", "--", *paths], root)
    if diff.returncode != 0:
        print(diff.stderr.strip(), file=sys.stderr)
        raise SystemExit(diff.returncode)
    return parse_numstat_delta(diff.stdout)


def untracked_source_line_additions(paths: list[str], root: Path) -> int:
    files = run_git(["ls-files", "--others", "--exclude-standard", "--", *paths], root)
    if files.returncode != 0:
        print(files.stderr.strip(), file=sys.stderr)
        raise SystemExit(files.returncode)

    additions = 0
    for raw_path in files.stdout.splitlines():
        rel_path = Path(raw_path)
        if rel_path.suffix not in SOURCE_EXTENSIONS:
            continue
        file_path = root / rel_path
        if not file_path.is_file():
            continue
        text = file_path.read_text("utf-8", errors="replace")
        additions += len(text.splitlines())
    return additions


def read_baseline_commit(baseline_file: Path) -> str:
    text = baseline_file.read_text("utf-8")
    match = re.search(r"^- Commit:\s*`?([0-9a-fA-F]{7,40})`?\s*$", text, re.MULTILINE)
    if not match:
        raise ValueError(f"Could not find '- Commit: `<sha>`' in {baseline_file}")
    return match.group(1)


def check_diff(
    base_ref: str,
    paths: list[str],
    root: Path,
    base_label: str,
    *,
    committed_only: bool = False,
) -> int:
    committed_additions, committed_deletions = committed_line_delta(
        base_ref,
        paths,
        root,
    )
    tracked_additions = 0
    tracked_deletions = 0
    untracked_additions = 0
    if not committed_only:
        tracked_additions, tracked_deletions = tracked_worktree_line_delta(paths, root)
        untracked_additions = untracked_source_line_additions(paths, root)

    additions = committed_additions + tracked_additions + untracked_additions
    deletions = committed_deletions + tracked_deletions
    delta = additions - deletions
    scope_label = "committed only" if committed_only else "committed + working tree"
    print(
        f"Refactor source line delta ({scope_label}) for {', '.join(paths)} "
        f"against {base_label} {base_ref}: "
        f"+{additions} -{deletions} = {delta}",
    )
    print(f"  committed: +{committed_additions} -{committed_deletions}")
    if not committed_only:
        print(f"  tracked working tree: +{tracked_additions} -{tracked_deletions}")
        print(f"  untracked source files: +{untracked_additions} -0")
    if delta > 0:
        print(
            "Refactor-labelled PRs must have non-positive net runtime source line delta.",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Record or enforce Gantry runtime refactor source line budgets.",
    )
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="Print a Markdown per-directory source line baseline.",
    )
    parser.add_argument(
        "--check-diff",
        action="store_true",
        help="Fail when the diff has positive net source line delta.",
    )
    parser.add_argument(
        "--base-ref",
        default=None,
        help="Branch/final base ref for --check-diff. Defaults to origin/main.",
    )
    parser.add_argument(
        "--baseline-file",
        help=(
            "Markdown baseline file containing '- Commit: `<sha>`'. "
            "When set, --check-diff compares phase progress against that T0 commit."
        ),
    )
    parser.add_argument(
        "--committed-only",
        action="store_true",
        help=(
            "For --check-diff, only check committed changes from the selected base to HEAD. "
            "By default tracked working-tree changes and untracked source files are included."
        ),
    )
    parser.add_argument(
        "--path",
        action="append",
        dest="paths",
        help="Path to include. Defaults to apps/core/src. May be repeated.",
    )
    args = parser.parse_args()

    paths = args.paths or DEFAULT_PATHS
    root = repo_root()
    if args.baseline:
        return print_baseline(paths, root)
    if args.check_diff:
        if args.baseline_file and args.base_ref:
            parser.error("--baseline-file and --base-ref are mutually exclusive for --check-diff.")
        if args.baseline_file:
            baseline_file = Path(args.baseline_file)
            if not baseline_file.is_absolute():
                baseline_file = root / baseline_file
            base_ref = read_baseline_commit(baseline_file)
            base_label = "phase baseline"
        else:
            base_ref = args.base_ref or DEFAULT_BASE_REF
            base_label = "branch base"
        return check_diff(
            base_ref,
            paths,
            root,
            base_label,
            committed_only=args.committed_only,
        )
    parser.error("Choose --baseline or --check-diff.")


if __name__ == "__main__":
    raise SystemExit(main())
