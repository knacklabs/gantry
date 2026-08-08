"""forge delegate — compose the brief and the invocation for one task.

Delegation used to be a judgement call made fresh each time: whether the run
could write was decided per request (and three layers disagreed on the
default), and nothing composed context for the executor — `factory/prompts/
implementer.md` was referenced by five docs and read by zero scripts. So the
worker guessed, and a read-only sandbox with `approvalPolicy: never` could
neither write nor ask.

This makes both facts artifacts. The brief is built from what the repo already
knows (the task contract, the implementer prompt, the active decisions, the
lessons matching these paths, the modules already in scope); write permission
is derived from stage state; and this command owns the companion argv launch.
Stage completion reads the recorded launch, so diagnostics and stale launches
cannot attest implementation.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from factory_lib import (
    git_control_dir, load_json, now_iso, protected_decomposition_state_path,
    repo_root, run_state_path, safe_factory_append, safe_factory_write_bytes,
    sha256_of, validate_payload,
)

from .common import fail
from .decisions import decision_records
from .events import append_event
from .lessons import relevant_lessons
from .stages import load_stages, task_digest

SAFE_TASK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
# A brief is read by a model, so an inlined rule set that runs to thousands of
# lines crowds out the task. Enough to carry the rules, not the whole course.
SKILL_INLINE_CHARS = 12000
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_EFFORT = "medium"
PROCESS_QUIET_SECONDS = 0.75
PROCESS_POLL_SECONDS = 0.02
TERMINATION_SIGNALS = tuple(
    candidate for candidate in (
        signal.SIGINT,
        signal.SIGTERM,
        getattr(signal, "SIGHUP", None),
        getattr(signal, "SIGQUIT", None),
    )
    if candidate is not None
)


class ProcessDiscoveryError(RuntimeError):
    """The process tree could not be inspected safely."""


@contextlib.contextmanager
def blocked_termination_signals():
    """Make spawn registration and cleanup atomic with respect to termination."""
    if not hasattr(signal, "pthread_sigmask"):
        yield
        return
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, TERMINATION_SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def unblock_termination_signals_in_child() -> None:
    """Do not leak the parent's atomic-spawn signal mask into the worker."""
    if hasattr(signal, "pthread_sigmask"):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, TERMINATION_SIGNALS)


def briefs_dir(base: Path) -> Path:
    return base / ".factory" / "briefs"


def diagnostic_briefs_dir(base: Path) -> Path:
    return base / ".factory" / "diagnostic-briefs"


def delegations_path(base: Path) -> Path:
    return git_control_dir(base) / "delegations.jsonl"


def delegation_mirror_path(base: Path) -> Path:
    return base / ".factory" / "delegations.jsonl"


def delegation_lock_path(base: Path, lock_id: str, *,
                         namespace: str = "task") -> Path:
    if not SAFE_TASK_ID.fullmatch(lock_id):
        fail(f"lock id {lock_id!r} is not a plain identifier")
    if namespace not in {"task", "state"}:
        fail(f"lock namespace {namespace!r} is not supported")
    return delegations_path(base).parent / "locks" / namespace / f"{lock_id}.lock"


def brief_path(base: Path, task_id: str) -> Path:
    # The id is matched against the recorded decomposition before it reaches
    # here, and re-validated: a task id must never be able to name a path.
    if not SAFE_TASK_ID.fullmatch(task_id):
        fail(f"task id {task_id!r} is not a plain identifier")
    return briefs_dir(base) / f"{task_id}.md"


def load_delegations(base: Path) -> list[dict]:
    path = delegations_path(base)
    if not path.exists():
        return []
    entries = []
    for line_number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            fail(f"delegation authority is malformed at line {line_number}; "
                 "no prior launch can authorize stage close")
        if not isinstance(entry, dict):
            fail(f"delegation authority has a non-object row at line "
                 f"{line_number}; no prior launch can authorize stage close")
        entries.append(entry)
    return entries


def append_delegation(base: Path, record: dict) -> None:
    validate_payload(base, "delegation", record)
    line = (json.dumps(record) + "\n").encode()
    # The worker can write the workspace mirror, so it is diagnostic only.
    # Stage close reads the Git-control copy, which workspace-write sandboxes
    # cannot modify.
    path = delegations_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)
    # The mirror is deliberately best-effort. A worker may replace anything in
    # .factory; that must neither redirect an orchestrator write nor prevent
    # the protected terminal row from being published.
    safe_factory_append(base, delegation_mirror_path(base).name, line)


def _pid_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_group_alive(pgid: object) -> bool:
    if not isinstance(pgid, int) or pgid <= 0:
        return False
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_start_identity(pid: object) -> str | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    proc = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        capture_output=True, text=True,
    )
    # Collapse runs of whitespace exactly as _process_table does. `ps` pads the
    # day of month to width two ("Aug  4"), so the raw string and the table's
    # " ".join(fields) form differ on days 1-9 — and every identity comparison
    # in this module compares one against the other. Left unnormalized, no
    # observed process is ever recognized as live for nine days a month, so
    # nothing gets signalled and proof trees survive.
    identity = " ".join(proc.stdout.split())
    return identity if proc.returncode == 0 and identity else None


