#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

from factory_lib import (
    client_signoff, load_json, read_hook_input, repo_root, run_state_path,
)
from forge_cli.quickfix import claim_files, load_active, record_files
from forge_cli.repo_kind import is_harness_source_repo

payload = read_hook_input()
tool_name = payload.get("tool_name", "")
tool_input = payload.get("tool_input") or {}
command = (tool_input.get("command") or "").strip()
permission_mode = payload.get("permission_mode", "")


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    raise SystemExit(0)


# Planning lock: product writes are always refused until a plan is approved
# or a bounded quickfix is open. Planning surfaces stay available.
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
PLANNING_WRITE_OK = (
    "plans/", "docs/", ".gstack/", ".github/", "prototype/",
)
CLIENT_MACHINERY_WRITE_OK = (
    "factory/", "constitution/", "harness/", ".claude/", ".codex/",
)
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
PLANNING_WRITE_OK_FILES = {
    "AGENTS.md", "CLAUDE.md", "WORKFLOW.md", "harness.yaml", "README.md",
    ".gitignore", ".gitattributes", ".envrc",
    # session memory, not evidence — gitignored, and `forge note` appends to it
    ".factory/scratchpad.md",
}
# Files under .factory/ the evidence guard lets through — but that is the ONLY
# guard they skip. The scratchpad is also freely writable (PLANNING_WRITE_OK_FILES
# above). The repo-kind marker is deliberately NOT there: it is a product path,
# so the planning lock governs it — creating, editing, or DELETING it needs an
# approved plan or a quickfix. Disarming the source-repo lock therefore takes the
# same ceremony as any machinery change, never a silent hand-edit or `rm`.
FACTORY_STATE_WRITABLE = {
    ".factory/scratchpad.md",
    ".factory/harness-source.json",
}
# The repo-kind marker. It decides whether the machinery trees are product at
# all, so it may be changed ONLY under an approved plan + decomposition, never a
# quickfix: a quickfix that could `rm` it as its first claimed file would flip
# the repo to client-mode and let every later machinery write skip the budget
# entirely (defeating the very bound it exists to enforce). Under an approved
# plan the machinery is already writable, so removing the marker grants nothing.
HARNESS_SOURCE_MARKER = ".factory/harness-source.json"
PLAN_MODE_MSG = (
    "Planning lock is armed — product writes require an approved plan. "
    "Either enter plan mode (shift+tab) [PLAN MODE] and save the approved plan per "
    "factory/prompts/planner.md, or run `./forge quickfix start \"<reason>\"` "
    "for a bounded five-file fix."
)
QUICKFIX_LIMIT_MSG = (
    "Quickfix scope exceeded — this is not a quickfix, enter plan mode (shift+tab). "
    "The other planning-lock exit is `./forge quickfix start \"<reason>\"`, but the "
    "current window must be closed first."
)
MARKER_PLAN_ONLY_MSG = (
    f"{HARNESS_SOURCE_MARKER} is the repo-kind marker: it may be created, edited, "
    "or deleted ONLY under an approved plan with a recorded decomposition, never a "
    "quickfix. A quickfix that removed it could flip this repo to client-mode and "
    "escape its own file budget. Plan the change, or leave the marker alone."
)
OPAQUE_WRITE_MSG = (
    "Opaque delegated writes cannot use a quickfix because its five-file budget "
    "cannot be tracked. Either enter plan mode (shift+tab) [PLAN MODE] and save an "
    "approved plan, or use `./forge quickfix start \"<reason>\"` for direct edits "
    "whose product paths the hook can record."
)


def product_path(raw: str, root: Path, is_harness: bool) -> str | None:
    """Return a canonical repo-relative product path, otherwise None.

    is_harness is the EFFECTIVE repo kind: while a quickfix is open it is the
    value pinned at the window's start (not the live marker), so deleting the
    marker mid-window cannot change what counts as product.
    """
    value = raw.strip().strip("\"'")
    if not value or value in {"-", "/dev/null"}:
        return None
    # Unexpanded shell expansions ($HOME, $(pwd), backticks) cannot be
    # classified — the hook sees the literal, not the destination. Treat as
    # unknown rather than product: this guard defends drift, and a drifting
    # worker writes plain paths (decision 0013; artifact gates backstop).
    if "$" in value or "`" in value:
        return None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    try:
        rel = resolved.relative_to(root.resolve()).as_posix()
    except ValueError:
        return None
    if not rel or rel in PLANNING_WRITE_OK_FILES:
        return None
    exempt_prefixes = PLANNING_WRITE_OK
    if not is_harness:
        exempt_prefixes += CLIENT_MACHINERY_WRITE_OK
    if any(rel == prefix.rstrip("/") or rel.startswith(prefix)
           for prefix in exempt_prefixes):
        return None
    return rel


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
OPAQUE_QUICKFIX_MSG = (
    "This op touches an unbounded set of machinery files — a recursive/globbed "
    "delete, or a recursive/globbed copy or move INTO a machinery path — so a "
    "quickfix cannot honestly claim it against its budget. Enumerate the exact "
    "paths, or plan the change where the whole diff is measured."
)


