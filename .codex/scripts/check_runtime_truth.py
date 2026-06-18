#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

ACTIVE_DOCS = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "CLAUDE.md",
    REPO_ROOT / "AGENTS.md",
    REPO_ROOT / "docs" / "MEMORY.md",
    REPO_ROOT / "docs" / "CONTINUITY.md",
    REPO_ROOT / "docs" / "SPEC.md",
    REPO_ROOT / "docs" / "README.md",
    REPO_ROOT / "docs" / "architecture" / "capability-management.md",
    REPO_ROOT / "docs" / "architecture" / "channel-interactions.md",
    REPO_ROOT / "docs" / "sdk" / "api-reference.md",
    REPO_ROOT / ".agents" / "skills" / "gantry-admin" / "SKILL.md",
]

CLI_CONTRACT_FILES = [
    REPO_ROOT / "apps" / "core" / "src" / "cli" / "index.ts",
]

RUNTIME_PATTERNS = [
    re.compile(r"\bAGENT_RUNTIME\b"),
    re.compile(r"\bSETUP_CONTAINER\b"),
    re.compile(r"container runtime", re.IGNORECASE),
    re.compile(r"Docker Compose runtime", re.IGNORECASE),
]

FEATURES_PATTERNS = [
    re.compile(r"features\.memory"),
    re.compile(r"features\.embeddings"),
    re.compile(r"features\.dreaming"),
]

EMBED_REQUIRED_PATTERNS = [
    re.compile(r"embeddings.{0,40}required.{0,40}memory", re.IGNORECASE),
    re.compile(r"OpenAI.{0,40}required.{0,40}memory", re.IGNORECASE),
]

STALE_STORAGE_PATTERNS = [
    re.compile(r"Postgres is not exposed", re.IGNORECASE),
    re.compile(r"SQLite is the supported runtime database", re.IGNORECASE),
]

DISALLOWED_POSTGRES_CLI_PATTERNS = [
    re.compile(r"\bgantry\s+postgres\s+(up|down|status|url)\b", re.IGNORECASE),
]

DISALLOWED_CAPABILITY_GUIDANCE_PATTERNS = [
    (
        re.compile(
            r"\b(?:run|use|execute)\s+`?claude\s+mcp\s+(?:add|add-json|remove|reset-project-choices)\b",
            re.IGNORECASE,
        ),
        "direct Claude MCP mutation guidance",
    ),
    (
        re.compile(
            r"\b(?:run|use|execute)\s+`?(?:npm|pnpm|yarn|brew|go|uv)\s+(?:install|add|get|pip)\b.{0,80}\b(?:skill|capability|tool|mcp)\b",
            re.IGNORECASE,
        ),
        "direct dependency install guidance for agent capabilities",
    ),
]

REQUIRED_CAPABILITY_DOC_FILES = [
    REPO_ROOT / "docs" / "architecture" / "capability-management.md",
    REPO_ROOT / "docs" / "architecture" / "channel-interactions.md",
    REPO_ROOT / "docs" / "sdk" / "api-reference.md",
    REPO_ROOT / ".agents" / "skills" / "gantry-admin" / "SKILL.md",
    REPO_ROOT / "CLAUDE.md",
]

REQUIRED_CAPABILITY_TOOL_NAMES = [
    "send_message",
    "ask_user_question",
    "request_skill_install",
    "request_skill_proposal",
    "request_skill_dependency_install",
    "request_mcp_server",
    "request_access",
    "service_restart",
    "register_agent",
]

STALE_CAPABILITY_TOOL_NAMES = [
    "request_permission",
    "capability_search",
    "request_capability",
    "propose_local_cli_capability",
    "target.kind=tool",
    "target.kind=provider_capability",
    "target.kind=propose",
]

GANTRY_ADMIN_SKILL = REPO_ROOT / ".agents" / "skills" / "gantry-admin" / "SKILL.md"

REQUIRED_GANTRY_ADMIN_FRAGMENTS = [
    "## Permission Management",
    "## Proactive Actions",
    "admin_permission_list",
    "admin_permission_revoke",
    "settings_desired_state",
    "request_settings_update",
    "scheduler_upsert_job",
    "gantry credentials model set",
]


def _scan_patterns(path: Path, patterns: list[re.Pattern[str]]) -> list[str]:
    text = path.read_text(encoding="utf-8")
    failures: list[str] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            failures.append(f"{path.relative_to(REPO_ROOT)}:{line}: matched `{pattern.pattern}`")
    return failures


def _scan_named_patterns(
    path: Path, patterns: list[tuple[re.Pattern[str], str]]
) -> list[str]:
    text = path.read_text(encoding="utf-8")
    failures: list[str] = []
    for pattern, label in patterns:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            failures.append(f"{path.relative_to(REPO_ROOT)}:{line}: {label}")
    return failures


