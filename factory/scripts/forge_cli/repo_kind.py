"""Repository-kind discriminator shared by Forge gate machinery."""
from __future__ import annotations

from pathlib import Path


ORCHESTRATION_PREFIXES = (
    "plans/", "docs/", ".gstack/", "prototype/",
)
CLIENT_MACHINERY_PREFIXES = (
    "factory/", "constitution/", "harness/", ".claude/", ".codex/",
)
ORCHESTRATION_FILES = {
    "README.md", ".gitignore", ".gitattributes", ".envrc",
    ".factory/scratchpad.md",
}


def is_harness_source_repo(root: Path) -> bool:
    """Return whether root is the Symphony Forge source repository."""
    return (root / ".factory" / "harness-source.json").exists()


def locked_repo_path(
    raw: str, root: Path, *, harness_source: bool | None = None,
) -> str | None:
    """Return a canonical locked repo path, or None for an exempt surface."""
    value = raw.strip().strip("\"'")
    if not value or value in {"-", "/dev/null"} or "$" in value or "`" in value:
        return None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        rel = candidate.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None
    if not rel or rel in ORCHESTRATION_FILES:
        return None
    exempt_prefixes = ORCHESTRATION_PREFIXES
    source_repo = (
        is_harness_source_repo(root) if harness_source is None else harness_source
    )
    if not source_repo:
        exempt_prefixes += CLIENT_MACHINERY_PREFIXES
    if any(rel == prefix.rstrip("/") or rel.startswith(prefix)
           for prefix in exempt_prefixes):
        return None
    return rel
