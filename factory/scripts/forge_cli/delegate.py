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
import errno
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
    repo_root, require_ready_task, require_task_worktree, run_state_path,
    safe_factory_append,
    safe_factory_write_bytes, sha256_of, task_digest, validate_payload,
)

from .common import fail
from .decisions import decision_records
from .events import append_event
from .lessons import relevant_lessons
from .stages import load_stages, review_budget

SAFE_TASK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
# A brief is read by a model, so an inlined rule set that runs to thousands of
# lines crowds out the task. Enough to carry the rules, not the whole course.
SKILL_INLINE_CHARS = 12000
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_EFFORT = "medium"
PROCESS_QUIET_SECONDS = 0.75
PROCESS_POLL_SECONDS = 0.02
SIGKILL = getattr(signal, "SIGKILL", None)
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


def _psutil():
    """Load the optional runtime dependency only when process work starts."""
    import psutil

    return psutil


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
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
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
    psutil = _psutil()
    try:
        process = psutil.Process(pid)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True


def _process_group_alive(pgid: object) -> bool:
    if not isinstance(pgid, int) or pgid <= 0:
        return False
    psutil = _psutil()
    try:
        process = psutil.Process(pgid)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True


def _process_start_identity(pid: object) -> float | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    psutil = _psutil()
    try:
        return psutil.Process(pid).create_time()
    except psutil.NoSuchProcess:
        return None
    except psutil.AccessDenied as exc:
        raise ProcessDiscoveryError(
            f"could not identify process {pid}") from exc


def _process_is_zombie(pid: int) -> bool:
    psutil = _psutil()
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied as exc:
        raise ProcessDiscoveryError(
            f"could not inspect process {pid}") from exc


def _process_table() -> dict[int, tuple[int, float]]:
    psutil = _psutil()
    table: dict[int, tuple[int, float]] = {}
    try:
        # Fetch ONLY pid/ppid/create_time — the fields this table uses. Eager
        # "environ"/"cmdline" reads raise SystemError on macOS for processes we
        # cannot inspect, aborting the whole scan; those are read lazily per
        # token candidate in _tagged_processes instead.
        processes = list(psutil.process_iter(
            ["pid", "ppid", "create_time"]))
        for process in processes:
            try:
                pid = process.info["pid"]
                ppid = process.info["ppid"]
                identity = process.info["create_time"]
                if isinstance(pid, int) and isinstance(ppid, int) \
                        and isinstance(identity, (int, float)):
                    table[pid] = (ppid, float(identity))
            except (psutil.AccessDenied, psutil.NoSuchProcess, SystemError):
                continue
    except (psutil.Error, OSError, SystemError) as exc:
        raise ProcessDiscoveryError("could not read the process table") from exc
    return table


def _descendants(root_pid: int) -> dict[int, float]:
    psutil = _psutil()
    try:
        children = psutil.Process(root_pid).children(recursive=True)
    except psutil.NoSuchProcess:
        return {}
    except psutil.AccessDenied as exc:
        raise ProcessDiscoveryError(
            f"could not inspect descendants of process {root_pid}") from exc
    found: dict[int, float] = {}
    for child in children:
        try:
            found[child.pid] = child.create_time()
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            continue
    return found


