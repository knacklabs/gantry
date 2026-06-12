from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

FILE_SIZE_LIMIT = 700
FILE_SIZE_LIMITS_BY_TARGET = {
    "apps/core/src/adapters/storage/postgres/schema/schema.ts": 900,
}
FILE_SIZE_RULE = "file_line_budget"
REQUIRED_EXCEPTION_FIELDS = ("file", "rule", "reason", "removeByPhase")
SUPPORTED_EXCEPTION_RULES = {
    "forbidden_import_by_layer",
    "forbidden_external_import_by_layer",
    "forbidden_provider_import",
    "provider_specific_path",
    "direct_risky_execution",
    "browser_default_profile_path",
    "old_term_groupFolder",
    "old_term_mainGroup",
    "old_term_registeredGroup",
    "old_term_claude_only",
    "empty_folder",
    "wrapper_only_file",
}

ACTIVE_DOC_FILES = (
    "README.md",
    "AGENTS.md",
    "WORKFLOW.md",
    "CONTRIBUTING.md",
    "docs/FACTORY.md",
    "docs/QUALITY.md",
    "docs/SECURITY.md",
)

FORBIDDEN_IMPORT_RULES = (
    (
        "apps/core/src/domain",
        (
            "apps/core/src/app",
            "apps/core/src/config",
            "apps/core/src/control",
            "apps/core/src/runtime",
            "apps/core/src/runner",
            "apps/core/src/jobs",
            "apps/core/src/channels",
            "apps/core/src/cli",
            "apps/core/src/infrastructure",
            "apps/core/src/session",
            "apps/core/src/memory",
            "apps/core/src/platform",
        ),
    ),
    (
        "apps/core/src/config",
        (
            "apps/core/src/app",
            "apps/core/src/runtime",
            "apps/core/src/runner",
            "apps/core/src/cli",
            "apps/core/src/control",
            "apps/core/src/jobs",
        ),
    ),
    (
        "apps/core/src/infrastructure",
        (
            "apps/core/src/app",
            "apps/core/src/runtime",
            "apps/core/src/cli",
            "apps/core/src/control",
            "apps/core/src/runner",
            "apps/core/src/jobs",
        ),
    ),
    (
        "apps/core/src/platform",
        (
            "apps/core/src/runtime",
            "apps/core/src/channels",
            "apps/core/src/cli",
            "apps/core/src/session",
            "apps/core/src/memory",
        ),
    ),
    (
        "apps/core/src/runtime",
        (
            "apps/core/src/channels",
            "apps/core/src/cli",
        ),
    ),
    ("apps/core/src/jobs", ("apps/core/src/cli",)),
    ("apps/core/src/control", ("apps/core/src/cli",)),
    ("apps/core/src/memory", ("apps/core/src/cli",)),
    ("apps/core/src/channels", ("apps/core/src/cli",)),
)

FORBIDDEN_CHANNEL_REGISTRATION_FILES = (
    "apps/core/src/channels/index.ts",
    "apps/core/src/channels/registry.ts",
)

FORBIDDEN_CHANNEL_REGISTRATION_PATTERNS = (
    (re.compile(r"\bregisterChannel\s*\("), "legacy channel self-registration API"),
    (
        re.compile(r"import\s+['\"]\.\./channels/index(?:\.[cm]?[jt]s)?['\"]"),
        "side-effect channel registration import",
    ),
    (
        re.compile(r"from\s+['\"]\./registry(?:\.[cm]?[jt]s)?['\"]"),
        "legacy channel registry import",
    ),
)

FORBIDDEN_RUNTIME_RUNNER_MATERIALIZATION_PATTERNS = (
    (
        re.compile(r"\b(?:syncHostAgentRunnerRuntime|getRuntimeAgentRunnerRoot)\b"),
        "legacy runtime runner materialization API",
    ),
    (
        re.compile(r"""['"]\.runtime['"]"""),
        "runtime-home .runtime path usage",
    ),
)

FORBIDDEN_IPC_CONTRACT_FILES = (
    "apps/core/src/memory/memory-ipc-contract.ts",
    "apps/core/src/runtime/browser-ipc-contract.ts",
)

FORBIDDEN_IPC_CONTRACT_IMPORT_PATTERNS = (
    (
        re.compile(r"""from\s+['"][^'"]*(?:memory-ipc-contract|browser-ipc-contract)(?:\.[cm]?[jt]s)?['"]"""),
        "removed IPC contract import path",
    ),
    (
        re.compile(r"""import\s+['"][^'"]*(?:memory-ipc-contract|browser-ipc-contract)(?:\.[cm]?[jt]s)?['"]"""),
        "removed IPC contract side-effect import path",
    ),
)

IPC_ORCHESTRATOR_FILE = "apps/core/src/runtime/ipc.ts"

FORBIDDEN_IPC_ORCHESTRATOR_MONOLITH_PATTERNS = (
    (
        re.compile(r"\bexport\s+async\s+function\s+processTaskIpc\s*\("),
        "in-orchestrator task domain handler",
    ),
    (
        re.compile(r"\basync\s+function\s+processBrowserIpcRequest\s*\("),
        "in-orchestrator browser domain handler",
    ),
    (
        re.compile(r"\bswitch\s*\(\s*data\.type\s*\)"),
        "in-orchestrator task switch dispatch",
    ),
    (
        re.compile(r"case\s+'scheduler_[^']+'"),
        "in-orchestrator scheduler case branch",
    ),
)

FORBIDDEN_DIRECT_PROVIDER_SEND_SOURCE_PREFIXES = (
    "apps/core/src/app",
    "apps/core/src/runtime",
    "apps/core/src/jobs",
    "apps/core/src/session",
    "apps/core/src/application",
    "apps/core/src/domain",
)

FORBIDDEN_DIRECT_PROVIDER_SEND_PATTERNS = (
    (
        re.compile(r"\b(?:this\.)?bot\.api\.sendMessage\s*\("),
        "telegram bot api sendMessage",
    ),
    (
        re.compile(r"\b(?:this\.)?telegramApi\.sendMessage\s*\("),
        "telegram api sendMessage",
    ),
    (
        re.compile(
            r"\b(?:this\.)?(?:app\.client|client|slackClient)\.chat\.postMessage\s*\("
        ),
        "slack chat.postMessage",
    ),
    (
        re.compile(r"\b(?:this\.)?sdkClient\.sendMessage\s*\("),
        "teams sdkClient.sendMessage",
    ),
    (
        re.compile(r"\b(?:this\.)?teamsClient\.sendMessage\s*\("),
        "teams client sendMessage",
    ),
)

