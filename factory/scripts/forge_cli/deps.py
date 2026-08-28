"""forge deps — the sanctioned, bounded path to refresh a dependency lockfile.

A task that adds a runtime dependency has to update the lockfile, but the two
normal write paths cannot: the delegated companion runs in a sandbox that need
not have network or a package manager, and the orchestrating session is behind
the write-lock. `forge deps lock` closes that gap by running the repo's own
package manager in *lockfile-only* mode as a forge subprocess — no `node_modules`
mutation and no build scripts, so the write is bounded to the lockfile itself.
The package manager is inferred from the lockfile present, so this works on pnpm,
npm, and Yarn Berry repos without hardcoding one ecosystem.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

from factory_lib import repo_root

from .common import fail

# Lockfile -> (package manager, lockfile-only argv). Each argv refreshes ONLY the
# lockfile: no node_modules, no lifecycle/build scripts.
LOCKERS: tuple[tuple[str, str, list[str]], ...] = (
    ("pnpm-lock.yaml", "pnpm", ["install", "--lockfile-only", "--ignore-scripts"]),
    ("package-lock.json", "npm", ["install", "--package-lock-only", "--ignore-scripts"]),
    ("npm-shrinkwrap.json", "npm", ["install", "--package-lock-only", "--ignore-scripts"]),
    ("yarn.lock", "yarn", ["install", "--mode", "update-lockfile"]),
)


def detect_locker(root: Path) -> tuple[str, str, list[str]] | None:
    """Return (lockfile, package_manager, argv) for the first lockfile present."""
    for lockfile, manager, argv in LOCKERS:
        if (root / lockfile).is_file():
            return lockfile, manager, argv
    return None


def cmd_lock(args: argparse.Namespace) -> None:
    root = Path(args.repo).resolve() if args.repo else repo_root()
    if not (root / "package.json").is_file():
        fail(f"forge deps lock: no package.json in {root} — nothing to lock.")
    found = detect_locker(root)
    if found is None:
        fail(
            "forge deps lock: no lockfile found next to package.json "
            "(pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, or yarn.lock). "
            "Create one with your package manager once, then re-run."
        )
    lockfile, manager, argv = found
    executable = shutil.which(manager)
    if not executable:
        fail(
            f"forge deps lock: '{manager}' is not on PATH but {lockfile} needs it. "
            f"Install {manager} (or run its lockfile-only refresh yourself)."
        )
    print(f"forge deps lock: refreshing {lockfile} via `{manager} {' '.join(argv)}`")
    proc = subprocess.run([executable, *argv], cwd=root)
    if proc.returncode != 0:
        fail(
            f"forge deps lock: {manager} exited {proc.returncode}; {lockfile} was "
            "not updated. Fix the reported dependency error and re-run."
        )
    print(
        f"forge deps lock: {lockfile} refreshed (lockfile only — no node_modules, "
        "no build scripts). Review and commit it with your change."
    )
