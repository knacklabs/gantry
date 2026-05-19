#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip())
    except subprocess.CalledProcessError:
        return Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Warn about likely missing tests/docs before final handoff.")
    parser.add_argument("--changed-file", action="append", default=[], help="Changed file path. Repeat as needed.")
    parser.add_argument("--no-architecture", action="store_true", help="Skip architecture check.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    return parser.parse_args()


def run_git_lines(root: Path, args: list[str]) -> list[str]:
    proc = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def discover_changed_files(root: Path) -> list[str]:
    tracked = run_git_lines(root, ["diff", "--name-only", "HEAD"])
    untracked = run_git_lines(root, ["ls-files", "--others", "--exclude-standard"])
    return sorted(set(tracked + untracked))


def starts_with_any(path: str, prefixes: tuple[str, ...]) -> bool:
    return path.startswith(prefixes)


def path_has_any(path: str, needles: tuple[str, ...]) -> bool:
    return any(needle in path for needle in needles)


def is_test_file(path: str) -> bool:
    return (
        "/test/" in path
        or path.startswith(".codex/scripts/tests/")
        or path.endswith(".test.ts")
        or path.endswith("_test.py")
        or path.startswith("packages/contracts/test/")
    )


def is_doc_file(path: str) -> bool:
    return path.endswith(".md") or path.startswith("docs/")


def has_matching_test(changed: list[str], needles: tuple[str, ...]) -> bool:
    return any(is_test_file(path) and path_has_any(path, needles) for path in changed)


def run_architecture_check(root: Path) -> dict[str, object]:
    script = root / ".codex" / "scripts" / "check_architecture.py"
    if not script.exists():
        return {"status": "missing", "command": None, "stdout": "", "stderr": "", "exitCode": 0}

    command = [sys.executable, str(script)]
    proc = subprocess.run(command, cwd=root, capture_output=True, text=True)
    return {
        "status": "passed" if proc.returncode == 0 else "failed",
        "command": "python3 .codex/scripts/check_architecture.py",
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "exitCode": proc.returncode,
    }


def collect_warnings(changed: list[str]) -> list[str]:
    warnings: list[str] = []
    docs_changed = any(is_doc_file(path) for path in changed)
    tests_changed = any(is_test_file(path) for path in changed)

    code_like = [
        path
        for path in changed
        if starts_with_any(
            path,
            (
                "apps/core/src/",
                "packages/contracts/src/",
                "packages/sdk/src/",
                ".codex/scripts/",
                ".codex/prompts/",
                ".codex/agents/",
                ".codex/rules/",
                ".codex/skills/",
            ),
        )
        or path in {"package.json", "tsconfig.json", "vitest.config.ts"}
    ]
    if code_like and not tests_changed and not docs_changed:
        warnings.append("Changed source/config/harness files but no test or docs files were changed.")

    schema_changed = any(
        starts_with_any(path, ("apps/core/src/adapters/storage/postgres/",))
        and path_has_any(path, ("schema", "migration", "repo", "repository"))
        for path in changed
    )
    if schema_changed and not has_matching_test(changed, ("postgres", "storage", "repo", "repository", "schema")):
        warnings.append("Postgres schema/repository files changed without repository/storage/schema tests.")

    permission_changed = any(
        starts_with_any(path, ("apps/core/src/",))
        and path_has_any(path, ("permission", "tool", "sandbox", "browser"))
        for path in changed
    )
    if permission_changed and not has_matching_test(changed, ("permission", "tool", "sandbox", "browser")):
        warnings.append("Permission/tool/browser/sandbox files changed without permission or sandbox/browser tests.")

    provider_changed = any(
        starts_with_any(
            path,
            (
                "apps/core/src/adapters/llm/",
                "apps/core/src/adapters/browser/",
                "apps/core/src/adapters/sandbox/",
                "apps/core/src/runner/",
            ),
        )
        or (
            starts_with_any(path, ("apps/core/src/",))
            and path_has_any(path, ("provider", "provider-session", "llm"))
        )
        for path in changed
    )
    if provider_changed and not has_matching_test(changed, ("provider", "provider-session", "resume", "session")):
        warnings.append("Provider adapter/session files changed without provider-session or resume tests.")

    channel_changed = any(
        starts_with_any(path, ("apps/core/src/adapters/channels/", "apps/core/src/channels/"))
        or (starts_with_any(path, ("apps/core/src/",)) and path_has_any(path, ("channel", "message-loop")))
        for path in changed
    )
    if channel_changed and not has_matching_test(changed, ("message", "persistence", "channel", "wiring")):
        warnings.append("Channel adapter files changed without message persistence or channel wiring tests.")

    durable_jsonl_writes = find_direct_durable_provider_artifact_paths(changed)
    if durable_jsonl_writes:
        warnings.append(
            "Direct durable Claude/provider JSONL paths changed outside FileArtifact/materializer paths: "
            + ", ".join(durable_jsonl_writes)
        )

    durable_claude_config = find_direct_durable_claude_config_paths(changed)
    if durable_claude_config:
        warnings.append(
            "Direct durable Claude settings/skills paths changed outside Claude materializers: "
            + ", ".join(durable_claude_config)
        )

    claude_config_dir_setters = find_unowned_claude_config_dir_setters(changed)
    if claude_config_dir_setters:
        warnings.append(
            "CLAUDE_CONFIG_DIR ownership changed outside Claude materializer/runtime provider: "
            + ", ".join(claude_config_dir_setters)
        )

    return warnings


def find_direct_durable_provider_artifact_paths(changed: list[str]) -> list[str]:
    allowed_prefixes = (
        "apps/core/src/adapters/artifacts/",
        "apps/core/src/adapters/llm/anthropic-claude-agent/",
    )
    flagged: list[str] = []
    root = repo_root()
    for path in changed:
        if not path.startswith("apps/core/src/"):
            continue
        if is_test_file(path) or is_doc_file(path) or starts_with_any(path, allowed_prefixes):
            continue
        file_path = root / path
        try:
            text = file_path.read_text(encoding="utf-8")
        except OSError:
            continue
        compact = " ".join(text.split())
        if (
            ".jsonl" in compact
            and (
                "DATA_DIR" in compact
                or "GANTRY_HOME" in compact
                or "data' , 'sessions" in compact
                or "data\", \"sessions" in compact
            )
            and ".claude" in compact
        ):
            flagged.append(path)
    return flagged


def find_direct_durable_claude_config_paths(changed: list[str]) -> list[str]:
    allowed_prefixes = (
        "apps/core/src/adapters/llm/anthropic-claude-agent/",
    )
    flagged: list[str] = []
    root = repo_root()
    for path in changed:
        if not path.startswith("apps/core/src/"):
            continue
        if is_test_file(path) or is_doc_file(path) or starts_with_any(path, allowed_prefixes):
            continue
        file_path = root / path
        try:
            text = file_path.read_text(encoding="utf-8")
        except OSError:
            continue
        compact = " ".join(text.split())
        if (
            ".claude" in compact
            and (
                "GANTRY_HOME" in compact
                or "settings.json" in compact
                or "settings.local.json" in compact
                or "skills" in compact
            )
        ) or "settings.local.json" in compact:
            flagged.append(path)
    return flagged


def find_unowned_claude_config_dir_setters(changed: list[str]) -> list[str]:
    allowed = {
        "apps/core/src/runtime/agent-spawn.ts",
        "apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts",
    }
    allowed_prefixes = (
        "apps/core/src/adapters/llm/anthropic-claude-agent/",
    )
    flagged: list[str] = []
    root = repo_root()
    for path in changed:
        if not path.startswith("apps/core/src/"):
            continue
        if is_test_file(path) or is_doc_file(path) or path in allowed or starts_with_any(path, allowed_prefixes):
            continue
        file_path = root / path
        try:
            text = file_path.read_text(encoding="utf-8")
        except OSError:
            continue
        if "CLAUDE_CONFIG_DIR" in text and (
            "process.env.CLAUDE_CONFIG_DIR =" in text
            or "CLAUDE_CONFIG_DIR:" in text
        ):
            flagged.append(path)
    return flagged


def main() -> int:
    args = parse_args()
    root = repo_root()
    changed = sorted(set(args.changed_file or discover_changed_files(root)))
    warnings = collect_warnings(changed)
    architecture = (
        {"status": "skipped", "command": None, "stdout": "", "stderr": "", "exitCode": 0}
        if args.no_architecture
        else run_architecture_check(root)
    )

    payload = {
        "changedFiles": changed,
        "architecture": architecture,
        "warnings": warnings,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Checked {len(changed)} changed file(s).")
        status = architecture["status"]
        if status == "passed":
            print("Architecture check passed.")
        elif status == "failed":
            print("Architecture check failed.")
            stdout = str(architecture.get("stdout") or "").strip()
            stderr = str(architecture.get("stderr") or "").strip()
            if stdout:
                print(stdout)
            if stderr:
                print(stderr, file=sys.stderr)
        elif status == "missing":
            print("Architecture check not found.")
        else:
            print("Architecture check skipped.")

        if warnings:
            print("Completion warnings:")
            for warning in warnings:
                print(f"- {warning}")
        else:
            print("No completion warnings.")

    return 1 if architecture["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