def _tagged_processes(
        token: str,
        baseline: dict[int, tuple[int, float]] | None = None,
        current: dict[int, tuple[int, float]] | None = None) -> dict[int, float]:
    psutil = _psutil()
    marker = f"FORGE_PROCESS_TOKEN={token}"
    current = current if current is not None else _process_table()
    candidates = set(current)
    if baseline is not None:
        candidates = {
            pid for pid, details in current.items()
            if baseline.get(pid) != details
        }
    found: dict[int, float] = {}
    # Enumerate PIDs only — do NOT eagerly fetch environ/cmdline via
    # process_iter attrs. On macOS the bulk environ read raises SystemError
    # for processes we cannot inspect, which would abort the whole scan.
    # environ/cmdline are read lazily, per candidate, below.
    try:
        processes = list(psutil.process_iter())
        current_user = psutil.Process().username()
    except (psutil.Error, OSError, SystemError) as exc:
        raise ProcessDiscoveryError("could not inspect tagged processes") from exc
    for process in processes:
        pid = process.pid
        if pid not in candidates:
            continue
        try:
            if process.username() != current_user:
                continue
        except (psutil.AccessDenied, psutil.NoSuchProcess, SystemError):
            # Never use the command-line fallback until ownership is proven.
            continue
        try:
            environment = process.environ()
        except (psutil.AccessDenied, psutil.NoSuchProcess, SystemError, OSError):
            environment = None
        tagged = (
            isinstance(environment, dict)
            and environment.get("FORGE_PROCESS_TOKEN") == token
        )
        if not tagged:
            try:
                command = process.cmdline()
                tagged = any(marker in part for part in command)
            except (psutil.AccessDenied, psutil.NoSuchProcess, SystemError,
                    OSError):
                continue
        if not tagged:
            continue
        identity = _process_start_identity(pid)
        if identity is not None:
            found[pid] = identity
        elif _pid_alive(pid):
            raise ProcessDiscoveryError(
                f"could not identify tagged process {pid}")
    return found


def _live_identified_processes(
        processes: dict[int, float]) -> dict[int, float]:
    live: dict[int, float] = {}
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
        processes: dict[int, float],
        signum: int | None = signal.SIGTERM) -> dict[int, float]:
    psutil = _psutil()
    signalled: dict[int, float] = {}
    for pid, identity in processes.items():
        # Keep the identity check adjacent to the signal: a batch-wide snapshot
        # leaves enough time for an early PID to exit and be reused.
        try:
            process = psutil.Process(pid)
            if process.status() == psutil.STATUS_ZOMBIE:
                continue
            if process.create_time() != identity:
                continue
            if signum == SIGKILL:
                process.kill()
            else:
                process.terminate()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
        signalled[pid] = identity
    return signalled


def _signal_verified_process_group(
        pgid: int, leader_identity: float) -> bool:
    """Terminate an identified leader and its currently observed children."""
    psutil = _psutil()
    try:
        leader = psutil.Process(pgid)
        if leader.status() == psutil.STATUS_ZOMBIE:
            return False
        if leader.create_time() != leader_identity:
            return False
        children = leader.children(recursive=True)
    except (psutil.AccessDenied, psutil.NoSuchProcess):
        return False
    processes: dict[int, float] = {}
    for child in children:
        try:
            processes[child.pid] = child.create_time()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
    # Children are signalled first so the leader cannot exit and reparent them
    # before they are terminated.
    processes[pgid] = leader_identity
    signalled = _signal_identified_processes(processes)
    return signalled.get(pgid) == leader_identity


def _capture_spawn_identity(proc: subprocess.Popen[str]) -> float | str:
    """Identify a new process or stop its owned tree before registration."""
    try:
        identity = _process_start_identity(proc.pid)
    except (OSError, ProcessDiscoveryError) as exc:
        identity_error: Exception = exc
    else:
        if identity:
            return identity
        identity_error = OSError(
            f"could not identify spawned process {proc.pid}")
    if proc.poll() is not None:
        return ""
    try:
        retry_identity = _process_start_identity(proc.pid)
    except (OSError, ProcessDiscoveryError):
        retry_identity = None
    if retry_identity is not None:
        _signal_verified_process_group(proc.pid, retry_identity)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if proc.poll() is None and retry_identity is not None:
            processes = _descendants(proc.pid)
            processes[proc.pid] = retry_identity
            _signal_identified_processes(processes, SIGKILL)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"unidentified process group {proc.pid} survived termination"
            ) from exc
    raise identity_error


