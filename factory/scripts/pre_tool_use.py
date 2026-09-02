#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    raise SystemExit(0)


EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def _raw_payload() -> dict:
    try:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        raw = stream.read()
        value = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _repo_from_cwd() -> Path:
    current = Path.cwd().resolve()
    return next((path for path in (current, *current.parents)
                 if (path / ".git").exists()), current)


def _unmerged_paths(root: Path) -> set[str]:
    result = subprocess.run(
        ["git", "ls-files", "-u", "-z"], cwd=root, capture_output=True,
        text=True, encoding="utf-8", errors="surrogateescape",
    )
    if result.returncode:
        return set()
    return {
        record.split("\t", 1)[1]
        for record in result.stdout.split("\0")
        if "\t" in record
    }


def _git_recovery(command: str, root: Path, unmerged: set[str]) -> bool | None:
    """Allow/deny a single git-native recovery command; None means unrelated."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens or tokens[0].rsplit("/", 1)[-1] != "git":
        return None
    index = 1
    while index < len(tokens) and tokens[index].startswith("-"):
        if tokens[index] in {"-C", "--git-dir", "--work-tree"}:
            return False
        if tokens[index] in {"-C", "-c", "--git-dir", "--work-tree"}:
            index += 2
        else:
            index += 1
    if index >= len(tokens):
        return None
    verb, args = tokens[index], tokens[index + 1:]
    if verb in {"merge", "rebase", "cherry-pick"}:
        return args == ["--abort"]
    if verb not in {"checkout", "rm", "add", "reset"}:
        return None
    if verb == "checkout":
        modes = [arg for arg in args if arg in {"--ours", "--theirs"}]
        if len(modes) != 1:
            return None
    paths: list[str] = []
    skip_value = False
    for arg in args:
        if skip_value:
            skip_value = False
            continue
        if arg in {"--pathspec-from-file"}:
            return False
        if arg in {"--source"}:
            skip_value = True
            continue
        if arg == "--" or arg.startswith("-"):
            continue
        paths.append(arg)
    if verb == "reset" and "--hard" in args:
        return False
    if verb == "reset" and not paths:
        return True
    normalized: set[str] = set()
    for raw in paths:
        candidate = Path(raw)
        try:
            normalized.add((candidate if candidate.is_absolute() else root / candidate)
                           .resolve().relative_to(root.resolve()).as_posix())
        except ValueError:
            return False
    return bool(normalized) and normalized <= unmerged


STATIC_WRITE_EXEMPT_PREFIXES = ("plans/", "docs/", ".gstack/", "prototype/")
STATIC_WRITE_EXEMPT_FILES = {"README.md", ".gitignore", ".gitattributes", ".envrc"}

def _static_locked(raw: str, root: Path) -> bool:
    value = raw.strip().strip("\"'")
    if not value or "$" in value or "`" in value:
        return True
    candidate = Path(value)
    try:
        rel = (candidate if candidate.is_absolute() else root / candidate) \
            .resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return False
    return rel not in STATIC_WRITE_EXEMPT_FILES and not any(
        rel == prefix.rstrip("/") or rel.startswith(prefix)
        for prefix in STATIC_WRITE_EXEMPT_PREFIXES)


def _fallback_readonly(command: str) -> bool:
    if "$" in command or "`" in command or re.search(r"[<>]", command):
        return False
    for segment in re.split(r"&&|\|\||[;|\n]", command):
        try:
            tokens = shlex.split(segment)
        except ValueError:
            return False
        while tokens and re.fullmatch(r"\w+=\S*", tokens[0]):
            tokens.pop(0)
        if not tokens:
            continue
        name = tokens[0].rsplit("/", 1)[-1]
        if name == "git":
            verb = next((token for token in tokens[1:] if not token.startswith("-")), "")
            if any(token.startswith("--output") for token in tokens[1:]) or verb not in {
                "status", "diff", "show", "log", "ls-files", "rev-parse"}:
                return False
        elif name not in {"pwd", "ls", "rg", "grep", "cat", "head", "tail", "wc", "diff", "stat", "file"}:
            return False
    return True


def denylist_fallback(payload: dict, reason: str) -> None:
    root = _repo_from_cwd()
    command = ((payload.get("tool_input") or {}).get("command") or "").strip()
    unmerged = _unmerged_paths(root)
    recovery = _git_recovery(command, root, unmerged)
    if recovery is True:
        print(json.dumps({}))
        raise SystemExit(0)
    if recovery is False:
        deny("Merge recovery is limited to the paths currently reported by git ls-files -u.")
    tool = payload.get("tool_name", "")
    target = ((payload.get("tool_input") or {}).get("file_path") or
              (payload.get("tool_input") or {}).get("notebook_path") or "")
    if (tool in EDIT_TOOLS and _static_locked(target, root)) or (
        tool == "Bash" and not _fallback_readonly(command)
    ):
        deny(f"Forge emergency deny-list engaged ({reason}); product and canon writes stay locked.")
    print(json.dumps({}))
    raise SystemExit(0)


payload = _raw_payload()
try:
    from factory_lib import (
        client_signoff, load_json, repo_root, run_state_path,
    )
    from forge_cli.context import context_files, context_paths, scan_inbox
    from forge_cli.quickfix import DEGRADED, claim_files, load_active, profile_of
    from forge_cli.repo_kind import is_harness_source_repo, locked_repo_path
except (ImportError, SyntaxError) as exc:
    denylist_fallback(payload, type(exc).__name__)

tool_name = payload.get("tool_name", "")
tool_input = payload.get("tool_input") or {}
command = (tool_input.get("command") or "").strip()
permission_mode = payload.get("permission_mode", "")


# Session lock: product and canon writes are always refused unless a bounded
# degraded window is open. Orchestration surfaces stay available.
# .factory/ is deliberately NOT writable by hand: run.json holds plan_status,
# so a hand-edit disarms this very lock, and AGENTS.md already requires that
# evidence enter .factory/ only through the record_* scripts. Those scripts
# write it as themselves — this guard classifies tool-call targets, not what a
# sanctioned script does internally. The scratchpad is the one freely
# hand-written file there (`forge note`); the repo-kind marker also lives there
# but is planning-locked, not free (see FACTORY_STATE_WRITABLE).
FACTORY_STATE_MSG = (
    ".factory/ is recorded state, never hand-written (AGENTS.md): run.json "
    "carries plan_status, so editing it disarms the planning lock. Use the "
    "record_* scripts, `./forge note` for the scratchpad, or `./forge stage` "
    "for stage status."
)
# Files under .factory/ the evidence guard lets through — but that is the ONLY
# guard they skip. The scratchpad is also exempt in the shared locked-path
# classifier. The repo-kind marker is deliberately NOT there: it is a product path,
# so the session lock governs it. Disarming the source-repo lock therefore runs
# through a delegated worker, never a silent session edit or `rm`.
FACTORY_STATE_WRITABLE = {
    ".factory/scratchpad.md",
    ".factory/harness-source.json",
}
# The repo-kind marker. It decides whether the machinery trees are product at
# all, so a session may never change it, including during degraded mode: a
# window that could `rm` it as its first claim would flip the repo to client-mode
# and let every later machinery write skip the budget entirely.
HARNESS_SOURCE_MARKER = ".factory/harness-source.json"
PLAN_MODE_MSG = (
    "Session write lockout is armed — product and canon writes must run through "
    "`./forge delegate <task-id>`. If the companion is unavailable, open the sole "
    "bounded exception with `./forge mode degraded start --reason \"<reason>\"`."
)
QUICKFIX_LIMIT_MSG = (
    "Degraded window scope exceeded — its five-file claim budget is exhausted. "
    "Close it with `./forge mode done`, restore the companion, and use "
    "`./forge delegate <task-id>` for the remaining write work."
)
MARKER_PLAN_ONLY_MSG = (
    f"{HARNESS_SOURCE_MARKER} is the repo-kind marker: it may be created, edited, "
    "or deleted only through `./forge delegate <task-id>`, never by the session or "
    "a degraded window. Removing it inside a window could flip this repo to "
    "client-mode and escape the file budget."
)
def product_path(raw: str, root: Path, is_harness: bool) -> str | None:
    """Compatibility name for the shared repo-kind-aware lock classifier."""
    return locked_repo_path(raw, root, harness_source=is_harness)


def tokenize(segment: str) -> list[str] | None:
    """Shell tokens, or None when the segment cannot be parsed at all.

    Non-posix mode is the fallback because it survives the apostrophe in a
    heredoc body (`cat > src/app.ts <<'EOF'\\nit's fine`) that posix mode
    rejects — losing that would blind the guard to a real product write.
    """
    for posix in (True, False):
        try:
            return shlex.split(segment, posix=posix)
        except ValueError:
            continue
    return None


HEREDOC_START = re.compile(r"<<-?\s*[\"']?(\w+)[\"']?")


def strip_heredoc_bodies(value: str) -> str:
    """Drop heredoc BODIES, keep the command lines that open them.

    `cat > src/app.ts <<'EOF'` is a product write and must still be seen; the
    body is data — prose there ("changed a > b", "sed -i") is not a command.
    """
    lines = value.splitlines()
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        match = HEREDOC_START.search(line)
        index += 1
        if not match:
            continue
        terminator = match.group(1)
        while index < len(lines) and lines[index].strip() != terminator:
            index += 1
        index += 1  # skip the terminator itself
    return "\n".join(kept)


def redirect_targets(tokens: list[str]) -> list[str]:
    """Write targets of unquoted > / >> operators.

    Token-level so a redirect character INSIDE a quoted argument
    (git commit -m 'a > b') is text, not a redirect.
    """
    targets: list[str] = []
    for index, token in enumerate(tokens):
        if token in {">", ">>"}:
            if index + 1 < len(tokens):
                targets.append(tokens[index + 1])
        elif token.startswith(">") and token.lstrip(">"):
            targets.append(token.lstrip(">"))
    return targets


def in_factory_state(raw: str, root: Path) -> bool:
    """True when a write target lands in protected .factory/ state."""
    value = raw.strip().strip("\"'")
    if not value or "$" in value or "`" in value:
        return False
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        rel = candidate.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return False
    # `.factory` (the directory itself, e.g. `rm -rf .factory`) is protected too:
    # deleting it wipes recorded state and the repo-kind marker in one stroke.
    if rel == ".factory":
        return True
    return rel.startswith(".factory/") and rel not in FACTORY_STATE_WRITABLE


# git global options that consume a following token as their value; the real
# subcommand is the first bare token once these (and plain flags) are skipped.
GIT_VALUE_OPTS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--config-env",
}


def git_subcommand(args: list[str]) -> tuple[str | None, list[str]]:
    """The git subcommand and its args, skipping global options and their values."""
    index = 0
    while index < len(args):
        token = args[index]
        if token in GIT_VALUE_OPTS:
            index += 2  # option plus its separate value
            continue
        if token.startswith("-"):
            index += 1  # a flag, or --opt=value carrying its own value
            continue
        return token, args[index + 1:]
    return None, []


def has_git_commit(value: str) -> bool:
    """True when a shell segment directly invokes `git ... commit`."""
    for segment in re.split(r"[;&|\n]+", strip_heredoc_bodies(value)):
        tokens = tokenize(segment)
        if tokens is None:
            continue
        command_index = next(
            (index for index, token in enumerate(tokens)
             if not re.fullmatch(r"\w+=\S*", token)),
            None,
        )
        if command_index is None:
            continue
        if tokens[command_index].rsplit("/", 1)[-1] != "git":
            continue
        if git_subcommand(tokens[command_index + 1:])[0] == "commit":
            return True
    return False


def _copy_operands(operands: list[str], args: list[str],
                   root: Path) -> tuple[list[str], list[str]]:
    """(created destination files, source paths) for a cp/mv.

    A directory (or repo-root) destination expands to `<dir>/<basename>` per
    source, so each CREATED file is counted against the budget rather than the
    container claiming one slot for many files. A file destination is itself.
    GNU `-t <dir>` / `--target-directory=<dir>` puts the dir first, sources after.
    """
    target = None
    for position, arg in enumerate(args):
        if arg in ("-t", "--target-directory") and position + 1 < len(args):
            target = args[position + 1]
        elif arg.startswith("--target-directory="):
            target = arg.split("=", 1)[1]
    if target is not None:
        dest, sources = target, operands
    elif len(operands) >= 2:
        dest, sources = operands[-1], operands[:-1]
    else:
        return operands, []  # single/zero operand — nothing to expand
    dest_path = Path(dest) if Path(dest).is_absolute() else root / dest
    if dest_path.is_dir() or dest in (".", ""):
        base = dest.rstrip("/") or "."
        return [f"{base}/{Path(src).name}" for src in sources], sources
    return [dest], sources


def bash_write_paths(value: str, root: Path) -> list[str]:
    """Extract likely write targets from a shell command.

    # ponytail: heuristic, defends drift not adversaries — tighten patterns
    # if a real bypass shows up.
    """
    found: list[str] = []
    # Newlines separate commands too: without them a multi-line script is one
    # segment, and an earlier command's operand list swallows later lines.
    for segment in re.split(r"[;&|\n]+", strip_heredoc_bodies(value)):
        tokens = tokenize(segment)
        if tokens is None:
            continue
        found.extend(redirect_targets(tokens))
        # Command POSITION only (after env-var prefixes) — the same discipline
        # the codex-exec guard uses. Otherwise prose that merely mentions a
        # tool ("...sed -i, cp, mv...") is parsed as an invocation.
        command_index = next(
            (index for index, token in enumerate(tokens)
             if not re.fullmatch(r"\w+=\S*", token)),
            None,
        )
        if command_index is None:
            continue
        command_name = tokens[command_index].rsplit("/", 1)[-1]
        if command_name not in {"tee", "sed", "cp", "mv", "touch", "rm",
                                "unlink", "git"}:
            continue
        args = tokens[command_index + 1:]
        operands = [token for token in args
                    if not token.startswith("-") and token not in {">", ">>"}]
        if command_name == "tee":
            found.extend(operands)
        elif command_name == "touch":
            found.extend(operands)
        elif command_name in {"rm", "unlink"}:
            # Deleting a product path disarms as surely as writing one: removing
            # the repo-kind marker would flip source->client. Every operand is a
            # target. This heuristic covers the COMMON drift shapes; cwd games
            # (`cd .factory && rm`), git -C, indirect pathspecs, globs, and
            # arbitrary code (python -c, find -delete) are beyond it by design
            # (decision 0013). The quickfix repo-kind PIN makes the file budget
            # un-escapable regardless of how the marker is deleted; the locked
            # case falls back to git visibility + artifact-gate backstop.
            found.extend(operands)
        elif command_name == "git":
            # `git rm` / `git mv` delete or relocate tracked files like their
            # shell namesakes — skip git's global options to reach the subcommand.
            sub, sub_args = git_subcommand(args)
            if sub in {"rm", "mv"}:
                found.extend(token for token in sub_args
                             if not token.startswith("-") and token not in {">", ">>"})
        elif command_name == "cp" and operands:
            # Count each CREATED file (dir destinations expand to dir/basename),
            # so N copies into a machinery dir spend N budget slots, not one.
            created, _ = _copy_operands(operands, args, root)
            found.extend(created)
        elif command_name == "mv":
            # The destination is a write (expanded like cp) AND every source is a
            # deletion — moving the marker away removes it just like `rm`.
            created, sources = _copy_operands(operands, args, root)
            found.extend(created)
            found.extend(sources)
        elif command_name == "sed" and any(
            token == "-i" or token.startswith("-i") or token.startswith("--in-place")
            for token in args
        ) and operands:
            found.append(operands[-1])
    return found


def _contains_marker(rel: str) -> bool:
    """True when rel IS the repo-kind marker or a directory that contains it.

    An ancestor delete (`rm -r .factory`) removes the marker just as surely as
    deleting it by name. The repo ROOT (`.`/``) is deliberately excluded: it is
    a benign create-destination for `cp/mv <src> .`, not a marker deletion, and
    a genuine root wipe (`rm -rf .`) is caught by the rm-rf policy instead.
    """
    if rel == HARNESS_SOURCE_MARKER:
        return True
    if not rel or rel == ".":
        return False
    return HARNESS_SOURCE_MARKER.startswith(rel.rstrip("/") + "/")


# Shell metacharacters that expand one literal into an unbounded set of paths:
# globs (`*?[`) and brace expansion (`{1..6}`, `{a,b}`).
GLOB_METACHARS = ("*", "?", "[", "{")
OPAQUE_DEGRADED_MSG = (
    "This op touches an unbounded set of machinery files — a recursive/globbed "
    "delete, or a recursive/globbed copy or move INTO a machinery path — so a "
    "degraded window cannot honestly claim it against its budget. Enumerate the exact "
    "paths, or plan the change where the whole diff is measured."
)


def has_opaque_product_write(command: str, root: Path, is_harness: bool) -> bool:
    """An op whose exact product-file set can't be read from the literal command,
    so a degraded window cannot claim it: a recursive/globbed/brace DELETE of a product
    path (`rm`/`unlink`/`git rm`), or a recursive/glob-sourced copy/move whose
    DESTINATION is a product path. Copy/move opacity is keyed on the destination,
    never the source, so a read-OUT backup (`cp -R factory/scripts /tmp/x`) is
    never blocked. Pure shell games and arbitrary code stay a documented residual
    (decision 0013); the repo-kind PIN, not this check, is the security guarantee.
    """
    for segment in re.split(r"[;&|\n]+", strip_heredoc_bodies(command)):
        tokens = tokenize(segment)
        if tokens is None:
            continue
        index = next((i for i, token in enumerate(tokens)
                      if not re.fullmatch(r"\w+=\S*", token)), None)
        if index is None:
            continue
        name = tokens[index].rsplit("/", 1)[-1]
        args = tokens[index + 1:]
        if name == "git":
            sub, args = git_subcommand(args)
            if sub != "rm":
                continue
            name = "rm"
        elif name not in {"rm", "unlink", "cp", "mv"}:
            continue
        flags = [token for token in args if token.startswith("-")]
        operands = [token for token in args
                    if not token.startswith("-") and token not in {">", ">>"}]
        recursive = any(
            flag in ("-r", "-R", "-a", "--recursive", "--archive")
            or (len(flag) > 1 and not flag.startswith("--")
                and any(char in flag for char in "rRa"))
            for flag in flags)
        if name in {"rm", "unlink"}:
            for operand in operands:
                if (recursive or any(c in operand for c in GLOB_METACHARS)) \
                        and product_path(operand, root, is_harness):
                    return True
        else:  # cp / mv — opaque only when it WRITES into a product path
            created, sources = _copy_operands(operands, args, root)
            writes_product = any(product_path(c, root, is_harness) for c in created)
            glob_source = any(any(g in src for g in GLOB_METACHARS) for src in sources)
            if writes_product and (recursive or glob_source):
                return True
    return False


def guard_product_writes(targets: list[str], root: Path, command: str = "") -> None:
    window = load_active(root)
    # Effective repo kind: a live marker read, UNLESS a window is open — then
    # the kind pinned at its start wins, so deleting the marker during the window
    # (by any means) cannot flip classification and let machinery escape the
    # budget. Fail-safe: an old window with no pin falls back to the live marker.
    if window is not None and "harness_source" in window:
        is_harness = bool(window["harness_source"])
    else:
        is_harness = is_harness_source_repo(root)
    degraded = bool(window and profile_of(window) == DEGRADED)
    # Opaque check FIRST: a recursive/globbed op or a `cp -t`/dir copy can affect
    # product files the literal-target extractor never classifies, so `product`
    # may be empty even though the command hits machinery. Deny before any early
    # return, whether the repo is fully locked or a quickfix is open.
    if command and has_opaque_product_write(command, root, is_harness):
        deny(OPAQUE_DEGRADED_MSG if degraded else PLAN_MODE_MSG)
    product = list(dict.fromkeys(
        rel for raw in targets if (rel := product_path(raw, root, is_harness)) is not None
    ))
    if not product:
        return
    if any(_contains_marker(rel) for rel in product):
        # A session window must never be able to touch the marker:
        # deleting it — directly, or by removing an ANCESTOR like `.factory` via
        # `rm -rf .factory` — would disable classification and the budget with it.
        # Only the hook-bypassing delegated worker may change it.
        deny(MARKER_PLAN_ONLY_MSG)
    if not degraded:
        deny(PLAN_MODE_MSG)
    claimed, _ = claim_files(root, product)
    if not claimed:
        deny(QUICKFIX_LIMIT_MSG)


blocked = [
    r"\brm\s+-rf\b",
    r"\bgit\s+reset\s+--hard\b",
    r"\bgit\s+push\s+--force\b",
    r"\bterraform\s+destroy\b",
    r"\bkubectl\s+delete\b",
]
for pattern in blocked:
    if re.search(pattern, command):
        deny(f"Blocked by factory policy: {command}")

# Raw `codex exec` bypasses the sanctioned runtime (/codex:rescue -> the
# plugin companion): no session threading, no background management, no
# repo-pinned invocation shape. There is NO escape hatch — doctor installs
# codex-plugin-cc as a required tool; if it breaks, repair it or work in a
# Codex session directly (docs/degraded-mode.md).
# Match INVOCATIONS (command position, env prefixes, pipeline segments,
# command substitution) — not prose in heredocs/echo that mentions the phrase.
# `codex [global flags] exec` counts too — flags between must not bypass.
CODEX_EXEC_INVOCATION = re.compile(
    r"(?:^|[;&|]\s*|\$\(\s*)(?:\w+=\S+\s+)*codex(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+exec\b",
    re.MULTILINE,
)
if CODEX_EXEC_INVOCATION.search(command):
    deny(
        "Direct `codex exec` is off-contract — invoke Codex through the plugin: "
        "/codex:rescue [--background] [--write] [--model <m>] [--effort <e>] \"<task>\" "
        "(read-only unless --write). Plugin missing or broken? `./forge doctor --fix` "
        "reinstalls it; meanwhile work in a Codex session directly "
        "(docs/degraded-mode.md) — same prompts, same artifacts, same gates."
    )

check_bypass = ["pnpm test", "pnpm lint", "pnpm typecheck", "pnpm check:all"]
if any(token in command for token in check_bypass) and "factory/scripts/verify.py" not in command:
    deny(
        "Use `python3 factory/scripts/verify.py` so verification artifacts stay deterministic."
    )

# Sign-off gate: heavy factory phases cannot start before client sign-off.
# Discovery/prototype phases and record_signoff.py itself stay allowed.
PHASE_ADVANCING = (
    "record_decomposition_from_json.py",
    "pr_ready.py",
)
GATED_PHASES = (
    "planning",
    "decomposing",
    "awaiting-approval",
    "implementing",
    "testing",
    "reviewing",
    "functional-check",
    "pr-ready",
)
root = repo_root()
unmerged = _unmerged_paths(root)
recovery = _git_recovery(command, root, unmerged) if unmerged else None
if recovery is True:
    print(json.dumps({}))
    raise SystemExit(0)
if recovery is False:
    deny("Merge recovery is limited to the paths currently reported by git ls-files -u.")
if tool_name in EDIT_TOOLS and unmerged:
    edit_path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if edit_path:
        candidate = Path(edit_path)
        try:
            rel = (candidate if candidate.is_absolute() else root / candidate).resolve() \
                .relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = ""
        if rel in unmerged:
            deny("Conflicted files must be resolved with git-native recovery, not content hand-writes.")

try:
    run_state = load_json(run_state_path(root), default={})
except (json.JSONDecodeError, OSError, TypeError, ValueError) as exc:
    denylist_fallback(payload, type(exc).__name__)

if tool_name == "Bash" and has_git_commit(command):
    context_dir, ledger_path = context_paths(root)
    # An inbox that was never scanned and holds nothing stays untouched: the
    # belt must not leave an untracked ledger.json behind on every commit.
    if ledger_path.exists() or (context_dir.is_dir() and context_files(context_dir)):
        drift, refused = scan_inbox(root)
    else:
        drift, refused = [], []
    if refused:
        deny("REFUSED (not registered — fix, then rescan):\n" +
             "\n".join(f"- {line}" for line in refused))
    if drift:
        staged = subprocess.run(
            ["git", "add", "--", "docs/context/ledger.json"],
            cwd=root, capture_output=True, text=True,
            encoding="utf-8", errors="surrogateescape",
        )
        if staged.returncode:
            deny("Context ledger refreshed but could not be staged: " +
                 (staged.stderr.strip() or staged.stdout.strip() or "git add failed"))

edit_target = (tool_input.get("file_path") or tool_input.get("notebook_path") or "")
write_targets = [edit_target] if tool_name in EDIT_TOOLS and edit_target else []
if tool_name == "Bash":
    write_targets = bash_write_paths(command, root)

# Recorded state is never hand-written, in any mode and at any plan status.
for candidate in write_targets:
    if in_factory_state(candidate, root):
        deny(FACTORY_STATE_MSG)

# The session lock covers every permission mode. Planning changes authorization
# for the plan UI, never for product or canon writes.
guard_product_writes(write_targets, root,
                     command=command if tool_name == "Bash" else "")
# A heredoc whose ONLY consumer is a data sink (cat/tee/printf/echo writing
# to a file) is data, never argv: its body is dropped before the companion
# classification so a note that mentions the companion, or holds a quote or
# backtick that breaks shlex, is not mistaken for a launch. Every other shape
# keeps its body and is classified as before — a body fed to sh/node/xargs,
# through a pipe, or followed by more text CAN carry a launch (`sh <<EOF`,
# `cat <<EOF | sh`), so nothing outside this exact shape is stripped.
HEREDOC_SINK_ARGV0 = {"cat", "tee", "printf", "echo"}
HEREDOC_NOTE = re.compile(
    r"\A(?P<head>[^\n]*?)<<-?[ \t]*(?P<q>['\"]?)(?P<word>\w+)(?P=q)"
    r"(?P<tail>[^\n]*)\n(?P<body>.*?)\n(?P=word)[ \t]*\n?\Z", re.DOTALL)


def _strip_note_heredoc(text: str) -> str:
    match = HEREDOC_NOTE.match(text)
    if match is None:
        return text
    head, tail = match.group("head"), match.group("tail")
    argv0 = re.match(r"[ \t]*(?:\w+=\S*[ \t]+)*([^\s<>|;&]+)", head)
    if (
        argv0 is None
        or Path(argv0.group(1)).name not in HEREDOC_SINK_ARGV0
        or re.search(r"[|;&`]|\$\(", head + tail)
    ):
        return text
    return text[:match.start("body")] + text[match.end("body"):]


classify_command = _strip_note_heredoc(command)
literal_command = classify_command.replace("''", "").replace('""', "")
shell_shape = re.sub(
    r"\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*", "", literal_command)
try:
    shell_tokens = shlex.split(classify_command)
except ValueError:
    if (
        tool_name == "Bash"
        and (
            "--write" in shell_shape
            or
            re.search(r"\bcodex-companion(?:\.mjs)?\b", shell_shape)
        )
    ):
        deny("Bash command could not be safely parsed, so Forge cannot verify "
             "that it respects the delegation and planning boundaries. Use "
             "`./forge delegate <task-id>` for a companion launch.")
    shell_tokens = []
compact_command = re.sub(r"[^a-z0-9]", "", shell_shape.lower())
has_companion = (
    re.search(r"\bcodex-companion(?:\.mjs)?\b", shell_shape) is not None
    or re.search(r"\$(?:\{)?(?=[A-Za-z_])[A-Za-z0-9_]*companion[A-Za-z0-9_]*",
                 classify_command, re.IGNORECASE) is not None
    or any(re.fullmatch(r"codex-companion(?:\.mjs)?", Path(token).name)
           for token in shell_tokens)
    or "codexcompanion" in compact_command
)
# Read-only companion runs are the /codex:rescue exploration lane and
# pass — but ONLY in a shape whose argv the hook can prove from text: a
# single simple command, no shell metacharacters, launching the
# companion directly (optionally via node). Anything else that mentions
# the companion is either a safe display command (rg/cat/...) or an
# unverifiable launch, which is denied: shell text cannot bound a child
# interpreter's computed argv, so we never try.
# `result <job-id>` only prints a stored job's output — the fetch path for a
# backgrounded read-only /codex:rescue run; `--background` merely detaches a
# read-only `task`. Neither can write (writes need --write, never allowlisted).
# `cancel`, `setup` and `task-worker` mutate state and stay denied.
READONLY_COMPANION_VERBS = {"status", "task", "task-resume-candidate", "result"}
READONLY_COMPANION_FLAGS = {"--model", "--effort", "--json", "--background"}
COMPANION_NAME = re.compile(r"codex-companion(?:\.mjs)?")
# No shell-capable pagers (less/more run "+!cmd" startup commands).
DISPLAY_SAFE_ARGV0 = {
    "rg", "grep", "cat", "head", "tail", "printf", "echo",
    "ls", "stat", "wc", "file", "md5", "shasum",
}


# Exec-capable or non-terminating options among DISPLAY_SAFE_ARGV0 tools,
# per tool: rg --pre / --pre-glob run a preprocessor command; tail -f / -F /
# --follow / --pid follow forever. Every other flag (grep -n, rg -i, tail -n,
# ls -la, head -c ...) only reads or formats, so a display command that
# merely MENTIONS the companion may carry them. Pager-style `+` tokens stay
# denied. Per tool, because `-f` is a harmless read flag for grep/stat.
DISPLAY_EXEC_OPTIONS = {
    "rg": ("--pre",),
    "tail": ("-f", "-F", "--follow", "--pid"),
}


def _display_safe(tokens):
    """Display command whose options cannot execute or hang."""
    denied = DISPLAY_EXEC_OPTIONS.get(Path(tokens[0]).name, ())
    return not any(
        t.startswith("+") or t.startswith(denied) for t in tokens[1:]
    )


def _has_active_shell_syntax(value: str) -> bool:
    """Shell syntax outside quotes (plus expansions inside double quotes)."""
    quote = None
    escaped = False
    for char in value:
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
            elif quote == '"' and char in "$`":
                return True
        elif char in "'\"":
            quote = char
        elif char in ";&|<>$`(){}\n*?~=[]":
            return True
    return False


def _companion_readonly_launch_ok():
    """True iff the command is a provably read-only companion launch."""
    if _has_active_shell_syntax(command):
        return False
    if not shell_tokens:
        return False
    argv0 = Path(shell_tokens[0]).name
    comp_idx = None
    for idx, token in enumerate(shell_tokens):
        if COMPANION_NAME.fullmatch(Path(token).name):
            comp_idx = idx
            break
    if comp_idx is None:
        # Companion referenced only inside larger tokens (prose/paths):
        # display commands may show it; anything else is unverifiable.
        return argv0 in DISPLAY_SAFE_ARGV0 and _display_safe(shell_tokens)
    if comp_idx == 0 or (comp_idx == 1 and argv0 in ("node", "nodejs")):
        rest = shell_tokens[comp_idx + 1:]
        # Verb allowlist, not a flag denylist: other subcommands (setup,
        # cancel, task-worker) mutate state without any write flag. Options
        # are default-deny too: --cwd can retarget other repos, and future
        # flags should not be trusted implicitly. The equals-sign form of
        # --prompt-file stays explicitly unsupported because active shell
        # syntax above refuses '='.
        if not rest or rest[0] not in READONLY_COMPANION_VERBS:
            return False
        args = rest[1:]
        prompt_flags = [idx for idx, token in enumerate(args)
                        if token == "--prompt-file"]
        if prompt_flags:
            if rest[0] != "task" or len(prompt_flags) != 1:
                return False
            prompt_idx = prompt_flags[0]
            if prompt_idx + 1 >= len(args) or args[prompt_idx + 1].startswith("-"):
                return False
            prompt_path = Path(args[prompt_idx + 1])
            if prompt_path.is_absolute() or ".." in prompt_path.parts:
                return False
            try:
                resolved_root = root.resolve()
                resolved_prompt = (resolved_root / prompt_path).resolve()
                valid_prompt = (resolved_prompt.is_relative_to(resolved_root)
                                and resolved_prompt.is_file())
            except (OSError, RuntimeError):
                valid_prompt = False
            if not valid_prompt:
                return False
            args = args[:prompt_idx] + args[prompt_idx + 2:]
        return all(
            not token.startswith("-") or token in READONLY_COMPANION_FLAGS
            for token in args
        )
    # Companion path appears under another executor (xargs, env, sh -c,
    # an interpreter): the final argv cannot be established from text.
    return argv0 in DISPLAY_SAFE_ARGV0 and _display_safe(shell_tokens)


if tool_name == "Bash" and has_companion and not _companion_readonly_launch_ok():
    deny("Companion launches are off-contract unless they are a provably "
         "read-only direct invocation (no write flags, no shell "
         "metacharacters, no wrapping executor). Use `./forge delegate "
         "<task-id>` for write work; it owns the argv launch and records "
         "evidence that `forge stage done` can verify.")

if run_state and not client_signoff(root)[0]:
    advancing = any(script in command for script in PHASE_ADVANCING)
    if "update_run.py" in command and "--phase" in command:
        advancing = advancing or any(phase in command for phase in GATED_PHASES)
    if advancing:
        deny(
            "Client sign-off not recorded. Get docs/decisions/NNNN-client-signoff.md "
            "accepted (non-empty confirmed_by), then run "
            "`python3 factory/scripts/record_signoff.py` before advancing the phase."
        )

print(json.dumps({}))
