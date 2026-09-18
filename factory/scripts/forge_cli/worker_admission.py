"""Validate a hook caller against a live protected Forge write launch."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from factory_lib import (
    classify_scope_entries, git_control_dir, load_json, now_iso, run_state_path,
    sha256_of, task_digest,
)

from .delegate import (
    SAFE_TASK_ID,
    _lock_is_held,
    _process_start_identity,
    argv_digest,
    brief_path,
    delegation_lock_path,
    load_delegations,
)
from .quickfix import LITE, load_active, profile_of
from .stages import load_stages


def _deny(reason: str) -> tuple[None, str]:
    return None, f"Forge worker write admission refused: {reason}"


def _revocation_path(base: Path, launch_id: str) -> Path:
    if not SAFE_TASK_ID.fullmatch(launch_id):
        raise ValueError("launch id is not a plain identifier")
    return git_control_dir(base) / "revoked-launches" / f"{launch_id}.json"


def revoke_worker_admission(base: Path, record: dict) -> None:
    """Permanently revoke one launch before cancellation signals its process."""
    launch_id = str(record.get("launch_id") or "")
    path = _revocation_path(base, launch_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        return
    try:
        payload = json.dumps({
            "launch_id": launch_id,
            "process_token": record.get("process_token"),
            "revoked_at": now_iso(),
        }).encode("utf-8")
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def worker_admission_revoked(base: Path, launch_id: str) -> bool:
    try:
        path = _revocation_path(base, launch_id)
        path.lstat()
        return True
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True


def parse_native_grill_label(label: object) -> tuple[str, str] | None:
    """Parse only exact non-task grills or grill-task-<safe-id>."""
    if not isinstance(label, str):
        return None
    from grill_gates import gate_names
    gates = set(gate_names())
    prefix = "grill-task-"
    if "task" in gates and label.startswith(prefix):
        task_id = label.removeprefix(prefix)
        return ("task", task_id) if SAFE_TASK_ID.fullmatch(task_id) else None
    return next(((gate, "") for gate in gates - {"task"}
                 if label == f"grill-{gate}"), None)


def _current_process_descends_from(pid: int, identity: str) -> bool:
    try:
        import psutil
    except ImportError:
        return False
    try:
        # ponytail: follow only this caller's ppid chain; a global process scan
        # is unnecessary and can be denied even when the caller is inspectable.
        current = os.getpid()
        seen: set[int] = set()
        while current > 0 and current not in seen:
            seen.add(current)
            process = psutil.Process(current)
            if current == pid:
                return str(process.create_time()) == identity
            parent = process.ppid()
            if parent == current:
                break
            current = parent
    except (OSError, SystemError, psutil.Error):
        return False
    return False


def _bound_rows(base: Path, launch_id: str,
                all_rows: list[dict] | None = None) -> tuple[list[dict], str]:
    try:
        rows = [row for row in (all_rows if all_rows is not None
                                else load_delegations(base))
                if row.get("launch_id") == launch_id]
    except (OSError, SystemExit, ValueError) as exc:
        return [], str(exc)
    if not rows:
        return [], "the launch id has no protected authority record"
    bindings = (
        "task", "story", "brief_sha256", "task_sha256", "write", "model", "effort",
        "argv", "argv_sha256", "write_scope", "stage_started_at", "process_token", "mode",
        "transport", "brief_path", "executable_path", "resume_session",
        "output_path", "stderr_path",
    )
    if any(row.get(field) != rows[0].get(field)
           for row in rows[1:] for field in bindings):
        return [], "the launch binding changed between lifecycle rows"
    if [row.get("launch_status") for row in rows] != ["starting", "running"]:
        return [], "the latest protected launch is not exclusively running"
    return rows, ""


def _lite_contract(base: Path, record: dict) -> tuple[dict | None, str]:
    window = load_active(base)
    if not window or profile_of(window) != LITE:
        return _deny("the bound lite window is no longer open")
    if record.get("mode") != LITE or record.get("task") != window.get("id"):
        return _deny("the running launch does not match the current lite window")
    canonical = brief_path(base, str(window["id"]))
    try:
        lines = canonical.read_text(encoding="utf-8").splitlines()
    except OSError:
        return _deny("the bound lite brief is missing")
    description = next(
        (line.removeprefix("Fix: ") for line in lines if line.startswith("Fix: ")),
        "",
    )
    contract = {
        "acceptance_criteria": [description],
        "required_tests": [],
        "verify_commands": [],
        "write_scope": [],
    }
    if not description or record.get("task_sha256") != task_digest(contract):
        return _deny("the lite fix contract changed after launch")
    return {"kind": LITE, "window": window}, ""


def _stage_contract(base: Path, record: dict) -> tuple[dict | None, str]:
    task_id = record.get("task")
    from factory_lib import protected_decomposition_state_path

    decomposition = load_json(protected_decomposition_state_path(base), default={})
    task = next((item for item in decomposition.get("tasks", [])
                 if isinstance(item, dict) and item.get("id") == task_id), None)
    if task is None or record.get("task_sha256") != task_digest(task):
        return _deny("the protected task contract changed after launch")
    stages = load_stages(base)
    stage = next((item for item in stages.get("stages", [])
                  if isinstance(item, dict) and item.get("id") == task_id), None)
    # The stage digest is its immutable start baseline and can differ after a
    # supported mid-stage amendment. The current task check above binds this
    # launch to the amended contract; started_at still binds its incarnation.
    if (
        stage is None
        or stage.get("status") != "active"
        or stage.get("started_at") != record.get("stage_started_at")
    ):
        return _deny("the bound task stage is no longer the active stage")
    run = load_json(run_state_path(base), default={})
    story = run.get("story") or run.get("issue_key")
    if record.get("story") and record.get("story") != story:
        return _deny("the active story changed after launch")
    task_scope = task.get("write_scope") or []
    if not task_scope or any(not isinstance(item, str) or not item.strip()
                             for item in task_scope):
        return _deny("the protected task has no valid write scope")
    scope = record.get("write_scope") if record.get("transport") == "native" else task_scope
    if (not isinstance(scope, list) or not scope
            or any(not isinstance(item, str) or not item.strip() for item in scope)):
        return _deny("the protected native launch has no valid recorded write scope")
    if scope != task_scope:
        return _deny("the protected native launch write scope does not match its task")
    from .stages import stage_baseline
    return {
        "kind": "stage",
        "scope": classify_scope_entries(base, scope, stage_baseline(base, stage)),
    }, ""


def live_worker_admission(base: Path) -> tuple[dict | None, str]:
    """Return the live launch grant, or a reason for a claimed-but-invalid grant.

    An empty reason means this is an ordinary coordinator process with no worker
    credentials. Environment markers select a protected record; they never grant
    authority by themselves.
    """
    token = os.environ.get("FORGE_PROCESS_TOKEN", "")
    launch_id = os.environ.get("FORGE_LAUNCH_ID", "")
    if not token and not launch_id:
        return None, ""
    if not token:
        return _deny("FORGE_PROCESS_TOKEN is missing")
    all_rows = None
    if not launch_id:
        # The current Claude companion exports only its protected process token;
        # it still resolves one exact launch. Native launches require both markers.
        try:
            all_rows = load_delegations(base)
        except (OSError, SystemExit, ValueError) as exc:
            return _deny(str(exc))
        candidates = {
            row.get("launch_id") for row in all_rows
            if row.get("process_token") == token and not row.get("transport")
        }
        if len(candidates) != 1 or not all(isinstance(item, str) for item in candidates):
            return _deny("the current Claude process token does not resolve one companion launch")
        launch_id = candidates.pop()
    if worker_admission_revoked(base, launch_id):
        return _deny("the protected launch authority was revoked")
    rows, error = _bound_rows(base, launch_id, all_rows)
    if error:
        return _deny(error)
    record = rows[-1]
    if record.get("argv_sha256") != argv_digest(record.get("argv") or []):
        return _deny("the protected launch argv digest is invalid")
    if record.get("transport") == "native" and not os.environ.get("FORGE_LAUNCH_ID"):
        return _deny("native workers require FORGE_LAUNCH_ID")
    if record.get("process_token") != token or record.get("write") is not True:
        return _deny("the environment does not match a protected write launch")
    pid, identity = record.get("pid"), record.get("pid_started")
    if not isinstance(pid, int) or not isinstance(identity, str):
        return _deny("the running row has no process identity")
    try:
        current_identity = _process_start_identity(pid)
    except (OSError, RuntimeError):
        current_identity = None
    if current_identity is None or str(current_identity) != identity:
        return _deny("the registered worker process is no longer live")
    if not _current_process_descends_from(pid, identity):
        return _deny("the hook caller is outside the registered worker process tree")
    task_id = record.get("task")
    if not isinstance(task_id, str):
        return _deny("the protected launch has no task id")
    lock_path = delegation_lock_path(base, task_id)
    if not _lock_is_held(lock_path):
        return _deny("the protected write lock is no longer held")
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _deny("the protected write lock is malformed")
    if (
        lock.get("kind") != "delegation"
        or lock.get("launch_id") != launch_id
        or lock.get("owner_pid") != pid
    ):
        return _deny("the protected write lock does not match the running worker")
    canonical = brief_path(base, task_id)
    if (
        canonical.is_symlink()
        or not canonical.is_file()
        or record.get("brief_sha256") != sha256_of(canonical)
    ):
        return _deny("the delegation brief changed after launch")
    if record.get("brief_path"):
        try:
            if (base / str(record["brief_path"])).resolve() != canonical.resolve():
                return _deny("the native brief path is not canonical")
        except OSError:
            return _deny("the native brief path cannot be resolved")
    contract, reason = (_lite_contract(base, record) if record.get("mode") == LITE
                        else _stage_contract(base, record))
    if record.get("transport") == "native" and contract:
        try:
            from .codex_runtime import native_argv_valid
            native_shape_valid = native_argv_valid(
                record, base, contract.get("scope") or [])
        except (ImportError, OSError, TypeError, ValueError):
            native_shape_valid = False
        if not native_shape_valid:
            return _deny("the protected native argv is invalid")
    if worker_admission_revoked(base, launch_id):
        return _deny("the protected launch authority was revoked")
    return contract, reason


def live_native_read_only_grill(base: Path) -> tuple[dict | None, str]:
    """Authenticate the live native child for one ledgered read-only grill."""
    token = os.environ.get("FORGE_PROCESS_TOKEN", "")
    launch_id = os.environ.get("FORGE_LAUNCH_ID", "")
    if not token and not launch_id:
        return None, ""
    if not token or not launch_id:
        return _deny("native read-only grills require both launch selectors")
    if worker_admission_revoked(base, launch_id):
        return _deny("the protected launch authority was revoked")
    rows, error = _bound_rows(base, launch_id)
    if error:
        return _deny(error)
    record = rows[-1]

    parsed_label = parse_native_grill_label(record.get("task"))
    if parsed_label is None:
        return _deny("the protected read-only launch is not a grill")
    gate, task_id = parsed_label
    expected = base / ".factory" / (
        f"grill-brief-{gate}" + (f"-{task_id}" if task_id else "") + ".md")
    digest = record.get("task_sha256")
    if (
        record.get("transport") != "native"
        or record.get("write") is not False
        or record.get("mode")
        or record.get("process_token") != token
        or not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or record.get("argv_sha256") != argv_digest(record.get("argv") or [])
    ):
        return _deny("the protected read-only grill binding is invalid")
    try:
        from .codex_runtime import native_argv_valid
        argv_valid = native_argv_valid(record, base, [])
    except (ImportError, OSError, TypeError, ValueError):
        argv_valid = False
    if not argv_valid:
        return _deny("the protected native read-only argv is invalid")
    if (
        expected.is_symlink()
        or not expected.is_file()
        or record.get("brief_path") != expected.relative_to(base).as_posix()
        or record.get("brief_sha256") != sha256_of(expected)
    ):
        return _deny("the protected grill brief changed after launch")
    pid, identity = record.get("pid"), record.get("pid_started")
    if not isinstance(pid, int) or not isinstance(identity, str):
        return _deny("the running grill row has no process identity")
    try:
        current_identity = _process_start_identity(pid)
    except (OSError, RuntimeError):
        current_identity = None
    if current_identity is None or str(current_identity) != identity:
        return _deny("the registered grill process is no longer live")
    if not _current_process_descends_from(pid, identity):
        return _deny("the hook caller is outside the registered grill process tree")
    if worker_admission_revoked(base, launch_id):
        return _deny("the protected launch authority was revoked")
    return record, ""


def path_in_scope(path: str, scope: list[str]) -> bool:
    return any(
        bool(prefix := entry.strip().rstrip("/"))
        and (path == prefix or (entry.strip().endswith("/")
                               and path.startswith(prefix + "/")))
        for entry in scope
    )