def _terminate_processes_until_quiet(
        initial: dict[int, float], discover, reap=None) -> bool:
    """Discover and terminate new descendants until the set stays empty."""
    known = dict(initial)
    term_sent: dict[tuple[int, float], float] = {}
    kill_sent: dict[tuple[int, float], float] = {}
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
                        {pid: identity}, SIGKILL):
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
        baseline: dict[int, tuple[int, float]] | None = None,
        initial: dict[int, float] | None = None,
        reap=None) -> bool:
    return _terminate_processes_until_quiet(
        initial or {},
        lambda: _tagged_processes(token, baseline) if token else {},
        reap=reap,
    )


def _lock_file(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write("\0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise BlockingIOError(exc.errno, exc.strerror) from exc
            raise
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _acquire_delegation_lock(base: Path, lock_id: str, launch_id: str,
                             *, wait: bool = False,
                             namespace: str = "task"):
    path = delegation_lock_path(base, lock_id, namespace=namespace)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    deadline = time.monotonic() + 30
    while True:
        try:
            _lock_file(handle)
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
        _unlock_file(handle)
    handle.close()


def _lock_is_held(path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        _lock_file(handle)
    except BlockingIOError:
        return True
    else:
        _unlock_file(handle)
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
            # recorded_identity is the serialized (str) create_time; compare in
            # the same form (psutil returns the identical float per process).
            try:
                float(recorded_identity)
            except (TypeError, ValueError):
                fail(f"{task_id} already has a foreground delegation running "
                     f"(pid {pid}); wait for it to finish.")
            if (
                    current_identity is not None
                    and str(current_identity) == recorded_identity):
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
        descendants: dict[int, float],
        baseline: dict[int, tuple[int, float]] | None,
        *, foreground_identity: float | str = "") -> bool:
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
        baseline: dict[int, tuple[int, float]] | None = None,
        foreground_identity: float | str = "") -> bool:
    """Cancel a spawned command immediately, then reap every observed child."""
    # The foreground process group is the one resource we already own and can
    # identify without walking the process table. Signal it before fallible
    # descendant discovery so an unavailable `ps` cannot leave the command
    # running after Forge exits.
    if foreground_identity and proc.poll() is None:
        _signal_verified_process_group(proc.pid, foreground_identity)
    try:
        descendants = _descendants(proc.pid)
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
        baseline: dict[int, tuple[int, float]] | None = None,
        foreground_identity: float | str = "") -> bool:
    """Wait for trusted work and reap its observed process tree.

    A child can create a new session and leave the leader's process group. PID
    identity plus an inherited token finds normal detached children without
    risking a later process that merely reused the same PID. The short
    post-exit quiet window closes the common fork-and-exit race. This is
    deterministic cleanup for trusted repository commands, not hostile-code
    containment; a process that deliberately clears its environment needs the
    separately deferred container boundary.
    """
    descendants: dict[int, float] = {}
    try:
        while proc.poll() is None:
            current = _process_table()
            descendants.update(_descendants(proc.pid))
            if token:
                descendants.update(
                    _tagged_processes(token, baseline, current))
            time.sleep(PROCESS_POLL_SECONDS)
        current = _process_table()
        descendants.update(_descendants(proc.pid))
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
        installed = json.loads(metadata.read_text(encoding="utf-8"))
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
    text = (base / "harness.yaml").read_text(encoding="utf-8") if (base / "harness.yaml").is_file() else ""
    block = re.search(r"^  implementation:\n((?:    .*\n|\n)*)", text, re.MULTILINE)
    body = block.group(1) if block else ""
    model = re.search(r'^    model:\s*"?([\w.-]+)"?', body, re.MULTILINE)
    effort = re.search(r'^    reasoning:\s*"?(\w+)', body, re.MULTILINE)
    return (model.group(1) if model else DEFAULT_MODEL,
            effort.group(1) if effort else DEFAULT_EFFORT)


def mode_run_config(base: Path, mode: str) -> tuple[str, str, int]:
    """Return the model, effort, and file bound pinned for a workflow mode."""
    manifest = base / "harness.yaml"
    text = manifest.read_text(encoding="utf-8") if manifest.is_file() else ""
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
    text = (base / "harness.yaml").read_text(encoding="utf-8") if (base / "harness.yaml").is_file() else ""
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
            return candidate.read_text(encoding="utf-8")[:SKILL_INLINE_CHARS]
    return ""