RECOVERY_ONLY_CHANNEL_WIRING_CALL_ALLOWLIST = {
    "apps/core/src/app/bootstrap/runtime-services.ts",
}

RECOVERY_ONLY_CHANNEL_WIRING_CALL_PATTERNS = (
    (
        re.compile(r"\bchannelWiring\.createRecoveryDispatchPermit\s*\("),
        "channel wiring recovery dispatch permit minting",
    ),
    (
        re.compile(r"\bchannelWiring\.sendProviderMessage\s*\("),
        "channel wiring recovery provider send seam",
    ),
)

MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
IMPORT_FROM_RE = re.compile(r"(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['\"]([^'\"]+)['\"]", re.MULTILINE)
SIDE_EFFECT_IMPORT_RE = re.compile(r"(?:^|\n)\s*import\s*['\"]([^'\"]+)['\"]", re.MULTILINE)
DYNAMIC_IMPORT_RE = re.compile(r"\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
EXPORT_FROM_STATEMENT_RE = re.compile(
    r"^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['\"][^'\"]+['\"]\s*;?\s*$"
)
COMMENT_OR_BLANK_RE = re.compile(r"^\s*(?://.*|/\*.*\*/)?\s*$")

PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID = (
    "myclaw-architecture-gates-20260517-provider-boundary-sentinels"
)
PROVIDER_BOUNDARY_TOKENS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "@anthropic-ai/claude-agent-sdk",
        re.compile(re.escape("@anthropic-ai/claude-agent-sdk")),
    ),
    ("@anthropic-ai/sdk", re.compile(re.escape("@anthropic-ai/sdk"))),
    ("ANTHROPIC_", re.compile(r"ANTHROPIC_")),
    ("CLAUDE_CONFIG_DIR", re.compile(r"CLAUDE_CONFIG_DIR")),
    ("CLAUDE_CODE_OAUTH_TOKEN", re.compile(r"CLAUDE_CODE_OAUTH_TOKEN")),
    ("claude-jsonl", re.compile(r"claude-jsonl")),
    ("runner/claude", re.compile(r"runner/claude")),
    ("provider = 'anthropic'", re.compile(r"\bprovider\s*=\s*['\"]anthropic['\"]")),
    (
        "provider: 'anthropic'",
        re.compile(r"(?:(?<![\w$])provider|['\"]provider['\"])\s*:\s*(?:['\"`]anthropic['\"`]|`anth\$\{\s*['\"]ropic['\"]\s*\}`)"),
    ),
    (
        "const PROVIDER = 'anthropic'",
        re.compile(r"\bconst\s+PROVIDER\s*=\s*['\"]anthropic['\"]"),
    ),
    ("default('anthropic')", re.compile(r"\.default\(\s*['\"]anthropic['\"]\s*\)")),
    ("anthropic_sdk", re.compile(r"\banthropic_sdk\b")),
    # DeepAgents/LangChain import-form sentinels (the bare token `deepagents` is
    # the public engine value and appears legitimately in shared/config, so only
    # the import specifier forms are gated to keep this boundary leak-tight).
    ("from 'deepagents'", re.compile(r"from\s+['\"]deepagents['\"]")),
    ("@langchain/", re.compile(r"@langchain/")),
)
PROVIDER_BOUNDARY_DEFAULT_APPROVED_PATHS = (
    "apps/core/src/adapters/llm/anthropic-claude-agent",
    "apps/core/src/adapters/llm/deepagents-langchain",
)
PROVIDER_BOUNDARY_ALLOWED_APPROVED_PATHS = set(PROVIDER_BOUNDARY_DEFAULT_APPROVED_PATHS)
PROVIDER_BOUNDARY_DISALLOWED_BROAD_PATHS = (
    "apps/core/src/config",
    "apps/core/src/memory",
    "apps/core/src/shared",
)


@dataclass(frozen=True)
class ExceptionEntry:
    file: str
    rule: str
    reason: str
    remove_by_phase: str
    max_lines: int | None = None
    max_occurrences: int | None = None
    max_violations: int | None = None


class ExceptionRegistry:
    def __init__(self, entries: list[ExceptionEntry]) -> None:
        self.entries = entries
        self.by_file_rule: dict[tuple[str, str], ExceptionEntry] = {
            (entry.file, entry.rule): entry for entry in entries
        }

    def get(self, file: str, rule: str) -> ExceptionEntry | None:
        return self.by_file_rule.get((normalize_repo_relative(file), rule))

    def has(self, file: str, rule: str) -> bool:
        return self.get(file, rule) is not None

    def stale_entries(self, active_keys: set[tuple[str, str]]) -> list[str]:
        stale: list[str] = []
        for entry in self.entries:
            if entry.rule in {FILE_SIZE_RULE, "empty_folder", "wrapper_only_file"}:
                continue
            key = (entry.file, entry.rule)
            if key not in active_keys:
                stale.append(f"{entry.file} has stale exception for `{entry.rule}`; remove it.")
        return stale


@dataclass(frozen=True)
class ProviderBoundaryException:
    file: str
    matches: dict[str, int]
    reason: str
    remove_by_plan: str


@dataclass(frozen=True)
class ProviderBoundaryExceptions:
    cleanup_plan_id: str
    entries: dict[str, ProviderBoundaryException]

FRAMEWORK_BOUNDARY_RULES = (
    {
        "name": "enterprise frameworks in core runtime layers",
        "source_prefixes": (
            "apps/core/src/domain",
            "apps/core/src/application",
            "apps/core/src/runtime",
        ),
        "specifier_prefixes": ("@nestjs/", "next", "next/"),
        "allowed_prefixes": (),
        "message": "NestJS and NextJS must integrate through SDK/control API, not core runtime internals.",
    },
    {
        "name": "Fastify outside control HTTP adapter",
        "source_prefixes": ("apps/core/src",),
        "specifier_prefixes": ("fastify", "@fastify/"),
        "allowed_prefixes": ("apps/core/src/adapters/control-http",),
        "message": "Fastify is allowed only in the control HTTP adapter.",
    },
    {
        "name": "Anthropic SDK outside provider adapter",
        "source_prefixes": ("apps/core/src",),
        "specifier_prefixes": ("@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"),
        "allowed_prefixes": (
            "apps/core/src/adapters/llm/anthropic",
            "apps/core/src/adapters/llm/anthropic-claude-agent",
        ),
        "message": "Anthropic SDK imports must stay in approved provider adapter paths.",
    },
)