def _process_is_zombie(pid: int) -> bool:
    proc = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True, text=True,
    )
    return proc.returncode == 0 and proc.stdout.strip().startswith("Z")


def _process_table() -> dict[int, tuple[int, str]]:
    proc = subprocess.run(
        ["ps", "-x", "-o", "pid=,ppid=,lstart="],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise ProcessDiscoveryError("could not read the process table")
    table: dict[int, tuple[int, str]] = {}
    for line in proc.stdout.splitlines():
        fields = line.split()
        if len(fields) != 7:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        table[pid] = (ppid, " ".join(fields[2:]))
    return table


def _descendants(root_pid: int,
                 table: dict[int, tuple[int, str]]) -> dict[int, str]:
    found: dict[int, str] = {}
    frontier = {root_pid}
    while frontier:
        children = {
            pid: identity for pid, (ppid, identity) in table.items()
            if ppid in frontier and pid not in found
        }
        found.update(children)
        frontier = set(children)
    return found


def _tagged_processes(
        token: str,
        baseline: dict[int, tuple[int, str]] | None = None,
        current: dict[int, tuple[int, str]] | None = None,
        proc_root: Path | None = None) -> dict[int, str]:
    marker = f"FORGE_PROCESS_TOKEN={token}"
    current = current if current is not None else _process_table()
    candidates = set(current)
    if baseline is not None:
        candidates = {
            pid for pid, details in current.items()
            if baseline.get(pid) != details
        }
    # Injectable so the Linux-only branch is reachable from a macOS dev box.
    # It was not, which is why an unreadable-environ abort reached CI green
    # locally and red on the runner.
    proc_root = proc_root if proc_root is not None else Path("/proc")
    if proc_root.is_dir():
        found: dict[int, str] = {}
        marker_bytes = marker.encode()
        entries = (proc_root / str(pid) for pid in candidates)
        for candidate in entries:
            if not candidate.name.isdigit():
                continue
            try:
                environment = (candidate / "environ").read_bytes().split(b"\0")
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                # Unreadable environ means the process cannot be SHOWN to carry
                # our token, and cannot be one of ours: Linux refuses
                # /proc/<pid>/environ for a ZOMBIE (ptrace_may_access fails on
                # an exited task) and for any process we do not own. Our own
                # short-lived proof children become zombies routinely, so
                # raising here aborted the whole gate on Linux while macOS —
                # which has no /proc — never ran this branch at all.
                #
                # Skipping also matches the portable `ps eww` fallback below,
                # which simply cannot print an unreadable environment and so
                # never matches the marker. The two paths now agree.
                continue
            except OSError as exc:
                raise ProcessDiscoveryError(
                    f"could not inspect process {candidate.name}") from exc
            if marker_bytes not in environment:
                continue
            pid = int(candidate.name)
            identity = _process_start_identity(pid)
            if identity:
                found[pid] = identity
            elif _pid_alive(pid):
                raise ProcessDiscoveryError(
                    f"could not identify tagged process {pid}")
        return found
    if not candidates:
        return {}
    command = [
        "ps", "eww",
        "-p", ",".join(str(pid) for pid in sorted(candidates)),
        "-o", "pid=,lstart=,command=",
    ]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        remaining = _process_table()
        if not any(
            remaining.get(pid) == current.get(pid)
            for pid in candidates
        ):
            return {}
        raise ProcessDiscoveryError("could not inspect tagged processes")
    found: dict[int, str] = {}
    for line in proc.stdout.splitlines():
        if marker not in line:
            continue
        fields = line.split()
        if len(fields) < 7:
            raise ProcessDiscoveryError("malformed tagged-process record")
        try:
            pid = int(fields[0])
        except ValueError as exc:
            raise ProcessDiscoveryError(
                "malformed tagged-process PID") from exc
        found[pid] = " ".join(fields[1:6])
    return found


def _live_identified_processes(
        processes: dict[int, str]) -> dict[int, str]:
    live: dict[int, str] = {}
    for pid, identity in processes.items():
        current = _process_start_identity(pid)
        if current is None:
            if _pid_alive(pid):
                raise ProcessDiscoveryError(
                    f"could not identify observed process {pid}")
            continue
        if current == identity and not _process_is_zombie(pid):
            live[pid] = identity
    return live


def _signal_identified_processes(
        processes: dict[int, str],
        signum: int = signal.SIGTERM) -> dict[int, str]:
    signalled: dict[int, str] = {}
    for pid, identity in processes.items():
        # Keep the identity check adjacent to os.kill: a batch-wide snapshot
        # leaves enough time for an early PID to exit and be reused.
        if _process_is_zombie(pid):
            continue
        if _process_start_identity(pid) != identity:
            continue
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            continue
        signalled[pid] = identity
    return signalled


def _signal_verified_process_group(
        pgid: int, leader_identity: str) -> bool:
    """Signal a group only while its captured leader identity is still live."""
    if _process_is_zombie(pgid):
        return False
    if _process_start_identity(pgid) != leader_identity:
        return False
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    return True


def _capture_spawn_identity(proc: subprocess.Popen[str]) -> str:
    """Identify a new process or stop its owned group before registration."""
    try:
        identity = _process_start_identity(proc.pid)
    except OSError as exc:
        identity_error: OSError = exc
    else:
        if identity:
            return identity
        identity_error = OSError(
            f"could not identify spawned process {proc.pid}")
    if proc.poll() is not None:
        return ""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"unidentified process group {proc.pid} survived termination"
            ) from exc
    raise identity_error


