#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


FORBIDDEN_PATTERNS = [
    re.compile(r"(^|/)\.git($|/)"),
    re.compile(r"(^|/)\.claude($|/)"),
    re.compile(r"(^|/)\.factory($|/)"),
    re.compile(r"(^|/)node_modules($|/)"),
    re.compile(r"(^|/)\.env(?:[./]|$)"),
    re.compile(
        r"(^|/)(?:id_rsa|id_ed25519|.*private[-_]?key.*|.*(?:^|[-_.])key(?:[-_.]|$).*\.pem|.*(?:^|[-_.])priv(?:ate)?(?:[-_.]|$).*\.pem)$",
        re.I,
    ),
    re.compile(r"(^|/).*\.(?:sqlite|sqlite3|db|duckdb)$", re.I),
]


def check_paths(paths: list[str]) -> list[str]:
    failures: list[str] = []
    for path in paths:
        normalized = path.strip()
        if normalized.startswith("./"):
            normalized = normalized[2:]
        for pattern in FORBIDDEN_PATTERNS:
            if pattern.search(normalized):
                failures.append(normalized)
                break
    return sorted(set(failures))


def package_metadata(path: Path) -> dict[str, object]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}") from exc
    return parsed if isinstance(parsed, dict) else {}


def workspace_package_dirs(root: Path) -> list[Path]:
    package_json = package_metadata(root / "package.json")
    workspaces = package_json.get("workspaces", [])
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages", [])
    if not isinstance(workspaces, list):
        return []

    dirs: list[Path] = []
    for pattern in workspaces:
        if not isinstance(pattern, str) or pattern.startswith("!"):
            continue
        for candidate in root.glob(pattern):
            package_path = candidate / "package.json"
            if not package_path.is_file():
                continue
            metadata = package_metadata(package_path)
            if metadata.get("private") is True:
                continue
            dirs.append(candidate)
    return sorted(set(dirs))


def npm_pack_files_for_package(package_dir: Path) -> list[str]:
    result = subprocess.run(
        ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
        cwd=package_dir,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        sys.stderr.write(result.stdout)
        raise SystemExit(f"npm pack returned invalid JSON: {exc}") from exc
    if not payload or not isinstance(payload, list):
        raise SystemExit("npm pack returned no package metadata")
    names: list[str] = []
    for package in payload:
        if not isinstance(package, dict):
            continue
        files = package.get("files")
        if not isinstance(files, list):
            raise SystemExit("npm pack metadata did not include files")
        for item in files:
            if isinstance(item, dict) and isinstance(item.get("path"), str):
                names.append(item["path"])
    return names


def npm_pack_files(root: Path) -> list[str]:
    names: list[str] = []
    for package_dir in [root, *workspace_package_dirs(root)]:
        names.extend(npm_pack_files_for_package(package_dir))
    return names


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail if npm package contents include forbidden files."
    )
    parser.add_argument("--root", default=".", help="Repository root")
    parser.add_argument(
        "--paths-json",
        help="Test hook: JSON array of paths to check instead of running npm pack.",
    )
    args = parser.parse_args()

    paths = (
        json.loads(args.paths_json)
        if args.paths_json is not None
        else npm_pack_files(Path(args.root).resolve())
    )
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
        raise SystemExit("--paths-json must be a JSON array of strings")

    failures = check_paths(paths)
    if failures:
        print("Forbidden package contents detected:")
        for path in failures:
            print(f"- {path}")
        return 1
    print("Package contents gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
