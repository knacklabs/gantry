"""The review lenses read the tree they judge (decision 0076).

The autoreview skill starts its engine in an empty temporary folder, and the
engine's read-only sandbox refuses every path outside that folder. A reviewer
told to open the callee of a changed line answered "CreateProcess rejected
access ... blocked by policy" and then wrote `missing` for a contract the
callee satisfied (probe, 2026-09-13) -- the same shape as eleven of WF-1 T5's
first twenty-five blockers, and the reason a contract about unchanged code
came back `partial` round after round: the reviewer could only guess.

The skill accepts an external Codex binary. This module writes a launcher that
swaps the empty folder for the review worktree and starts the real Codex
otherwise unchanged. The sandbox stays read-only (the skill passes no sandbox
flag, so `codex exec` keeps its read-only default); only where it points
changes, and the worktree is a fresh detached checkout with no ignored files.

On Windows one more thing is needed. The skill passes `--ignore-user-config`,
which also drops `[windows] sandbox = "elevated"` from the user's Codex
config; without that sandbox Codex refuses EVERY command in read-only mode
("CreateProcess rejected the command: blocked by policy" for `Get-Location`
itself, probe 2026-09-13). The launcher carries that one key through as a
`-c` override, and points CODEX_HOME back at the home that holds the sandbox's
set-up state (the skill's runtime home has none, so Codex re-ran set-up and
its UAC prompt was cancelled: error 1223). Then the reviewer's read-only shell
works at all.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import sys
from pathlib import Path

EMPTY_WORKSPACE_ENV = "FORGE_REVIEW_EMPTY_WORKSPACE"
CODEX_BIN_ENV = "FORGE_REVIEW_CODEX_BIN"

LAUNCHER = '''\
"""Written by `forge review`: start Codex inside the reviewed worktree.

The skill points Codex at an empty folder (`-C <tmp>`); this swaps that one
argument for the review worktree, carries the Windows sandbox setting the
skill's `--ignore-user-config` dropped, and leaves every other argument,
stdin, stdout, stderr and the exit code alone. Read-only stays read-only.
"""
import json
import os
import subprocess
import sys

REAL = {real!r}
WORKTREE = {worktree!r}
EXTRA = {extra!r}
SANDBOX_HOME = {sandbox_home!r}

# The skill points CODEX_HOME at a fresh runtime folder. On Windows the
# elevated sandbox keeps its set-up state under the user's real CODEX_HOME
# (.sandbox, .sandbox-bin, .sandbox-secrets); without it Codex re-runs set-up,
# which needs a UAC prompt no headless review can answer (error 1223). Point
# the engine back at the home that holds the state. Config stays ignored
# (`--ignore-user-config`), and auth.json there is the same file the skill
# hard-linked into its runtime home.
if SANDBOX_HOME and os.path.isdir(os.path.join(SANDBOX_HOME, ".sandbox")):
    os.environ["CODEX_HOME"] = SANDBOX_HOME

argv = sys.argv[1:]
out = []
i = 0
placed = not EXTRA
while i < len(argv):
    if argv[i] == "exec" and not placed:
        out += EXTRA
        placed = True
    if argv[i] in ("-C", "--cd") and i + 1 < len(argv):
        out += [argv[i], WORKTREE]
        i += 2
        continue
    out.append(argv[i])
    i += 1
if not placed:
    out = EXTRA + out
# What actually started, beside this script: the one place to look when a
# reviewer says it could not read a file.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "launch.log"),
          "a", encoding="utf-8") as log:
    log.write(json.dumps({{"real": REAL, "argv": out}}) + "\\n")
sys.exit(subprocess.call([REAL, *out]))
'''


def real_codex() -> str | None:
    """The Codex binary the launcher hands over to: FORGE_REVIEW_CODEX_BIN,
    then CODEX_BIN (the skill's own knob), then `codex` on PATH."""
    named = os.environ.get(CODEX_BIN_ENV) or os.environ.get("CODEX_BIN") or "codex"
    found = shutil.which(named)
    if found:
        return found
    return named if Path(named).is_file() else None


def codex_home() -> Path:
    home = os.environ.get("CODEX_HOME")
    return Path(home) if home else Path.home() / ".codex"


def codex_config_path() -> Path:
    return codex_home() / "config.toml"


def sandbox_home() -> str:
    """The CODEX_HOME that holds the Windows elevated-sandbox state, or ""."""
    if os.name != "nt":
        return ""
    home = codex_home()
    return str(home) if (home / ".sandbox").is_dir() else ""


def windows_sandbox_override() -> list[str]:
    """`-c windows.sandbox="<mode>"` when the user's Codex config sets one and
    this is Windows; empty otherwise. Read with a regex on purpose: the config
    is user-authored and a parse error must not stop a review."""
    if os.name != "nt":
        return []
    try:
        text = codex_config_path().read_text(encoding="utf-8")
    except OSError:
        return []
    table = re.search(r"^\[windows\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if not table:
        return []
    mode = re.search(r'^\s*sandbox\s*=\s*"([^"]+)"', table.group(1), re.M)
    return ["-c", f'windows.sandbox="{mode.group(1)}"'] if mode else []


def repo_readable(engine: str) -> tuple[bool, str]:
    """Whether this run can point the reviewer at the reviewed tree, and if
    not, why -- printed, so a review that fell back to the diff-only bundle
    says so instead of quietly guessing again."""
    if engine != "codex":
        return False, f"the {engine} engine runs where the skill puts it"
    if os.environ.get(EMPTY_WORKSPACE_ENV):
        return False, f"{EMPTY_WORKSPACE_ENV} is set"
    if real_codex() is None:
        return False, "codex is not on PATH (set CODEX_BIN)"
    return True, ""


def write_launcher(review_dir: Path, worktree: Path) -> Path:
    """Write the launcher beside (never inside) the worktree -- the skill
    refuses a binary that lives in the reviewed repository -- and return the
    path to hand to `--codex-bin`."""
    real = real_codex()
    if real is None:
        raise SystemExit("cannot write the review launcher: codex is not on PATH")
    bin_dir = review_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "codex_in_worktree.py"
    script.write_text(LAUNCHER.format(real=str(real), worktree=str(worktree),
                                      extra=windows_sandbox_override(),
                                      sandbox_home=sandbox_home()),
                      encoding="utf-8")
    if os.name == "nt":
        launcher = bin_dir / "codex.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        launcher = bin_dir / "codex"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n',
                            encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return launcher
