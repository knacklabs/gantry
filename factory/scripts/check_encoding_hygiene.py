#!/usr/bin/env python3
"""Enforce explicit UTF-8 at every text I/O boundary in factory scripts."""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "factory" / "scripts"

# These byte/lossless paths are intentional and must not be converted to
# replacement-decoded text.  The scanner already ignores binary modes; this
# inventory makes the review-sensitive exceptions explicit and auditable.
BYTE_PATH_ALLOWLIST: dict[str, str] = {
    "factory/scripts/factory_lib.py:1239": "git diff --name-only output (grounding staleness sweep)",
    "factory/scripts/forge_cli/stages.py:644": "git diff --no-index numstat for untracked budget counting",
    # Lossless git path captures. These exact sites may use surrogateescape.
    "factory/scripts/check_dual_runtime.py:478": "git ls-files paths",
    "factory/scripts/check_dual_runtime.py:541": "git toplevel path",
    "factory/scripts/check_pr_ticket.py:62": "git diff paths",
    "factory/scripts/check_refactor_delta.py:51": "git numstat paths",
    "factory/scripts/check_repo_budget.py:44": "git ls-files paths",
    "factory/scripts/check_repo_budget.py:54": "git toplevel path",
    "factory/scripts/check_repo_budget.py:57": "git ls-files paths",
    "factory/scripts/factory_lib.py:32": "git toplevel path",
    "factory/scripts/factory_lib.py:504": "git toplevel path",
    "factory/scripts/factory_lib.py:511": "git toplevel path",
    "factory/scripts/factory_lib.py:928": "git status paths",
    "factory/scripts/factory_lib.py:1006": "git diff paths",
    "factory/scripts/forge_cli/adopt.py:185": "git status paths",
    "factory/scripts/forge_cli/audit.py:95": "git ls-files paths",
    "factory/scripts/forge_cli/lessons.py:63": "git diff and ls-files paths",
    "factory/scripts/forge_cli/phase.py:25": "git status paths",
    "factory/scripts/forge_cli/project.py:138": "git ls-tree paths",
    "factory/scripts/forge_cli/quickfix.py:294": "decoded git path bytes",
    "factory/scripts/forge_cli/sanitise.py:20": "decoded git path bytes",
    "factory/scripts/forge_cli/sanitise.py:104": "git rm path diagnostics",
    "factory/scripts/forge_cli/stages.py:155": "decoded git path bytes",
    "factory/scripts/forge_cli/upgrade.py:163": "decoded git path bytes",
    "factory/scripts/forge_cli/upgrade.py:329": "indexed symlink target bytes",
    "factory/scripts/forge_cli/upgrade.py:332": "indexed symlink path bytes",
    "factory/scripts/forge_cli/upgrade.py:364": "decoded git path bytes",
    "factory/scripts/forge_cli/upgrade.py:425": "git status paths",
    "factory/scripts/forge_cli/upgrade.py:663": "git path output",
    "factory/scripts/pr_ready.py:251": "git freshness paths",
    "factory/scripts/pre_tool_use.py:481": "git path output",
}

# These sites must remain byte-mode. check_file verifies that every entry still
# names a call and refuses text=True, universal_newlines, encoding, or errors.
BYTE_MODE_ALLOWLIST: dict[str, str] = {
    "factory/scripts/check_dual_runtime.py:108": "copy detection bytes",
    "factory/scripts/forge_cli/doctor.py:291": "shell probe bytes",
    "factory/scripts/forge_cli/upgrade.py:159": "NUL-delimited paths",
    "factory/scripts/forge_cli/upgrade.py:314": "indexed paths",
    "factory/scripts/forge_cli/upgrade.py:324": "indexed symlink blob",
    "factory/scripts/forge_cli/upgrade.py:355": "NUL-delimited grep paths",
    "factory/scripts/pr_ready.py:349": "update-ref byte mode",
}