def has_opaque_product_write(command: str, root: Path, is_harness: bool) -> bool:
    """An op whose exact product-file set can't be read from the literal command,
    so a quickfix cannot claim it: a recursive/globbed/brace DELETE of a product
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


def guard_product_writes(targets: list[str], state: dict, root: Path,
                         command: str = "") -> None:
    quickfix = load_active(root)
    # Effective repo kind: a live marker read, UNLESS a quickfix is open — then
    # the kind pinned at its start wins, so deleting the marker during the window
    # (by any means) cannot flip classification and let machinery escape the
    # budget. Fail-safe: an old window with no pin falls back to the live marker.
    if quickfix is not None and "harness_source" in quickfix:
        is_harness = bool(quickfix["harness_source"])
    else:
        is_harness = is_harness_source_repo(root)
    approved_and_decomposed = (state.get("plan_status") == "approved"
                               and state.get("decomposition_status") == "recorded")
    # Opaque check FIRST: a recursive/globbed op or a `cp -t`/dir copy can affect
    # product files the literal-target extractor never classifies, so `product`
    # may be empty even though the command hits machinery. Deny before any early
    # return, whether the repo is fully locked or a quickfix is open.
    if (command and not approved_and_decomposed
            and has_opaque_product_write(command, root, is_harness)):
        deny(OPAQUE_QUICKFIX_MSG)
    product = list(dict.fromkeys(
        rel for raw in targets if (rel := product_path(raw, root, is_harness)) is not None
    ))
    if not product:
        return
    if (any(_contains_marker(rel) for rel in product)
            and not approved_and_decomposed):
        # A quickfix must never be able to touch the marker (see its definition):
        # deleting it — directly, or by removing an ANCESTOR like `.factory` via
        # `rm -rf .factory` — would disable classification and the budget with it.
        # Only an approved, decomposed plan authorizes a marker change.
        deny(MARKER_PLAN_ONLY_MSG)
    if (state.get("plan_status") == "approved"
            and state.get("decomposition_status") == "recorded"):
        # The plan already authorizes this write. Recording only observes it:
        # it neither applies the quickfix budget nor changes the return below.
        record_files(root, product)
    if state.get("plan_status") == "approved":
        # An approved plan is not yet an implementation licence: the bounded
        # tasks are what implementation is measured against, and a write before
        # the decomposition exists belongs to no task (AGENTS.md phase 4).
        if state.get("decomposition_status") == "recorded":
            return
        if not quickfix:
            deny(
                "Plan approved, but no decomposition is recorded — implementation "
                "is bounded by tasks, so a product write now belongs to no task. "
                "Record it: python3 factory/scripts/record_decomposition_from_json.py "
                "--input /tmp/decomposition.json (or open a bounded window: "
                "./forge quickfix start \"<reason>\")."
            )
    # An open window does not skip this: each product file it touches must be
    # claimed against the budget, which is what bounds the escape hatch.
    if not quickfix:
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
run_state = load_json(run_state_path(root), default={})

edit_target = (tool_input.get("file_path") or tool_input.get("notebook_path") or "")
write_targets = [edit_target] if tool_name in EDIT_TOOLS and edit_target else []
if tool_name == "Bash":
    write_targets = bash_write_paths(command, root)

# Recorded state is never hand-written, in any mode and at any plan status.
for candidate in write_targets:
    if in_factory_state(candidate, root):
        deny(FACTORY_STATE_MSG)

# The lock covers plan mode too: plan mode stops the Edit tools, not a Bash
# redirect, and writing product code while planning is the thing being stopped.
if permission_mode != "plan" or tool_name == "Bash":
    guard_product_writes(write_targets, run_state, root,
                         command=command if tool_name == "Bash" else "")
literal_command = command.replace("''", "").replace('""', "")
shell_shape = re.sub(
    r"\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*", "", literal_command)
try:
    shell_tokens = shlex.split(command)
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
COMPANION_WRITE_FLAGS = {
    "--write", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
}
READONLY_COMPANION_VERBS = {"task", "task-resume-candidate"}
READONLY_COMPANION_FLAGS = {"--model", "--effort", "--json"}
COMPANION_METACHARS = re.compile("[;&|<>$`(){}\n*?~\\=\\[\\]]|\x27\x27|\x22\x22")
COMPANION_NAME = re.compile(r"codex-companion(?:\.mjs)?")
# No shell-capable pagers (less/more run "+!cmd" startup commands).
DISPLAY_SAFE_ARGV0 = {
    "rg", "grep", "cat", "head", "tail", "printf", "echo",
    "ls", "stat", "wc", "file", "md5", "shasum",
}


def _display_safe(tokens):
    """Display command with NO option tokens: some display tools grow
    exec options (rg --pre, tail --pid); bare invocations have none."""
    return not any(t.startswith(("-", "+")) for t in tokens[1:])


def _companion_readonly_launch_ok():
    """True iff the command is a provably read-only companion launch."""
    if COMPANION_METACHARS.search(command):
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
        # are default-deny too: --prompt-file and --cwd can exfiltrate
        # arbitrary local files / retarget other repos, and future flags
        # should not be trusted implicitly.
        if not rest or rest[0] not in READONLY_COMPANION_VERBS:
            return False
        return all(
            not token.startswith("-") or token in READONLY_COMPANION_FLAGS
            for token in rest[1:]
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