def _check_capability_docs() -> list[str]:
    failures: list[str] = []
    for doc in REQUIRED_CAPABILITY_DOC_FILES:
        if not doc.exists():
            failures.append(f"Missing required capability doc: {doc.relative_to(REPO_ROOT)}")
            continue
        text = doc.read_text(encoding="utf-8")
        for tool_name in REQUIRED_CAPABILITY_TOOL_NAMES:
            if tool_name not in text:
                failures.append(
                    f"{doc.relative_to(REPO_ROOT)} missing capability request tool `{tool_name}`"
                )
        for stale in STALE_CAPABILITY_TOOL_NAMES:
            if stale in text:
                failures.append(
                    f"{doc.relative_to(REPO_ROOT)} references stale capability surface `{stale}`"
                )
    return failures


def _check_gantry_admin_playbook() -> list[str]:
    failures: list[str] = []
    if not GANTRY_ADMIN_SKILL.exists():
        failures.append(
            f"Missing required file: {GANTRY_ADMIN_SKILL.relative_to(REPO_ROOT)}"
        )
        return failures
    text = GANTRY_ADMIN_SKILL.read_text(encoding="utf-8")
    for fragment in REQUIRED_GANTRY_ADMIN_FRAGMENTS:
        if fragment not in text:
            failures.append(
                f"{GANTRY_ADMIN_SKILL.relative_to(REPO_ROOT)} missing self-management fragment `{fragment}`"
            )
    return failures


def _check_bundled_skill_claims() -> list[str]:
    failures: list[str] = []
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    commands_skill = REPO_ROOT / ".agents" / "skills" / "commands" / "SKILL.md"
    session_commands = (
        REPO_ROOT / "apps" / "core" / "src" / "session" / "session-commands.ts"
    ).read_text(encoding="utf-8")
    # /commands parsing may live in the sibling parse module after extraction;
    # the handler + help stay in session-commands.ts.
    session_command_parse_path = (
        REPO_ROOT / "apps" / "core" / "src" / "session" / "session-command-parse.ts"
    )
    session_command_parse = (
        session_command_parse_path.read_text(encoding="utf-8")
        if session_command_parse_path.exists()
        else ""
    )

    required_readme_skills = ["`/commands`", "`gantry-admin`"]
    for skill in required_readme_skills:
        if skill not in readme:
            failures.append(f"README.md missing bundled skill entry {skill}")

    parses_commands = (
        "kind: 'commands'" in session_commands
        or "kind: 'commands'" in session_command_parse
    )
    if not parses_commands or "formatSessionCommandsHelp" not in session_commands:
        failures.append("apps/core/src/session/session-commands.ts missing host-managed /commands support")

    if commands_skill.exists():
        failures.append(
            ".agents/skills/commands/SKILL.md must not exist; /commands is host-managed, not an SDK skill"
        )

    return failures


def _check_runtime_settings_renderer() -> list[str]:
    failures: list[str] = []
    runtime_settings_path = (
        REPO_ROOT / "apps" / "core" / "src" / "config" / "settings" / "runtime-settings.ts"
    )
    renderer_path = (
        REPO_ROOT / "apps" / "core" / "src" / "config" / "settings" / "runtime-settings-renderer.ts"
    )
    content = renderer_path.read_text(encoding="utf-8")
    required_fragments = [
        "'memory:'",
        "'  embeddings:'",
        "'  dreaming:'",
        "'  llm:'",
    ]
    for fragment in required_fragments:
        if fragment not in content:
            failures.append(
                f"{renderer_path.relative_to(REPO_ROOT)} missing canonical memory fragment `{fragment.strip('`').strip(chr(39))}`"
            )
    combined_content = content + "\n" + runtime_settings_path.read_text(encoding="utf-8")
    if "features:" in combined_content and "features block is not supported" not in combined_content:
        failures.append(
            "runtime settings modules must not render features settings."
        )
    return failures


def main() -> int:
    failures: list[str] = []

    for doc in ACTIVE_DOCS:
        if not doc.exists():
            failures.append(f"Missing required file: {doc.relative_to(REPO_ROOT)}")
            continue
        failures.extend(_scan_patterns(doc, RUNTIME_PATTERNS))
        failures.extend(_scan_patterns(doc, FEATURES_PATTERNS))
        failures.extend(_scan_patterns(doc, EMBED_REQUIRED_PATTERNS))
        failures.extend(_scan_patterns(doc, STALE_STORAGE_PATTERNS))
        failures.extend(_scan_named_patterns(doc, DISALLOWED_CAPABILITY_GUIDANCE_PATTERNS))

    for code_file in CLI_CONTRACT_FILES:
        if not code_file.exists():
            failures.append(f"Missing required file: {code_file.relative_to(REPO_ROOT)}")
            continue
        failures.extend(_scan_patterns(code_file, DISALLOWED_POSTGRES_CLI_PATTERNS))

    failures.extend(_check_bundled_skill_claims())
    failures.extend(_check_runtime_settings_renderer())
    failures.extend(_check_capability_docs())
    failures.extend(_check_gantry_admin_playbook())

    if failures:
        print("Runtime truth checks failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Runtime truth checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
