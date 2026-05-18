#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path

from architecture_rules import (
    check_architecture_map_hygiene,
    check_browser_default_profile_paths,
    check_forbidden_channel_registration_surface,
    check_forbidden_ipc_contract_surface,
    check_forbidden_ipc_orchestrator_monolith,
    check_forbidden_runtime_runner_materialization,
    check_doc_references,
    check_direct_risky_execution,
    check_empty_folders,
    check_forbidden_direct_provider_sends,
    check_external_imports_by_layer,
    check_file_size_budget,
    check_framework_boundary_imports,
    check_map_layer_imports,
    check_old_terms,
    check_provider_boundary,
    check_provider_imports,
    check_provider_specific_paths,
    check_wrapper_only_files,
    iter_production_sources,
    iter_provider_boundary_sources,
    load_architecture_map,
    load_provider_boundary_exceptions,
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
    parser.add_argument(
        "--map",
        default=".codex/architecture-map.json",
        help="Path to architecture map JSON (absolute or relative to --root).",
    )
    parser.add_argument(
        "--provider-boundary-exceptions",
        default=".codex/provider-boundary-exceptions.json",
        help="Path to provider boundary exceptions JSON (absolute or relative to --root).",
    )
    return parser.parse_args()


def print_grouped_failures(issues: dict[str, list[str]]) -> None:
    print("Architecture checks failed.")
    groups = (
        ("exception_hygiene", "Exception Hygiene"),
        ("architecture_map_hygiene", "Architecture Map Hygiene"),
        ("file_size_budget", "File Size Budget"),
        ("layer_imports", "Layer Import Rules"),
        ("external_imports", "External Import Rules"),
        ("provider_imports", "Provider Imports"),
        ("provider_boundary", "Provider Boundary"),
        ("provider_specific_paths", "Provider-Specific Paths"),
        ("direct_risky_execution", "Direct Risky Execution"),
        ("browser_default_profile_paths", "Browser Default Profile Paths"),
        ("old_terms", "Old Architecture Terms"),
        ("empty_folders", "Empty Folders"),
        ("wrapper_only_files", "Wrapper-Only Files"),
        ("framework_boundary_imports", "Framework Boundary Imports"),
        ("forbidden_channel_registration_surface", "Channel Registration Surface"),
        ("forbidden_ipc_contract_surface", "IPC Contract Surface"),
        ("forbidden_ipc_orchestrator_monolith", "IPC Orchestrator"),
        ("forbidden_direct_provider_sends", "Direct Provider Sends"),
        ("forbidden_runtime_runner_materialization", "Runtime Runner Materialization"),
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
    map_path = Path(args.map)
    if not map_path.is_absolute():
        map_path = (root / map_path).resolve()
    provider_boundary_exceptions_path = Path(args.provider_boundary_exceptions)
    if not provider_boundary_exceptions_path.is_absolute():
        provider_boundary_exceptions_path = (root / provider_boundary_exceptions_path).resolve()

    production_files = iter_production_sources(root)
    provider_boundary_files = iter_provider_boundary_sources(root)
    production_rel_paths = {path.relative_to(root).as_posix() for path in production_files}
    exceptions, exception_hygiene = validate_exceptions(root, exceptions_path, production_rel_paths, date.today())
    provider_boundary_exceptions, provider_boundary_exception_hygiene = load_provider_boundary_exceptions(
        root, provider_boundary_exceptions_path
    )
    exception_hygiene.extend(provider_boundary_exception_hygiene)
    architecture_map, architecture_map_load_issues = load_architecture_map(map_path)
    architecture_map_hygiene = architecture_map_load_issues
    active_exception_counts = {}
    if architecture_map is not None:
        architecture_map_hygiene.extend(check_architecture_map_hygiene(root, architecture_map))
        layer_import_issues, layer_counts = check_map_layer_imports(
            production_files, root, architecture_map, exceptions
        )
        external_import_issues, external_counts = check_external_imports_by_layer(
            production_files, root, architecture_map, exceptions
        )
        provider_import_issues, provider_import_counts = check_provider_imports(
            production_files, root, architecture_map, exceptions
        )
        provider_boundary_issues = check_provider_boundary(
            provider_boundary_files, root, architecture_map, provider_boundary_exceptions
        )
        provider_path_issues, provider_path_counts = check_provider_specific_paths(
            production_files, root, architecture_map, exceptions
        )
        risky_execution_issues, risky_counts = check_direct_risky_execution(
            production_files, root, architecture_map, exceptions
        )
        browser_profile_issues, browser_counts = check_browser_default_profile_paths(
            production_files, root, architecture_map, exceptions
        )
        old_term_issues, old_term_counts = check_old_terms(
            production_files, root, architecture_map, exceptions
        )
        for counts in (
            layer_counts,
            external_counts,
            provider_import_counts,
            provider_path_counts,
            risky_counts,
            browser_counts,
            old_term_counts,
        ):
            active_exception_counts.update(counts)
    else:
        layer_import_issues = []
        external_import_issues = []
        provider_import_issues = []
        provider_boundary_issues = []
        provider_path_issues = []
        risky_execution_issues = []
        browser_profile_issues = []
        old_term_issues = []

    grouped_issues = {
        "exception_hygiene": exception_hygiene,
        "architecture_map_hygiene": architecture_map_hygiene,
        "file_size_budget": check_file_size_budget(production_files, root, architecture_map or {}),
        "layer_imports": layer_import_issues,
        "external_imports": external_import_issues,
        "provider_imports": provider_import_issues,
        "provider_boundary": provider_boundary_issues,
        "provider_specific_paths": provider_path_issues,
        "direct_risky_execution": risky_execution_issues,
        "browser_default_profile_paths": browser_profile_issues,
        "old_terms": old_term_issues,
        "empty_folders": check_empty_folders(root, architecture_map or {}, exceptions),
        "wrapper_only_files": check_wrapper_only_files(production_files, root, exceptions),
        "framework_boundary_imports": check_framework_boundary_imports(
            production_files, root
        ),
        "forbidden_channel_registration_surface": check_forbidden_channel_registration_surface(
            production_files, root
        ),
        "forbidden_ipc_contract_surface": check_forbidden_ipc_contract_surface(
            production_files, root
        ),
        "forbidden_ipc_orchestrator_monolith": check_forbidden_ipc_orchestrator_monolith(
            root
        ),
        "forbidden_direct_provider_sends": check_forbidden_direct_provider_sends(
            production_files, root
        ),
        "forbidden_runtime_runner_materialization": check_forbidden_runtime_runner_materialization(
            production_files, root
        ),
        "doc_references": check_doc_references(root),
    }
    stale = exceptions.stale_entries(set(active_exception_counts))
    if stale:
        grouped_issues["exception_hygiene"].extend(stale)

    if any(grouped_issues.values()):
        print_grouped_failures(grouped_issues)
        return 1

    print("Architecture checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