def _section(title: str, body: str) -> str:
    return f"\n## {title}\n\n{body.rstrip()}\n" if body.strip() else ""


CONSTITUTION_BRIEF = (
    "The KnackLabs Engineering Constitution in `constitution/` is BINDING — it is "
    "law for HOW code is written, not just how you behave. Before you write a line, "
    "open `constitution/README.md` (its index maps the work at hand to the "
    "authoritative reference) and READ + FOLLOW every matching doc: coding "
    "standards (`pnp-coding-standards-modular-monolith.md` — file suffixes, DTOs, "
    "mappers, interfaces, providers, module layout), API + Swagger "
    "(`pnp-api-standards.md`, `pnp-swagger-api-documentation-standards.md` — every "
    "endpoint has typed request AND response DTOs), logging/observability "
    "(`05`/`06`), exception handling (`07`), notification port (`08`), database "
    "(`pnp-database-standards.md`), provider pattern "
    "(`pnp-provider-pattern-for-integration.md`), modular-monolith structure "
    "(`03`). The constitution wins over habit and over anything this brief forgot "
    "to restate; a task never re-derives a standard the constitution already sets. "
    "Deviate only deliberately and in writing, with a reason (\"Context is King\") "
    "— never silently.\n\n"
    "This is UNCONDITIONAL and ENVIRONMENT-INDEPENDENT: `constitution/` is vendored "
    "into this repo, so it is on disk and readable even in a sandbox or worktree "
    "with no network. If you spawn or delegate to ANY subagent, you MUST pass it "
    "this same instruction — every agent that touches code follows the "
    "constitution, everywhere."
)


PONYTAIL_BRIEF = (
    "Ponytail is the BINDING minimal-diff coding discipline for every line you "
    "write or edit — hold it strictly, but it is a habit, not a mechanical gate. "
    "Understand the problem and TRACE the affected code first, then climb this "
    "ladder and STOP at the first rung that works: (1) does it need to exist at "
    "all? skip speculative features (YAGNI); (2) already in this codebase? reuse "
    "it; (3) does the stdlib provide it? use it; (4) a native platform feature? "
    "prefer it; (5) an already-installed dependency? use it before adding one; "
    "(6) can it be one line? one line beats fifty; (7) only then, the minimum "
    "viable code that solves the ACTUAL problem. Shortest diff, shortest "
    "explanation.\n\n"
    "Lazy, NOT negligent — NEVER simplify away trust-boundary/input validation, "
    "error handling that prevents data loss, security, accessibility basics, "
    "explicitly-requested functionality, hardware calibration knobs, or the one "
    "runnable self-check for non-trivial logic. Mark a deliberate corner cut with "
    "an inline `ponytail: <limitation>, <upgrade path if scale matters>` comment "
    "so it can be harvested later. Ponytail trims SPECULATIVE code; it NEVER "
    "overrides the constitution's mandated structure (modules, DTOs, the response "
    "envelope, provider pattern) — that structure is law, not bloat."
)