def _terminate_processes_until_quiet(
        initial: dict[int, str], discover, reap=None) -> bool:
    """Discover and terminate new descendants until the set stays empty."""
    known = dict(initial)
    term_sent: dict[tuple[int, str], float] = {}
    kill_sent: dict[tuple[int, str], float] = {}
    quiet_since: float | None = None
    discovery_failed = False
    while True:
        if reap is not None:
            reap()
        try:
            known.update(discover())
        except ProcessDiscoveryError:
            # Degrade DISCOVERY, never TERMINATION. Returning here abandoned
            # every process already known — including the foreground proof
            # this call owns and has just signalled — because the SIGTERM ->
            # SIGKILL escalation below never ran, so a proof that ignores
            # SIGTERM outlived Forge. Discovery is routinely fallible: `ps eww
            # -p` exits non-zero as soon as any candidate PID has gone, which
            # happens constantly on a busy machine. Incompleteness is reported
            # by the return value once the known set is actually quiet.
            discovery_failed = True
        live = _live_identified_processes(known)
        now = time.monotonic()
        for pid, identity in live.items():
            key = (pid, identity)
            if key not in term_sent:
                if _signal_identified_processes({pid: identity}):
                    term_sent[key] = now
                continue
            if now - term_sent[key] >= 5 and key not in kill_sent:
                if _signal_identified_processes(
                        {pid: identity}, signal.SIGKILL):
                    kill_sent[key] = now
                continue
            if key in kill_sent and now - kill_sent[key] >= 5:
                return False
        if live:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = now
        elif now - quiet_since >= PROCESS_QUIET_SECONDS:
            return not discovery_failed
        time.sleep(PROCESS_POLL_SECONDS)


def _terminate_tagged_processes(
        token: str,
        baseline: dict[int, tuple[int, str]] | None = None,
        initial: dict[int, str] | None = None,
        reap=None) -> bool:
    return _terminate_processes_until_quiet(
        initial or {},
        lambda: _tagged_processes(token, baseline) if token else {},
        reap=reap,
    )


def _acquire_delegation_lock(base: Path, lock_id: str, launch_id: str,
                             *, wait: bool = False,
                             namespace: str = "task"):
    path = delegation_lock_path(base, lock_id, namespace=namespace)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+")
    deadline = time.monotonic() + 30
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if wait and time.monotonic() < deadline:
                time.sleep(0.05)
                continue
            handle.close()
            fail(f"{lock_id} already has an active protected lock; wait for it "
                 "to finish.")
        handle.seek(0)
        handle.truncate()
        json.dump({
            "kind": "delegation",
            "launch_id": launch_id,
            "owner_pid": os.getpid(),
        }, handle)
        handle.flush()
        return handle


def _update_delegation_lock(handle, launch_id: str, owner_pid: int,
                            *, kind: str = "delegation",
                            owner_pgid: int | None = None) -> None:
    handle.seek(0)
    handle.truncate()
    json.dump({
        "kind": kind,
        "launch_id": launch_id,
        "owner_pid": owner_pid,
        **({"owner_pgid": owner_pgid} if owner_pgid is not None else {}),
    }, handle)
    handle.flush()


def _release_delegation_lock(handle, _launch_id: str) -> None:
    with contextlib.suppress(OSError):
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


