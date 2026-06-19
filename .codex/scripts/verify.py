#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory_lib import (
    dump_json,
    load_json,
    now_iso,
    repo_root,
    run_state_path,
    verify_state_path,
)

parser = argparse.ArgumentParser(description="Run deterministic validation sequence")
parser.add_argument("--print-only", action="store_true", help="Only print the commands that would run")
parser.add_argument(
    "--parallel-safe",
    action="store_true",
    help="Run independent read-only phases in parallel after required prerequisites pass.",
)
parser.add_argument(
    "--quiet-progress",
    action="store_true",
    help="Suppress phase start/finish progress lines.",
)
args = parser.parse_args()


@dataclass(frozen=True)
class VerifyCommand:
    phase: str
    command: str
    parallel_group: str | None = None


READ_ONLY_GROUP = "read-only"
DEFAULT_TIMEOUT_SECONDS = 30 * 60
SECRET_PATTERNS = [
    re.compile(
        r"(?i)(\"(?:[a-z0-9_]*_)?(?:api[_-]?key|token|secret|password|authorization)\"\s*:\s*\")([^\"]+)",
    ),
    re.compile(r"(?i)\b(authorization\s*[:=]\s*bearer\s+)([^\s]+)"),
    re.compile(r"(?i)\b(authorization\s*[:=]\s*)(?!\s*bearer\b)([^\r\n]+)"),
    re.compile(r"(?i)\b(bearer\s+)([a-z0-9._~+/=-]+)"),
    re.compile(
        r"(?i)\b((?:[a-z0-9_]*_)?(?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s]+)",
    ),
]
root = repo_root()
commands = [
    VerifyCommand(
        "structural",
        os.environ.get("FACTORY_STRUCTURAL_CMD")
        or "npm run format:check",
    ),
    VerifyCommand("build", os.environ.get("FACTORY_BUILD_CMD") or "npm run build"),
    VerifyCommand(
        "architecture",
        os.environ.get("FACTORY_ARCHITECTURE_CMD")
        or "python3 .codex/scripts/check_architecture.py",
        READ_ONLY_GROUP,
    ),
    VerifyCommand(
        "runtime-truth",
        os.environ.get("FACTORY_RUNTIME_TRUTH_CMD")
        or "python3 .codex/scripts/check_runtime_truth.py",
        READ_ONLY_GROUP,
    ),
    VerifyCommand(
        "factory-python-tests",
        os.environ.get("FACTORY_PYTHON_TEST_CMD")
        or "python3 -m unittest discover .codex/scripts/tests",
        READ_ONLY_GROUP,
    ),
    VerifyCommand(
        "typecheck",
        os.environ.get("FACTORY_TYPECHECK_CMD") or "npm run typecheck",
    ),
    VerifyCommand("tests", os.environ.get("FACTORY_TEST_CMD") or "npm test"),
    VerifyCommand("e2e", os.environ.get("FACTORY_E2E_CMD") or "npm run test:e2e"),
]


def print_progress(message: str) -> None:
    if not args.quiet_progress:
        print(message, flush=True)


def output_tail(value: str, *, max_lines: int = 40) -> str:
    lines = value.splitlines()
    if len(lines) <= max_lines:
        return "\n".join(lines)
    return "\n".join(lines[-max_lines:])


def redact_output(value: str) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(r"\1[REDACTED]", redacted)
    return redacted


def print_failure_tail(result: dict[str, Any]) -> None:
    stdout = redact_output(output_tail(str(result.get("stdout", "")))).strip()
    stderr = redact_output(output_tail(str(result.get("stderr", "")))).strip()
    if stdout:
        print_progress(f"[verify] {result['phase']} stdout tail:\n{stdout}")
    if stderr:
        print_progress(f"[verify] {result['phase']} stderr tail:\n{stderr}")


def command_timeout_seconds() -> float:
    raw = os.environ.get("FACTORY_VERIFY_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def terminate_process_group(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except PermissionError:
            proc.kill()


def run_verify_command(spec: VerifyCommand, cwd: Path) -> dict[str, Any]:
    print_progress(
        f"[verify] {spec.phase} start: {redact_output(spec.command)}",
    )
    started_at = now_iso()
    started = time.monotonic()
    timed_out = False
    proc = subprocess.Popen(
        spec.command,
        cwd=cwd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=command_timeout_seconds())
    except subprocess.TimeoutExpired:
        timed_out = True
        terminate_process_group(proc)
        stdout, stderr = proc.communicate()
        stderr = (
            f"{stderr}\nVerification phase timed out after "
            f"{command_timeout_seconds():g}s."
        )
    duration_seconds = round(time.monotonic() - started, 3)
    result = {
        "phase": spec.phase,
        "command": spec.command,
        "exit_code": 124 if timed_out else proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "timed_out": timed_out,
        "started_at": started_at,
        "completed_at": now_iso(),
        "duration_seconds": duration_seconds,
    }
    if result["exit_code"] == 0:
        print_progress(f"[verify] {spec.phase} ok in {duration_seconds:.3f}s")
    else:
        print_progress(
            f"[verify] {spec.phase} failed in {duration_seconds:.3f}s "
            f"(exit {result['exit_code']})",
        )
        print_failure_tail(result)
    return result


def run_parallel_group(group: list[VerifyCommand], cwd: Path) -> list[dict[str, Any]]:
    print_progress(
        f"[verify] {group[0].parallel_group} parallel group start: "
        f"{', '.join(item.phase for item in group)}",
    )
    by_phase: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(group)) as executor:
        futures = {executor.submit(run_verify_command, item, cwd): item for item in group}
        for future in as_completed(futures):
            item = futures[future]
            by_phase[item.phase] = future.result()
    return [by_phase[item.phase] for item in group]


results = []
all_ok = True

index = 0
while index < len(commands):
    spec = commands[index]
    if args.print_only:
        print(f"{spec.phase}: {spec.command}")
        index += 1
        continue

    if spec.parallel_group and args.parallel_safe:
        group = [spec]
        index += 1
        while (
            index < len(commands)
            and commands[index].parallel_group == spec.parallel_group
        ):
            group.append(commands[index])
            index += 1
        group_results = run_parallel_group(group, root)
        results.extend(group_results)
        if any(item["exit_code"] != 0 for item in group_results):
            all_ok = False
            break
        continue

    result = run_verify_command(spec, root)
    results.append(result)
    index += 1
    if result["exit_code"] != 0:
        all_ok = False
        break

if args.print_only:
    raise SystemExit(0)

state = load_json(run_state_path(root), default={})
verify = {
    "ok": all_ok,
    "completed_at": now_iso(),
    "results": results,
}
dump_json(verify_state_path(root), verify)
if state:
    state["verify_status"] = "passed" if all_ok else "failed"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)

if not all_ok:
    failed = next((item for item in results if item["exit_code"] != 0), None)
    print(
        f"Verification failed at {failed['phase']}: "
        f"{redact_output(failed['command'])}",
    )
    raise SystemExit(1)

print("Verification passed")
