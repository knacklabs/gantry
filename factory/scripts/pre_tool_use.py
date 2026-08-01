#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

from factory_lib import (
    client_signoff, load_json, read_hook_input, repo_root, run_state_path,
)
from forge_cli.quickfix import claim_files, load_active

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
    "plans/", "docs/", "factory/", ".claude/", ".codex/",
    ".gstack/", ".github/", "constitution/", "harness/", "prototype/",
)
# .factory/ is deliberately NOT writable by hand: run.json holds plan_status,
# so a hand-edit disarms this very lock, and AGENTS.md already requires that
# evidence enter .factory/ only through the record_* scripts. Those scripts
# write it as themselves — this guard classifies tool-call targets, not what a
# sanctioned script does internally. The scratchpad is the one hand-written
# file there, and `forge note` writes it.
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
OPAQUE_WRITE_MSG = (
    "Opaque delegated writes cannot use a quickfix because its five-file budget "
    "cannot be tracked. Either enter plan mode (shift+tab) [PLAN MODE] and save an "
    "approved plan, or use `./forge quickfix start \"<reason>\"` for direct edits "
    "whose product paths the hook can record."
)


def product_path(raw: str, root: Path) -> str | None:
    """Return a canonical repo-relative product path, otherwise None."""
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
    if any(rel == prefix.rstrip("/") or rel.startswith(prefix)
           for prefix in PLANNING_WRITE_OK):
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
    """True when a write target lands inside .factory/ (excluding the scratchpad)."""
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
    return rel.startswith(".factory/") and rel != ".factory/scratchpad.md"


def bash_write_paths(value: str) -> list[str]:
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
        if command_name not in {"tee", "sed", "cp", "mv", "touch"}:
            continue
        args = tokens[command_index + 1:]
        operands = [token for token in args
                    if not token.startswith("-") and token not in {">", ">>"}]
        if command_name == "tee":
            found.extend(operands)
        elif command_name == "touch":
            found.extend(operands)
        elif command_name == "cp" and operands:
            found.append(operands[-1])
        elif command_name == "mv":
            found.extend(operands)
        elif command_name == "sed" and any(
            token == "-i" or token.startswith("-i") or token.startswith("--in-place")
            for token in args
        ) and operands:
            found.append(operands[-1])
    return found


def guard_product_writes(targets: list[str], state: dict, root: Path) -> None:
    product = list(dict.fromkeys(
        rel for raw in targets if (rel := product_path(raw, root)) is not None
    ))
    if not product:
        return
    if state.get("plan_status") == "approved":
        # An approved plan is not yet an implementation licence: the bounded
        # tasks are what implementation is measured against, and a write before
        # the decomposition exists belongs to no task (AGENTS.md phase 4).
        if state.get("decomposition_status") == "recorded":
            return
        if not load_active(root):
            deny(
                "Plan approved, but no decomposition is recorded — implementation "
                "is bounded by tasks, so a product write now belongs to no task. "
                "Record it: python3 factory/scripts/record_decomposition_from_json.py "
                "--input /tmp/decomposition.json (or open a bounded window: "
                "./forge quickfix start \"<reason>\")."
            )
    # An open window does not skip this: each product file it touches must be
    # claimed against the budget, which is what bounds the escape hatch.
    quickfix = load_active(root)
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
    write_targets = bash_write_paths(command)

# Recorded state is never hand-written, in any mode and at any plan status.
for candidate in write_targets:
    if in_factory_state(candidate, root):
        deny(FACTORY_STATE_MSG)

# The lock covers plan mode too: plan mode stops the Edit tools, not a Bash
# redirect, and writing product code while planning is the thing being stopped.
if permission_mode != "plan" or tool_name == "Bash":
    guard_product_writes(write_targets, run_state, root)
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
if tool_name == "Bash" and has_companion:
    deny("Direct Codex companion commands are off-contract. Use "
         "`./forge delegate <task-id>`; it owns the argv launch and records "
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
