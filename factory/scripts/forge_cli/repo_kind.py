"""Repository-kind discriminator shared by Forge gate machinery."""
from __future__ import annotations

from pathlib import Path


def is_harness_source_repo(root: Path) -> bool:
    """Return whether root is the Symphony Forge source repository."""
    return (root / ".factory" / "harness-source.json").exists()