# Filled with exact file:line call sites after the sweep.  Only diagnostics,
# console reconfiguration, and worker-log read-back belong here.
REPLACE_ALLOWLIST: frozenset[str] = frozenset({
    "factory/scripts/check_agents_hygiene.py:9",
    "factory/scripts/check_dual_runtime.py:19",
    # Diagnostic matcher: replacement preserves ASCII prototype/import markers.
    "factory/scripts/check_dual_runtime.py:492",
    "factory/scripts/check_factory_scaffold.py:9",
    "factory/scripts/check_repo_budget.py:19",
    "factory/scripts/factory_lib.py:26",
    "factory/scripts/factory_lib.py:1310",
    "factory/scripts/forge_cli/common.py:19",
    "factory/scripts/forge_cli/delegate.py:1067",
    "factory/scripts/forge_cli/delegate.py:1070",
    "factory/scripts/forge_cli/doctor.py:68",
    "factory/scripts/forge_cli/doctor.py:419",
    "factory/scripts/forge_cli/doctor.py:479",
    "factory/scripts/forge_cli/doctor.py:600",
    "factory/scripts/forge_cli/doctor.py:662",
    "factory/scripts/forge_cli/doctor.py:671",
    "factory/scripts/forge_cli/doctor.py:820",
    "factory/scripts/forge_cli/stages.py:935",
    "factory/scripts/forge_cli/stages.py:937",
    "factory/scripts/forge_cli/stages.py:1029",
    "factory/scripts/forge_cli/stages.py:1031",
})

STDIN_ALLOWLIST: frozenset[str] = frozenset({
    "factory/scripts/factory_lib.py:1258",
})


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
    replace_allowlist: frozenset[str] = REPLACE_ALLOWLIST,
    byte_path_allowlist: dict[str, str] = BYTE_PATH_ALLOWLIST,
    byte_mode_allowlist: dict[str, str] = BYTE_MODE_ALLOWLIST,
    stdin_allowlist: frozenset[str] = STDIN_ALLOWLIST,
) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeError, SyntaxError) as exc:
        return [Violation(path, getattr(exc, "lineno", 1) or 1, "parse", str(exc))]

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

    violations: list[Violation] = []
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
            try:
                relative = path.relative_to(root).as_posix()
            except ValueError:
                relative = path.as_posix()
            site = f"{relative}:{node.lineno}"
            value = errors.value if isinstance(errors, ast.Constant) else object()
            if value in {None, "strict"}:
                pass
            elif value == "replace" and site in replace_allowlist:
                pass
            elif value == "surrogateescape" and site in byte_path_allowlist:
                pass
            else:
                violations.append(Violation(
                    path, node.lineno, "errors-policy",
                    "non-strict errors policy is not allowlisted at this file:line",
                ))

    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        relative = path.as_posix()
    calls_by_line = {
        node.lineno: node for node in ast.walk(tree) if isinstance(node, ast.Call)
    }
    for site in byte_mode_allowlist:
        expected_path, line_text = site.rsplit(":", 1)
        if expected_path != relative:
            continue
        call = calls_by_line.get(int(line_text))
        if call is None:
            violations.append(Violation(
                path, int(line_text), "byte-mode",
                "allowlisted byte-mode call moved or was removed; update the audited site",
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
        if f"{relative}:{node.lineno}" not in stdin_allowlist:
            violations.append(Violation(
                path, node.lineno, "stdin",
                "stdin access is not the allowlisted strict UTF-8 reader",
            ))
    return violations


def check_paths(
    paths: Iterable[Path],
    *,
    root: Path = ROOT,
    replace_allowlist: frozenset[str] = REPLACE_ALLOWLIST,
    byte_path_allowlist: dict[str, str] = BYTE_PATH_ALLOWLIST,
    byte_mode_allowlist: dict[str, str] = BYTE_MODE_ALLOWLIST,
    stdin_allowlist: frozenset[str] = STDIN_ALLOWLIST,
) -> list[Violation]:
    violations: list[Violation] = []
    for path in sorted(paths):
        violations.extend(check_file(
            path, root=root, replace_allowlist=replace_allowlist,
            byte_path_allowlist=byte_path_allowlist,
            byte_mode_allowlist=byte_mode_allowlist,
            stdin_allowlist=stdin_allowlist,
        ))
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
