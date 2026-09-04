"""forge codex status — is the delegated run still moving?

A stalled Codex job used to be invisible until somebody thought to ask. The
companion already records everything needed to see it — status, phase, the
write flag, timestamps, the log path — in its own job registry; nothing read
it.

DELIBERATELY ADVISORY. This reads a third-party path this repo does not own,
so it always exits 0 and never blocks a ship: a diagnostic over data outside
the contract must not be able to fail a gate (decision 0018).
"""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

from factory_lib import repo_root

from .stages import load_stages

STATE_ROOT = Path.home() / ".claude" / "plugins" / "data" / "codex-openai-codex" / "state"
STALL_MINUTES = 20


def _parse_time(value) -> datetime.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _registry_jobs(project_root: Path) -> dict[str, dict]:
    """Best-effort job records from the companion's project registry."""
    try:
        state = json.loads((project_root / "state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(state, dict) or not isinstance(state.get("jobs"), list):
        return {}
    return {
        str(job["id"]): job
        for job in state["jobs"]
        if isinstance(job, dict) and job.get("id") is not None
    }


def load_jobs(base: Path, state_root: Path | None = None) -> list[dict]:
    """Jobs whose workspace IS this repo.

    Matched on `workspaceRoot` rather than the state directory's name, which
    is a hash this repo has no business reproducing. Parsed defensively: the
    registry belongs to the plugin and may change shape without notice."""
    root = state_root or STATE_ROOT
    if not root.is_dir():
        return []
    jobs = []
    registries: dict[Path, dict[str, dict]] = {}
    for path in sorted(root.glob("*/jobs/*.json")):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            # Third-party bytes: a partially written or non-UTF-8 record is an
            # unusable job, never a reason for a diagnostic to exit non-zero.
            continue
        if not isinstance(job, dict):
            continue
        # The per-job file has the detailed payload, while state.json carries
        # updatedAt from phase/progress upserts. Merge them so inactivity can
        # use the companion's freshest available progress timestamp.
        project_root = path.parent.parent
        if project_root not in registries:
            registries[project_root] = _registry_jobs(project_root)
        registry_job = registries[project_root].get(str(job.get("id", "")), {})
        job = {**job, **registry_job}
        if Path(str(job.get("workspaceRoot", ""))) != base:
            continue
        job["_path"] = path
        jobs.append(job)
    return sorted(jobs, key=lambda j: str(j.get("createdAt", "")))


def age_minutes(job: dict, now: datetime.datetime | None = None) -> float | None:
    started = _parse_time(job.get("startedAt") or job.get("createdAt") or "")
    if started is None:
        return None
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if started.tzinfo is None:
        started = started.replace(tzinfo=datetime.timezone.utc)
    return (now - started).total_seconds() / 60.0


def inactivity_minutes(job: dict,
                       now: datetime.datetime | None = None) -> float | None:
    """Minutes since the newest parseable progress timestamp.

    The registry is third-party data, so accept the known update/phase field
    variants independently and fall back to the job start when none parse.
    """
    timestamps = [
        _parse_time(job.get(key))
        for key in (
            "updatedAt",
            "phaseUpdatedAt",
            "lastUpdateAt",
            "lastActivityAt",
            "startedAt",
            "createdAt",
        )
    ]
    parsed = [timestamp for timestamp in timestamps if timestamp is not None]
    if not parsed:
        return None
    normalized = [
        timestamp if timestamp.tzinfo is not None
        else timestamp.replace(tzinfo=datetime.timezone.utc)
        for timestamp in parsed
    ]
    latest = max(normalized)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    return (now - latest).total_seconds() / 60.0


def warnings_for(job: dict, *, stage_active: bool, stale_minutes: int,
                 now: datetime.datetime | None = None) -> list[str]:
    notes = []
    running = str(job.get("status", "")) in {"running", "starting", "queued"}
    inactivity = inactivity_minutes(job, now)
    if running and inactivity is not None and inactivity >= stale_minutes:
        notes.append(f"STALLED? no progress for {int(inactivity)}m with phase "
                     f"{str(job.get('phase') or 'unknown')!r}")
    if running and stage_active and job.get("write") is not True:
        # A read-only sandbox with approvalPolicy "never" can neither write nor
        # ask, so it narrates a plan and exits 0. That is the silent stall.
        notes.append("READ-ONLY while a stage is active — it cannot write and "
                     "cannot ask; re-run via `./forge delegate <task-id>`")
    return notes


def dead_launches(base: Path) -> list[dict]:
    """Launches the ledger still calls running whose process is GONE.

    The plugin's job registry carries no pid, so `status` was a flag on disk that
    nothing checked against reality: when a companion crashed, the registry kept
    saying "running" forever and a watcher polling that flag could never notice.
    The only signal was the time-based STALLED? guess — which needs a threshold
    to elapse and even then only says "maybe".

    The forge-side ledger DOES record `pid` and `pid_started` (the process
    create-time), so liveness is a fact we can check rather than a timeout we
    guess at. `pid_started` matters: a recycled pid belonging to an unrelated
    process would otherwise read as alive and keep the crash hidden.

    Defensive throughout — this command is advisory and must never fail a gate.
    """
    try:
        from .delegate import (
            _pid_alive, _process_start_identity, load_delegations,
        )
        entries = load_delegations(base)
    except (Exception, SystemExit):
        # SystemExit is NOT an Exception: load_delegations calls fail() on a
        # malformed ledger, and resolving the control directory exits outright
        # outside a git repo. Either would hard-kill an advisory command.
        return []

    latest: dict[str, dict] = {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("launch_id"):
            latest[str(entry["launch_id"])] = entry  # last row per launch wins
    dead = []
    for entry in latest.values():
        if entry.get("launch_status") not in {"starting", "running"}:
            continue
        pid = entry.get("pid")
        if not isinstance(pid, int):
            continue
        try:
            if _pid_alive(pid):
                recorded = entry.get("pid_started")
                if not recorded:
                    continue  # alive, and nothing to disambiguate against
                identity = _process_start_identity(pid)
                if identity is None or str(identity) == str(recorded):
                    continue  # genuinely still our process
        except (Exception, SystemExit):
            continue  # psutil missing or refusing: report nothing, never crash
        dead.append(entry)
    return dead


def cmd_status(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state_root = Path(args.state_root).expanduser() if args.state_root else STATE_ROOT
    # Crashes are reported FIRST and independently of the plugin registry: a
    # dead launch is the finding, and it is true whether or not the registry
    # still carries a row for it (or exists at all).
    corpses = dead_launches(base)
    for entry in corpses:
        print(f"[DEAD     ] {str(entry.get('task', '?')):<22} "
              f"pid={entry.get('pid')} is GONE but the launch ledger still says "
              f"{str(entry.get('launch_status'))!r}")
        print("            The companion CRASHED — it is not slow, and nothing "
              "is coming. Re-run `./forge delegate <task-id>`.")
        if entry.get("log"):
            print(f"            log: {entry['log']}")
    if not state_root.is_dir():
        if not corpses:
            print(f"codex status: unknown — no plugin job registry at {state_root}. "
                  "Nothing to report (this is a diagnostic, not a gate).")
        return
    jobs = load_jobs(base, state_root)
    if not jobs:
        if not corpses:
            print(f"codex status: no jobs recorded for {base}")
        return
    stage_active = any(s.get("status") == "active"
                       for s in load_stages(base).get("stages", []))
    flagged = 0
    for job in jobs:
        age = age_minutes(job)
        age_text = f"{int(age)}m" if age is not None else "?"
        print(f"[{str(job.get('status', '?')):<9}] {str(job.get('id', '?')):<22} "
              f"phase={str(job.get('phase') or '-'):<12} "
              f"write={'yes' if job.get('write') else 'no ':<3} age={age_text}")
        summary = str(job.get("summary") or job.get("title") or "").strip()
        if summary:
            print(f"            {summary[:100]}")
        if job.get("logFile"):
            print(f"            log: {job['logFile']}")
        for note in warnings_for(job, stage_active=stage_active,
                                 stale_minutes=args.stale_minutes):
            flagged += 1
            print(f"            !! {note}")
    if flagged:
        print(f"\n{flagged} warning(s). Advisory only — this reads the plugin's own "
              "registry and never fails a gate.")
