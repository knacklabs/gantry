from __future__ import annotations

import json
import re
import subprocess
from datetime import date
from pathlib import Path

FILE_SIZE_LIMIT = 400
FILE_SIZE_RULE = "file_size_budget"
REQUIRED_EXCEPTION_FIELDS = ("rule", "target", "owner", "reason", "expires_on")

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
        "apps/core/src/core",
        (
            "apps/core/src/runtime",
            "apps/core/src/channels",
            "apps/core/src/cli",
            "apps/core/src/storage",
            "apps/core/src/session",
            "apps/core/src/memory",
        ),
    ),
    (
        "apps/core/src/platform",
        (
            "apps/core/src/runtime",
            "apps/core/src/channels",
            "apps/core/src/cli",
            "apps/core/src/storage",
            "apps/core/src/session",
            "apps/core/src/memory",
        ),
    ),
    (
        "apps/core/src/storage",
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
    ("apps/core/src/channels", ("apps/core/src/cli",)),
    ("packages/agent-runner/src", ("apps/core/src",)),
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
    "packages/agent-runner/src/memory-ipc-contract.ts",
    "packages/agent-runner/src/browser-ipc-contract.ts",
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

MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
IMPORT_FROM_RE = re.compile(r"(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['\"]([^'\"]+)['\"]", re.MULTILINE)
SIDE_EFFECT_IMPORT_RE = re.compile(r"(?:^|\n)\s*import\s*['\"]([^'\"]+)['\"]", re.MULTILINE)

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


def load_exceptions(exceptions_path: Path) -> tuple[dict[str, object] | None, list[str]]:
    if not exceptions_path.exists():
        return None, [f"Missing exceptions file: {exceptions_path.as_posix()}"]
    try:
        payload = json.loads(exceptions_path.read_text())
    except json.JSONDecodeError as exc:
        return None, [f"Invalid JSON in {exceptions_path.as_posix()}: {exc}"]
    if not isinstance(payload, dict):
        return None, [f"{exceptions_path.as_posix()} must be a JSON object."]
    return payload, []


def normalize_repo_relative(path_value: str) -> str:
    return Path(path_value).as_posix()


def validate_exceptions(
    root: Path,
    exceptions_path: Path,
    production_files: set[str],
    today: date,
) -> tuple[dict[str, dict[str, object]], list[str]]:
    payload, issues = load_exceptions(exceptions_path)
    if payload is None:
        return {}, issues

    version = payload.get("version")
    if version != 1:
        issues.append("Exceptions file must set `version` to 1.")

    raw_exceptions = payload.get("exceptions")
    if not isinstance(raw_exceptions, list):
        issues.append("Exceptions file must include an `exceptions` array.")
        return {}, sorted(issues)

    by_target: dict[str, dict[str, object]] = {}
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(raw_exceptions):
        prefix = f"exceptions[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{prefix} must be an object.")
            continue

        item_issues: list[str] = []
        missing = [field for field in REQUIRED_EXCEPTION_FIELDS if not str(item.get(field, "")).strip()]
        if missing:
            item_issues.append(f"{prefix} is missing required fields: {', '.join(missing)}")

        rule = str(item.get("rule", "")).strip()
        target = normalize_repo_relative(str(item.get("target", "")).strip())
        expires_on = str(item.get("expires_on", "")).strip()

        if Path(target).is_absolute():
            item_issues.append(f"{prefix} target must be repo-relative: {target}")
        if rule != FILE_SIZE_RULE:
            item_issues.append(f"{prefix} has unsupported rule `{rule}`.")

        target_path = root / target
        if not target:
            item_issues.append(f"{prefix} target must be non-empty.")
        elif not target_path.exists():
            item_issues.append(f"{prefix} points to a missing target: {target}")

        if target and target not in production_files:
            item_issues.append(f"{prefix} target is not a production source file: {target}")

        try:
            expiry = date.fromisoformat(expires_on)
        except ValueError:
            item_issues.append(f"{prefix} has invalid `expires_on` date: {expires_on}")
        else:
            if expiry < today:
                item_issues.append(f"{prefix} is expired on {expires_on}.")

        max_lines = item.get("max_lines")
        if not isinstance(max_lines, int) or max_lines <= FILE_SIZE_LIMIT:
            item_issues.append(f"{prefix} must include integer `max_lines` greater than {FILE_SIZE_LIMIT}.")

        key = (rule, target)
        if key in seen:
            item_issues.append(f"{prefix} duplicates rule/target pair `{rule}:{target}`.")
        seen.add(key)

        if item_issues:
            issues.extend(item_issues)
            continue

        by_target[target] = item

    return by_target, sorted(issues)


def count_lines(path: Path) -> int:
    return len(path.read_text().splitlines())


def check_file_size_budget(production_files: list[Path], root: Path, exceptions: dict[str, dict[str, object]]) -> list[str]:
    issues: list[str] = []
    over_budget: set[str] = set()
    for file_path in production_files:
        rel = file_path.relative_to(root).as_posix()
        line_count = count_lines(file_path)
        if line_count <= FILE_SIZE_LIMIT:
            continue
        over_budget.add(rel)
        exception = exceptions.get(rel)
        if exception is None:
            issues.append(f"{rel} has {line_count} lines (limit {FILE_SIZE_LIMIT}) and no exception.")
            continue
        max_lines = int(exception["max_lines"])
        if line_count > max_lines:
            issues.append(f"{rel} has {line_count} lines but exception max_lines is {max_lines}.")

    for target in sorted(exceptions):
        if target not in over_budget:
            issues.append(f"{target} has an exception but is now within {FILE_SIZE_LIMIT} lines; remove it.")
    return sorted(issues)


def extract_import_specifiers(source_text: str) -> list[str]:
    specs = IMPORT_FROM_RE.findall(source_text)
    specs.extend(SIDE_EFFECT_IMPORT_RE.findall(source_text))
    return specs


def resolve_import_target(root: Path, source_file: Path, specifier: str) -> str | None:
    if specifier.startswith("."):
        base = (source_file.parent / specifier).resolve()
    elif specifier.startswith(("apps/", "packages/")):
        base = (root / specifier).resolve()
    else:
        return None

    if not path_in_repo(root, base):
        return None

    candidates = [base]
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