def _lock_is_held(path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        handle.close()


@contextlib.contextmanager
def delegation_exclusion(base: Path, task_id: str, *,
                         kind: str = "delegation",
                         namespace: str = "task"):
    owner_id = uuid.uuid4().hex
    handle = _acquire_delegation_lock(
        base, task_id, owner_id, wait=kind == "stage-state",
        namespace=namespace)
    if kind != "delegation":
        _update_delegation_lock(handle, owner_id, os.getpid(), kind=kind)
    try:
        yield
    finally:
        _release_delegation_lock(handle, owner_id)


def _reconcile_stale_launches(base: Path, task_id: str) -> None:
    def reap_tagged(entry: dict) -> None:
        launch_id = entry.get("launch_id")
        marker_value = entry.get("process_token")
        if not isinstance(marker_value, str) and isinstance(launch_id, str):
            marker_value = f"delegation-{launch_id}"
        if (
            isinstance(marker_value, str)
            and not _terminate_tagged_processes(marker_value)
        ):
            fail(f"{task_id} has a live process from an interrupted launch; "
                 "Forge could not reap it, so a second writer will not start.")

    launches: dict[str, dict] = {}
    for index, entry in enumerate(load_delegations(base)):
        if entry.get("task") != task_id or entry.get("write") is not True:
            continue
        key = entry.get("launch_id")
        launches[key if isinstance(key, str) else f"legacy:{index}"] = entry
    for entry in launches.values():
        status = entry.get("launch_status")
        if status not in {"starting", "running"}:
            continue
        pid = entry.get("pid")
        if status == "starting" and not _pid_alive(pid):
            reap_tagged(entry)
            failed = {**entry, "at": now_iso(), "launch_status": "failed"}
            failed.pop("exit_code", None)
            append_delegation(base, failed)
            continue
        if _pid_alive(pid):
            recorded_identity = entry.get("pid_started")
            current_identity = _process_start_identity(pid)
            if not recorded_identity or current_identity == recorded_identity:
                fail(f"{task_id} already has a foreground delegation running "
                     f"(pid {pid}); wait for it to finish.")
            # The PID has been recycled. It is not the recorded writer, and its
            # process group must not be signalled as if it were.
            reap_tagged(entry)
            failed = {**entry, "at": now_iso(), "launch_status": "failed"}
            failed.pop("exit_code", None)
            append_delegation(base, failed)
            continue
        reap_tagged(entry)
        pgid = entry.get("pgid", entry.get("pid"))
        if _process_group_alive(pgid):
            fail(f"{task_id} has a live process group {pgid}, but its recorded "
                 "leader identity is gone. Forge will not signal an unverified "
                 "reused group; stop the stale writer manually before retrying.")
        failed = {**entry, "at": now_iso(), "launch_status": "failed"}
        failed.pop("exit_code", None)
        append_delegation(base, failed)


def _reap_observed_process_tree(
        proc: subprocess.Popen[str], token: str,
        descendants: dict[int, str],
        baseline: dict[int, tuple[int, str]] | None,
        *, foreground_identity: str = "") -> bool:
    """Signal observed PIDs while the foreground process is being reaped."""
    if foreground_identity and proc.poll() is None:
        _signal_verified_process_group(proc.pid, foreground_identity)
        descendants[proc.pid] = foreground_identity
    children_stopped = _terminate_tagged_processes(
        token, baseline, descendants, reap=proc.poll)
    foreground_stopped = proc.poll() is not None
    return foreground_stopped and children_stopped


def _terminate_observed_process_tree(
        proc: subprocess.Popen[str], token: str,
        baseline: dict[int, tuple[int, str]] | None = None,
        foreground_identity: str = "") -> bool:
    """Cancel a spawned command immediately, then reap every observed child."""
    # The foreground process group is the one resource we already own and can
    # identify without walking the process table. Signal it before fallible
    # descendant discovery so an unavailable `ps` cannot leave the command
    # running after Forge exits.
    if foreground_identity and proc.poll() is None:
        _signal_verified_process_group(proc.pid, foreground_identity)
    try:
        descendants = _descendants(proc.pid, _process_table())
    except ProcessDiscoveryError:
        descendants = {}
    try:
        if token:
            descendants.update(_tagged_processes(token, baseline))
    except ProcessDiscoveryError:
        # `_reap_observed_process_tree` still waits on the owned foreground
        # process and reports incomplete descendant cleanup.
        pass
    return _reap_observed_process_tree(
        proc, token, descendants, baseline,
        foreground_identity=foreground_identity)


def _wait_and_reap(
        proc: subprocess.Popen[str], token: str = "",
        baseline: dict[int, tuple[int, str]] | None = None,
        foreground_identity: str = "") -> bool:
    """Wait for trusted work and reap its observed process tree.

    A child can create a new session and leave the leader's process group. PID
    identity plus an inherited token finds normal detached children without
    risking a later process that merely reused the same PID. The short
    post-exit quiet window closes the common fork-and-exit race. This is
    deterministic cleanup for trusted repository commands, not hostile-code
    containment; a process that deliberately clears its environment needs the
    separately deferred container boundary.
    """
    descendants: dict[int, str] = {}
    try:
        while proc.poll() is None:
            current = _process_table()
            descendants.update(_descendants(proc.pid, current))
            if token:
                descendants.update(
                    _tagged_processes(token, baseline, current))
            time.sleep(PROCESS_POLL_SECONDS)
        current = _process_table()
        descendants.update(_descendants(proc.pid, current))
        if token:
            descendants.update(_tagged_processes(token, baseline, current))
    except BaseException:
        _reap_observed_process_tree(
            proc, token, descendants, baseline,
            foreground_identity=foreground_identity)
        raise
    return _reap_observed_process_tree(
        proc, token, descendants, baseline)


def current_delegation(base: Path, task_id: str, *,
                       stage_started_at: str = "",
                       task_sha256: str = "",
                       ignore_lock: bool = False) -> dict | None:
    """The latest-started completed launch for the current canonical brief.

    One successful foreground launch cannot hide another launch that is still
    running: stage close requires the whole launch set to be terminal.
    """
    path = brief_path(base, task_id)
    lock_path = delegation_lock_path(base, task_id)
    if not path.is_file():
        return None
    if not ignore_lock and _lock_is_held(lock_path):
        return None
    launches: dict[str, tuple[int, list[dict]]] = {}
    for index, entry in enumerate(load_delegations(base)):
        if (
            entry.get("task") != task_id
            or entry.get("write") is not True
            or (stage_started_at
                and entry.get("stage_started_at") != stage_started_at)
            or (task_sha256 and entry.get("task_sha256") != task_sha256)
        ):
            continue
        launch_id = entry.get("launch_id")
        if not isinstance(launch_id, str):
            return None
        started, rows = launches.get(launch_id, (index, []))
        rows.append(entry)
        launches[launch_id] = (started, rows)
    if not launches:
        return None
    bindings = (
        "task", "brief_sha256", "task_sha256", "write", "model", "effort",
        "companion_path", "argv", "argv_sha256", "stage_started_at",
        "process_token",
    )
    completed: list[tuple[int, dict]] = []
    for started, rows in launches.values():
        if any(
            row.get(field) != rows[0].get(field)
            for row in rows[1:]
            for field in bindings
        ):
            return None
        statuses = [row.get("launch_status") for row in rows]
        if statuses in (["starting"], ["starting", "running"]):
            return None
        if statuses not in (
            ["starting", "failed"],
            ["starting", "running", "failed"],
            ["starting", "running", "succeeded"],
        ):
            return None
        terminal = rows[-1]
        if (
            terminal.get("launch_status") == "succeeded"
            and terminal.get("exit_code") != 0
        ):
            return None
        completed.append((started, terminal))
    _, latest = max(completed, key=lambda item: item[0])
    return latest


def companion_script(home: Path | None = None) -> Path:
    home = home or Path.home()
    cache = (home / ".claude" / "plugins" / "cache" / "openai-codex" /
             "codex").resolve()
    metadata = home / ".claude" / "plugins" / "installed_plugins.json"
    try:
        installed = json.loads(metadata.read_text())
        entries = installed["plugins"]["codex@openai-codex"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        fail("Codex companion installation metadata is missing or malformed — "
             "run `./forge doctor --fix`")
    candidates = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("installPath"), str):
            continue
        script = (Path(entry["installPath"]) / "scripts" /
                  "codex-companion.mjs").resolve()
        if script.is_relative_to(cache) and script.is_file():
            candidates.append(script)
    candidates = sorted(set(candidates))
    if len(candidates) != 1:
        fail("Codex companion installation is missing or ambiguous — run "
             "`./forge doctor --fix`")
    return candidates[0]


def pinned_run_config(base: Path) -> tuple[str, str]:
    """The model and effort harness.yaml pins for implementation.

    Read rather than duplicated — and read here because the repo's own
    .codex/config.toml is shadowed by ~/.codex, so the pin never reaches the
    CLI unless the invocation carries it."""
    text = (base / "harness.yaml").read_text() if (base / "harness.yaml").is_file() else ""
    block = re.search(r"^  implementation:\n((?:    .*\n|\n)*)", text, re.MULTILINE)
    body = block.group(1) if block else ""
    model = re.search(r'^    model:\s*"?([\w.-]+)"?', body, re.MULTILINE)
    effort = re.search(r'^    reasoning:\s*"?(\w+)', body, re.MULTILINE)
    return (model.group(1) if model else DEFAULT_MODEL,
            effort.group(1) if effort else DEFAULT_EFFORT)


def mode_run_config(base: Path, mode: str) -> tuple[str, str, int]:
    """Return the model, effort, and file bound pinned for a workflow mode."""
    manifest = base / "harness.yaml"
    text = manifest.read_text() if manifest.is_file() else ""
    modes = re.search(r"^modes:\n((?:  .*\n|\n)*)", text, re.MULTILINE)
    body = modes.group(1) if modes else ""
    selected = re.search(
        rf"^  {re.escape(mode)}:\n((?:    .*\n|\n)*)", body, re.MULTILINE)
    config = selected.group(1) if selected else ""
    model = re.search(r'^    model:\s*"?([\w.-]+)"?', config, re.MULTILINE)
    effort = re.search(r'^    reasoning:\s*"?(\w+)', config, re.MULTILINE)
    bound = re.search(r"^    bound:\s*(\d+)", config, re.MULTILINE)
    if not (model and effort and bound):
        fail(f"harness.yaml modes.{mode} must pin model, reasoning, and bound")
    return model.group(1), effort.group(1), int(bound.group(1))


def skill_groups(base: Path) -> dict[str, dict[str, list[str]]]:
    """Skills declared by phase, keeping required and advisory lists distinct."""
    text = (base / "harness.yaml").read_text() if (base / "harness.yaml").is_file() else ""
    groups: dict[str, dict[str, list[str]]] = {}
    for phase in ("implementation", "review"):
        phase_match = re.search(
            rf"^  {phase}:\n((?:    .*\n|\n)*)", text, re.MULTILINE)
        body = phase_match.group(1) if phase_match else ""
        required_match = re.search(
            r"^    required_skills:.*\n((?:      .*\n|\n)*)",
            body, re.MULTILINE)
        required = re.findall(
            r'^        - "?([\w-]+)"?', required_match.group(1), re.MULTILINE
        ) if required_match else []
        advisory_match = re.search(
            r"^    advisory_skills:.*\n((?:      .*\n|\n)*)",
            body, re.MULTILINE)
        advisory = re.findall(
            r'^      - skill:\s*"?([\w-]+)"?',
            advisory_match.group(1), re.MULTILINE
        ) if advisory_match else []
        if required or advisory:
            groups[phase] = {"required": required, "advisory": advisory}
    return groups


def required_skills(base: Path, phase: str = "implementation") -> list[str]:
    """Required skills for one artifact-producing phase."""
    return skill_groups(base).get(phase, {}).get("required", [])


def existing_modules(base: Path, scope: list[str]) -> list[str]:
    """What is already in the task's write_scope.

    "Use the components that exist" is an instruction the executor cannot act
    on without knowing what exists — and it is told not to inspect the repo.
    So the listing travels with the brief as data."""
    found: list[str] = []
    for entry in scope:
        target = base / entry.strip().rstrip("/")
        if target.is_file():
            found.append(entry.strip())
        elif target.is_dir():
            found.extend(
                sorted(p.relative_to(base).as_posix()
                       for p in target.rglob("*")
                       if p.is_file() and ".git" not in p.parts)[:60]
            )
    return found


def _skill_text(skill: str) -> str:
    for candidate in (Path.home() / ".claude" / "skills" / skill / "SKILL.md",
                      Path.home() / ".codex" / "skills" / skill / "SKILL.md"):
        if candidate.is_file():
            return candidate.read_text()[:SKILL_INLINE_CHARS]
    return ""


def _section(title: str, body: str) -> str:
    return f"\n## {title}\n\n{body.rstrip()}\n" if body.strip() else ""


def compose_brief(base: Path, task: dict, *, write: bool, user_facing: bool,
                  story: str) -> str:
    scope = task.get("write_scope") or []
    lines = [
        f"# Brief — {task['id']}: {task.get('title', '')}",
        "",
        f"Story: {story or '(none)'} | write access: "
        f"{'YES — you may edit files in the write scope' if write else 'NO — read only'}",
        "",
        "This brief is the whole context you are given. It was composed from the "
        "recorded decomposition, the implementer contract, the active decisions "
        "and the lessons ledger. Do not go looking for the rules elsewhere; if "
        "something needed is missing, raise a signal instead of guessing "
        "(`./forge signal raise`).",
    ]
    body = "\n".join(lines) + "\n"
    body += _section("Objective", task.get("objective", ""))
    body += _section("Acceptance criteria", "\n".join(
        f"- {c}" for c in task.get("acceptance_criteria") or []))
    body += _section("Write scope — nothing outside this", "\n".join(
        f"- {s}" for s in scope) + (
        "\n\n`forge stage done` refuses a change outside this list."))
    modules = existing_modules(base, scope)
    body += _section("What already exists in that scope (use it, do not re-create it)",
                     "\n".join(f"- {m}" for m in modules) or "(nothing yet)")
    body += _section("Tests you must write", "\n".join(
        f"- {t.get('id')}: `{t.get('command')}` ({t.get('path')})"
        for t in task.get("required_tests") or [])
        + ("\n\nThe implementer writes and records the tests; a declared test that "
           "does not exist or whose exact command fails refuses the stage."
           if task.get("required_tests") else ""))
    body += _section("Verify commands (they will be run when the stage closes)",
                     "\n".join(f"- `{c}`" for c in task.get("verify_commands") or []))
    body += _section("Reviewer focus", task.get("reviewer_focus", ""))
    decisions = [r for r in decision_records(base) if r["status"] == "accepted"]
    body += _section("Active decisions — binding", "\n".join(
        f"- {r['id']}: {r['title']}" for r in decisions))
    lessons = relevant_lessons(base, scope)
    body += _section("Lessons recorded against these paths", "\n".join(
        f"- {le.get('lesson', '')}" for le in lessons))
    prompt = base / "factory" / "prompts" / "implementer.md"
    if prompt.is_file():
        body += _section("Implementer contract", prompt.read_text())
    if user_facing:
        for skill in required_skills(base):
            text = _skill_text(skill)
            body += _section(
                f"Design rules — {skill} (inlined; your runtime cannot load it)",
                text or f"NOT INSTALLED on this machine. `./forge doctor --fix` "
                        f"installs {skill}. Until then this brief cannot carry the "
                        f"rules the harness will require you to attest.")
    return body


def argv_digest(argv: list[str]) -> str:
    """Digest the exact shell-free argument vector recorded for a launch."""
    return hashlib.sha256(
        json.dumps(argv, separators=(",", ":")).encode()
    ).hexdigest()


def launch_companion(
        base: Path, *, task_id: str, text: str, path: Path,
        task_sha256_value: str, model: str, effort: str, write: bool,
        story: str = "", background: bool = False, print_only: bool = False,
        stage_started_at: str = "", mode: str = "") -> dict | None:
    """Write a brief and run the protected companion launch lifecycle."""
    # Prefixed, not bare hex: a bare 32-character hex string reads as a
    # credential to secret scanners.
    launch_id = f"launch-{uuid.uuid4().hex}"
    lock = (_acquire_delegation_lock(base, task_id, launch_id)
            if write and not print_only else None)
    if write and not print_only:
        _reconcile_stale_launches(base, task_id)
    rel = path.relative_to(base / ".factory").as_posix()
    if not safe_factory_write_bytes(base, rel, text.encode()):
        fail(f"cannot safely write .factory/{rel}; remove any symlinked brief "
             "path and retry")
    brief_digest = sha256_of(path)
    node = shutil.which("node")
    if not node:
        fail("node is required to launch the Codex companion — run `./forge doctor --fix`")
    companion = companion_script()
    rel = path.relative_to(base).as_posix()
    argv = [
        node, str(companion), "task", "--json", "--cwd", str(base),
        "--model", model, "--effort", effort, "--prompt-file", rel,
    ]
    if write:
        argv.append("--write")
    if background:
        argv.append("--background")
    print(f"Brief written to {rel} ({len(text.splitlines())} lines)")
    write_detail = ("YES (lite window is open)" if mode else
                    "YES (stage is active with a write scope)")
    print(f"Write access: {write_detail if write else 'NO'}")
    print(f"Companion argv: {shlex.join(argv)}")
    if print_only:
        print("Print-only: companion was not launched and no launch evidence was recorded.")
        return None

    process_token = f"delegation-{launch_id}"
    record = {
        "generated_by": "orchestrator",
        "at": now_iso(),
        "launch_id": launch_id,
        "task": task_id,
        "brief_sha256": brief_digest,
        "task_sha256": task_sha256_value,
        "write": write,
        "model": model,
        "effort": effort,
        "companion_path": str(companion),
        "argv": argv,
        "argv_sha256": argv_digest(argv),
        "launch_status": "starting",
        "process_token": process_token,
    }
    if story:
        record["story"] = story
    if background:
        record["background"] = True
    if stage_started_at:
        record["stage_started_at"] = stage_started_at
    if mode:
        record["mode"] = mode
    terminal_recorded = False
    proc: subprocess.Popen[str] | None = None
    process_baseline: dict[int, tuple[int, str]] | None = None
    process_identity = ""
    stdout = ""
    stderr = ""
    stdout_log = tempfile.TemporaryFile(mode="w+t")
    stderr_log = tempfile.TemporaryFile(mode="w+t")
    handled_signals = list(TERMINATION_SIGNALS)
    previous_handlers = {
        candidate: signal.getsignal(candidate) for candidate in handled_signals
    }

    def handle_termination(signum, _frame):
        raise SystemExit(128 + signum)

    for candidate in handled_signals:
        signal.signal(candidate, handle_termination)
    append_delegation(base, record)
    try:
        try:
            process_env = os.environ.copy()
            process_env["FORGE_PROCESS_TOKEN"] = process_token
            with blocked_termination_signals():
                process_baseline = _process_table()
                proc = subprocess.Popen(
                    argv, cwd=base, stdout=stdout_log, stderr=stderr_log,
                    text=True, start_new_session=True, env=process_env,
                    preexec_fn=unblock_termination_signals_in_child,
                )
                process_identity = _capture_spawn_identity(proc)
                record.update({
                    "at": now_iso(),
                    "launch_status": "running",
                    "pid": proc.pid,
                    "pgid": proc.pid,
                    "pid_started": process_identity,
                })
                if lock is not None:
                    _update_delegation_lock(
                        lock, record["launch_id"], proc.pid,
                        owner_pgid=proc.pid)
                append_delegation(base, record)
        except OSError as exc:
            if proc is None:
                append_delegation(base, {
                    **record, "at": now_iso(), "launch_status": "failed",
                })
                terminal_recorded = True
                fail(f"Codex companion could not start: {exc}")
            # Popen succeeded; the outer handler must reap that process tree
            # before any terminal launch row is recorded.
            fail(f"Codex companion launch could not be registered: {exc}")
        try:
            if not _wait_and_reap(
                    proc, process_token, process_baseline, process_identity):
                raise RuntimeError("companion process tree survived termination")
        except BaseException:
            # The outer handler retries cleanup and records a terminal failure
            # only after the full observed process tree is verified dead.
            raise
        stdout_log.seek(0)
        stderr_log.seek(0)
        stdout = stdout_log.read()
        stderr = stderr_log.read()
        if stdout:
            print(stdout.rstrip())
        if proc.returncode != 0:
            append_delegation(base, {
                **record, "at": now_iso(), "launch_status": "failed",
                "exit_code": proc.returncode,
            })
            terminal_recorded = True
            fail("Codex companion launch failed "
                 f"(exit {proc.returncode}): {(stderr or stdout).strip()}")
        if sha256_of(path) != brief_digest:
            append_delegation(base, {
                **record, "at": now_iso(), "launch_status": "failed",
                "exit_code": proc.returncode,
            })
            terminal_recorded = True
            retry = "forge fix" if mode else "forge delegate"
            fail("delegation brief changed while the companion was running; launch "
                 f"evidence was not recorded — rerun `{retry}`")
        terminal = {
            **record, "at": now_iso(), "launch_status": "succeeded",
            "exit_code": proc.returncode,
        }
        append_delegation(base, terminal)
        terminal_recorded = True
        return terminal
    except BaseException:
        if proc is not None and not terminal_recorded:
            with blocked_termination_signals():
                terminated = _terminate_observed_process_tree(
                    proc, process_token, process_baseline, process_identity)
            if terminated:
                append_delegation(base, {
                    **record, "at": now_iso(), "launch_status": "failed",
                    "exit_code": proc.returncode if proc.returncode is not None else 130,
                })
        raise
    finally:
        stdout_log.close()
        stderr_log.close()
        for candidate, previous in previous_handlers.items():
            signal.signal(candidate, previous)
        if lock is not None and (
                proc is None or not _process_group_alive(proc.pid)):
            _release_delegation_lock(lock, record["launch_id"])


def cmd_delegate(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    decomposition = load_json(
        protected_decomposition_state_path(base), default={})
    tasks = decomposition.get("tasks") or []
    if not tasks:
        fail("no recorded decomposition — a delegation is scoped to a leaf task "
             "(record_decomposition_from_json.py)")
    task = next((t for t in tasks if t.get("id") == args.id), None)
    if task is None:
        fail(f"{args.id!r} is not a task in the recorded decomposition "
             f"({', '.join(str(t.get('id')) for t in tasks)})")
    if any(not isinstance(proof, dict)
           for proof in task.get("required_tests") or []):
        fail(f"{args.id} carries legacy string required_tests — re-record the "
             "decomposition with id, path and command proof objects")
    stage = next((s for s in load_stages(base).get("stages", [])
                  if s.get("id") == args.id), {})
    scope = task.get("write_scope") or []
    # Derived, not typed: an active stage with somewhere to write is a write
    # run. --read-only is the explicit exception, for exploration.
    write = bool(stage.get("status") == "active" and scope) and not args.read_only
    if write and args.background:
        fail("background write delegation cannot satisfy a measured stage: the "
             "worker could keep writing after stage close. Run it in the foreground, "
             "or use --read-only for background exploration.")
    state = load_json(run_state_path(base), default={})
    story = str(state.get("story") or state.get("issue_key") or "")
    text = compose_brief(base, task, write=write,
                         user_facing=bool(decomposition.get("user_facing")),
                         story=story)
    canonical_path = brief_path(base, args.id)
    path = (diagnostic_briefs_dir(base) / f"{args.id}.md"
            if args.print_only or not write else canonical_path)
    model, effort = pinned_run_config(base)
    launch_companion(
        base,
        task_id=args.id,
        text=text,
        path=path,
        task_sha256_value=task_digest(task),
        model=model,
        effort=effort,
        write=write,
        story=story,
        background=args.background,
        print_only=args.print_only,
        stage_started_at=str(stage.get("started_at") or ""),
    )
    if args.print_only:
        return
    append_event(base, "delegated", actor="orchestrator", story=story,
                 detail=f"{args.id} ({'write' if write else 'read-only'})")
    print("Then WATCH the event channel: Monitor .factory/signals.jsonl alongside "
          "the job (`./forge codex status` shows whether it is still moving).")
    if not write and stage.get("status") != "active":
        print(f"Note: {args.id} is not an active stage, so this is a read-only run. "
              f"`./forge stage start {args.id}` first if it should be building.")