def compose_brief(base: Path, task: dict, *, write: bool, user_facing: bool,
                  story: str) -> str:
    scope = task.get("write_scope") or []
    try:
        max_files, max_lines, _reason = review_budget(task)
    except ValueError as exc:
        fail(f"{task.get('id', '(unknown)')} carries an invalid review_budget "
             f"({exc}); re-record the decomposition before delegating")
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
        "",
        f"Review budget: {max_files} files / {max_lines} changed lines "
        "(additions + deletions), excluding `.factory/` and `plans/`. If the "
        "work will exceed it, stop and return incomplete so the orchestrator "
        "can split the task before more work.",
        "Narration budget: one line per state change, findings and refusals "
        "always in full, process chatter never (conduct §8).",
    ]
    body = "\n".join(lines) + "\n"
    body += _section("Constitution — coding standards (BINDING)", CONSTITUTION_BRIEF)
    body += _section(
        "Ponytail — minimal-diff coding discipline (BINDING)",
        "LOAD and RUN the `ponytail` skill from your Codex skills dir "
        "(`~/.codex/skills/ponytail`, installed by `./forge doctor --fix`) and hold "
        "it on every line you write or edit. Its rules are reproduced below as the "
        "binding floor in case your runtime cannot load it:\n\n"
        + (_skill_text("ponytail") or PONYTAIL_BRIEF))
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
    reviewer_focus = task.get("reviewer_focus", "")
    if isinstance(reviewer_focus, list):
        # The decomposition records reviewer_focus as a LIST (the stage-start
        # gate requires it non-empty); render it like the other list sections.
        reviewer_focus = "\n".join(f"- {item}" for item in reviewer_focus)
    body += _section("Reviewer focus", reviewer_focus)
    decisions = [r for r in decision_records(base) if r["status"] == "accepted"]
    body += _section("Active decisions — binding", "\n".join(
        f"- {r['id']}: {r['title']}" for r in decisions))
    lessons = relevant_lessons(base, scope)
    body += _section("Lessons recorded against these paths", "\n".join(
        f"- {le.get('lesson', '')}" for le in lessons))
    prompt = base / "factory" / "prompts" / "implementer.md"
    if prompt.is_file():
        body += _section("Implementer contract", prompt.read_text(encoding="utf-8"))
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
    write_detail = ("YES (lite window is open)" if mode else
                    "YES (stage is active with a write scope)")
    launch_detail = " | not launched" if print_only else ""
    print(f"Brief {rel} ({len(text.splitlines())} lines) | "
          f"Write access: {write_detail if write else 'NO'} | "
          f"{shlex.join(argv)}{launch_detail}")
    if print_only:
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
    process_baseline: dict[int, tuple[int, float]] | None = None
    process_identity: float | str = ""
    stdout = ""
    stderr = ""
    stdout_log = tempfile.TemporaryFile(
        mode="w+t", encoding="utf-8", errors="replace"
    )
    stderr_log = tempfile.TemporaryFile(
        mode="w+t", encoding="utf-8", errors="replace"
    )
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
            process_env["PYTHONUTF8"] = "1"
            with blocked_termination_signals():
                process_baseline = _process_table()
                spawn_options = (
                    {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                    if os.name == "nt"
                    else {"start_new_session": True,
                          "preexec_fn": unblock_termination_signals_in_child}
                )
                proc = subprocess.Popen(
                    argv, cwd=base, stdout=stdout_log, stderr=stderr_log,
                    text=True, env=process_env, **spawn_options,
                )
                process_identity = _capture_spawn_identity(proc)
                record.update({
                    "at": now_iso(),
                    "launch_status": "running",
                    "pid": proc.pid,
                    "pgid": proc.pid,
                    # Ledger field is a string (schema); create_time identity
                    # is compared in serialized form (str is stable per proc).
                    "pid_started": str(process_identity),
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
    # Derived, not typed: an active stage is a write run. --read-only is the
    # explicit exception for exploration; an empty scope is an incomplete
    # contract, not an implicit read-only downgrade.
    active = stage.get("status") == "active"
    if active and not args.read_only:
        require_task_worktree(base)
        task = require_ready_task(base, args.id)
        scope = task.get("write_scope") or []
    write = bool(active and scope) and not args.read_only
    task_sha256_value = task_digest(task)
    if write and args.background:
        fail("background write delegation cannot satisfy a measured stage: the "
             "worker could keep writing after stage close. Run it in the foreground, "
             "or use --read-only for background exploration.")
    state = load_json(run_state_path(base), default={})
    story = str(state.get("story") or state.get("issue_key") or "")
    text = compose_brief(base, task, write=write,
                         user_facing=bool(task.get("user_facing")),
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
        task_sha256_value=task_sha256_value,
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
