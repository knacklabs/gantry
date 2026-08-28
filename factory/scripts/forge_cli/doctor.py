"""forge doctor — machine prerequisites, with --fix auto-install."""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import re
import shlex
import shutil
import site
import stat
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from pathlib import Path

from factory_lib import decomposition_state_path, load_json, parse_sections, repo_root
from record_signoff import REQUIRED_BRIEF_HEADINGS

from .common import run_quiet
from .specs import missing_required_content, parse_frontmatter

DIRENV_VERSION = "2.37.1"
WINDOWS_GIT_PACKAGE = "Git.Git"
WINDOWS_PYTHON_PACKAGE = "Python.Python.3.14"
WINDOWS_INSTALL_TIMEOUT = 600
WINDOWS_INSTALL_FLAGS = (
    "--scope", "user", "--source", "winget", "--silent",
    "--accept-package-agreements", "--accept-source-agreements",
)
WINDOWS_LOCAL_APP_DATA = "f1b32785-6fba-4fcf-9d55-7b8e7f157091"
WINDOWS_PROGRAM_FILES = "905e63b6-c1bf-494e-b29c-65b732d3d21a"
WINDOWS_PROGRAM_FILES_X86 = "7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e"
WINDOWS_GIT_INSTALLER_URL = "https://git-scm.com/download/win"
WINDOWS_PYTHON_INSTALLER_URL = "https://www.python.org/downloads/windows/"

# Shell words that are not programs on PATH but are perfectly runnable.
SHELL_BUILTINS = {".", ":", "[", "cd", "echo", "eval", "exec", "exit", "export",
                  "false", "printf", "pwd", "set", "source", "test", "true",
                  "unset"}
# Openers of compound commands: the program is not token zero, and `bash -n`
# has already proved the whole thing parses.
SHELL_KEYWORDS = {"!", "(", "{", "case", "for", "if", "until", "while"}