RECOGNIZED_CODE_PATH_EXTENSIONS = {
    ".md",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".toml",
    ".yaml",
    ".yml",
    ".py",
    ".sh",
}

ROOT_FILE_REFERENCES = {
    "README.md",
    "AGENTS.md",
    "WORKFLOW.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "CLAUDE.md",
}


def repo_root_from_git() -> Path:
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(proc.stdout.strip())


def path_in_repo(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def is_production_source(rel_path: Path) -> bool:
    rel_text = rel_path.as_posix()
    lower = rel_text.lower()
    if rel_path.suffix not in {".ts", ".tsx"}:
        return False
    if "/src/" not in rel_text:
        return False
    if ".d.ts" in lower:
        return False
    if any(token in lower for token in ("/__tests__/", "/test/", "/tests/", ".test.", ".spec.", ".generated.")):
        return False
    if any(part.lower() in {"node_modules", "dist", "coverage", "generated", "__generated__"} for part in rel_path.parts):
        return False
    return rel_text.startswith("apps/") or rel_text.startswith("packages/")


def iter_production_sources(root: Path) -> list[Path]:
    files: list[Path] = []
    for top in ("apps", "packages"):
        base = root / top
        if not base.exists():
            continue
        for glob in ("*.ts", "*.tsx"):
            for file_path in base.rglob(glob):
                rel_path = file_path.relative_to(root)
                if is_production_source(rel_path):
                    files.append(file_path)
    return sorted(set(files))


def is_provider_boundary_source(rel_path: Path) -> bool:
    rel_text = rel_path.as_posix()
    lower = rel_text.lower()
    if rel_path.suffix not in {".ts", ".tsx"}:
        return False
    if ".d.ts" in lower:
        return False
    ignored_parts = {
        "node_modules",
        "dist",
        "coverage",
        "generated",
        "__generated__",
        ".factory",
        ".cocoindex_code",
    }
    if any(part.lower() in ignored_parts for part in rel_path.parts):
        return False
    if "/src/" not in rel_text and "/test/" not in rel_text:
        return False
    return rel_text.startswith("apps/") or rel_text.startswith("packages/")


def iter_provider_boundary_sources(root: Path) -> list[Path]:
    files: list[Path] = []
    for top in ("apps", "packages"):
        base = root / top
        if not base.exists():
            continue
        for glob in ("*.ts", "*.tsx"):
            for file_path in base.rglob(glob):
                rel_path = file_path.relative_to(root)
                if is_provider_boundary_source(rel_path):
                    files.append(file_path)
    return sorted(set(files))


def load_exceptions(exceptions_path: Path) -> tuple[list[object] | None, list[str]]:
    if not exceptions_path.exists():
        return None, [f"Missing exceptions file: {exceptions_path.as_posix()}"]
    try:
        payload = json.loads(exceptions_path.read_text())
    except json.JSONDecodeError as exc:
        return None, [f"Invalid JSON in {exceptions_path.as_posix()}: {exc}"]
    if not isinstance(payload, list):
        return None, [f"{exceptions_path.as_posix()} must be a JSON array of exception objects."]
    return payload, []


def normalize_repo_relative(path_value: str) -> str:
    return Path(path_value).as_posix()


def validate_exceptions(
    root: Path,
    exceptions_path: Path,
    production_files: set[str],
    today: date,
) -> tuple[ExceptionRegistry, list[str]]:
    payload, issues = load_exceptions(exceptions_path)
    if payload is None:
        return ExceptionRegistry([]), issues

    entries: list[ExceptionEntry] = []
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(payload):
        prefix = f"[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{prefix} must be an object.")
            continue

        item_issues: list[str] = []
        missing = [field for field in REQUIRED_EXCEPTION_FIELDS if not str(item.get(field, "")).strip()]
        if missing:
            item_issues.append(f"{prefix} is missing required fields: {', '.join(missing)}")

        rule = str(item.get("rule", "")).strip()
        target = normalize_repo_relative(str(item.get("file", "")).strip())
        reason = str(item.get("reason", "")).strip()
        remove_by_phase = str(item.get("removeByPhase", "")).strip()

        if Path(target).is_absolute():
            item_issues.append(f"{prefix} file must be repo-relative: {target}")
        if rule not in SUPPORTED_EXCEPTION_RULES:
            item_issues.append(f"{prefix} has unsupported rule `{rule}`.")

        target_path = root / target
        if not target:
            item_issues.append(f"{prefix} file must be non-empty.")
        elif not target_path.exists():
            item_issues.append(f"{prefix} points to a missing file/path: {target}")

        if rule != "empty_folder" and target and target not in production_files:
            item_issues.append(f"{prefix} file is not a production source file: {target}")
        if rule == "empty_folder" and target and target_path.exists() and not target_path.is_dir():
            item_issues.append(f"{prefix} empty_folder exception must point to a directory: {target}")

        if remove_by_phase.lower() in {"never", "permanent", "none"}:
            item_issues.append(f"{prefix} removeByPhase must be time-bounded, not `{remove_by_phase}`.")

        max_lines = item.get("max_lines")
        if max_lines is not None and (not isinstance(max_lines, int) or max_lines <= 0):
            item_issues.append(f"{prefix} max_lines must be a positive integer when present.")

        max_occurrences = item.get("maxOccurrences")
        if max_occurrences is not None and (not isinstance(max_occurrences, int) or max_occurrences <= 0):
            item_issues.append(f"{prefix} maxOccurrences must be a positive integer when present.")

        max_violations = item.get("maxViolations")
        if max_violations is not None and (not isinstance(max_violations, int) or max_violations <= 0):
            item_issues.append(f"{prefix} maxViolations must be a positive integer when present.")

        key = (rule, target)
        if key in seen:
            item_issues.append(f"{prefix} duplicates rule/file pair `{rule}:{target}`.")
        seen.add(key)

        if item_issues:
            issues.extend(item_issues)
            continue

        entries.append(
            ExceptionEntry(
                file=target,
                rule=rule,
                reason=reason,
                remove_by_phase=remove_by_phase,
                max_lines=max_lines if isinstance(max_lines, int) else None,
                max_occurrences=max_occurrences if isinstance(max_occurrences, int) else None,
                max_violations=max_violations if isinstance(max_violations, int) else None,
            )
        )

    return ExceptionRegistry(entries), sorted(issues)


