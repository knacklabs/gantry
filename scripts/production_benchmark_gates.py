#!/usr/bin/env python3
"""Evaluate production benchmark evidence against the scale-up gates."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


SANDBOX_START_P95_MS = 1_500
SANDBOX_START_P99_MS = 3_000
FIRST_VISIBLE_P95_MS = 10_000
LOCKED_DENIAL_MAX_P95_REGRESSION = 0.10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read runtime event JSON/JSONL evidence plus one production benchmark "
            "summary record and fail when production load gates are not met."
        )
    )
    parser.add_argument(
        "--input",
        help="Evidence file. Reads stdin when omitted. Accepts JSON array or JSONL.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a machine-readable report.",
    )
    return parser.parse_args()


def load_records(raw: str) -> list[dict[str, Any]]:
    text = raw.strip()
    if not text:
        return []
    if text.startswith("["):
        parsed = json.loads(text)
        if not isinstance(parsed, list):
            raise ValueError("JSON evidence must be an array of objects.")
        return [require_object(item) for item in parsed]
    records: list[dict[str, Any]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(require_object(json.loads(line)))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON on line {line_no}: {exc}") from exc
    return records


def require_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Every evidence record must be a JSON object.")
    return value


def event_type(record: dict[str, Any]) -> str | None:
    value = record.get("eventType", record.get("event_type"))
    return value if isinstance(value, str) else None


def payload(record: dict[str, Any]) -> dict[str, Any]:
    value = record.get("payload")
    return value if isinstance(value, dict) else {}


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def positive_int(value: Any) -> int:
    parsed = number(value)
    if parsed is None:
        return 0
    return max(0, int(parsed))


def bool_value(value: Any) -> bool:
    return value is True


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    index = max(0, math.ceil((percentile_value / 100) * len(sorted_values)) - 1)
    return sorted_values[min(index, len(sorted_values) - 1)]


def collect_startup(records: list[dict[str, Any]]) -> dict[str, Any]:
    sandbox_start: list[float] = []
    first_visible: list[float] = []
    failures = 0

    for record in records:
        if event_type(record) != "run.startup_diagnostic":
            continue
        event_payload = payload(record)
        exit_payload = event_payload.get("exit")
        if isinstance(exit_payload, dict):
            code = exit_payload.get("code")
            signal = exit_payload.get("signal")
            if bool_value(exit_payload.get("timedOut")) or code not in (0, None) or signal:
                failures += 1
        timing = event_payload.get("startupTiming")
        if not isinstance(timing, dict):
            continue
        sandbox_ms = number(timing.get("sandboxStartCallMs"))
        visible_ms = number(timing.get("firstVisibleOutputMs"))
        if sandbox_ms is not None:
            sandbox_start.append(sandbox_ms)
        if visible_ms is not None:
            first_visible.append(visible_ms)

    return {
        "sandboxStartCallMs": {
            "samples": len(sandbox_start),
            "p95": percentile(sandbox_start, 95),
            "p99": percentile(sandbox_start, 99),
        },
        "firstVisibleOutputMs": {
            "samples": len(first_visible),
            "p95": percentile(first_visible, 95),
        },
        "startupFailures": failures,
    }


def find_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    for record in records:
        if record.get("kind") == "production_benchmark_summary":
            return record
    return {}


def sample_p95_or_value(value: Any) -> float | None:
    parsed = number(value)
    if parsed is not None:
        return parsed
    if isinstance(value, list):
        samples = [parsed for item in value if (parsed := number(item)) is not None]
        return percentile(samples, 95)
    return None


def evaluate(records: list[dict[str, Any]]) -> dict[str, Any]:
    startup = collect_startup(records)
    summary = find_summary(records)
    worker = require_object(summary.get("worker", {}))
    queue = require_object(summary.get("queue", {}))
    sandbox = require_object(summary.get("sandbox", {}))
    mixed = require_object(summary.get("mixedLoad", {}))
    denial = require_object(summary.get("lockedPublicDenialFlood", {}))

    sandbox_failures = startup["startupFailures"] + positive_int(
        sandbox.get("startupFailures")
    )
    baseline_p95 = sample_p95_or_value(
        denial.get("baselineLiveChatP95Ms", denial.get("baselineLiveChatLatencyMs"))
    )
    flood_p95 = sample_p95_or_value(
        denial.get("floodLiveChatP95Ms", denial.get("floodLiveChatLatencyMs"))
    )
    regression = None
    if baseline_p95 and flood_p95 is not None:
        regression = (flood_p95 - baseline_p95) / baseline_p95

    checks = [
        check(
            "worker_8_cpu_8_gb_baseline",
            positive_int(worker.get("cpu")) >= 8
            and positive_int(worker.get("memoryGb")) >= 8,
            worker,
        ),
        check(
            "queue_defaults",
            positive_int(queue.get("maxMessageRuns")) == 6
            and positive_int(queue.get("maxJobRuns")) == 2,
            queue,
        ),
        check(
            "sandbox_resource_limits",
            positive_int(sandbox.get("memoryMb")) == 512
            and positive_int(sandbox.get("maxProcesses")) == 64,
            sandbox,
        ),
        check(
            "sandbox_start_p95",
            startup["sandboxStartCallMs"]["p95"] is not None
            and startup["sandboxStartCallMs"]["p95"] <= SANDBOX_START_P95_MS,
            startup["sandboxStartCallMs"],
        ),
        check(
            "sandbox_start_p99",
            startup["sandboxStartCallMs"]["p99"] is not None
            and startup["sandboxStartCallMs"]["p99"] <= SANDBOX_START_P99_MS,
            startup["sandboxStartCallMs"],
        ),
        check(
            "first_visible_output_p95",
            startup["firstVisibleOutputMs"]["p95"] is not None
            and startup["firstVisibleOutputMs"]["p95"] <= FIRST_VISIBLE_P95_MS,
            startup["firstVisibleOutputMs"],
        ),
        check("sandbox_startup_failures_zero", sandbox_failures == 0, sandbox_failures),
        check(
            "mixed_load_coverage",
            positive_int(mixed.get("chatRuns")) > 0
            and positive_int(mixed.get("jobRuns")) > 0
            and positive_int(mixed.get("delegatedAgentRuns")) > 0
            and positive_int(mixed.get("asyncBashRuns")) > 0,
            mixed,
        ),
        check(
            "mixed_load_no_starvation_or_orphans",
            not bool_value(mixed.get("liveChatStarved"))
            and positive_int(mixed.get("duplicateActiveTurns")) == 0
            and positive_int(mixed.get("orphanChildProcesses")) == 0,
            mixed,
        ),
        check(
            "mixed_load_terminal_state",
            positive_int(mixed.get("terminalTaskFailures")) == 0
            and positive_int(mixed.get("nonTerminalTasks")) == 0,
            mixed,
        ),
        check(
            "locked_public_denial_bounded",
            positive_int(denial.get("denialCount")) > 0
            and not bool_value(denial.get("unboundedBacklog")),
            denial,
        ),
        check(
            "locked_public_denial_live_p95_regression",
            regression is not None and regression <= LOCKED_DENIAL_MAX_P95_REGRESSION,
            {
                "baselineLiveChatP95Ms": baseline_p95,
                "floodLiveChatP95Ms": flood_p95,
                "regression": regression,
            },
        ),
    ]
    passed = all(item["passed"] for item in checks)
    return {
        "passed": passed,
        "startup": startup,
        "checks": checks,
    }


def check(name: str, passed: bool, evidence: Any) -> dict[str, Any]:
    return {"name": name, "passed": passed, "evidence": evidence}


def print_text(report: dict[str, Any]) -> None:
    status = "PASS" if report["passed"] else "FAIL"
    print(f"Production benchmark gates: {status}")
    for item in report["checks"]:
        state = "PASS" if item["passed"] else "FAIL"
        print(f"- {state} {item['name']}: {json.dumps(item['evidence'], sort_keys=True)}")


def main() -> int:
    args = parse_args()
    raw = Path(args.input).read_text() if args.input else sys.stdin.read()
    try:
        report = evaluate(load_records(raw))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"production benchmark gate error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
