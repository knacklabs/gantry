"""Native Codex coordinator selection and exact exec contracts."""
from __future__ import annotations

import itertools
import json
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


RUNTIMES = ("claude", "codex")


def selected_coordinator(requested: str | None = None) -> str:
    """Select the coordinator without changing the legacy outside-runtime default."""
    explicit = requested if requested is not None else os.environ.get("FORGE_COORDINATOR")
    if explicit is not None:
        value = explicit.strip().lower()
        if value not in RUNTIMES:
            raise SystemExit(
                "FORGE_COORDINATOR must be 'claude' or 'codex', "
                f"got {explicit!r}"
            )
        return value
    if os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SHELL"):
        return "codex"
    if os.environ.get("CLAUDECODE"):
        return "claude"
    return "claude"


def coordinator_runtime() -> str:
    return selected_coordinator()


def native_argv(
        executable: str, base: Path, model: str, effort: str, write: bool,
        write_scope: list[str] | None = None,
) -> list[str]:
    """Build the complete shell-free native invocation used as launch evidence."""
    argv = [
        executable,
        "exec",
        "--json",
        "--enable",
        "hooks",
        "-C",
        str(base),
        "--model",
        model,
        "--config",
        f'model_reasoning_effort="{effort}"',
        "--config",
        'approval_policy="never"',
        "--sandbox",
        "workspace-write" if write else "read-only",
    ]
    grants = []
    root = base.resolve()
    if write:
        for entry in write_scope or []:
            rel = PurePosixPath(entry)
            path = base.joinpath(*rel.parts)
            try:
                exact_file = (
                    not path.is_dir()
                    and path.resolve(strict=False) == root.joinpath(*rel.parts)
                )
            except (OSError, RuntimeError):
                exact_file = False
            if (
                entry == rel.as_posix()
                and not entry.endswith("/")
                and not rel.is_absolute()
                and len(rel.parts) > 1
                and rel.parts[0] == ".codex"
                and ".." not in rel.parts
                and exact_file
            ):
                grants.append(entry)
    for path in sorted(grants):
        argv.extend(("--add-dir", path))
    argv.append("-")
    return argv


def native_argv_valid(entry: dict, base: Path, write_scope: list[str]) -> bool:
    executable = entry.get("executable_path")
    argv = entry.get("argv")
    if not isinstance(executable, str) or not executable:
        return False
    if not isinstance(argv, list) or not all(isinstance(v, str) for v in argv):
        return False
    expected = native_argv(
        executable,
        base,
        str(entry.get("model") or ""),
        str(entry.get("effort") or ""),
        entry.get("write") is True,
        write_scope,
    )
    legacy = native_argv(
        executable,
        base,
        str(entry.get("model") or ""),
        str(entry.get("effort") or ""),
        entry.get("write") is True,
        [],
    )
    terminal = entry.get("launch_status") in {"failed", "succeeded"}
    resume_session = entry.get("resume_session")
    if resume_session in (None, ""):
        return argv == expected
    if not isinstance(resume_session, str):
        return False
    # Historical completed rows may carry the removed continuation shape. They
    # remain readable, while new launches cannot construct that argv.
    return (terminal
            and argv[:-3] in (expected[:-1], legacy[:-1])
            and argv[-3:] == ["resume", resume_session, "-"])


@dataclass(frozen=True)
class NativeResult:
    session_id: str = ""
    message: str = ""
    error: str = ""


def scan_native_result(path: Path) -> NativeResult:
    """Scan native JSONL once, retaining identity, terminal status, and message."""
    starts: list[dict] = []
    message = ""
    last_type = ""
    failed = False
    syntax_error = ""
    preserve_session = True
    try:
        with path.open("rb") as stream:
            raw_lines = itertools.chain.from_iterable(
                block.splitlines(keepends=True) for block in stream)
            for number, raw_line in enumerate(raw_lines, start=1):
                terminated = raw_line.endswith((b"\n", b"\r"))
                if terminated:
                    raw_line = (raw_line[:-2]
                                if raw_line.endswith(b"\r\n")
                                else raw_line[:-1])
                if not raw_line.strip():
                    continue
                try:
                    line = raw_line.decode("utf-8")
                except UnicodeDecodeError:
                    syntax_error = "native Codex output is not UTF-8"
                    if terminated:
                        preserve_session = False
                    break
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    syntax_error = (
                        f"native Codex output line {number} is not JSON")
                    if terminated:
                        preserve_session = False
                    break
                if (not isinstance(event, dict)
                        or not isinstance(event.get("type"), str)):
                    syntax_error = (
                        f"native Codex output line {number} is not an event")
                    preserve_session = False
                    break
                event_type = event["type"]
                last_type = event_type
                if event_type == "thread.started":
                    starts.append(event)
                if event_type in {"error", "turn.failed"}:
                    failed = True
                item = event.get("item")
                if (event_type == "item.completed"
                        and isinstance(item, dict)
                        and item.get("type") == "agent_message"
                        and isinstance(item.get("text"), str)):
                    message = item["text"].strip()
    except OSError as exc:
        return NativeResult(
            error=f"native Codex output is unavailable: {exc}")

    session_id = ""
    if preserve_session and len(starts) == 1:
        thread_id = starts[0].get("thread_id")
        if isinstance(thread_id, str):
            session_id = thread_id.strip()
    if syntax_error:
        return NativeResult(session_id, message, syntax_error)
    if not session_id:
        error = (
            "native Codex output has no unique thread.started identity")
    elif failed:
        error = "native Codex output reports a failed run"
    elif last_type != "turn.completed":
        error = (
            "native Codex output has no terminal turn.completed event")
    else:
        error = ""
    return NativeResult(session_id, message, error)


def parse_native_result(path: Path) -> str:
    """Return the persisted Codex session id only for a terminal success stream."""
    result = scan_native_result(path)
    if result.error:
        raise ValueError(result.error)
    return result.session_id
