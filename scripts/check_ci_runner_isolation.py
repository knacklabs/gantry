#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


WORKFLOW_DIR = Path(__file__).resolve().parent.parent / ".github" / "workflows"
TOP_LEVEL_KEY = re.compile(r"^(?P<key>[A-Za-z_][A-Za-z0-9_-]*):")
JOB_KEY = re.compile(r"^  (?P<key>[A-Za-z_][A-Za-z0-9_-]*):")


def workflow_files() -> list[Path]:
    return sorted(
        path
        for path in WORKFLOW_DIR.iterdir()
        if path.suffix in {".yml", ".yaml"}
    )


def block_end(lines: list[str], start: int, key_pattern: re.Pattern[str]) -> int:
    for index in range(start + 1, len(lines)):
        if key_pattern.match(lines[index]):
            return index
    return len(lines)


def top_level_block(lines: list[str], key: str) -> list[str] | None:
    for index, line in enumerate(lines):
        match = TOP_LEVEL_KEY.match(line)
        if match and match.group("key") == key:
            return lines[index : block_end(lines, index, TOP_LEVEL_KEY)]
    return None


def has_pull_request_trigger(lines: list[str]) -> bool:
    trigger = top_level_block(lines, "on")
    if trigger is None:
        return False
    return any(re.search(r"\bpull_request\b", line) for line in trigger)


def job_blocks(lines: list[str]) -> list[tuple[str, list[str]]]:
    jobs = top_level_block(lines, "jobs")
    if jobs is None:
        return []

    blocks: list[tuple[str, list[str]]] = []
    for index, line in enumerate(jobs):
        match = JOB_KEY.match(line)
        if not match:
            continue
        blocks.append(
            (
                match.group("key"),
                jobs[index : block_end(jobs, index, JOB_KEY)],
            )
        )
    return blocks


def runs_on_values(job: list[str]) -> list[str]:
    values: list[str] = []
    for index, line in enumerate(job):
        match = re.match(r"^(?P<indent>\s+)runs-on:\s*(?P<value>.*)$", line)
        if not match:
            continue
        values.append(match.group("value"))
        indent = len(match.group("indent"))
        for continuation in job[index + 1 :]:
            if not continuation.strip():
                continue
            continuation_indent = len(continuation) - len(continuation.lstrip())
            if continuation_indent <= indent:
                break
            values.append(continuation.strip())
    return values


def permissions_are_explicit_and_read_only(lines: list[str]) -> bool:
    permissions = top_level_block(lines, "permissions")
    if permissions is None:
        return False
    first_line = permissions[0]
    if re.search(r"permissions:\s*\{\s*\}\s*(?:#.*)?$", first_line):
        return True
    return any(
        re.match(r"^\s+contents:\s*(?:read|none)\s*(?:#.*)?$", line)
        for line in permissions[1:]
    )


def step_block(lines: list[str], line_index: int) -> list[str]:
    start = line_index
    while start >= 0 and not re.match(r"^\s+-\s+(?:name|uses|run):", lines[start]):
        start -= 1
    if start < 0:
        return []

    indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(rf"^\s{{{indent}}}-\s+(?:name|uses|run):", lines[index]):
            end = index
            break
    return lines[start:end]


def secret_step_has_absent_guard(lines: list[str]) -> bool:
    secret_steps: list[list[str]] = []
    for index, line in enumerate(lines):
        if "E2E_MODEL_API_KEY:" in line and "secrets." in line:
            secret_steps.append(step_block(lines, index))

    if not secret_steps:
        return False

    for step in secret_steps:
        text = "\n".join(step)
        has_empty_check = re.search(
            r'if\s+\[\s+-z\s+["\']?\$E2E_MODEL_API_KEY["\']?\s+\];\s*then',
            text,
        )
        if not has_empty_check or not re.search(r"^\s*exit 0\s*$", text, re.MULTILINE):
            return False
    return True


def main() -> int:
    failures: list[str] = []
    found_guarded_secret_step = False

    for path in workflow_files():
        lines = path.read_text(encoding="utf-8").splitlines()
        relative = path.relative_to(WORKFLOW_DIR.parent.parent)

        if not permissions_are_explicit_and_read_only(lines):
            failures.append(
                f"{relative}: workflow permissions must declare contents: read or tighter"
            )

        if has_pull_request_trigger(lines):
            for job_name, job in job_blocks(lines):
                if any("self-hosted" in value for value in runs_on_values(job)):
                    failures.append(
                        f"{relative}: pull_request job {job_name!r} uses self-hosted"
                    )

        if any("E2E_MODEL_API_KEY:" in line and "secrets." in line for line in lines):
            if secret_step_has_absent_guard(lines):
                found_guarded_secret_step = True
            else:
                failures.append(
                    f"{relative}: E2E_MODEL_API_KEY step lacks an absent-secret skip guard"
                )

    if not found_guarded_secret_step:
        failures.append("no guarded E2E_MODEL_API_KEY workflow step found")

    if failures:
        print("CI runner isolation check failed.")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("CI runner isolation check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
