#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

ACTIVE_DOCS = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs" / "MEMORY.md",
    REPO_ROOT / "docs" / "CONTINUITY.md",
    REPO_ROOT / "docs" / "SPEC.md",
    REPO_ROOT / "docs" / "npm-cli-onboarding.md",
    REPO_ROOT / ".claude" / "skills" / "commands" / "SKILL.md",
    REPO_ROOT / ".claude" / "skills" / "myclaw-admin" / "SKILL.md",
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


def _scan_patterns(path: Path, patterns: list[re.Pattern[str]]) -> list[str]:
    text = path.read_text(encoding="utf-8")
    failures: list[str] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            failures.append(f"{path.relative_to(REPO_ROOT)}:{line}: matched `{pattern.pattern}`")
    return failures


def _check_bundled_skill_claims() -> list[str]:
    failures: list[str] = []
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    commands_skill = (
        REPO_ROOT / ".claude" / "skills" / "commands" / "SKILL.md"
    ).read_text(encoding="utf-8")

    required_readme_skills = ["`/commands`", "`myclaw-admin`"]
    for skill in required_readme_skills:
        if skill not in readme:
            failures.append(f"README.md missing bundled skill entry {skill}")

    if "`myclaw-admin`" not in commands_skill:
        failures.append(".claude/skills/commands/SKILL.md missing myclaw-admin bundled skill entry")

    return failures


def _check_runtime_settings_renderer() -> list[str]:
    failures: list[str] = []
    content = (
        REPO_ROOT / "apps" / "core" / "src" / "cli" / "runtime-settings.ts"
    ).read_text(encoding="utf-8")
    required_fragments = [
        "memory:",
        "sqlite_path:",
        "qmd_root:",
        "embeddings:",
        "dreaming:",
    ]
    for fragment in required_fragments:
        if fragment not in content:
            failures.append(
                f"apps/core/src/cli/runtime-settings.ts missing canonical memory fragment `{fragment}`"
            )
    if "features:" in content and "features block is not supported" not in content:
        failures.append(
            "apps/core/src/cli/runtime-settings.ts must not render features settings."
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

    failures.extend(_check_bundled_skill_claims())
    failures.extend(_check_runtime_settings_renderer())

    if failures:
        print("Runtime truth checks failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Runtime truth checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