def load_provider_boundary_exceptions(
    root: Path,
    exceptions_path: Path,
) -> tuple[ProviderBoundaryExceptions, list[str]]:
    if not exceptions_path.exists():
        return ProviderBoundaryExceptions(PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID, {}), [
            f"Missing provider boundary exceptions file: {exceptions_path.as_posix()}"
        ]
    try:
        payload = json.loads(exceptions_path.read_text())
    except json.JSONDecodeError as exc:
        return ProviderBoundaryExceptions(PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID, {}), [
            f"Invalid JSON in {exceptions_path.as_posix()}: {exc}"
        ]
    if not isinstance(payload, dict):
        return ProviderBoundaryExceptions(PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID, {}), [
            f"{exceptions_path.as_posix()} must be a JSON object."
        ]

    issues: list[str] = []
    cleanup_plan_id = str(
        payload.get("cleanupPlanId", PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID)
    ).strip()
    if not cleanup_plan_id:
        issues.append("provider boundary exceptions must include cleanupPlanId.")
        cleanup_plan_id = PROVIDER_BOUNDARY_DEFAULT_CLEANUP_PLAN_ID

    raw_entries = payload.get("exceptions")
    if not isinstance(raw_entries, list):
        issues.append("provider boundary exceptions must include an exceptions array.")
        raw_entries = []

    entries: dict[str, ProviderBoundaryException] = {}
    supported_tokens = {name for name, _pattern in PROVIDER_BOUNDARY_TOKENS}
    for index, item in enumerate(raw_entries):
        prefix = f"[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{prefix} must be an object.")
            continue

        rel = normalize_repo_relative(str(item.get("file", "")).strip())
        reason = str(item.get("reason", "")).strip()
        remove_by_plan = str(item.get("removeByPlan", "")).strip()
        matches = item.get("matches")
        item_issues: list[str] = []

        if not rel:
            item_issues.append(f"{prefix} file must be non-empty.")
        elif Path(rel).is_absolute():
            item_issues.append(f"{prefix} file must be repo-relative: {rel}")
        elif any(ch in rel for ch in ("*", "?")) or rel.endswith("/"):
            item_issues.append(
                f"{prefix} file must be an exact file path, not a glob or directory: {rel}"
            )
        elif not (root / rel).exists():
            item_issues.append(f"{prefix} points to a missing file: {rel}")
        elif not (root / rel).is_file():
            item_issues.append(f"{prefix} file must point to an exact file: {rel}")

        if rel in entries:
            item_issues.append(f"{prefix} duplicates provider boundary exception for {rel}.")

        if not reason:
            item_issues.append(f"{prefix} is missing reason.")
        if not remove_by_plan:
            item_issues.append(f"{prefix} is missing removeByPlan.")
        elif remove_by_plan.lower() in {"never", "permanent", "none"}:
            item_issues.append(
                f"{prefix} removeByPlan must be time-bounded, not `{remove_by_plan}`."
            )

        if not isinstance(matches, dict) or not matches:
            item_issues.append(f"{prefix} matches must be a non-empty object.")
            normalized_matches: dict[str, int] = {}
        else:
            normalized_matches = {}
            for token, count in matches.items():
                token_name = str(token)
                if token_name not in supported_tokens:
                    item_issues.append(f"{prefix} has unsupported token `{token_name}`.")
                    continue
                if not isinstance(count, int) or count <= 0:
                    item_issues.append(
                        f"{prefix} count for `{token_name}` must be a positive integer."
                    )
                    continue
                normalized_matches[token_name] = count

        if item_issues:
            issues.extend(item_issues)
            continue

        entries[rel] = ProviderBoundaryException(
            file=rel,
            matches=normalized_matches,
            reason=reason,
            remove_by_plan=remove_by_plan,
        )

    return ProviderBoundaryExceptions(cleanup_plan_id=cleanup_plan_id, entries=entries), sorted(issues)


def count_lines(path: Path) -> int:
    return len(path.read_text().splitlines())


def line_budget_for(rel: str, architecture_map: dict[str, Any] | None = None) -> int:
    default_limit = FILE_SIZE_LIMIT
    target_limits: dict[str, int] = FILE_SIZE_LIMITS_BY_TARGET
    if architecture_map is not None:
        configured_default = architecture_map.get("defaultLineBudget")
        if isinstance(configured_default, int) and configured_default > 0:
            default_limit = configured_default
        configured_limits = architecture_map.get("lineBudgets")
        if isinstance(configured_limits, dict):
            target_limits = {
                normalize_repo_relative(str(path)): int(limit)
                for path, limit in configured_limits.items()
                if isinstance(path, str) and isinstance(limit, int) and limit > 0
            }
    return target_limits.get(rel, default_limit)


def check_file_size_budget(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any] | None = None,
) -> list[str]:
    issues: list[str] = []
    for file_path in production_files:
        rel = file_path.relative_to(root).as_posix()
        line_count = count_lines(file_path)
        limit = line_budget_for(rel, architecture_map)
        if line_count <= limit:
            continue
        issues.append(f"{rel} has {line_count} lines (limit {limit}).")
    return sorted(issues)


def extract_import_specifiers(source_text: str) -> list[str]:
    specs = IMPORT_FROM_RE.findall(source_text)
    specs.extend(SIDE_EFFECT_IMPORT_RE.findall(source_text))
    specs.extend(DYNAMIC_IMPORT_RE.findall(source_text))
    return specs


def resolve_import_target(root: Path, source_file: Path, specifier: str) -> str | None:
    if specifier.startswith("."):
        base = (source_file.parent / specifier).resolve()
    elif specifier.startswith(("apps/", "packages/")):
        base = (root / specifier).resolve()
    elif specifier == "@gantry/contracts":
        base = (root / "packages/contracts/src/index.ts").resolve()
    elif specifier.startswith("@gantry/contracts/"):
        base = (root / "packages/contracts/src" / specifier.removeprefix("@gantry/contracts/")).resolve()
    elif specifier == "@gantry/sdk":
        base = (root / "packages/sdk/src/index.ts").resolve()
    elif specifier.startswith("@gantry/sdk/"):
        base = (root / "packages/sdk/src" / specifier.removeprefix("@gantry/sdk/")).resolve()
    else:
        return None

    if not path_in_repo(root, base):
        return None

    candidates = [base]
    if base.suffix in {".js", ".mjs", ".cjs"}:
        candidates.extend(
            [
                base.with_suffix(".ts"),
                base.with_suffix(".tsx"),
                base.with_suffix(".d.ts"),
            ]
        )
    if not base.suffix:
        candidates.extend(
            [
                base.with_suffix(".ts"),
                base.with_suffix(".tsx"),
                base.with_suffix(".d.ts"),
                base.with_suffix(".js"),
                base / "index.ts",
                base / "index.tsx",
                base / "index.js",
            ]
        )

    for candidate in candidates:
        if candidate.exists() and candidate.is_file() and path_in_repo(root, candidate):
            return candidate.relative_to(root).as_posix()
    return None


