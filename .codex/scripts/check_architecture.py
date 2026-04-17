#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path

from architecture_rules import (
    check_forbidden_channel_registration_surface,
    check_forbidden_ipc_contract_surface,
    check_forbidden_ipc_orchestrator_monolith,
    check_doc_references,
    check_file_size_budget,
    check_forbidden_import_edges,
    iter_production_sources,
    repo_root_from_git,
    validate_exceptions,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run architecture fitness checks.")
    parser.add_argument("--root", help="Repository root path. Defaults to `git rev-parse --show-toplevel`.")
    parser.add_argument(
        "--exceptions",
        default=".codex/architecture-exceptions.json",
        help="Path to architecture exceptions JSON (absolute or relative to --root).",
    )
    return parser.parse_args()


def print_grouped_failures(issues: dict[str, list[str]]) -> None:
    print("Architecture checks failed.")
    groups = (
        ("exception_hygiene", "Exception Hygiene"),
        ("file_size_budget", "File Size Budget"),
        ("forbidden_import_edges", "Forbidden Import Edges"),
        ("forbidden_channel_registration_surface", "Channel Registration Surface"),
        ("forbidden_ipc_contract_surface", "IPC Contract Surface"),
        ("forbidden_ipc_orchestrator_monolith", "IPC Orchestrator"),
        ("doc_references", "Active Doc References"),
    )
    for key, label in groups:
        entries = issues.get(key, [])
        if not entries:
            continue
        print(f"\n[{label}]")
        for entry in entries:
            print(f"- {entry}")


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve() if args.root else repo_root_from_git()
    exceptions_path = Path(args.exceptions)
    if not exceptions_path.is_absolute():
        exceptions_path = (root / exceptions_path).resolve()

    production_files = iter_production_sources(root)
    production_rel_paths = {path.relative_to(root).as_posix() for path in production_files}
    exceptions, exception_hygiene = validate_exceptions(root, exceptions_path, production_rel_paths, date.today())

    grouped_issues = {
        "exception_hygiene": exception_hygiene,
        "file_size_budget": check_file_size_budget(production_files, root, exceptions),
        "forbidden_import_edges": check_forbidden_import_edges(production_files, root),
        "forbidden_channel_registration_surface": check_forbidden_channel_registration_surface(
            production_files, root
        ),
        "forbidden_ipc_contract_surface": check_forbidden_ipc_contract_surface(
            production_files, root
        ),
        "forbidden_ipc_orchestrator_monolith": check_forbidden_ipc_orchestrator_monolith(
            root
        ),
        "doc_references": check_doc_references(root),
    }

    if any(grouped_issues.values()):
        print_grouped_failures(grouped_issues)
        return 1

    print("Architecture checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
