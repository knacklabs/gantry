"""forge doctor — machine prerequisites, with --fix auto-install."""
from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import shutil
import stat
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from factory_lib import decomposition_state_path, load_json, parse_sections, repo_root
from record_signoff import REQUIRED_BRIEF_HEADINGS

from .common import run_quiet
from .specs import missing_required_content, parse_frontmatter

DIRENV_VERSION = "2.37.1"

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
    syntax = subprocess.run(["bash", "-n", "-c", text],
                            capture_output=True, text=True)
    if syntax.returncode != 0:
        return f"is not valid shell ({syntax.stderr.strip().splitlines()[-1:] or ['parse error']})"
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
    from .delegate import skill_groups

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
    sections = parse_sections(brief.read_text()) if brief.is_file() else {}
    missing = [heading for heading in REQUIRED_BRIEF_HEADINGS
               if not sections.get(heading, "").strip()]
    if missing:
        found.append(("brief", f"docs/product/BRIEF.md: {', '.join(missing)}"))

    specs = base / "docs" / "specs"
    for spec in sorted(specs.glob("*.md")) if specs.is_dir() else []:
        document = spec.read_text()
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


# Shared install locations — fast_status() and cmd_doctor() must agree on
# where things live, or the session banner and full doctor drift apart.
def _codex_plugin_dir(home: Path) -> Path:
    return home / ".claude" / "plugins" / "cache" / "openai-codex" / "codex"


def _gstack_dir(home: Path) -> Path:
    return home / ".claude" / "skills" / "gstack"


def _autoreview_dir(home: Path) -> Path:
    return home / ".codex" / "skills" / "autoreview"


def fast_status(home: Path | None = None) -> tuple[list[str], list[str]]:
    """Millisecond machine check for the SessionStart hook: PATH lookups and
    directory existence ONLY — no subprocesses, no versions, no logins.
    Returns (required_missing, advisory_missing). A fresh clone after
    `git pull` gets told its machine is not ready at the FIRST session,
    not at the first mid-task failure."""
    home = home or Path.home()
    required = {
        "git": shutil.which("git") is not None,
        "node": shutil.which("node") is not None,
        "direnv + shell hook": shutil.which("direnv") is not None and _has_direnv_hook(home),
        "codex CLI": shutil.which("codex") is not None,
        "claude CLI": shutil.which("claude") is not None,
        "codex-plugin-cc": _codex_plugin_dir(home).is_dir(),
        "gstack skills": _gstack_dir(home).is_dir(),
        "autoreview skill": _autoreview_dir(home).is_dir(),
    }
    advisory = {
        "frontend-design skill": (home / ".claude" / "skills" / "frontend-design").is_dir(),
        "emil-design-eng skill": (home / ".claude" / "skills" / "emil-design-eng").is_dir(),
    }
    return ([k for k, ok in required.items() if not ok],
            [k for k, ok in advisory.items() if not ok])


def _github_slug() -> str:
    code, out = run_quiet(["git", "remote", "get-url", "origin"])
    if code != 0:
        return ""
    url = out.strip()
    for prefix in ("git@github.com:", "https://github.com/", "ssh://git@github.com/"):
        if url.startswith(prefix):
            return url.removeprefix(prefix).removesuffix(".git")
    return ""


def _merge_check_status(*, fix: bool) -> tuple[bool, str] | None:
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
    slug = _github_slug()
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
                input=payload, capture_output=True, text=True, timeout=15)
            if proc.returncode != 0:
                return False, f"fix failed (admin rights?): {proc.stderr.strip()[:120]}"
        else:
            print(f"[fix ] adding scaffold-check to {default}'s required checks ...")
            proc = subprocess.run(
                ["gh", "api", "-X", "POST", f"{checks_url}/contexts",
                 "--input", "-"],
                input=json.dumps(["scaffold-check"]),
                capture_output=True, text=True, timeout=15)
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

    def which(binary: str) -> str | None:
        return shutil.which(binary)

    # Core toolchain
    checks.append(_check(
        "git", which("git") is not None, which("git") or "not on PATH",
        "https://git-scm.com — or `xcode-select --install` on macOS"))

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

    # Merge gate: scaffold-check must be a REQUIRED status check on the
    # default branch, or a red CI run can still merge (observed: a red suite
    # reached main with CI failing and nothing enforcing it). This is a
    # per-repo GitHub setting — vendored workflow files cannot carry it, so
    # doctor checks it wherever a client repo is set up. Advisory: it needs
    # network + gh auth, and admin rights to fix.
    protection = _merge_check_status(fix=args.fix)
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

    skill_packs = [
        (
            "mattpocock skills",
            "mattpocock/skills",
            ["--all"],
            home / ".claude" / "skills" / "ask-matt",
        ),
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

    for name, repo, extra, sentinel in skill_packs:
        checks.append(_check(
            name,
            sentinel.is_dir(),
            "installed" if sentinel.is_dir() else "not installed",
            f"`npx -y skills add {repo} -g --copy {' '.join(extra)}`",
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
        mark = "OK " if check["ok"] else ("MISS" if check["required"] else "opt ")
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
    try:
        repo = Path(getattr(args, "repo", None) or repo_root())
    except (subprocess.CalledProcessError, FileNotFoundError):
        repo = None
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

    print("\nforge doctor: ready. Next: forge.py init --name <project> --target <dir>")
