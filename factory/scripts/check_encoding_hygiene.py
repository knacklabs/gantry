#!/usr/bin/env python3
"""Enforce explicit UTF-8 at every text I/O boundary in factory scripts."""

from __future__ import annotations

import ast
import hashlib
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "factory" / "scripts"


@dataclass(frozen=True)
class ContentPin:
    path: str
    fingerprint: str
    occurrence: int = 0


def _pin(path: str, fingerprint: str, occurrence: int = 0) -> ContentPin:
    return ContentPin(path, fingerprint, occurrence)

# These byte/lossless paths are intentional and must not be converted to
# replacement-decoded text.  The scanner already ignores binary modes; this
# inventory makes the review-sensitive exceptions explicit and auditable.
BYTE_PATH_ALLOWLIST: tuple[tuple[ContentPin, str], ...] = (
    (_pin("factory/scripts/factory_lib.py", "4ad0c6dbd733d15fdba23183a161dfd905dc2f49b1617dcb5af7423eb5acf106"), "git merge-base path"), (_pin("factory/scripts/factory_lib.py", "4326f6597b693386fa4e0ca59e463b00eae3bb0871ed1966ccb73ef5e48f4ccc"), "git worktree root path"),
    (_pin("factory/scripts/factory_lib.py", "dfe55c6b17d233d8e81d85a93aedc3ae481685125f53af168888bbaec5b1f4af"), "git status paths"), (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 2), "git index paths"),
    (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 3), "git diff --name-only output (grounding staleness sweep)"), (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 3), "git diff paths"),
    (_pin("factory/scripts/forge_cli/stages.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 1), "git diff --no-index numstat for untracked budget counting"),
    # Lossless git path captures. These exact sites may use surrogateescape.
    (_pin("factory/scripts/check_dual_runtime.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git ls-files paths"), (_pin("factory/scripts/check_dual_runtime.py", "38256a6f6b02ff496f24d305861a51c39aa5d3c29bda98fc038c3b6ba87b240e"), "git toplevel path"),
    (_pin("factory/scripts/check_pr_ticket.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 1), "git diff paths"),
    (_pin("factory/scripts/check_refactor_delta.py", "00d790d343d9fcf34ed9718193de678dcf76c0fb9b13424117b233f52155d920"), "git numstat paths"), (_pin("factory/scripts/check_repo_budget.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git ls-files paths"), (_pin("factory/scripts/check_repo_budget.py", "e9af62e10b3f1ee51caba8710f8c8e3ce6496386cc1e82bb59a027ebc44c0950"), "git toplevel path"),
    (_pin("factory/scripts/check_repo_budget.py", "7e2cdb4c1926c667b35c075a296079925b85a82bf8055025bab1e81d8d029412"), "git ls-files paths"),
    (_pin("factory/scripts/factory_lib.py", "38256a6f6b02ff496f24d305861a51c39aa5d3c29bda98fc038c3b6ba87b240e"), "git toplevel path"), (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git control directory path"),
    (_pin("factory/scripts/factory_lib.py", "4326f6597b693386fa4e0ca59e463b00eae3bb0871ed1966ccb73ef5e48f4ccc"), "git worktree root path"), (_pin("factory/scripts/factory_lib.py", "dfe55c6b17d233d8e81d85a93aedc3ae481685125f53af168888bbaec5b1f4af"), "git status paths"),
    (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 2), "git diff paths"), (_pin("factory/scripts/forge_cli/adopt.py", "e7b730a595dde31704ca26b6941be09a2c4788668fe7cce19fa75be66f0d1a3a"), "git status paths"),
    (_pin("factory/scripts/forge_cli/audit.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git ls-files paths"), (_pin("factory/scripts/forge_cli/audit.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git ls-files paths"),
    (_pin("factory/scripts/forge_cli/lessons.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git diff and ls-files paths"), (_pin("factory/scripts/forge_cli/phase.py", "e7b730a595dde31704ca26b6941be09a2c4788668fe7cce19fa75be66f0d1a3a"), "git status paths"), (_pin("factory/scripts/forge_cli/phase.py", "e7b730a595dde31704ca26b6941be09a2c4788668fe7cce19fa75be66f0d1a3a"), "git status paths"),
    (_pin("factory/scripts/forge_cli/project.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 2), "git ls-tree paths"), (_pin("factory/scripts/forge_cli/quickfix.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "decoded git path bytes"),
    (_pin("factory/scripts/forge_cli/sanitise.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "decoded git path bytes"), (_pin("factory/scripts/forge_cli/sanitise.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 1), "git rm path diagnostics"),
    (_pin("factory/scripts/forge_cli/stages.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "decoded git path bytes"), (_pin("factory/scripts/forge_cli/upgrade.py", "3def57d2ef8e58b66ac3627b03d1e5c44b28f79f74b9d5cb67626f631442ebc2", 1), "decoded git path bytes"),
    (_pin("factory/scripts/forge_cli/upgrade.py", "17a81292ed3b54775bd2b53fcc5dd8b93e3fefc9ff5de344227374a4affcfb8a"), "indexed symlink target bytes"), (_pin("factory/scripts/forge_cli/upgrade.py", "bc670a317ffe7404fcaa6c76ea386577280b024002ec91e653eaca942c29bad1"), "indexed symlink path bytes"),
    (_pin("factory/scripts/forge_cli/upgrade.py", "3def57d2ef8e58b66ac3627b03d1e5c44b28f79f74b9d5cb67626f631442ebc2"), "decoded git path bytes"), (_pin("factory/scripts/forge_cli/upgrade.py", "a0dca3a357e54399cdff638e3221989d819a7ab5326a2855a2635ffd80778eb1"), "git status paths"),
    (_pin("factory/scripts/forge_cli/upgrade.py", "df519031f73eaa05f29a2400e047d6df86e063ffc9d6da960673d1b58377bf7e"), "git path output"),
    (_pin("factory/scripts/pr_ready.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git freshness paths"), (_pin("factory/scripts/pr_ready.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "git freshness paths"),
    (_pin("factory/scripts/pre_tool_use.py", "b8f1600045705ee2e7878b4a4335e7a58250f20286e39a8edc3bf2a01806f15b"), "git path output"), (_pin("factory/scripts/pre_tool_use.py", "0bb8fafe2022eacf21fe2b83887b18a12e0d176180642715b5a25d288ab39d1d"), "git unmerged paths"), (_pin("factory/scripts/pre_tool_use.py", "b8f1600045705ee2e7878b4a4335e7a58250f20286e39a8edc3bf2a01806f15b"), "git context-ledger staging paths"),
    # Task-level shipping (0047): lossless git subprocess captures.
    (_pin("factory/scripts/factory_lib.py", "70743b2c238d8a02f270f4bcdf7735b12f01ba8e074faefa8a4950542098b038"), "git fetch origin/main output"),
    (_pin("factory/scripts/factory_lib.py", "8fbba4427985a266637ed43d2e2c07f15b87872aa7ed4a6a38706554ffe77fc7"), "git cat-file task marker check"),
    (_pin("factory/scripts/factory_lib.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 4), "git symbolic-ref current branch"),
    (_pin("factory/scripts/forge_cli/tasks.py", "13ca18bc3a83fc8ca32a3b0c9cfee255553c1003eefa3668574bdf8804e69ad9"), "git subprocess helper output"),
    (_pin("factory/scripts/forge_cli/tasks.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"), "gh pr create output"),
)

# These sites must remain byte-mode. check_file verifies that every entry still
# names a call and refuses text=True, universal_newlines, encoding, or errors.
BYTE_MODE_ALLOWLIST: tuple[tuple[ContentPin, str], ...] = (
    (_pin("factory/scripts/check_dual_runtime.py", "69a07f6ea79309463348ea4464a632c901b5844915015094f69884c9248f135e"), "copy detection bytes"), (_pin("factory/scripts/forge_cli/doctor.py", "e016ed56ac87b2d49d7dbb6c7b67cb3fb2113ffdd2c8c541a3c4bbeea6488c4d"), "shell probe bytes"),
    (_pin("factory/scripts/forge_cli/upgrade.py", "ab783c0e8a603cf3b76256c6af19fccd53d48f00a895d6262a24875c9d10a389"), "NUL-delimited paths"), (_pin("factory/scripts/forge_cli/upgrade.py", "ab783c0e8a603cf3b76256c6af19fccd53d48f00a895d6262a24875c9d10a389", 1), "indexed paths"),
    (_pin("factory/scripts/forge_cli/upgrade.py", "18fcd414cc60953c90181344a98634945bf00dd00753219231974f9e12c697ba"), "indexed symlink blob"), (_pin("factory/scripts/forge_cli/upgrade.py", "f7b2b42a2187263d2f9de4faf387c54c64ecf5c8b92d92315d5028399de8e13a"), "NUL-delimited grep paths"),
    (_pin("factory/scripts/pr_ready.py", "227b092c1f2b3e396f86c172d4908bf8b12f05a5ab8a6820bc9c8f44d68c05fd"), "update-ref byte mode"),
)

# Filled with exact file:line call sites after the sweep.  Only diagnostics,
# console reconfiguration, and worker-log read-back belong here.
REPLACE_ALLOWLIST: tuple[ContentPin, ...] = (
    _pin("factory/scripts/forge_cli/doctor.py", "0bb8fafe2022eacf21fe2b83887b18a12e0d176180642715b5a25d288ab39d1d", 1), _pin("factory/scripts/forge_cli/delegate.py", "52b16e4813cdf0877d46fa535febf6dd5ef5d75b88de4a4c0a833fea81959ea7"),
    _pin("factory/scripts/forge_cli/stages.py", "20fceedc51a075e792fba9e0338f98ea4e99aab8019144bce770e4601c5ee20a", 1), _pin("factory/scripts/forge_cli/stages.py", "c94d0727342455ffac97fce3c6865421242c03f535b7ebff0c45ae878685e01f"),
    _pin("factory/scripts/check_dual_runtime.py", "5f0fbd72b30fb35378eb98dabfb9013ab557d8ee9a608724f3c63f47ff53bf6b"), _pin("factory/scripts/factory_lib.py", "1f62e74bfdb6534a502d82f64cc6ebd68fcb44b1a36cf2465eaebb501b65e21e"),
    _pin("factory/scripts/forge_cli/doctor.py", "0eba86ba778a367fac91e65d9786366ba8a7bb42ab84494ebaa593930e5c5863"), _pin("factory/scripts/check_repo_budget.py", "5f0fbd72b30fb35378eb98dabfb9013ab557d8ee9a608724f3c63f47ff53bf6b"), _pin("factory/scripts/check_dual_runtime.py", "4ad7ceb903808af0a648da708763f94e38e697eceee6faf9401bbf0f9a384659"),
    _pin("factory/scripts/forge_cli/stages.py", "20fceedc51a075e792fba9e0338f98ea4e99aab8019144bce770e4601c5ee20a"), _pin("factory/scripts/forge_cli/doctor.py", "0bb8fafe2022eacf21fe2b83887b18a12e0d176180642715b5a25d288ab39d1d", 2), _pin("factory/scripts/forge_cli/doctor.py", "0bb8fafe2022eacf21fe2b83887b18a12e0d176180642715b5a25d288ab39d1d"),
    _pin("factory/scripts/forge_cli/delegate.py", "01f73bb886befe6848bc4c69342e27095bd0f7bafd5d0eee1e48c787a15b8b60"), _pin("factory/scripts/factory_lib.py", "5f0fbd72b30fb35378eb98dabfb9013ab557d8ee9a608724f3c63f47ff53bf6b"), _pin("factory/scripts/check_agents_hygiene.py", "5f0fbd72b30fb35378eb98dabfb9013ab557d8ee9a608724f3c63f47ff53bf6b"),
    _pin("factory/scripts/forge_cli/doctor.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 2), _pin("factory/scripts/forge_cli/doctor.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"),
    _pin("factory/scripts/forge_cli/doctor.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a", 1), _pin("factory/scripts/check_factory_scaffold.py", "5f0fbd72b30fb35378eb98dabfb9013ab557d8ee9a608724f3c63f47ff53bf6b"), _pin("factory/scripts/forge_cli/common.py", "8a2e66903fca9ef3a2c5c2ad0bc8bda60d14cf90c9d6f3e664bf62e6c8dc746a"),
    _pin("factory/scripts/factory_lib.py", "1f62e74bfdb6534a502d82f64cc6ebd68fcb44b1a36cf2465eaebb501b65e21e"), _pin("factory/scripts/forge_cli/stages.py", "c94d0727342455ffac97fce3c6865421242c03f535b7ebff0c45ae878685e01f", 1),
)

STDIN_ALLOWLIST: tuple[ContentPin, ...] = (
    _pin("factory/scripts/pre_tool_use.py", "e87c0002fa3aedcd1279d75b35f65d75f8f5e0c4ab3af29bc757621306c04e05"), _pin("factory/scripts/factory_lib.py", "3ce68f1918dc98ff169cc09fdac24d23a481167067341201941dcdd63a57f671"), _pin("factory/scripts/factory_lib.py", "3ce68f1918dc98ff169cc09fdac24d23a481167067341201941dcdd63a57f671"),
)


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    rule: str
    message: str

    def render(self, root: Path) -> str:
        try:
            display = self.path.relative_to(root)
        except ValueError:
            display = self.path
        return f"{display}:{self.line}: {self.rule}: {self.message}"


def construct_fingerprint(line: str) -> str:
    return hashlib.sha256(line.strip().encode("utf-8")).hexdigest()


def _pins(
    allowlist: tuple[ContentPin, ...] | tuple[tuple[ContentPin, str], ...],
) -> tuple[ContentPin, ...]:
    return tuple(entry[0] if isinstance(entry, tuple) else entry
                 for entry in allowlist)


def _resolve_pins(
    path: Path,
    relative: str,
    source: str,
    allowlist: tuple[ContentPin, ...] | tuple[tuple[ContentPin, str], ...],
    rule: str,
) -> tuple[set[int], list[Violation]]:
    resolved: dict[tuple[str, int], int] = {}
    occurrences: dict[str, int] = {}
    for line_number, line in enumerate(source.splitlines(), 1):
        fingerprint = construct_fingerprint(line)
        occurrence = occurrences.get(fingerprint, 0)
        resolved[(fingerprint, occurrence)] = line_number
        occurrences[fingerprint] = occurrence + 1
    lines: set[int] = set()
    violations: list[Violation] = []
    for pin in _pins(allowlist):
        if pin.path != relative:
            continue
        line_number = resolved.get((pin.fingerprint, pin.occurrence))
        if line_number is not None:
            lines.add(line_number)
            continue
        violations.append(Violation(
            path, 1, rule,
            "allowlisted construct changed or was removed; re-review the pin",
        ))
    return lines, violations


def _literal_keyword(call: ast.Call, name: str) -> object:
    for keyword in call.keywords:
        if keyword.arg == name and isinstance(keyword.value, ast.Constant):
            return keyword.value.value
    return None


def _has_keyword(call: ast.Call, name: str) -> bool:
    return any(keyword.arg == name for keyword in call.keywords)


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((kw.value for kw in call.keywords if kw.arg == name), None)


def _call_name(call: ast.Call) -> str:
    parts: list[str] = []
    node: ast.expr = call.func
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _mode(call: ast.Call, *, positional_index: int = 1) -> object:
    keyword_mode = _literal_keyword(call, "mode")
    if keyword_mode is not None:
        return keyword_mode
    if (
        len(call.args) > positional_index
        and isinstance(call.args[positional_index], ast.Constant)
    ):
        return call.args[positional_index].value
    return None


def _is_text_open(call: ast.Call, name: str) -> bool:
    if name == "io.TextIOWrapper":
        return True
    if name in {"tempfile.TemporaryFile", "tempfile.NamedTemporaryFile"}:
        mode = _mode(call, positional_index=0)
        return isinstance(mode, str) and "b" not in mode
    if isinstance(call.func, ast.Name) and call.func.id == "open":
        mode = _mode(call)
    elif name == "io.open":
        mode = _mode(call)
    elif (
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "open"
        and not name.startswith(("os.", "webbrowser."))
    ):
        mode = _mode(call, positional_index=0)
    else:
        return False
    return not (isinstance(mode, str) and "b" in mode)


def _is_subprocess_text(
    call: ast.Call,
    name: str,
    subprocess_module_aliases: set[str],
    pipe_aliases: set[str],
) -> bool:
    if name not in {
        "subprocess.run",
        "subprocess.Popen",
        "subprocess.call",
        "subprocess.check_call",
        "subprocess.check_output",
    }:
        return False
    text_mode = (
        _literal_keyword(call, "text") is True
        or _literal_keyword(call, "universal_newlines") is True
        or _has_keyword(call, "encoding")
        or _has_keyword(call, "errors")
    )
    if not text_mode:
        return False
    if name == "subprocess.check_output" or _has_keyword(call, "input"):
        return True
    if _literal_keyword(call, "capture_output") is True:
        return True
    pipe_keywords = {"stdout", "stderr"}
    if name == "subprocess.Popen":
        pipe_keywords.add("stdin")

    def is_pipe(value: ast.expr) -> bool:
        return (
            isinstance(value, ast.Attribute)
            and isinstance(value.value, ast.Name)
            and value.value.id in subprocess_module_aliases
            and value.attr == "PIPE"
        ) or (
            isinstance(value, ast.Name)
            and value.id in pipe_aliases
        )

    return any(
        keyword.arg in pipe_keywords and is_pipe(keyword.value)
        for keyword in call.keywords
    )


def _is_sys_stdin(
    node: ast.AST, sys_aliases: set[str], stdin_aliases: set[str],
) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id in sys_aliases
        and node.attr == "stdin"
    ) or (
        isinstance(node, ast.Name) and node.id in stdin_aliases
    ) or (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "getattr"
        and len(node.args) >= 2
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id in sys_aliases
        and isinstance(node.args[1], ast.Constant)
        and node.args[1].value == "stdin"
    )


def check_file(
    path: Path,
    *,
    root: Path = ROOT,
    replace_allowlist: tuple[ContentPin, ...] = REPLACE_ALLOWLIST,
    byte_path_allowlist: tuple[tuple[ContentPin, str], ...] = BYTE_PATH_ALLOWLIST,
    byte_mode_allowlist: tuple[tuple[ContentPin, str], ...] = BYTE_MODE_ALLOWLIST,
    stdin_allowlist: tuple[ContentPin, ...] = STDIN_ALLOWLIST,
) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeError, SyntaxError) as exc:
        return [Violation(path, getattr(exc, "lineno", 1) or 1, "parse", str(exc))]

    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        relative = path.as_posix()

    resolved_allowlists: list[set[int]] = []
    violations: list[Violation] = []
    for allowlist, rule in (
        (replace_allowlist, "errors-policy"),
        (byte_path_allowlist, "errors-policy"),
        (byte_mode_allowlist, "byte-mode"),
        (stdin_allowlist, "stdin"),
    ):
        lines, pin_violations = _resolve_pins(
            path, relative, source, allowlist, rule)
        resolved_allowlists.append(lines)
        violations.extend(pin_violations)
    replace_lines, byte_path_lines, byte_mode_lines, stdin_lines = resolved_allowlists

    subprocess_aliases = {"subprocess": "subprocess"}
    subprocess_module_aliases = {"subprocess"}
    tempfile_aliases = {"tempfile": "tempfile"}
    pipe_aliases: set[str] = set()
    sys_aliases = {"sys"}
    stdin_aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "subprocess":
                    local_name = alias.asname or alias.name
                    subprocess_aliases[local_name] = "subprocess"
                    subprocess_module_aliases.add(local_name)
                elif alias.name == "sys":
                    sys_aliases.add(alias.asname or alias.name)
                elif alias.name == "tempfile":
                    tempfile_aliases[alias.asname or alias.name] = "tempfile"
        elif isinstance(node, ast.ImportFrom) and node.module == "subprocess":
            for alias in node.names:
                subprocess_aliases[alias.asname or alias.name] = (
                    f"subprocess.{alias.name}"
                )
                if alias.name == "PIPE":
                    pipe_aliases.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module == "tempfile":
            for alias in node.names:
                tempfile_aliases[alias.asname or alias.name] = (
                    f"tempfile.{alias.name}"
                )
        elif isinstance(node, ast.ImportFrom) and node.module == "sys":
            for alias in node.names:
                if alias.name == "stdin":
                    stdin_aliases.add(alias.asname or alias.name)

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)
        head, separator, tail = name.partition(".")
        if head in subprocess_aliases:
            name = subprocess_aliases[head] + (separator + tail if separator else "")
        elif head in tempfile_aliases:
            name = tempfile_aliases[head] + (separator + tail if separator else "")
        if _is_subprocess_text(
            node, name, subprocess_module_aliases, pipe_aliases,
        ):
            encoding = _literal_keyword(node, "encoding")
            if encoding != "utf-8":
                violations.append(Violation(
                    path, node.lineno, "subprocess-text",
                    "text capture requires literal encoding='utf-8'",
                ))

        is_path_text = (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"read_text", "write_text"}
        )
        if is_path_text or _is_text_open(node, name):
            encoding = _literal_keyword(node, "encoding")
            if encoding != "utf-8":
                violations.append(Violation(
                    path, node.lineno, "text-file",
                    "text file I/O requires literal encoding='utf-8'",
                ))

        errors = _keyword(node, "errors")
        if errors is not None:
            value = errors.value if isinstance(errors, ast.Constant) else object()
            if value in {None, "strict"}:
                pass
            elif value == "replace" and node.lineno in replace_lines:
                pass
            elif value == "surrogateescape" and node.lineno in byte_path_lines:
                pass
            else:
                violations.append(Violation(
                    path, node.lineno, "errors-policy",
                    "non-strict errors policy is not content-allowlisted",
                ))

    calls_by_line = {
        node.lineno: node for node in ast.walk(tree) if isinstance(node, ast.Call)
    }
    for line_number in byte_mode_lines:
        call = calls_by_line.get(line_number)
        if call is None:
            violations.append(Violation(
                path, line_number, "byte-mode",
                "allowlisted content no longer names a call; re-review the pin",
            ))
            continue
        if (
            _literal_keyword(call, "text") is True
            or _literal_keyword(call, "universal_newlines") is True
            or _has_keyword(call, "encoding")
            or _has_keyword(call, "errors")
        ):
            violations.append(Violation(
                path, call.lineno, "byte-mode",
                "allowlisted DO-NOT site must remain byte-mode",
            ))

    for node in ast.walk(tree):
        is_input = (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "input"
        )
        if not (is_input or _is_sys_stdin(node, sys_aliases, stdin_aliases)):
            continue
        if node.lineno not in stdin_lines:
            violations.append(Violation(
                path, node.lineno, "stdin",
                "stdin access is not the allowlisted strict UTF-8 reader",
            ))
    return violations


def check_paths(
    paths: Iterable[Path],
    *,
    root: Path = ROOT,
    replace_allowlist: tuple[ContentPin, ...] = REPLACE_ALLOWLIST,
    byte_path_allowlist: tuple[tuple[ContentPin, str], ...] = BYTE_PATH_ALLOWLIST,
    byte_mode_allowlist: tuple[tuple[ContentPin, str], ...] = BYTE_MODE_ALLOWLIST,
    stdin_allowlist: tuple[ContentPin, ...] = STDIN_ALLOWLIST,
) -> list[Violation]:
    violations: list[Violation] = []
    for path in sorted(paths):
        violations.extend(check_file(
            path, root=root, replace_allowlist=replace_allowlist,
            byte_path_allowlist=byte_path_allowlist,
            byte_mode_allowlist=byte_mode_allowlist,
            stdin_allowlist=stdin_allowlist,
        ))
    if root == ROOT:
        inventories = ((replace_allowlist, "errors-policy"),
                       (byte_path_allowlist, "errors-policy"),
                       (byte_mode_allowlist, "byte-mode"),
                       (stdin_allowlist, "stdin"))
        for allowlist, rule in inventories:
            for pin in _pins(allowlist):
                pinned_path = root / pin.path
                if not pinned_path.is_file():
                    violations.append(Violation(
                        pinned_path, 1, rule, "allowlisted file was removed; "
                        "re-review the pin"))
    return violations


def main() -> int:
    paths = (
        path for path in SCRIPTS.rglob("*.py")
        if "__pycache__" not in path.parts
    )
    violations = check_paths(paths)
    if violations:
        for violation in violations:
            print(violation.render(ROOT))
        print(f"encoding hygiene: FAIL ({len(violations)} violation(s))")
        return 1
    print("encoding hygiene: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