def path_matches_prefix(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(f"{prefix}/")


def is_broad_directory_approval(prefix: str, broad_path: str) -> bool:
    return prefix == broad_path or (
        prefix.startswith(f"{broad_path}/") and Path(prefix).suffix == ""
    )


def import_matches_prefix(specifier: str, prefix: str) -> bool:
    if prefix.endswith(":"):
        return specifier.startswith(prefix)
    if prefix.endswith("/"):
        return specifier.startswith(prefix)
    return specifier == prefix or specifier.startswith(f"{prefix}/")


def check_forbidden_import_edges(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for specifier in extract_import_specifiers(source_text):
            target_rel = resolve_import_target(root, source_file, specifier)
            if target_rel is None:
                continue
            for source_prefix, forbidden_prefixes in FORBIDDEN_IMPORT_RULES:
                if not path_matches_prefix(source_rel, source_prefix):
                    continue
                for forbidden_prefix in forbidden_prefixes:
                    if path_matches_prefix(target_rel, forbidden_prefix):
                        violations.add(
                            f"{source_rel} imports {target_rel} via `{specifier}` "
                            f"(forbidden {source_prefix} -> {forbidden_prefix})."
                        )
    return sorted(violations)


def check_framework_boundary_imports(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for specifier in extract_import_specifiers(source_text):
            for rule in FRAMEWORK_BOUNDARY_RULES:
                if not any(
                    path_matches_prefix(source_rel, prefix)
                    for prefix in rule["source_prefixes"]
                ):
                    continue
                if not any(
                    import_matches_prefix(specifier, prefix)
                    for prefix in rule["specifier_prefixes"]
                ):
                    continue
                if any(
                    path_matches_prefix(source_rel, prefix)
                    for prefix in rule["allowed_prefixes"]
                ):
                    continue
                line = source_text.count("\n", 0, source_text.find(specifier)) + 1
                violations.add(
                    f"{source_rel}:{line}: imports `{specifier}` ({rule['message']})"
                )
    return sorted(violations)


def load_architecture_map(map_path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    if not map_path.exists():
        return None, [f"Missing architecture map: {map_path.as_posix()}"]
    try:
        payload = json.loads(map_path.read_text())
    except json.JSONDecodeError as exc:
        return None, [f"Invalid JSON in {map_path.as_posix()}: {exc}"]
    if not isinstance(payload, dict):
        return None, [f"{map_path.as_posix()} must be a JSON object."]
    return payload, []


def check_architecture_map_hygiene(root: Path, architecture_map: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    layers = architecture_map.get("layers")
    if not isinstance(layers, dict):
        return ["architecture-map.json must include a `layers` object."]

    required_layers = {
        "domain",
        "application",
        "runtime",
        "adapters",
        "config",
        "shared",
        "packages/contracts",
        "packages/sdk",
    }
    missing = required_layers.difference(layers)
    if missing:
        issues.append(f"architecture-map.json missing required layers: {', '.join(sorted(missing))}.")

    for layer_name, layer in layers.items():
        if not isinstance(layer, dict):
            issues.append(f"layer `{layer_name}` must be an object.")
            continue
        paths = layer.get("paths")
        if not isinstance(paths, list) or not paths:
            issues.append(f"layer `{layer_name}` must include non-empty paths.")
            continue
        for raw_path in paths:
            if not isinstance(raw_path, str) or not raw_path.strip():
                issues.append(f"layer `{layer_name}` includes an invalid path.")
                continue
            rel = normalize_repo_relative(raw_path)
            if Path(rel).is_absolute():
                issues.append(f"layer `{layer_name}` path must be repo-relative: {rel}")
            elif not (root / rel).exists():
                issues.append(f"layer `{layer_name}` path does not exist: {rel}")

        allowed = layer.get("allowedImportLayers")
        if not isinstance(allowed, list):
            issues.append(f"layer `{layer_name}` must include allowedImportLayers.")
        elif any(not isinstance(item, str) for item in allowed):
            issues.append(f"layer `{layer_name}` allowedImportLayers must contain strings only.")

    provider_paths = architecture_map.get("approvedProviderSpecificPaths", [])
    if isinstance(provider_paths, list):
        normalized_provider_paths = [
            normalize_repo_relative(item) for item in provider_paths if isinstance(item, str)
        ]
        for broad_path in PROVIDER_BOUNDARY_DISALLOWED_BROAD_PATHS:
            if any(
                is_broad_directory_approval(prefix, broad_path)
                for prefix in normalized_provider_paths
            ):
                issues.append(
                    f"approvedProviderSpecificPaths must not broadly approve `{broad_path}`; "
                    "use exact architecture exceptions for current debt."
                )

    return sorted(issues)


def map_list(architecture_map: dict[str, Any], key: str) -> list[str]:
    value = architecture_map.get(key, [])
    if not isinstance(value, list):
        return []
    return [normalize_repo_relative(item) for item in value if isinstance(item, str)]


def map_dict(architecture_map: dict[str, Any], key: str) -> dict[str, Any]:
    value = architecture_map.get(key, {})
    return value if isinstance(value, dict) else {}


def layer_entries(architecture_map: dict[str, Any]) -> list[tuple[str, str]]:
    layers = architecture_map.get("layers", {})
    entries: list[tuple[str, str]] = []
    if not isinstance(layers, dict):
        return entries
    for layer_name, layer in layers.items():
        if not isinstance(layer, dict):
            continue
        paths = layer.get("paths", [])
        if not isinstance(paths, list):
            continue
        for raw_path in paths:
            if isinstance(raw_path, str):
                entries.append((normalize_repo_relative(raw_path), str(layer_name)))
    return sorted(entries, key=lambda item: len(item[0]), reverse=True)


def classify_layer(rel_path: str, architecture_map: dict[str, Any]) -> str | None:
    for prefix, layer_name in layer_entries(architecture_map):
        if path_matches_prefix(rel_path, prefix):
            return layer_name
    return None


def allowed_import_layers(architecture_map: dict[str, Any], layer_name: str) -> set[str]:
    layers = architecture_map.get("layers", {})
    if not isinstance(layers, dict):
        return set()
    layer = layers.get(layer_name)
    if not isinstance(layer, dict):
        return set()
    allowed = layer.get("allowedImportLayers", [])
    if not isinstance(allowed, list):
        return set()
    return {str(item) for item in allowed if isinstance(item, str)}


def allowed_external_imports(architecture_map: dict[str, Any], layer_name: str) -> list[str]:
    layers = architecture_map.get("layers", {})
    if not isinstance(layers, dict):
        return []
    layer = layers.get(layer_name)
    if not isinstance(layer, dict):
        return []
    allowed = layer.get("allowedExternalImports", [])
    if not isinstance(allowed, list):
        return []
    return [str(item) for item in allowed if isinstance(item, str)]


def exception_or_issue(
    exceptions: ExceptionRegistry,
    active_counts: dict[tuple[str, str], int],
    rel_path: str,
    rule: str,
    message: str,
) -> str | None:
    key = (rel_path, rule)
    active_counts[key] = active_counts.get(key, 0) + 1
    entry = exceptions.get(rel_path, rule)
    if entry is None:
        return message
    max_violations = entry.max_violations
    if max_violations is not None and active_counts[key] > max_violations:
        return f"{message} Exception maxViolations is {max_violations}."
    return None


def check_map_layer_imports(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_layer = classify_layer(source_rel, architecture_map)
        if source_layer is None:
            continue
        allowed_layers = allowed_import_layers(architecture_map, source_layer)
        source_text = source_file.read_text()
        for specifier in extract_import_specifiers(source_text):
            target_rel = resolve_import_target(root, source_file, specifier)
            if target_rel is None:
                continue
            target_layer = classify_layer(target_rel, architecture_map)
            if target_layer is None or target_layer in allowed_layers:
                continue
            line = source_text.count("\n", 0, source_text.find(specifier)) + 1
            issue = exception_or_issue(
                exceptions,
                active_counts,
                source_rel,
                "forbidden_import_by_layer",
                f"{source_rel}:{line}: {source_layer} imports {target_layer} file {target_rel} via `{specifier}`.",
            )
            if issue:
                issues.add(issue)
    return sorted(issues), active_counts


def check_external_imports_by_layer(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_layer = classify_layer(source_rel, architecture_map)
        if source_layer is None:
            continue
        allowed = allowed_external_imports(architecture_map, source_layer)
        if "*" in allowed:
            continue
        source_text = source_file.read_text()
        for specifier in extract_import_specifiers(source_text):
            if specifier.startswith(".") or specifier.startswith(("apps/", "packages/")):
                continue
            if resolve_import_target(root, source_file, specifier) is not None:
                continue
            if any(import_matches_prefix(specifier, prefix) for prefix in allowed):
                continue
            line = source_text.count("\n", 0, source_text.find(specifier)) + 1
            issue = exception_or_issue(
                exceptions,
                active_counts,
                source_rel,
                "forbidden_external_import_by_layer",
                f"{source_rel}:{line}: {source_layer} imports external package `{specifier}`.",
            )
            if issue:
                issues.add(issue)
    return sorted(issues), active_counts


def check_provider_specific_paths(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    patterns = map_dict(architecture_map, "providerSpecificPatterns")
    approved_paths = map_list(architecture_map, "approvedProviderSpecificPaths")
    if not patterns:
        return [], active_counts

    compiled: list[tuple[str, re.Pattern[str]]] = []
    for name, pattern in patterns.items():
        if isinstance(name, str) and isinstance(pattern, str):
            compiled.append((name, re.compile(pattern, re.IGNORECASE)))

    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        if any(path_matches_prefix(source_rel, prefix) for prefix in approved_paths):
            continue
        source_text = source_file.read_text()
        for name, pattern in compiled:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                issue = exception_or_issue(
                    exceptions,
                    active_counts,
                    source_rel,
                    "provider_specific_path",
                    f"{source_rel}:{line}: provider-specific `{name}` code must live in an approved provider adapter path.",
                )
                if issue:
                    issues.add(issue)
    return sorted(issues), active_counts


def check_provider_imports(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    provider_imports = map_list(architecture_map, "providerImportSpecifiers")
    approved_paths = map_list(architecture_map, "approvedProviderSpecificPaths")
    if not provider_imports:
        return [], active_counts

    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for specifier in extract_import_specifiers(source_text):
            if not any(import_matches_prefix(specifier, prefix) for prefix in provider_imports):
                continue
            if any(path_matches_prefix(source_rel, prefix) for prefix in approved_paths):
                continue
            line = source_text.count("\n", 0, source_text.find(specifier)) + 1
            issue = exception_or_issue(
                exceptions,
                active_counts,
                source_rel,
                "forbidden_provider_import",
                f"{source_rel}:{line}: imports provider package `{specifier}` outside approved adapter paths.",
            )
            if issue:
                issues.add(issue)
    return sorted(issues), active_counts


def provider_boundary_approved_paths(architecture_map: dict[str, Any]) -> list[str]:
    if "approvedProviderBoundaryPaths" not in architecture_map:
        return list(PROVIDER_BOUNDARY_DEFAULT_APPROVED_PATHS)
    value = architecture_map.get("approvedProviderBoundaryPaths")
    if not isinstance(value, list):
        return []
    return [normalize_repo_relative(item) for item in value if isinstance(item, str)]


def count_provider_boundary_tokens(source_text: str) -> dict[str, int]:
    return {
        name: count
        for name, pattern in PROVIDER_BOUNDARY_TOKENS
        if (count := len(pattern.findall(source_text))) > 0
    }


def check_provider_boundary(
    source_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ProviderBoundaryExceptions,
) -> list[str]:
    issues: list[str] = []
    approved_paths = provider_boundary_approved_paths(architecture_map)
    if not approved_paths:
        issues.append(
            "approvedProviderBoundaryPaths must include at least one provider adapter path."
        )

    for broad_path in PROVIDER_BOUNDARY_DISALLOWED_BROAD_PATHS:
        if any(
            path_matches_prefix(broad_path, prefix)
            or path_matches_prefix(prefix, broad_path)
            for prefix in approved_paths
        ):
            issues.append(
                f"approvedProviderBoundaryPaths must not broadly approve `{broad_path}`; "
                "record exact current debt in .codex/provider-boundary-exceptions.json."
            )

    for prefix in approved_paths:
        if prefix not in PROVIDER_BOUNDARY_ALLOWED_APPROVED_PATHS:
            issues.append(
                f"approvedProviderBoundaryPaths contains unsupported path `{prefix}`; "
                "this gate currently approves only "
                f"{sorted(PROVIDER_BOUNDARY_ALLOWED_APPROVED_PATHS)}."
            )

    expected_boundary = ", ".join(approved_paths) if approved_paths else "<none>"
    active_matches: dict[str, dict[str, int]] = {}
    first_lines: dict[tuple[str, str], int] = {}
    for source_file in source_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        matches = count_provider_boundary_tokens(source_text)
        if not matches:
            continue
        if any(path_matches_prefix(source_rel, prefix) for prefix in approved_paths):
            continue
        active_matches[source_rel] = matches
        for token, pattern in PROVIDER_BOUNDARY_TOKENS:
            if token not in matches:
                continue
            match = pattern.search(source_text)
            if match is not None:
                first_lines[(source_rel, token)] = source_text.count("\n", 0, match.start()) + 1

    for rel, matches in sorted(active_matches.items()):
        entry = exceptions.entries.get(rel)
        if entry is None:
            for token, count in sorted(matches.items()):
                line = first_lines.get((rel, token), 1)
                issues.append(
                    f"{rel}:{line}: matched provider token `{token}` {count} time(s) outside "
                    f"approved provider adapter boundary `{expected_boundary}`; either move the code "
                    f"behind that boundary or record exact debt for cleanup plan "
                    f"`{exceptions.cleanup_plan_id}`."
                )
            continue
        if entry.matches != matches:
            issues.append(
                f"{rel}: provider boundary exception count changed for cleanup plan "
                f"`{exceptions.cleanup_plan_id}`; expected {entry.matches}, actual {matches}."
            )

    for rel, entry in sorted(exceptions.entries.items()):
        if rel not in active_matches:
            issues.append(
                f"{rel}: stale provider boundary exception for cleanup plan "
                f"`{exceptions.cleanup_plan_id}`; remove it or move the file out of approved paths."
            )
        elif entry.remove_by_plan != exceptions.cleanup_plan_id:
            issues.append(
                f"{rel}: provider boundary exception removeByPlan `{entry.remove_by_plan}` "
                f"must match cleanup plan `{exceptions.cleanup_plan_id}`."
            )

    return sorted(issues)


def risky_child_process_names(source_text: str) -> set[str]:
    names: set[str] = set()
    for match in re.finditer(r"import\s+\{([^}]+)\}\s+from\s+['\"](?:node:)?child_process['\"]", source_text):
        for raw_name in match.group(1).split(","):
            parts = raw_name.strip().split()
            if not parts:
                continue
            imported = parts[0]
            local = parts[-1] if "as" in parts else imported
            if imported in {"exec", "spawn"}:
                names.add(local)
    for match in re.finditer(r"import\s+\*\s+as\s+(\w+)\s+from\s+['\"](?:node:)?child_process['\"]", source_text):
        names.add(f"{match.group(1)}.exec")
        names.add(f"{match.group(1)}.spawn")
    return names


def check_direct_risky_execution(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    approved_paths = map_list(architecture_map, "riskyExecutionApprovedPaths")
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        if any(path_matches_prefix(source_rel, prefix) for prefix in approved_paths):
            continue
        source_text = source_file.read_text()
        patterns: list[tuple[re.Pattern[str], str]] = [
            (re.compile(r"\bchild_process\.(?:exec|spawn)\s*\("), "child_process.exec/spawn"),
            (re.compile(r"\bBun\.spawn\s*\("), "Bun.spawn"),
            (re.compile(r"\bnew\s+Deno\.Command\s*\("), "Deno.Command"),
        ]
        for name in risky_child_process_names(source_text):
            if "." in name:
                patterns.append((re.compile(rf"\b{re.escape(name)}\s*\("), name))
            else:
                patterns.append((re.compile(rf"\b{re.escape(name)}\s*\("), name))
        for pattern, label in patterns:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                issue = exception_or_issue(
                    exceptions,
                    active_counts,
                    source_rel,
                    "direct_risky_execution",
                    f"{source_rel}:{line}: direct risky execution `{label}` must go through an approved sandbox adapter.",
                )
                if issue:
                    issues.add(issue)
    return sorted(issues), active_counts


def check_browser_default_profile_paths(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    patterns = map_list(architecture_map, "browserDefaultProfilePathPatterns")
    if not patterns:
        return [], active_counts
    compiled = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for pattern in compiled:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                issue = exception_or_issue(
                    exceptions,
                    active_counts,
                    source_rel,
                    "browser_default_profile_path",
                    f"{source_rel}:{line}: references a browser default profile path.",
                )
                if issue:
                    issues.add(issue)
    return sorted(issues), active_counts


def check_old_terms(
    production_files: list[Path],
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> tuple[list[str], dict[tuple[str, str], int]]:
    issues: set[str] = set()
    active_counts: dict[tuple[str, str], int] = {}
    patterns = map_dict(architecture_map, "oldTermPatterns")
    compiled: list[tuple[str, re.Pattern[str]]] = []
    for rule_suffix, pattern in patterns.items():
        if isinstance(rule_suffix, str) and isinstance(pattern, str):
            compiled.append((f"old_term_{rule_suffix}", re.compile(pattern, re.IGNORECASE)))

    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for rule, pattern in compiled:
            matches = list(pattern.finditer(source_text))
            if not matches:
                continue
            entry = exceptions.get(source_rel, rule)
            if entry is not None:
                max_occurrences = entry.max_occurrences
                if max_occurrences is None:
                    issues.add(f"{source_rel} exception for `{rule}` must include maxOccurrences.")
                elif len(matches) > max_occurrences:
                    issues.add(
                        f"{source_rel} has {len(matches)} `{rule}` matches but exception maxOccurrences is {max_occurrences}."
                    )
                active_counts[(source_rel, rule)] = len(matches)
                continue
            first = matches[0]
            line = source_text.count("\n", 0, first.start()) + 1
            issues.add(f"{source_rel}:{line}: contains old architecture term `{first.group(0)}` ({rule}).")
            active_counts[(source_rel, rule)] = len(matches)
    return sorted(issues), active_counts


def check_empty_folders(
    root: Path,
    architecture_map: dict[str, Any],
    exceptions: ExceptionRegistry,
) -> list[str]:
    issues: list[str] = []
    scan_roots = map_list(architecture_map, "emptyFolderScanRoots") or ["apps/core/src", "packages"]
    ignored_parts = {"node_modules", "dist", "coverage", "__pycache__"}
    for scan_root in scan_roots:
        base = root / scan_root
        if not base.exists():
            continue
        for path in sorted(item for item in base.rglob("*") if item.is_dir()):
            rel = path.relative_to(root).as_posix()
            if any(part in ignored_parts for part in path.relative_to(root).parts):
                continue
            try:
                next(path.iterdir())
                continue
            except StopIteration:
                pass
            if exceptions.has(rel, "empty_folder"):
                continue
            issues.append(f"{rel} is empty and needs a purpose file or an exception.")
    return issues


def check_wrapper_only_files(
    production_files: list[Path],
    root: Path,
    exceptions: ExceptionRegistry,
) -> list[str]:
    issues: list[str] = []
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        lines = source_file.read_text().splitlines()
        meaningful = [line for line in lines if not COMMENT_OR_BLANK_RE.match(line)]
        if not meaningful:
            continue
        if len(meaningful) > 12:
            continue
        if not all(EXPORT_FROM_STATEMENT_RE.match(line) for line in meaningful):
            continue
        if exceptions.has(source_rel, "wrapper_only_file"):
            continue
        issues.append(f"{source_rel} is wrapper-only ({len(meaningful)} export lines).")
    return sorted(issues)


def check_forbidden_channel_registration_surface(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for rel in FORBIDDEN_CHANNEL_REGISTRATION_FILES:
        if (root / rel).exists():
            violations.add(f"{rel} exists but side-effect channel registration is not allowed.")

    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for pattern, description in FORBIDDEN_CHANNEL_REGISTRATION_PATTERNS:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                violations.add(
                    f"{source_rel}:{line}: matched {description} ({pattern.pattern})"
                )
    return sorted(violations)


def check_forbidden_runtime_runner_materialization(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for pattern, description in FORBIDDEN_RUNTIME_RUNNER_MATERIALIZATION_PATTERNS:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                violations.add(
                    f"{source_rel}:{line}: matched {description} ({pattern.pattern})"
                )
    return sorted(violations)


def check_forbidden_ipc_contract_surface(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for rel in FORBIDDEN_IPC_CONTRACT_FILES:
        if (root / rel).exists():
            violations.add(f"{rel} exists but IPC contracts must live only in packages/contracts.")

    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        for pattern, description in FORBIDDEN_IPC_CONTRACT_IMPORT_PATTERNS:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                violations.add(
                    f"{source_rel}:{line}: matched {description} ({pattern.pattern})"
                )
    return sorted(violations)


def check_forbidden_ipc_orchestrator_monolith(root: Path) -> list[str]:
    source_file = root / IPC_ORCHESTRATOR_FILE
    if not source_file.exists():
        return []

    source_text = source_file.read_text()
    violations: set[str] = set()
    source_rel = source_file.relative_to(root).as_posix()
    for pattern, description in FORBIDDEN_IPC_ORCHESTRATOR_MONOLITH_PATTERNS:
        for match in pattern.finditer(source_text):
            line = source_text.count("\n", 0, match.start()) + 1
            violations.add(
                f"{source_rel}:{line}: matched {description} ({pattern.pattern})"
            )
    return sorted(violations)


def check_forbidden_direct_provider_sends(production_files: list[Path], root: Path) -> list[str]:
    violations: set[str] = set()
    for source_file in production_files:
        source_rel = source_file.relative_to(root).as_posix()
        source_text = source_file.read_text()
        if source_rel not in RECOVERY_ONLY_CHANNEL_WIRING_CALL_ALLOWLIST:
            for pattern, description in RECOVERY_ONLY_CHANNEL_WIRING_CALL_PATTERNS:
                for match in pattern.finditer(source_text):
                    line = source_text.count("\n", 0, match.start()) + 1
                    violations.add(
                        f"{source_rel}:{line}: matched recovery-only channel wiring call `{description}` ({pattern.pattern}); only runtime recovery wiring may use this seam."
                    )

        if not any(
            path_matches_prefix(source_rel, prefix)
            for prefix in FORBIDDEN_DIRECT_PROVIDER_SEND_SOURCE_PREFIXES
        ):
            continue
        for pattern, description in FORBIDDEN_DIRECT_PROVIDER_SEND_PATTERNS:
            for match in pattern.finditer(source_text):
                line = source_text.count("\n", 0, match.start()) + 1
                violations.add(
                    f"{source_rel}:{line}: matched direct provider send `{description}` ({pattern.pattern}); route through channel adapters."
                )
    return sorted(violations)


def active_docs(root: Path) -> list[Path]:
    docs: list[Path] = []
    for rel in ACTIVE_DOC_FILES:
        path = root / rel
        if path.exists():
            docs.append(path)
    for folder in ("docs/product", "docs/architecture", "docs/decisions"):
        base = root / folder
        if not base.exists():
            continue
        docs.extend(path for path in sorted(base.rglob("*.md")) if not path.name.startswith("plan-"))
    unique = {path.relative_to(root).as_posix(): path for path in docs}
    return [unique[key] for key in sorted(unique)]


def should_ignore_markdown_target(target: str) -> bool:
    normalized = target.strip()
    if not normalized or normalized.startswith("#") or normalized.startswith("/"):
        return True
    if normalized.startswith("~/") or "://" in normalized:
        return True
    if normalized.lower().startswith(("mailto:", "tel:")):
        return True
    return any(ch in normalized for ch in ("*", "{", "}"))


def resolve_doc_target(root: Path, source_doc: Path, target: str) -> Path | None:
    if target.startswith(("./", "../")):
        candidate = (source_doc.parent / target).resolve()
    else:
        candidate = (root / target).resolve()
    return candidate if path_in_repo(root, candidate) else None


def looks_like_local_file_reference(token: str) -> bool:
    if " " in token:
        return False
    if token.startswith(("/", "~/", "-", "http://", "https://")) or "://" in token:
        return False
    if any(ch in token for ch in ("*", "{", "}", "$")) or token.endswith("/"):
        return False
    if token.startswith(".factory/"):
        return False
    if token in ROOT_FILE_REFERENCES:
        return True
    suffix = Path(token).suffix.lower()
    return suffix in RECOGNIZED_CODE_PATH_EXTENSIONS and "/" in token


def check_doc_references(root: Path) -> list[str]:
    missing: set[str] = set()
    for doc in active_docs(root):
        rel_doc = doc.relative_to(root).as_posix()
        text = doc.read_text()
        for raw_target in MARKDOWN_LINK_RE.findall(text):
            target = raw_target.strip().split()[0].strip("<>").split("#", 1)[0]
            if should_ignore_markdown_target(target):
                continue
            resolved = resolve_doc_target(root, doc, target)
            if resolved is None or not resolved.exists():
                missing.add(f"{rel_doc} -> {target}")
        for token in INLINE_CODE_RE.findall(text):
            if not looks_like_local_file_reference(token):
                continue
            resolved = resolve_doc_target(root, doc, token)
            if resolved is None or not resolved.exists():
                missing.add(f"{rel_doc} -> {token}")
    return sorted(missing)