def unrunnable_reason(command: str) -> str | None:
    """Why this verify_commands entry cannot execute, or None if it can.

    `stage done` RUNS these, so an entry whose program is not resolvable can
    never close its stage. Recording it is recording a gate that will always
    fail — which in practice meant it was prose ("package test script") that
    nobody ever tried to run. Checking at record time is the same standard,
    applied early enough to fix."""
    text = (command or "").strip()
    if not text:
        return "empty"
    # Syntax first: `git status |` resolves `git` and would otherwise pass here
    # only to fail forever at stage close with a shell parse error.
    # bash may be absent, or be the Windows System32 WSL relay stub, which
    # fails for ANY input -- sometimes with an EMPTY stderr, sometimes writing
    # its own relay error to stderr. Either way the probe itself is unusable,
    # so first confirm bash can parse a trivially valid script (":"); only a
    # bash that clears that check is trusted to judge `text`. Otherwise fall
    # through to the shlex+argv standard below rather than misreport valid
    # commands as invalid shell.
    def _bash_dash_n(script: str) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(["bash", "-n", "-c", script],
                                  capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        except OSError:
            return None

    probe = _bash_dash_n(":")
    if probe is not None and probe.returncode == 0:
        syntax = _bash_dash_n(text)
        if syntax is not None and syntax.returncode != 0 and syntax.stderr.strip():
            return f"is not valid shell ({syntax.stderr.strip().splitlines()[-1:]})"
    try:
        tokens = shlex.split(text)
    except ValueError as exc:                    # unbalanced quotes
        return f"is not parseable as a shell command ({exc})"
    # Skip leading VAR=value assignments: `FACTORY_TEST_CMD=x pytest` is fine.
    while tokens and "=" in tokens[0] and not tokens[0].startswith("="):
        tokens = tokens[1:]
    if not tokens:
        return "is only environment assignments, with no command to run"
    program = tokens[0]
    # Compound shell (`if ...; then pytest; fi`, `! pytest`, subshells) is valid
    # and its program is not token zero. bash -n already proved it parses; a
    # keyword opener means the runnability question is answered.
    if program in SHELL_KEYWORDS or program in SHELL_BUILTINS or shutil.which(program):
        return None
    return f"starts with {program!r}, which is not on PATH and is not a shell builtin"


# The runtimes that consume each skill group, and where each loads skills from.
SKILL_HOMES = {"claude": Path(".claude") / "skills", "codex": Path(".codex") / "skills"}
# Implementation guidance is consumed by both the coordinating and executing
# runtimes; review inputs are consumed by Codex's sole autoreview pass.
SKILL_GROUP_RUNTIMES = {
    "implementation": tuple(SKILL_HOMES),
    "review": ("codex",),
}


def skills_missing_per_runtime(base: Path, home: Path | None = None,
                               *, advisory: bool = False) -> list[tuple[str, str]]:
    """(runtime, skill) pairs a runtime cannot load for one requirement kind.

    Required groups back artifact attestations; advisory groups are reported
    without turning doctor into a gate."""
    try:
        from .delegate import skill_groups
    except ModuleNotFoundError as exc:
        if exc.name != "fcntl":
            raise
        return []

    home = home or Path.home()
    missing = []
    kind = "advisory" if advisory else "required"
    for phase, groups in skill_groups(base).items():
        for skill in groups[kind]:
            for runtime in SKILL_GROUP_RUNTIMES.get(phase, ()):
                rel = SKILL_HOMES[runtime]
                # A directory is not a skill: what a runtime LOADS is SKILL.md,
                # and a half-install must not report ready.
                if not (home / rel / skill / "SKILL.md").is_file():
                    missing.append((runtime, skill))
    return missing


def prose_verify_commands(base: Path) -> list[str]:
    """Migration report: active decompositions still carrying entries that
    cannot run. Shipped history is deliberately not scanned — it is evidence
    of what happened, not a gate that will fire again."""
    tasks = load_json(decomposition_state_path(base), default={}).get("tasks", [])
    found = []
    for task in tasks:
        for command in task.get("verify_commands") or []:
            reason = unrunnable_reason(str(command))
            if reason:
                found.append(f"{task.get('id', '?')}: {command!r} {reason}")
    return found


def legacy_required_tests(base: Path) -> list[str]:
    """Active task tests that predate the executable proof-object contract."""
    tasks = load_json(decomposition_state_path(base), default={}).get("tasks", [])
    found = []
    for task in tasks:
        for proof in task.get("required_tests") or []:
            if not isinstance(proof, dict) or set(proof) != {"id", "path", "command"}:
                found.append(f"{task.get('id', '?')}: {proof!r}")
    return found


def legacy_capture_gaps(base: Path) -> list[tuple[str, str]]:
    """Brief/spec capture gaps that predate the required-heading contract."""
    found = []
    brief = base / "docs" / "product" / "BRIEF.md"
    # A missing brief is the most incomplete a brief can be. Reporting only
    # briefs that exist made the one project that needs this line the one
    # project that never sees it, while sign-off refuses it either way.
    sections = parse_sections(brief.read_text(encoding="utf-8")) if brief.is_file() else {}
    missing = [heading for heading in REQUIRED_BRIEF_HEADINGS
               if not sections.get(heading, "").strip()]
    if missing:
        found.append(("brief", f"docs/product/BRIEF.md: {', '.join(missing)}"))

    specs = base / "docs" / "specs"
    for spec in sorted(specs.glob("*.md")) if specs.is_dir() else []:
        document = spec.read_text(encoding="utf-8")
        if parse_frontmatter(document).get("status") != "confirmed":
            continue
        missing = missing_required_content(document)
        if missing:
            found.append(("spec", f"{spec.relative_to(base)}: {', '.join(missing)}"))
    return found


def report_legacy_capture_gaps(base: Path) -> None:
    for kind, detail in legacy_capture_gaps(base):
        print(f"[opt ] capture/{kind:<5} {detail}")


def legacy_roadmap_gaps(base: Path) -> list[tuple[str, str]]:
    """Stored hierarchy gaps that legacy roadmap routes deliberately tolerate."""
    path = base / "plans" / "roadmap.json"
    if not path.is_file():
        from .project import has_discovery_material

        if has_discovery_material(base):
            return [(
                "roadmap",
                "plans/roadmap.json: absent despite discovery material; author it "
                "with forge roadmap derive or forge roadmap epic add plus forge roadmap add",
            )]
        return []

    # Defensive on purpose: doctor is what someone runs when the project is
    # ALREADY broken, so a roadmap that is null, a list, or holds a non-object
    # item must produce a report rather than a traceback. Crashing here takes
    # doctor's other checks down with it, at exactly the moment they are what
    # is being asked for.
    roadmap = load_json(path, default={})
    if not isinstance(roadmap, dict):
        return [("shape", "plans/roadmap.json: not a JSON object")]
    found = []
    if not roadmap.get("epics"):
        found.append(("epics", "plans/roadmap.json: no epics declared"))
    items = roadmap.get("items")
    if items is not None and not isinstance(items, list):
        return [*found, ("shape", "plans/roadmap.json: 'items' is not a list")]
    for position, item in enumerate(items or [], 1):
        if not isinstance(item, dict):
            found.append(("shape", f"item {position}: not an object"))
            continue
        if not item.get("epic"):
            found.append(("story", f"{item.get('key', '?')}: no epic declared"))
        if (item.get("status") == "done" and not item.get("outcome")
                and item.get("predates_outcome_contract") is not True):
            found.append((
                "outcome",
                f"{item.get('key', '?')}: done without an outcome or "
                "predates_outcome_contract marker",
            ))
    return found


def report_legacy_roadmap_gaps(base: Path) -> None:
    for kind, detail in legacy_roadmap_gaps(base):
        print(f"[opt ] roadmap/{kind:<5} {detail}")


def _check(name: str, ok: bool, detail: str, fix: str, required: bool = True) -> dict:
    return {"name": name, "ok": ok, "detail": detail, "fix": fix, "required": required}


def _display_mark(check: dict) -> str:
    if check["ok"]:
        return "OK "
    if check["name"].startswith("hook-health "):
        return "RED"
    return "MISS" if check["required"] else "opt "


HOOK_CONFIGS = (Path(".claude/settings.json"), Path(".codex/hooks.json"))
HOOK_HEALTH_FIX = (
    "restore missing `forge`/factory scripts, or run `./forge doctor --fix` "
    "to install Python 3.10+, then rerun doctor"
)
HOOK_SHELL_FIX = (
    "install Git for Windows (Git Bash provides sh), then rerun doctor"
)


def _hook_shell_candidates(env: dict[str, str]) -> list[str]:
    """Git Bash launchers in the same order the hook runtimes can discover them."""
    candidates = []
    configured = env.get("CLAUDE_CODE_GIT_BASH_PATH")
    if configured:
        candidates.append(configured)
    on_path = shutil.which("sh", path=env.get("PATH"))
    if on_path:
        candidates.append(on_path)
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        root = env.get(variable)
        if not root:
            continue
        git_root = Path(root) / ("Programs/Git" if variable == "LOCALAPPDATA" else "Git")
        candidates.extend(str(git_root / relative) for relative in (
            "bin/bash.exe", "usr/bin/bash.exe", "usr/bin/sh.exe",
        ))
    return list(dict.fromkeys(candidates))


def _existing_hook_shell(env: dict[str, str]) -> str | None:
    return next((candidate for candidate in _hook_shell_candidates(env)
                 if Path(candidate).is_file()), None)


def _runnable_hook_shell(env: dict[str, str], base: Path | None = None) -> str | None:
    """Probe candidates before committing; WSL cannot read a Windows checkout path."""
    for candidate in _hook_shell_candidates(env):
        if not Path(candidate).is_file():
            continue
        # `-n` makes the candidate open and parse the actual launcher without
        # needing Python. Git Bash accepts the Windows checkout path; WSL does
        # not. The subsequent health rows execute every command for real.
        command = ([candidate, "-n", str(base / "forge")]
                   if base is not None else [candidate, "-c", "exit 0"])
        try:
            probe = subprocess.run(
                command, cwd=base, capture_output=True, env=env, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if probe.returncode == 0:
            return candidate
    return None


def fast_hook_status(base: Path | None = None) -> tuple[bool, str]:
    """Check hook launcher prerequisites without spawning a subprocess."""
    if base is not None:
        required = (Path("forge"), Path("factory/scripts/forge.py"), *HOOK_CONFIGS)
        for relative in required:
            if not (base / relative).is_file():
                return False, f"{relative} is missing"
        if os.name != "nt" and not os.access(base / "forge", os.X_OK):
            return False, "forge is not executable"
    shell = _existing_hook_shell(dict(os.environ))
    if not shell:
        return False, "sh is not on PATH (install Git for Windows)"
    interpreter = (
        shutil.which("py") or shutil.which("python3") or shutil.which("python")
    )
    if not interpreter:
        return False, "py/python3/python is not on PATH"
    return True, f"{shell} + {interpreter}"


def _hook_health_payload(event: str) -> str:
    """Harmless synthetic stdin matching the registered hook event."""
    payload: dict[str, object] = {"hook_event_name": event}
    if event == "PreToolUse":
        payload.update({
            "tool_name": "Bash",
            "tool_input": {"command": ":"},
            "permission_mode": "default",
        })
    elif event == "SessionStart":
        payload["source"] = "startup"
    elif event == "PreCompact":
        payload["trigger"] = "manual"
    elif event == "Stop":
        payload["stop_hook_active"] = True
    return json.dumps(payload)


def hook_health_checks(base: Path, *, env: dict[str, str] | None = None) -> list[dict]:
    """Execute every registered hook exactly as its runtime will execute it."""
    checks = []
    run_env = {
        **os.environ,
        **(env or {}),
        "FACTORY_HOOK_HEALTH": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    shell = _runnable_hook_shell(run_env, base)
    shell_exists = _existing_hook_shell(run_env) is not None
    if shell:
        shell_dir = str(Path(shell).parent)
        run_env["PATH"] = shell_dir + os.pathsep + run_env.get("PATH", "")

    for relative in HOOK_CONFIGS:
        path = base / relative
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            hooks = document.get("hooks") if isinstance(document, dict) else None
            if not isinstance(hooks, dict):
                raise ValueError("top-level 'hooks' must be an object")
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            checks.append(_check(
                f"hook-health {relative}", False, str(exc), HOOK_HEALTH_FIX,
            ))
            continue

        for event, registrations in hooks.items():
            if not isinstance(registrations, list):
                checks.append(_check(
                    f"hook-health {relative}:{event}", False,
                    "hook registrations must be a list", HOOK_HEALTH_FIX,
                ))
                continue
            for registration_index, registration in enumerate(registrations, 1):
                if not isinstance(registration, dict):
                    checks.append(_check(
                        f"hook-health {relative}:{event}[{registration_index}]",
                        False, "hook registration must be an object", HOOK_HEALTH_FIX,
                    ))
                    continue
                registered_hooks = registration.get("hooks")
                if not isinstance(registered_hooks, list):
                    checks.append(_check(
                        f"hook-health {relative}:{event}[{registration_index}]",
                        False, "registered hooks must be a list", HOOK_HEALTH_FIX,
                    ))
                    continue
                for hook_index, hook in enumerate(registered_hooks, 1):
                    if not isinstance(hook, dict):
                        checks.append(_check(
                            f"hook-health {relative}:{event}"
                            f"[{registration_index}.{hook_index}]",
                            False, "hook must be an object", HOOK_HEALTH_FIX,
                        ))
                        continue
                    command = hook.get("command")
                    if hook.get("type") != "command":
                        continue
                    name = (
                        f"hook-health {relative}:{event}"
                        f"[{registration_index}.{hook_index}]"
                    )
                    if not isinstance(command, str) or not command.strip():
                        checks.append(_check(
                            name, False, "command hook has no command", HOOK_HEALTH_FIX,
                        ))
                        continue
                    if not shell:
                        detail = (
                            f"{command} -> hook launcher probe failed"
                            if shell_exists else f"{command} -> sh is not on PATH"
                        )
                        checks.append(_check(
                            name, False, detail,
                            HOOK_HEALTH_FIX if shell_exists else HOOK_SHELL_FIX,
                        ))
                        continue
                    try:
                        result = subprocess.run(
                            [shell, "-c", command],
                            cwd=base,
                            input=_hook_health_payload(event),
                            capture_output=True,
                            text=True,
                            env=run_env,
                            timeout=30, encoding="utf-8", errors="replace",
                        )
                        output = (result.stdout + result.stderr).strip()
                        detail = command
                        if result.returncode != 0:
                            suffix = f": {output[-240:]}" if output else ""
                            semantics = (
                                " (blocking)" if result.returncode == 2
                                else " (invalid hook exit; expected 0 or 2)"
                            )
                            detail = (
                                f"{command} -> exit {result.returncode}{semantics}{suffix}"
                            )
                        checks.append(_check(
                            name, result.returncode == 0, detail, HOOK_HEALTH_FIX,
                        ))
                    except (OSError, subprocess.TimeoutExpired) as exc:
                        checks.append(_check(
                            name, False, f"{command} -> {exc}", HOOK_HEALTH_FIX,
                        ))
    return checks


# Shared install locations — fast_status() and cmd_doctor() must agree on
# where things live, or the session banner and full doctor drift apart.
def _codex_plugin_dir(home: Path) -> Path:
    return home / ".claude" / "plugins" / "cache" / "openai-codex" / "codex"


def _gstack_dir(home: Path) -> Path:
    return home / ".claude" / "skills" / "gstack"


def _autoreview_dir(home: Path) -> Path:
    return home / ".codex" / "skills" / "autoreview"


def _python_candidates() -> list[tuple[str, tuple[str, ...]]]:
    candidates = []
    for name, launcher_args in (("py", ("-3",)), ("python3", ()), ("python", ())):
        binary = shutil.which(name)
        if binary:
            candidates.append((binary, launcher_args))
    return candidates


def _python_status() -> tuple[bool, str]:
    candidates = _python_candidates()
    if not candidates:
        return False, "py -3 / python3 / python is not on PATH"
    detail = ""
    for binary, launcher_args in candidates:
        try:
            result = subprocess.run(
                [binary, *launcher_args, "--version"],
                capture_output=True, text=True, timeout=5,
                encoding="utf-8", errors="replace",
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            detail = f"{binary}: {exc}"
            continue
        output = (result.stdout + result.stderr).strip()
        match = re.search(r"Python\s+(\d+)\.(\d+)(?:\.(\d+))?", output)
        if result.returncode == 0 and match:
            version = tuple(int(part or 0) for part in match.groups())
            detail = f"{binary}: {match.group(0)}"
            if version >= (3, 10, 0):
                return True, detail
            continue
        detail = f"{binary}: {output or f'exit {result.returncode}'}"
    return False, detail


def _python_check() -> dict:
    ok, detail = _python_status()
    return _check(
        "python >= 3.10", ok, detail,
        "install Python 3.10+ (https://www.python.org/downloads/)",
    )


def _user_home() -> Path | None:
    """The current user's home directory, resolved. USERPROFILE on Windows,
    HOME on Unix, falling back to Path.home()."""
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if not home:
        try:
            home = str(Path.home())
        except (RuntimeError, OSError):
            return None
    try:
        return Path(home).resolve()
    except (OSError, ValueError):
        return None


def _under_user_home(path: Path) -> bool:
    """True when `path` lives under the current user's home directory — the
    region a filesystem-restricted Codex sandbox is least likely to grant (on
    Windows it is actively hidden; on macOS/Linux it need not be in the sandbox
    read roots)."""
    home = _user_home()
    if home is None:
        return False
    try:
        return path.resolve().is_relative_to(home)
    except (OSError, ValueError):
        return False


def _discoverable_interpreters() -> list[tuple[tuple[int, int], Path]]:
    """(version, real sys.executable) for every Python the host — and thus the
    Codex sandbox, via the system PATH — might resolve. Resolves launchers to
    their real interpreter (a `py -3` lives in a machine dir but execs a
    home-scoped python), and on Windows also enumerates ALL installs via
    `py -0p` so a machine interpreter that `py -3` does not default to still
    counts."""
    found: dict[str, tuple[int, int]] = {}
    for binary, launcher_args in _python_candidates():
        code, output = run_quiet([
            binary, *launcher_args, "-c",
            "import sys;print(sys.version_info[0],sys.version_info[1]);"
            "print(sys.executable)",
        ])
        lines = output.splitlines()
        if code != 0 or len(lines) < 2 or not lines[1].strip():
            continue
        try:
            version = (int(lines[0].split()[0]), int(lines[0].split()[1]))
        except (ValueError, IndexError):
            continue
        found[str(Path(lines[1].strip()))] = version
    if os.name == "nt":
        code, output = run_quiet(["py", "-0p"])
        if code == 0:
            for line in output.splitlines():
                match = re.match(
                    r"\s*-V:(\d+)\.(\d+)\S*\s+\*?\s*(.+\S)\s*$", line)
                if match:
                    found[str(Path(match.group(3)))] = (
                        int(match.group(1)), int(match.group(2)))
    return [(version, Path(path)) for path, version in found.items()]


def _codex_sandbox_python_check() -> dict:
    """Codex runs delegated implementation in a filesystem-restricted sandbox.
    On Windows it runs as a SEPARATE user with the caller's profile hidden; on
    macOS/Linux the seatbelt/landlock sandbox likewise need not grant the user's
    HOME. So a Python installed under the user's home — Windows
    AppData\\Local\\Programs\\Python, or a pyenv (~/.pyenv), ~/.local, or conda
    interpreter on Unix — can be unreachable inside the sandbox, making
    `./forge` (and the `.codex` `pre_tool_use` hook that shells out to it) fail
    INSIDE delegated Codex runs even though host doctor is green (the host
    resolves the home-scoped interpreter fine). Advisory only (opt), all OSes:
    non-blocking for host-side forge use, but flagged because a green host must
    not mask a broken worker. A system/machine interpreter (C:\\Program Files,
    /usr/bin, /opt/homebrew, /usr/local) sits outside HOME and passes.
    """
    name = "codex-sandbox python"
    usable = [
        (version, path) for version, path in _discoverable_interpreters()
        if version >= (3, 10)
    ]
    if not usable:
        # The hard `python >= 3.10` row already reports the absence.
        return _check(name, True, "deferred to the python >= 3.10 check", "",
                      required=False)
    reachable = [path for version, path in usable if not _under_user_home(path)]
    if reachable:
        return _check(name, True,
                      f"{reachable[0]} is outside the user home (sandbox-reachable)",
                      "", required=False)
    home_bound = ", ".join(str(path) for _, path in usable[:2])
    if os.name == "nt":
        fix = (f"install Python 3.10+ MACHINE-WIDE so the sandbox user can reach "
               f"it: `winget install --id {WINDOWS_PYTHON_PACKAGE} --scope "
               "machine` (elevated), or grant the Codex sandbox read access to "
               "the interpreter's directory")
    else:
        fix = ("use a system/machine Python outside your home (the OS package "
               "manager's python3, or Homebrew under /opt/homebrew or "
               "/usr/local), or grant the Codex sandbox read access to the "
               "interpreter's directory")
    return _check(
        name, False,
        f"every Python >=3.10 is under the user home ({home_bound}) — the Codex "
        "sandbox may not reach it, so `./forge` can fail inside delegated runs",
        fix, required=False,
    )


def _psutil_discoverable() -> bool:
    return importlib.util.find_spec("psutil") is not None


def _psutil_import_status() -> tuple[bool, str]:
    try:
        importlib.import_module("psutil")
    except Exception as exc:
        return False, f"import failed: {type(exc).__name__}: {exc}"
    return True, f"importable by {sys.executable}"


def _psutil_install_command() -> list[str]:
    command = [sys.executable, "-m", "pip", "install"]
    if sys.prefix == sys.base_prefix:
        command.append("--user")
    return [*command, "psutil"]


def _psutil_fix_message() -> str:
    scope = "" if sys.prefix != sys.base_prefix else " --user"
    return (
        f"`{sys.executable} -m pip install{scope} psutil` (manual `pip install "
        "psutil` fallback); if Python is externally managed, install psutil "
        "for this interpreter with your OS package manager or run Forge from "
        "a user-managed Python environment — never use --break-system-packages"
    )


def _install_psutil() -> tuple[bool, str]:
    command = _psutil_install_command()
    scope = "virtualenv" if sys.prefix != sys.base_prefix else "user scope"
    print(f"[fix ] installing psutil for {sys.executable} ({scope}) ...")
    code, output = run_quiet(command)
    if code != 0:
        normalized = output.lower()
        if ("externally-managed-environment" in normalized
                or "externally managed" in normalized):
            return False, (
                f"{sys.executable} is externally managed and refused the "
                "psutil install"
            )
        return False, output or f"pip exited {code}"
    if sys.prefix == sys.base_prefix:
        site.addsitedir(site.getusersitepackages())
        importlib.invalidate_caches()
    ok, detail = _psutil_import_status()
    if not ok:
        return False, f"pip exited successfully but psutil {detail}"
    return True, detail


def _psutil_check(*, fix: bool = False) -> dict:
    ok, detail = _psutil_import_status()
    if not ok and fix:
        ok, detail = _install_psutil()
    return _check("psutil", ok, detail, _psutil_fix_message())


def fast_status(home: Path | None = None) -> tuple[list[str], list[str]]:
    """Millisecond SessionStart check: lookups/existence only, no subprocesses.
    Returns (required_missing, advisory_missing). A fresh clone after
    `git pull` gets told its machine is not ready at the FIRST session,
    not at the first mid-task failure."""
    home = home or Path.home()
    required = {
        "git": shutil.which("git") is not None,
        # Optimistic, subprocess-free hook heuristic; _python_check is the
        # authoritative version check used by doctor.
        "python >= 3.10": sys.version_info >= (3, 10) or any(
            shutil.which(name) for name in ("py", "python3", "python")
        ),
        "psutil": _psutil_discoverable(),
        "node": shutil.which("node") is not None,
        "direnv + shell hook": shutil.which("direnv") is not None and _has_direnv_hook(home),
        "codex CLI": shutil.which("codex") is not None,
        "claude CLI": shutil.which("claude") is not None,
        "codex-plugin-cc": _codex_plugin_dir(home).is_dir(),
        "gstack skills": _gstack_dir(home).is_dir(),
        "autoreview skill": _autoreview_dir(home).is_dir(),
        "grill-me skill": (home / ".claude" / "skills" / "grill-me").is_dir(),
    }
    advisory = {
        "frontend-design skill": (home / ".claude" / "skills" / "frontend-design").is_dir(),
        "emil-design-eng skill": (home / ".claude" / "skills" / "emil-design-eng").is_dir(),
    }
    return ([k for k, ok in required.items() if not ok],
            [k for k, ok in advisory.items() if not ok])


def _github_slug(repo: str | None = None) -> str:
    # Inline (not run_quiet) so the branch-protection lookup can target the
    # --repo checkout via cwd rather than the process's working directory.
    try:
        proc = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=15, cwd=repo,
            encoding="utf-8", errors="replace",
        )
        code, out = proc.returncode, (proc.stdout + proc.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        code, out = 1, str(exc)
    if code != 0:
        return ""
    url = out.strip()
    for prefix in ("git@github.com:", "https://github.com/", "ssh://git@github.com/"):
        if url.startswith(prefix):
            return url.removeprefix(prefix).removesuffix(".git")
    return ""


def _merge_check_status(*, fix: bool, repo: str | None = None) -> tuple[bool, str] | None:
    """Is `scaffold-check` a required status check on the default branch?

    Returns None when the question cannot be answered (no gh, no GitHub
    remote, offline, unauthenticated) — an unanswerable advisory check is
    noise, not signal. The fix path is deliberately non-destructive: it PUTs
    a minimal rule only when NO protection exists, and otherwise ADDs the
    context to the existing required checks, never overwriting reviewer
    requirements or other rules an admin configured.
    """
    if shutil.which("gh") is None:
        return None
    slug = _github_slug(repo)
    if not slug:
        return None
    code, out = run_quiet(["gh", "api", f"repos/{slug}", "--jq", ".default_branch"])
    if code != 0:
        return None  # offline or unauthenticated — cannot answer
    default = out.strip()
    checks_url = f"repos/{slug}/branches/{default}/protection/required_status_checks"

    def contexts() -> tuple[list[str] | None, bool]:
        """(contexts, definitive): None contexts = no required checks set."""
        code, out = run_quiet(["gh", "api", checks_url, "--jq", ".contexts[]"])
        if code == 0:
            return out.split(), True
        if "Branch not protected" in out or "Not Found" in out:
            return None, True
        return None, False

    current, definitive = contexts()
    if not definitive:
        return None
    if current is not None and "scaffold-check" in current:
        return True, f"{slug}@{default}"
    if fix:
        if current is None:
            print(f"[fix ] protecting {default}: scaffold-check required to merge ...")
            payload = json.dumps({
                "required_status_checks": {"strict": False,
                                           "contexts": ["scaffold-check"]},
                "enforce_admins": False,
                "required_pull_request_reviews": None,
                "restrictions": None,
            })
            proc = subprocess.run(
                ["gh", "api", "-X", "PUT",
                 f"repos/{slug}/branches/{default}/protection", "--input", "-"],
                input=payload, capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace")
            if proc.returncode != 0:
                return False, f"fix failed (admin rights?): {proc.stderr.strip()[:120]}"
        else:
            print(f"[fix ] adding scaffold-check to {default}'s required checks ...")
            proc = subprocess.run(
                ["gh", "api", "-X", "POST", f"{checks_url}/contexts",
                 "--input", "-"],
                input=json.dumps(["scaffold-check"]),
                capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace")
            if proc.returncode != 0:
                return False, f"fix failed (admin rights?): {proc.stderr.strip()[:120]}"
        current, definitive = contexts()
        if definitive and current is not None and "scaffold-check" in current:
            return True, f"{slug}@{default}"
        return False, "fix applied but verification failed"
    detail = ("no branch protection" if current is None
              else "protected, but scaffold-check is not required")
    return False, f"{slug}@{default}: {detail}"


def _platform_name() -> str:
    system = platform.system().lower()

    if system == "windows":
        return "windows"

    # Git Bash/MSYS may report Windows through platform.system(), but keep
    # this fallback for unusual Python builds.
    msystem = os.environ.get("MSYSTEM", "").upper()
    if msystem.startswith(("MINGW", "MSYS", "CYGWIN")):
        return "windows"

    if system == "darwin":
        return "macos"

    if system == "linux":
        return "linux"

    return "unknown"


def _current_shell() -> str:
    shell = Path(os.environ.get("SHELL", "")).name.lower()

    if shell in {"bash", "zsh"}:
        return shell

    # Git Bash often does not populate SHELL consistently.
    if os.environ.get("MSYSTEM"):
        return "bash"

    return "bash"


def _shell_rc(home: Path, shell: str) -> Path:
    return home / (".zshrc" if shell == "zsh" else ".bashrc")


def _hook_line(shell: str) -> str:
    return f'eval "$(direnv hook {shell})"'


def _has_direnv_hook(home: Path) -> bool:
    for rc in (home / ".zshrc", home / ".bashrc"):
        if rc.exists():
            try:
                if "direnv hook" in rc.read_text(encoding="utf-8"):
                    return True
            except OSError:
                pass
    return False


def _append_direnv_hook(home: Path) -> bool:
    shell = _current_shell()
    rc = _shell_rc(home, shell)
    line = _hook_line(shell)

    try:
        existing = rc.read_text(encoding="utf-8") if rc.exists() else ""
        if line not in existing:
            with rc.open("a", encoding="utf-8") as fh:
                fh.write(
                    "\n# direnv (symphony-forge: project-local GSTACK_HOME via .envrc)\n"
                    f"{line}\n"
                )
            print(f"[fix ] added direnv hook to {rc}")
        return True
    except OSError as exc:
        print(f"[warn] could not update {rc}: {exc}")
        return False


def _prepend_user_bin_to_path(home: Path) -> Path:
    user_bin = home / "bin"
    user_bin.mkdir(parents=True, exist_ok=True)

    current = os.environ.get("PATH", "")
    entries = current.split(os.pathsep) if current else []
    user_bin_str = str(user_bin)

    if user_bin_str not in entries:
        os.environ["PATH"] = user_bin_str + os.pathsep + current

    return user_bin


def _prepend_existing_paths(paths: list[Path]) -> None:
    current = os.environ.get("PATH", "")
    entries = current.split(os.pathsep) if current else []
    additions = [
        str(path) for path in paths
        if path.is_dir() and str(path) not in entries
    ]
    if additions:
        os.environ["PATH"] = os.pathsep.join([*additions, *entries])


def _refresh_windows_path() -> None:
    candidates: list[Path] = []
    local = _windows_known_folder(WINDOWS_LOCAL_APP_DATA)
    if local:
        candidates.extend([
            local / "Programs" / "Git" / "cmd",
            local / "Programs" / "Python" / "Python314",
            local / "Programs" / "Python" / "Python314" / "Scripts",
            local / "Programs" / "Python" / "Launcher",
            local / "Microsoft" / "WinGet" / "Links",
            local / "Microsoft" / "WindowsApps",
        ])
    program_files_roots = [
        Path(root) for variable in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)")
        if (root := os.environ.get(variable))
    ]
    program_files_roots.extend(
        folder for folder_id in (WINDOWS_PROGRAM_FILES, WINDOWS_PROGRAM_FILES_X86)
        if (folder := _windows_known_folder(folder_id))
    )
    for program_files in program_files_roots:
        candidates.extend([
            program_files / "Git" / "cmd",
            program_files / "Python314",
            program_files / "Python314" / "Scripts",
        ])
    _prepend_existing_paths(candidates)


def _winget_user_install(
    winget: str, package_id: str, label: str, manual_url: str,
) -> dict | None:
    print(f"[fix ] installing {label} with winget (user scope) ...")
    try:
        result = subprocess.run(
            [winget, "install", "--id", package_id, "--exact", *WINDOWS_INSTALL_FLAGS],
            capture_output=True, text=True, timeout=WINDOWS_INSTALL_TIMEOUT,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[warn] winget failed while installing {label}: {exc}")
        return _check(
            f"{label} user-scope install", False,
            f"winget could not install {label}: {exc}; manual installer: {manual_url}",
            f"install {label} manually from {manual_url}",
        )
    if result.returncode == 0:
        return None
    output = (result.stdout + result.stderr).strip()
    print(f"[warn] winget could not install {label} in user scope.")
    return _check(
        f"{label} user-scope install", False,
        f"winget exited {result.returncode}"
        f"{f': {output}' if output else ''}; manual installer: {manual_url}",
        f"install {label} manually from {manual_url}",
    )


def _install_git_windows(winget: str) -> dict | None:
    return _winget_user_install(
        winget, WINDOWS_GIT_PACKAGE, "Git for Windows", WINDOWS_GIT_INSTALLER_URL,
    )


def _install_python_windows(winget: str) -> dict | None:
    return _winget_user_install(
        winget, WINDOWS_PYTHON_PACKAGE, "Python 3.14", WINDOWS_PYTHON_INSTALLER_URL,
    )


def _windows_known_folder(folder_id: str) -> Path | None:
    """Read a Windows known folder without trusting process environment."""
    if _platform_name() != "windows":
        return None

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_ulong),
            ("Data2", ctypes.c_ushort),
            ("Data3", ctypes.c_ushort),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    value = uuid.UUID(folder_id)
    guid = GUID(
        value.time_low, value.time_mid, value.time_hi_version,
        (ctypes.c_ubyte * 8)(*value.bytes[8:]),
    )
    path_pointer = ctypes.c_wchar_p()
    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32
    shell32.SHGetKnownFolderPath.argtypes = [
        ctypes.POINTER(GUID), ctypes.c_ulong, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_wchar_p),
    ]
    shell32.SHGetKnownFolderPath.restype = ctypes.c_long
    result = shell32.SHGetKnownFolderPath(
        ctypes.byref(guid), 0, None, ctypes.byref(path_pointer),
    )
    if result != 0:
        return None
    try:
        return Path(path_pointer.value) if path_pointer.value else None
    finally:
        ole32.CoTaskMemFree(path_pointer)


def _trusted_user_winget_path() -> str | None:
    local_app_data = _windows_known_folder(WINDOWS_LOCAL_APP_DATA)
    if local_app_data and local_app_data.is_absolute():
        alias = local_app_data / "Microsoft" / "WindowsApps" / "winget.exe"
        try:
            # App Execution Aliases are APPEXECLINK reparse points. Resolving
            # one raises WinError 1920, so trust this API-derived identity
            # without following it. Ordinary symlinks are not accepted.
            if os.path.lexists(alias) and not alias.is_symlink():
                return str(alias)
        except OSError:
            pass

    return None


def _windows_process_is_elevated() -> bool:
    if _platform_name() != "windows":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return True


def _elevated_windows_remediation_check() -> dict:
    return _check(
        "elevated Windows prerequisite remediation", False,
        "refusing Windows auto-remediation from an elevated process because "
        "per-user install paths are user-writable",
        "run 'forge doctor --fix' from a normal (unelevated) prompt, or "
        f"install Git manually from {WINDOWS_GIT_INSTALLER_URL} and Python "
        f"manually from {WINDOWS_PYTHON_INSTALLER_URL}",
    )


def _remediate_windows_prerequisites(*, install_git: bool, install_python: bool) -> list[dict]:
    if _windows_process_is_elevated():
        return [_elevated_windows_remediation_check()]

    rows: list[dict] = []
    git_install_error: dict | None = None
    python_install_error: dict | None = None
    winget: str | None = None
    try:
        winget = _trusted_user_winget_path()
        if not winget:
            rows.append(_check(
                "winget for Windows prerequisites", False,
                "winget is absent or outside its trusted WindowsApps/App Installer roots; "
                f"install Git from {WINDOWS_GIT_INSTALLER_URL} and Python 3.10+ from "
                f"{WINDOWS_PYTHON_INSTALLER_URL}",
                "install App Installer/winget, or use the named manual installer URLs",
            ))
        else:
            if install_git:
                git_install_error = _install_git_windows(winget)
            if install_python:
                python_install_error = _install_python_windows(winget)
    finally:
        # Named refusals and partial installs must converge in the same run.
        _refresh_windows_path()
        git_ok = shutil.which("git") is not None
        python_ok = _python_check()["ok"]

        # The refreshed probes are authoritative. winget can return nonzero
        # for an already-installed package while the tool is now usable.
        if git_ok and python_ok:
            rows.clear()
        elif winget:
            if git_install_error and not git_ok:
                rows.append(git_install_error)
            elif install_git and not git_ok:
                rows.append(_check(
                    "Git for Windows installed but not found", False,
                    "winget exited successfully, but Git was still absent after "
                    "refreshing PATH",
                    f"install Git manually from {WINDOWS_GIT_INSTALLER_URL}",
                ))
            if python_install_error and not python_ok:
                rows.append(python_install_error)
            elif install_python and not python_ok:
                rows.append(_check(
                    "Python 3.14 installed but not found", False,
                    "winget exited successfully, but Python 3.10+ was still absent "
                    "after refreshing PATH",
                    f"install Python manually from {WINDOWS_PYTHON_INSTALLER_URL}",
                ))
    return rows


def _install_direnv_windows(home: Path) -> bool:
    user_bin = _prepend_user_bin_to_path(home)
    target = user_bin / "direnv.exe"
    temp_target = user_bin / "direnv.exe.download"

    url = (
        "https://github.com/direnv/direnv/releases/download/"
        f"v{DIRENV_VERSION}/direnv.windows-amd64"
    )

    print(f"[fix ] installing direnv {DIRENV_VERSION} for Windows Git Bash ...")

    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "symphony-forge-doctor"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            with temp_target.open("wb") as fh:
                shutil.copyfileobj(response, fh)

        # A valid Windows binary is several MB. This rejects HTML/404 text.
        if temp_target.stat().st_size < 1_000_000:
            raise RuntimeError(
                f"downloaded file is unexpectedly small ({temp_target.stat().st_size} bytes)"
            )

        temp_target.replace(target)
        target.chmod(target.stat().st_mode | stat.S_IEXEC)
        print(f"[fix ] installed direnv at {target}")
        return True
    except Exception as exc:
        print(f"[warn] failed to install direnv automatically: {exc}")
        try:
            temp_target.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def _install_direnv_macos() -> bool:
    brew = shutil.which("brew")
    if not brew:
        print("[warn] Homebrew is required to auto-install direnv on macOS.")
        return False

    print("[fix ] installing direnv with Homebrew ...")
    code, _ = run_quiet([brew, "install", "direnv"])
    return code == 0


def _install_direnv_linux() -> bool:
    installers: list[tuple[list[str], str]] = []

    if shutil.which("apt-get"):
        prefix = [] if os.geteuid() == 0 else (["sudo"] if shutil.which("sudo") else [])
        if prefix or os.geteuid() == 0:
            installers.append((prefix + ["apt-get", "update"], "apt-get update"))
            installers.append((prefix + ["apt-get", "install", "-y", "direnv"], "apt-get"))
    elif shutil.which("dnf"):
        prefix = [] if os.geteuid() == 0 else (["sudo"] if shutil.which("sudo") else [])
        if prefix or os.geteuid() == 0:
            installers.append((prefix + ["dnf", "install", "-y", "direnv"], "dnf"))
    elif shutil.which("yum"):
        prefix = [] if os.geteuid() == 0 else (["sudo"] if shutil.which("sudo") else [])
        if prefix or os.geteuid() == 0:
            installers.append((prefix + ["yum", "install", "-y", "direnv"], "yum"))
    elif shutil.which("pacman"):
        prefix = [] if os.geteuid() == 0 else (["sudo"] if shutil.which("sudo") else [])
        if prefix or os.geteuid() == 0:
            installers.append((prefix + ["pacman", "-Sy", "--noconfirm", "direnv"], "pacman"))

    if not installers:
        print("[warn] no supported Linux package manager or sudo access found for direnv.")
        return False

    print("[fix ] installing direnv with the system package manager ...")
    for command, label in installers:
        code, _ = run_quiet(command)
        if code != 0:
            print(f"[warn] {label} failed while installing direnv.")
            return False

    return True


def _install_direnv(home: Path) -> bool:
    target_platform = _platform_name()

    if target_platform == "windows":
        installed = _install_direnv_windows(home)
    elif target_platform == "macos":
        installed = _install_direnv_macos()
    elif target_platform == "linux":
        installed = _install_direnv_linux()
    else:
        print("[warn] unsupported platform for automatic direnv installation.")
        return False

    if not installed:
        return False

    # shutil.which reads the current PATH. Windows user-local installation
    # updates PATH in-process through _prepend_user_bin_to_path().
    return shutil.which("direnv") is not None


def _direnv_fix_message() -> str:
    target_platform = _platform_name()

    if target_platform == "windows":
        return (
            "install direnv.exe in ~/bin, add `eval \"$(direnv hook bash)\"` "
            "to ~/.bashrc, reopen Git Bash, then run `direnv allow`"
        )

    if target_platform == "macos":
        shell = _current_shell()
        rc = "~/.zshrc" if shell == "zsh" else "~/.bashrc"
        return (
            f"`brew install direnv` + `eval \"$(direnv hook {shell})\"` in {rc}, "
            "then `direnv allow`"
        )

    return (
        "install direnv with your Linux package manager, add the matching "
        "`eval \"$(direnv hook <shell>)\"` line to your shell rc file, "
        "then run `direnv allow`"
    )


def _git_fix_message() -> str:
    if _platform_name() == "windows":
        return (
            "run `./forge doctor --fix`, or install Git for Windows manually from "
            "https://git-scm.com/download/win"
        )
    return "https://git-scm.com — or `xcode-select --install` on macOS"


def cmd_doctor(args: argparse.Namespace) -> None:
    home = Path.home()
    if getattr(args, "fast", False):
        required_missing, advisory_missing = fast_status(home)
        for name in required_missing:
            print(f"[MISS] {name}")
        for name in advisory_missing:
            print(f"[opt ] {name}")
        if required_missing:
            print(f"\nforge doctor --fast: {len(required_missing)} required tool(s) "
                  "missing — run `./forge doctor --fix` (only logins stay manual).")
            raise SystemExit(1)
        print("forge doctor --fast: machine ready"
              + (f" ({len(advisory_missing)} advisory missing)" if advisory_missing else ""))
        return
    checks: list[dict] = []
    try:
        repo = Path(getattr(args, "repo", None) or repo_root())
    except (subprocess.CalledProcessError, FileNotFoundError):
        repo = None

    def which(binary: str) -> str | None:
        return shutil.which(binary)

    # Core toolchain. Windows remediation happens before rows are recorded so
    # the fixing run can truthfully report the tools it just installed.
    git = which("git")
    python = _python_check()
    windows_install_checks: list[dict] = []
    if _platform_name() == "windows" and args.fix and (not git or not python["ok"]):
        if _windows_process_is_elevated():
            windows_install_checks = [_elevated_windows_remediation_check()]
        else:
            windows_install_checks = _remediate_windows_prerequisites(
                install_git=not bool(git), install_python=not python["ok"],
            )
            git = which("git")
            python = _python_check()
            if repo is None and git:
                try:
                    repo = Path(repo_root())
                except (subprocess.CalledProcessError, FileNotFoundError):
                    pass

    checks.append(_check(
        "git", git is not None, git or "not on PATH", _git_fix_message()))
    checks.append(python)
    checks.extend(windows_install_checks)

    checks.append(_psutil_check(fix=args.fix))
    checks.append(_codex_sandbox_python_check())

    if repo:
        checks.extend(hook_health_checks(repo))

    node = which("node")
    node_ok, node_ver = (False, "not on PATH")
    if node:
        code, out = run_quiet([node, "--version"])
        node_ver = out
        node_ok = (
            code == 0
            and out.lstrip("v").split(".")[0].isdigit()
            and int(out.lstrip("v").split(".")[0]) >= 20
        )

    checks.append(_check(
        "node >= 20",
        node_ok,
        node_ver,
        "install Node 20+ (https://nodejs.org or `brew install node`)",
    ))

    checks.append(_check(
        "pnpm",
        which("pnpm") is not None,
        which("pnpm") or "not on PATH",
        "`npm install -g pnpm` (needed once the nx workspace exists)",
        required=False,
    ))

    checks.append(_check(
        "docker",
        which("docker") is not None,
        which("docker") or "not on PATH",
        "Docker Desktop (needed once the nx workspace exists)",
        required=False,
    ))

    # direnv — pins GSTACK_HOME into each repo (.envrc) so gstack output is
    # project-local and committed, not stranded in ~/.gstack.
    if not which("direnv") and args.fix:
        _install_direnv(home)

    direnv = which("direnv")
    hook_ok = _has_direnv_hook(home)

    if direnv and not hook_ok and args.fix:
        hook_ok = _append_direnv_hook(home)

    if direnv and hook_ok and args.fix and Path.cwd().joinpath(".envrc").exists():
        code, out = run_quiet([direnv, "allow", str(Path.cwd())])
        if code == 0:
            print(f"[fix ] allowed {Path.cwd() / '.envrc'}")
        else:
            print(f"[warn] direnv allow failed: {out}")

    if not direnv:
        direnv_detail = "not on PATH"
    elif not hook_ok:
        direnv_detail = f"{direnv} (shell hook missing)"
    else:
        direnv_detail = direnv

    checks.append(_check(
        "direnv + shell hook",
        bool(direnv) and hook_ok,
        direnv_detail,
        _direnv_fix_message(),
    ))

    # Codex — the execution plane. Presence is not enough: the API refuses
    # the pinned GPT-5.6 models on old CLIs ("requires a newer version of
    # Codex") and the error only surfaces at delegation time — so the
    # version floor is checked HERE, at setup.
    MIN_CODEX = (0, 144, 0)
    if not which("codex") and args.fix and which("npm"):
        print("[fix ] installing @openai/codex ...")
        run_quiet(["npm", "install", "-g", "@openai/codex"])

    def codex_version() -> tuple[int, ...] | None:
        binary = which("codex")
        if not binary:
            return None
        code, out = run_quiet([binary, "--version"])
        try:
            return tuple(int(p) for p in out.split()[-1].split(".")[:3])
        except (ValueError, IndexError):
            return None

    version = codex_version()
    if version is not None and version < MIN_CODEX and args.fix and which("npm"):
        print(f"[fix ] codex CLI {'.'.join(map(str, version))} is below the "
              f"{'.'.join(map(str, MIN_CODEX))} floor — upgrading ...")
        run_quiet(["npm", "install", "-g", "@openai/codex@latest"])
        version = codex_version()

    codex = which("codex")
    if codex:
        version_ok = version is not None and version >= MIN_CODEX
        checks.append(_check(
            f"codex CLI >= {'.'.join(map(str, MIN_CODEX))}",
            version_ok,
            ".".join(map(str, version)) if version else "version unreadable",
            "`npm install -g @openai/codex@latest` — the pinned gpt-5.6 models "
            "refuse older CLIs at call time — or rerun with --fix",
        ))
        code, out = run_quiet([codex, "login", "status"])
        logged_in = code == 0 and "not logged in" not in out.lower()
        checks.append(_check(
            "codex CLI + login",
            logged_in,
            out.splitlines()[-1] if out else "unknown",
            "`codex login` (ChatGPT subscription or API key — login is always manual)",
        ))
    else:
        checks.append(_check(
            "codex CLI + login",
            False,
            "not on PATH",
            "`npm install -g @openai/codex` then `codex login` — or rerun with --fix",
        ))

    # Claude Code — the coordination plane
    claude_bin = which("claude")
    checks.append(_check(
        "claude CLI",
        claude_bin is not None,
        claude_bin or "not on PATH",
        "https://claude.ai/code — install Claude Code",
    ))

    def install_claude_plugin(marketplace_url: str, plugin_ref: str) -> None:
        if not claude_bin:
            return
        run_quiet([claude_bin, "plugin", "marketplace", "add", marketplace_url])
        run_quiet([claude_bin, "plugin", "install", plugin_ref])

    plugin = _codex_plugin_dir(home)
    if not plugin.is_dir() and args.fix and claude_bin:
        print("[fix ] installing codex-plugin-cc ...")
        install_claude_plugin(
            "https://github.com/openai/codex-plugin-cc",
            "codex@openai-codex",
        )

    checks.append(_check(
        "codex-plugin-cc",
        plugin.is_dir(),
        str(plugin) if plugin.is_dir() else "not installed",
        "`claude plugin marketplace add https://github.com/openai/codex-plugin-cc && "
        "claude plugin install codex@openai-codex` — or rerun with --fix "
        "(leave the review gate disabled)",
    ))

    # Required skills
    gstack = _gstack_dir(home)
    if not gstack.is_dir() and args.fix:
        print("[fix ] installing gstack ...")
        code, _ = run_quiet([
            "git",
            "clone",
            "--depth",
            "1",
            "https://github.com/garrytan/gstack.git",
            str(gstack),
        ])
        if code == 0 and (gstack / "setup").exists():
            run_quiet([str(gstack / "setup")])

    checks.append(_check(
        "gstack skills",
        gstack.is_dir(),
        str(gstack) if gstack.is_dir() else "not installed",
        "`git clone --depth 1 https://github.com/garrytan/gstack.git "
        "~/.claude/skills/gstack && ~/.claude/skills/gstack/setup` "
        "(needed for /office-hours discovery) — or rerun with --fix",
    ))

    # autoreview is the SOLE reviewer (decision 0001 D6) — the review gate
    # cannot pass without it, so it is REQUIRED and --fix installs it.
    autoreview = _autoreview_dir(home)
    if not autoreview.is_dir() and args.fix:
        print("[fix ] installing the autoreview skill ...")
        with tempfile.TemporaryDirectory() as tmp:
            code, _ = run_quiet([
                "git", "clone", "--depth", "1",
                "https://github.com/openclaw/agent-skills.git", tmp,
            ])
            src = Path(tmp) / "skills" / "autoreview"
            if code == 0 and src.is_dir():
                autoreview.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src, autoreview, dirs_exist_ok=True)

    checks.append(_check(
        "autoreview skill",
        autoreview.is_dir(),
        str(autoreview) if autoreview.is_dir() else "not installed",
        "clone https://github.com/openclaw/agent-skills and copy skills/autoreview "
        "to ~/.codex/skills/ (the ONE reviewer — the review gate needs it) — "
        "or rerun with --fix",
    ))

    # /grill-me is the grilling skill the plan and task gates require (referenced
    # across .claude/CLAUDE.md, griller.md, planner.md, phase.py, harness.yaml).
    # It ships in Matt Pocock's skills pack, so --fix installs the pack.
    grill_me = home / ".claude" / "skills" / "grill-me"
    if not grill_me.is_dir() and args.fix:
        print("[fix ] installing the /grill-me skill (mattpocock/skills) ...")
        run_quiet(["npx", "-y", "skills", "add", "mattpocock/skills",
                   "-g", "--copy", "--all"])
    checks.append(_check(
        "grill-me skill",
        grill_me.is_dir(),
        str(grill_me) if grill_me.is_dir() else "not installed",
        "`npx -y skills add mattpocock/skills -g --copy --all` "
        "(the /grill-me grill skill the plan/task gates require) — or rerun with --fix",
    ))

    # Merge gate: scaffold-check must be a REQUIRED status check on the
    # default branch, or a red CI run can still merge (observed: a red suite
    # reached main with CI failing and nothing enforcing it). This is a
    # per-repo GitHub setting — vendored workflow files cannot carry it, so
    # doctor checks it wherever a client repo is set up. Advisory: it needs
    # network + gh auth, and admin rights to fix.
    protection = _merge_check_status(fix=args.fix, repo=getattr(args, "repo", None))
    if protection is not None:
        ok, detail = protection
        checks.append(_check(
            "branch protection: scaffold-check required to merge",
            ok, detail,
            "run `gh api -X PUT repos/<owner>/<repo>/branches/<default>/protection"
            " --input -` with required_status_checks contexts [\"scaffold-check\"]"
            " (repo admin) — or rerun with --fix",
            required=False,
        ))

    # Optional tools below are reported but not installed by the normal
    # `doctor --fix` path. This keeps machine setup focused on required items.

    # Design skill packs — --fix installs them, but they are not required to
    # pass (only user-facing tasks need them, enforced per-task via harness.yaml
    # required_skills). The mattpocock pack is installed above for /grill-me.
    skill_packs = [
        (
            "anthropic frontend-design",
            "anthropics/skills",
            ["-s", "frontend-design", "-a", "*", "-y"],
            home / ".claude" / "skills" / "frontend-design",
        ),
        (
            "emilkowalski skills",
            "emilkowalski/skills",
            ["--all"],
            home / ".claude" / "skills" / "emil-design-eng",
        ),
    ]

    for name, pack_repo, extra, sentinel in skill_packs:
        if not sentinel.is_dir() and args.fix:
            print(f"[fix ] installing {name} ...")
            run_quiet(["npx", "-y", "skills", "add", pack_repo,
                       "-g", "--copy", *extra])
        checks.append(_check(
            name,
            sentinel.is_dir(),
            "installed" if sentinel.is_dir() else "not installed",
            f"`npx -y skills add {pack_repo} -g --copy {' '.join(extra)}`",
            required=False,
        ))

    ponytail_cache = home / ".claude" / "plugins" / "cache"

    def ponytail_ok() -> bool:
        return ponytail_cache.is_dir() and any(ponytail_cache.glob("*ponytail*"))

    checks.append(_check(
        "ponytail plugin",
        ponytail_ok(),
        "installed" if ponytail_ok() else "not installed",
        "`claude plugin marketplace add https://github.com/DietrichGebert/ponytail && "
        "claude plugin install ponytail@ponytail` "
        "(prototype phase 0b only — see harness.yaml)",
        required=False,
    ))

    width = max(len(c["name"]) for c in checks)
    failures = 0

    for check in checks:
        mark = _display_mark(check)
        print(f"[{mark}] {check['name']:<{width}}  {check['detail']}")

        if not check["ok"]:
            print(f"       fix: {check['fix']}")
            if check["required"]:
                failures += 1

    # Repo-level migration report. Prose verify_commands predate the record-time
    # refusal, so an ALREADY-recorded decomposition can still carry one — and it
    # would surface as a stage that cannot close. Report it before that happens.
    # doctor also runs outside a repo (fresh machine), where there is nothing
    # to migrate.
    # Required skills must be loadable by every runtime asked to attest them.
    # --fix mirrors an already-installed copy across, which is the whole gap:
    # `skills add` installs for Claude, and Codex reads a different directory.
    for runtime, skill in (skills_missing_per_runtime(repo) if repo else []):
        target = home / SKILL_HOMES[runtime] / skill
        source = next((home / rel / skill for rel in SKILL_HOMES.values()
                       if (home / rel / skill / "SKILL.md").is_file()), None)
        if args.fix and source:
            print(f"[fix ] mirroring {skill} -> {target} ...")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, dirs_exist_ok=True)
        if not (target / "SKILL.md").is_file():
            print(f"[MISS] skill/{runtime:<7} {skill} not loadable by {runtime} "
                  f"({target})")
            print(f"       fix: harness.yaml requires {skill} for user-facing work "
                  f"and the recorder refuses an artifact that does not attest it — "
                  f"install it, then rerun with --fix to mirror it across runtimes.")
            failures += 1

    for runtime, skill in (
            skills_missing_per_runtime(repo, advisory=True) if repo else []):
        target = home / SKILL_HOMES[runtime] / skill
        source = next((home / rel / skill for rel in SKILL_HOMES.values()
                       if (home / rel / skill / "SKILL.md").is_file()), None)
        if args.fix and source:
            print(f"[fix ] mirroring {skill} -> {target} ...")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, dirs_exist_ok=True)
        if not (target / "SKILL.md").is_file():
            print(f"[opt ] skill/{runtime:<7} {skill} not loadable by {runtime} "
                  f"({target})")
            print(f"       fix: harness.yaml advises {skill}; install it, then "
                  f"rerun with --fix to mirror it across runtimes.")

    prose = prose_verify_commands(repo) if repo else []
    for entry in prose:
        print(f"[MISS] verify_commands  {entry}")
    if prose:
        print("       fix: re-record the decomposition with the command that "
              "proves the task — `forge stage done` executes every entry, so "
              "these can never pass.")
        failures += len(prose)

    legacy = legacy_required_tests(repo) if repo else []
    for entry in legacy:
        print(f"[MISS] required_tests   {entry}")
    if legacy:
        print("       fix: re-record the decomposition with {id, path, command} "
              "objects; stage done executes the exact command.")
        failures += len(legacy)

    if repo:
        report_legacy_capture_gaps(repo)
        report_legacy_roadmap_gaps(repo)

    if failures:
        print(f"\nforge doctor: {failures} required item(s) missing.")
        raise SystemExit(1)

    print("\nforge doctor: ready")
