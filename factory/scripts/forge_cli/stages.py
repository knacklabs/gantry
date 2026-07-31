"""forge stage — per-task execution tracker (.factory/stages.json).

The recorded decomposition is immutable evidence; this file is the mutable
execution state derived from it (one stage per leaf task, list order =
execution order). The loop per stage (WORKFLOW.md "Stage Loop", decision
0007): implement via /codex:rescue → inspect the diff → validate assumption
rows → smallest checks → LOCAL autoreview until clean → commit →
`forge stage done`. `pr_ready` refuses while any stage is not done. Task-
scoped: archived to .factory/history/<issue>/ and cleaned at ship.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import shlex
import signal
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from factory_lib import (
    clean_git_env, decomposition_state_path, dump_json, git_control_dir,
    head_sha, load_json, now_iso, protected_decomposition_state_path, repo_root,
    run_state_path, safe_factory_write_json, sha256_of,
)

from .common import fail
from .events import append_event

# The workflow writes these itself while a stage runs — the events ledger, the
# stage tracker, an assumption row appended to the active plan. They are not
# the product change under measurement, so write_scope does not have to name
# them. Deliberately NARROWER than pr_ready's EVIDENCE_PATHS: that list exempts
# all of `factory/` and `docs/`, which in the harness's own repo is the product
# — exempting it here would make the scope check vacuous exactly where it is
# being dogfooded.
WORKFLOW_PATHS = (".factory/", "plans/")


@contextlib.contextmanager
def termination_signal_guard():
    """Turn wrapper termination into normal cleanup paths for proof children."""
    handled = [
        candidate for candidate in (
            signal.SIGINT,
            signal.SIGTERM,
            getattr(signal, "SIGHUP", None),
            getattr(signal, "SIGQUIT", None),
        )
        if candidate is not None
    ]
    previous = {candidate: signal.getsignal(candidate) for candidate in handled}

    def stop(signum, _frame):
        raise SystemExit(128 + signum)

    for candidate in handled:
        signal.signal(candidate, stop)
    try:
        yield
    finally:
        for candidate, prior in previous.items():
            signal.signal(candidate, prior)


def stages_path(base: Path) -> Path:
    return base / ".factory" / "stages.json"


def authoritative_stages_path(base: Path) -> Path:
    return git_control_dir(base) / "stages.json"


def write_stages(base: Path, data: dict) -> None:
    """Publish protected authority first, then a best-effort workspace mirror."""
    dump_json(authoritative_stages_path(base), data)
    safe_factory_write_json(base, stages_path(base).name, data)


def write_skeleton(base: Path, issue: str, tasks: list[dict]) -> None:
    """Re-recording a decomposition after a mid-story scope change must not
    erase what is already built: surviving task ids keep their status and
    timestamps, new ids arrive pending, removed ids drop out."""
    existing = load_stages(base)
    previous = ({s.get("id"): s for s in existing.get("stages", [])}
                if existing.get("issue") == issue else {})
    stages = []
    for task in tasks:
        stage = {"id": task["id"], "title": task["title"], "status": "pending"}
        old = previous.get(task["id"])
        if old:
            stage.update({k: v for k, v in old.items()
                          if k in ("status", "started_at", "completed_at",
                                   "base_sha", "dirty_at_start", "task_sha256",
                                   "incomplete")})
            stage["title"] = task["title"]
        stages.append(stage)
    write_stages(base, {"issue": issue, "stages": stages})


def load_stages(base: Path) -> dict:
    protected = authoritative_stages_path(base)
    if protected.is_file():
        data = load_json(protected, default={})
        current_issue = load_json(run_state_path(base), default={}).get("issue_key")
        return data if not current_issue or data.get("issue") == current_issue else {}
    return {}


def pending_stages(base: Path) -> list[dict]:
    return [s for s in load_stages(base).get("stages", [])
            if s.get("status") != "done"]


def _git(base: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=base, capture_output=True, text=True,
        env=clean_git_env())
    return proc.stdout if proc.returncode == 0 else ""


def dirty_paths(base: Path) -> list[str]:
    """Every dirty path, including both sides of renames, without quote parsing."""
    raw = _git(base, "status", "--porcelain=v1", "-z", "-uall")
    entries = raw.split("\0")
    paths: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        status, rel = entry[:2], entry[3:]
        if rel:
            paths.append(rel)
        if any(flag in status for flag in "RC") and index < len(entries):
            source = entries[index]
            index += 1
            if source:
                paths.append(source)
    return sorted(set(paths))


def committed_paths(base: Path, base_sha: str, head: str) -> set[str]:
    """Both sides of every committed change, including renames and copies."""
    raw = _git(base, "diff", "--name-status", "-z", "--find-renames",
               f"{base_sha}..{head}")
    entries = raw.split("\0")
    paths: set[str] = set()
    index = 0
    while index < len(entries):
        status = entries[index]
        index += 1
        if not status or index >= len(entries):
            continue
        rel = entries[index]
        index += 1
        if rel:
            paths.add(rel)
        if status[:1] in {"R", "C"} and index < len(entries):
            destination = entries[index]
            index += 1
            if destination:
                paths.add(destination)
    return paths


def _gitlink_entries(index_stage: str) -> dict[str, str]:
    """Gitlink metadata keyed by exact, unquoted path bytes decoded by Git."""
    result: dict[str, str] = {}
    for entry in index_stage.split("\0"):
        if "\t" not in entry:
            continue
        metadata, rel = entry.split("\t", 1)
        fields = metadata.split()
        if fields and fields[0] == "160000":
            result[rel] = metadata
    return result


def _gitlink_identities(base: Path, index_stage: str | None = None,
                        wanted: set[str] | None = None) -> dict[str, str]:
    entries = _gitlink_entries(
        index_stage
        if index_stage is not None
        else _git(base, "ls-files", "--stage", "-z")
    )
    result: dict[str, str] = {}
    for rel, metadata in entries.items():
        if wanted is not None and rel not in wanted:
            continue
        checkout = base / rel
        head = _git(base, "-C", str(checkout), "rev-parse", "HEAD")
        status = _git(
            base, "-C", str(checkout),
            "status", "--porcelain=v2", "-z", "-uall")
        digest = hashlib.sha256()
        digest.update("\0".join((metadata, head, status)).encode())
        result[rel] = digest.hexdigest()
    return result


def _digest(base: Path, rel: str,
            gitlinks: dict[str, str] | None = None) -> str | None:
    if gitlinks is None:
        gitlinks = _gitlink_identities(base, wanted={rel})
    if rel in gitlinks:
        return gitlinks[rel]
    path = base / rel
    try:
        digest = hashlib.sha256()
        mode = path.lstat().st_mode
        if path.is_symlink():
            digest.update(str(mode).encode())
            digest.update(os.readlink(path).encode())
        elif path.is_dir():
            # Git does not record directory modes. Replacement descendants are
            # measured separately, so chmod on their container is not product
            # work and must not satisfy the contribution gate.
            digest.update(b"directory")
        else:
            digest.update(str(mode).encode())
            digest.update(path.read_bytes())
        return digest.hexdigest()
    except FileNotFoundError:
        return ""
    except OSError:
        return None


def _git_path_identity(base: Path, rel: str) -> str:
    return "\0".join((
        _git(base, "status", "--porcelain=v2", "-z", "-uall", "--", rel),
        _git(base, "ls-files", "--stage", "-z", "--", rel),
        _git(base, "ls-files", "-v", "-z", "--", rel),
    ))


def dirty_digests(base: Path) -> dict[str, dict[str, str]]:
    """Content and Git identity of every dirty path when the stage starts.

    Names alone are not enough: subtracting a NAME would hide every later edit
    or index transition to that file. Digests plus porcelain/index identity
    distinguish "still exactly as I found it" from "this stage changed it
    too", even when bytes stay equal."""
    result: dict[str, dict[str, str]] = {}
    paths = dirty_paths(base)
    gitlinks = _gitlink_identities(base, wanted=set(paths))
    for rel in paths:
        digest = _digest(base, rel, gitlinks)
        if digest is None:
            fail(f"cannot read dirty path {rel!r}; stage measurement refuses "
                 "to treat unreadable content as absent")
        result[rel] = {
            "digest": digest,
            "git": _git_path_identity(base, rel),
        }
    return result


def product_tree_snapshot(base: Path) -> dict:
    """The exact Git-visible product tree attested by proof commands."""
    tracked = [
        rel for rel in _git(base, "ls-files", "-z", "--cached").split("\0")
        if rel
    ]
    index_stage = _git(base, "ls-files", "--stage", "-z")
    dirty = [
        rel for rel in dirty_paths(base)
        if not rel.startswith(WORKFLOW_PATHS)
    ]
    digests: dict[str, str] = {}
    gitlinks = _gitlink_identities(
        base, index_stage=index_stage, wanted=set(tracked) | set(dirty))
    for rel in sorted(set(tracked) | set(dirty)):
        digest = _digest(base, rel, gitlinks)
        if digest is None:
            fail(f"cannot read product path {rel!r}; proof cannot attest an "
                 "unreadable final tree")
        digests[rel] = digest
    return {
        "head": head_sha(base) or "",
        "status": _git(base, "status", "--porcelain=v2", "-z", "-uall"),
        "worktree_raw": _git(base, "diff", "--raw", "-z"),
        "index_raw": _git(base, "diff", "--cached", "--raw", "-z"),
        "index_stage": index_stage,
        "index_flags": _git(base, "ls-files", "-v", "-z"),
        "tracked": {rel: digests[rel] for rel in tracked},
        "dirty": {rel: digests[rel] for rel in dirty},
    }


def changed_paths(base: Path, base_sha: str, already_dirty) -> list[str]:
    """Everything this stage moved: commits since base_sha plus the working
    tree. Pre-existing dirt is subtracted only from the working-tree side:
    once a path enters a commit it is stage work and must be scope-checked."""
    committed: set[str] = set()
    head = head_sha(base)
    if base_sha and head and base_sha != head:
        committed.update(committed_paths(base, base_sha, head))
    working = set(dirty_paths(base))
    measured_paths = (
        working
        | (set(already_dirty) if isinstance(already_dirty, dict) else set())
    )
    gitlinks = _gitlink_identities(base, wanted=measured_paths)
    current_digests: dict[str, str] = {}
    for path in measured_paths:
        digest = _digest(base, path, gitlinks)
        if digest is None:
            fail(f"cannot read changed path {path!r}; stage measurement refuses "
                 "to treat unreadable content as absent")
        current_digests[path] = digest
    if isinstance(already_dirty, dict):
        working = {
            path for path in working
            if (
                current_digests[path]
                != (
                    already_dirty.get(path, {}).get("digest", "\0")
                    if isinstance(already_dirty.get(path), dict)
                    else already_dirty.get(path, "\0")
                )
                or (
                    isinstance(already_dirty.get(path), dict)
                    and _git_path_identity(base, path)
                    != already_dirty[path].get("git", "\0")
                )
            )
        }
        for path, baseline in already_dirty.items():
            digest = (
                baseline.get("digest", "\0")
                if isinstance(baseline, dict) else baseline)
            git_identity = (
                baseline.get("git", "\0")
                if isinstance(baseline, dict) else None)
            if (current_digests[path] != digest
                    or (git_identity is not None
                        and _git_path_identity(base, path) != git_identity)):
                working.add(path)
    return sorted(committed | working)


def contribution_paths(base: Path, paths: list[str], already_dirty,
                       base_sha: str) -> list[str]:
    """Paths whose current bytes differ from the pre-stage workspace.

    A pre-existing dirty file may be committed during a stage for workspace
    hygiene. If its bytes never changed, that commit is still scope-checked but
    it cannot masquerade as the task's implementation.
    """
    if not isinstance(already_dirty, dict):
        already_dirty = {}
    gitlinks = _gitlink_identities(base, wanted=set(paths))
    worktree_changed = {
        rel for rel in _git(
            base, "diff", "--name-only", "-z", base_sha, "--").split("\0")
        if rel
    }
    tracked_at_start = {
        rel for rel in _git(
            base, "ls-tree", "-r", "--name-only", "-z",
            base_sha).split("\0")
        if rel
    }
    result = []
    for path in paths:
        baseline = already_dirty.get(path)
        if baseline is None:
            current = _digest(base, path, gitlinks)
            if current is None:
                fail(f"cannot read changed path {path!r}; stage measurement "
                     "refuses to treat unreadable content as absent")
            if path in worktree_changed or (
                    path not in tracked_at_start and current != ""):
                result.append(path)
            continue
        before = baseline.get("digest") if isinstance(baseline, dict) else baseline
        current = _digest(base, path, gitlinks)
        if current is None:
            fail(f"cannot read changed path {path!r}; stage measurement refuses "
                 "to treat unreadable content as absent")
        if current != before:
            result.append(path)
    return result


def split_index_paths(base: Path) -> list[str]:
    """Paths with staged content different from the tested worktree content."""
    def exact_path_exists(rel: str) -> bool:
        current = base
        for part in Path(rel).parts:
            try:
                entries = os.listdir(current)
            except FileNotFoundError:
                return False
            except OSError:
                return True
            if part not in entries:
                return False
            current /= part
        return os.path.lexists(current)

    staged = {
        rel for rel in _git(
            base, "diff", "--cached", "--name-only", "-z").split("\0")
        if rel
    }
    unstaged = {
        rel for rel in _git(
            base, "diff", "--name-only", "-z").split("\0")
        if rel
    }
    unstaged.update(
        rel for rel in _git(
            base, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
        if rel
    )
    staged_deletions = {
        rel for rel in _git(
            base, "diff", "--cached", "--no-renames", "--diff-filter=D",
            "--name-only", "-z").split("\0")
        if rel
    }
    index_paths = {
        rel for rel in _git(
            base, "ls-files", "--cached", "-z").split("\0")
        if rel
    }
    gitlink_paths = set(_gitlink_entries(
        _git(base, "ls-files", "--stage", "-z")
    ))

    def directory_matches_index(rel: str) -> bool:
        root = base / rel
        if not root.is_dir() or root.is_symlink():
            return False
        prefix = f"{rel.rstrip('/')}/"
        indexed = {
            path for path in index_paths if path.startswith(prefix)
        }
        if not indexed:
            return False
        actual: set[str] = set()
        actual_directories: set[str] = set()
        expected_directories: set[str] = set()
        for indexed_path in indexed:
            parent = Path(indexed_path).parent.as_posix()
            while parent != rel and parent.startswith(prefix):
                expected_directories.add(parent)
                parent = Path(parent).parent.as_posix()
        walk_errors: list[OSError] = []
        for current, directories, files in os.walk(
                root, followlinks=False, onerror=walk_errors.append):
            current_path = Path(current)
            gitlink_directories = [
                name for name in directories
                if (current_path / name).relative_to(base).as_posix()
                in gitlink_paths
            ]
            actual.update(
                (current_path / name).relative_to(base).as_posix()
                for name in gitlink_directories
            )
            symlink_directories = [
                name for name in directories
                if (current_path / name).is_symlink()
            ]
            ordinary_directories = [
                name for name in directories
                if (
                    name not in symlink_directories
                    and name not in gitlink_directories
                )
            ]
            actual_directories.update(
                (current_path / name).relative_to(base).as_posix()
                for name in ordinary_directories
            )
            directories[:] = ordinary_directories
            for name in [*files, *symlink_directories]:
                actual.add(
                    (current_path / name).relative_to(base).as_posix()
                )
        return (
            not walk_errors
            and actual == indexed
            and actual_directories == expected_directories
        )

    recreated = {
        rel for rel in staged_deletions
        if (
            exact_path_exists(rel)
            and not directory_matches_index(rel)
        )
    }
    return sorted((staged & unstaged) | recreated)


def protected_authority_snapshot(base: Path) -> dict[str, str]:
    """Exact protected state before proof code receives execution."""
    control = git_control_dir(base)
    if not control.exists():
        fail("protected Forge authority is missing")
    result: dict[str, str] = {}
    for path in sorted(control.rglob("*")):
        rel = path.relative_to(control).as_posix()
        try:
            info = path.lstat()
            if path.is_symlink():
                body = f"symlink:{os.readlink(path)}".encode()
            elif path.is_dir():
                body = b"directory"
            else:
                body = path.read_bytes()
        except OSError:
            fail(f"cannot read protected authority path {rel!r}")
        digest = hashlib.sha256()
        digest.update(str(info.st_mode).encode())
        digest.update(body)
        result[rel] = digest.hexdigest()
    return result


def task_digest(task: dict) -> str:
    """The task contract a stage was started under.

    The decomposition can be re-recorded while a stage is active — that is the
    sanctioned repair when a scope turns out to be wrong — but it must not be
    a way to widen `write_scope` or drop `required_tests` moments before
    closing over them."""
    payload = json.dumps({k: task.get(k) for k in
                          ("write_scope", "required_tests", "verify_commands",
                           "acceptance_criteria")}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def _covered(path: str, scope: list[str]) -> bool:
    for entry in scope:
        prefix = entry.strip().rstrip("/")
        if prefix and (path == prefix or path.startswith(prefix + "/")):
            return True
    return False


def out_of_scope(paths: list[str], scope: list[str]) -> list[str]:
    """Product paths this sequential task touched but never declared."""
    return [p for p in paths
            if not p.startswith(WORKFLOW_PATHS)
            and not _covered(p, scope)]


def task_for(base: Path, stage_id: str) -> dict:
    tasks = load_json(
        protected_decomposition_state_path(base), default={}).get("tasks", [])
    return next((t for t in tasks if t.get("id") == stage_id), {})


def _find(data: dict, stage_id: str) -> dict:
    stage = next((s for s in data.get("stages", []) if s.get("id") == stage_id), None)
    if stage is None:
        known = ", ".join(s.get("id", "?") for s in data.get("stages", []))
        fail(f"stage {stage_id!r} is not in .factory/stages.json ({known or 'empty'})")
    return stage


def _cmd_start_locked(args: argparse.Namespace, base: Path) -> None:
    data = load_stages(base)
    if not data:
        fail("no .factory/stages.json — record the decomposition first "
             "(record_decomposition_from_json.py creates the stage tracker)")
    if args.parallel:
        fail("task stages are sequential inside one story worktree; parallelism "
             "belongs between dependency-ready stories in separate worktrees")
    stage = _find(data, args.id)
    if stage.get("status") == "done":
        fail(f"{args.id} is already done — stages don't reopen; a follow-up is a "
             "new stage in a re-recorded decomposition")
    current_task = task_for(base, args.id)
    if stage.get("status") == "active":
        recorded = stage.get("task_sha256")
        current = task_digest(current_task)
        if not recorded or recorded == current:
            fail(f"{args.id} is already active — restarting it would erase the "
                 "measured delta. Continue the active stage, or re-record a "
                 "changed task contract before deliberately re-baselining it.")
        changed = [
            path for path in changed_paths(
                base, stage.get("base_sha", ""),
                stage.get("dirty_at_start", {}),
            )
            if not path.startswith(WORKFLOW_PATHS)
        ]
        strays = out_of_scope(changed, current_task.get("write_scope") or [])
        if strays:
            fail(f"{args.id} cannot re-baseline over path(s) still outside the "
                 f"new task contract: {', '.join(strays[:10])}. Resolve or "
                 "remove those changes before restarting the stage.")
    active_others = [
        other["id"] for other in data.get("stages", [])
        if other is not stage and other.get("status") == "active"
    ]
    if active_others:
        fail(f"{args.id} cannot start while task {', '.join(active_others)} is "
             "active; tasks are sequential inside a story worktree")
    earlier = data["stages"][:data["stages"].index(stage)]
    not_done = [s["id"] for s in earlier if s.get("status") != "done"]
    if not_done:
        fail(f"{args.id} follows unfinished task(s): {', '.join(not_done)} — "
             "finish them in decomposition order")
    stage["status"] = "active"
    stage["started_at"] = now_iso()
    # `stage done` measures the diff, and a measurement needs a fixed point —
    # plus the dirt that was already there, which is not this stage's work.
    stage["base_sha"] = head_sha(base) or ""
    stage["dirty_at_start"] = dirty_digests(base)
    stage["task_sha256"] = task_digest(current_task)
    append_event(base, "stage-start", actor="implementer", story=data.get("issue", ""),
                 detail=f"{args.id} {stage.get('title', '')}")
    stage.pop("parallel", None)
    write_stages(base, data)
    print(f"Stage {args.id} active — {stage.get('title')}")
    print("Loop: implement via /codex:rescue → inspect diff → validate assumptions → "
          "smallest checks → LOCAL autoreview until clean → commit → forge stage done "
          f"{args.id}")


def cmd_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    from .delegate import delegation_exclusion

    with delegation_exclusion(base, args.id, kind="stage-state"):
        with delegation_exclusion(
                base, "stages", kind="stage-state", namespace="state"):
            _cmd_start_locked(args, base)


def _measure(base: Path, stage_id: str, stage: dict, task: dict) -> None:
    """Closing a stage is a measurement, not an assertion.

    Every other diff-based check in this repo fires when TOO MUCH changed.
    None fired when too little did — which is exactly what a stalled or
    half-finished delegation looks like, and it signed itself off."""
    base_sha = stage.get("base_sha")
    if not base_sha:
        fail(f"{stage_id} was started before its base commit was recorded, so "
             "there is nothing to measure against. Re-run "
             f"`forge stage start {stage_id}` (it is still active) and close it again.")
    if not task:
        fail(f"{stage_id} has no task in the recorded decomposition, so there is "
             "no contract to measure it against — a stage with no boundary is "
             "not something that can be attested. Re-record the decomposition "
             "with this task, then re-start the stage.")
    if not (task.get("write_scope") or []):
        fail(f"{stage_id} declares no write_scope, so nothing bounds what it may "
             "change. Re-record the decomposition with the paths this task owns, "
             f"then `forge stage start {stage_id}` again.")
    recorded = stage.get("task_sha256")
    if recorded and recorded != task_digest(task):
        # Re-recording mid-stage is the sanctioned repair for a wrong scope —
        # but it must not be a way to widen the contract moments before closing
        # over it. Re-starting re-baselines deliberately and on the record.
        fail(f"{stage_id}'s task contract changed after the stage started "
             "(write_scope, required_tests, verify_commands or acceptance "
             "criteria). Closing over a contract you just rewrote proves "
             f"nothing — run `forge stage start {stage_id}` to re-baseline "
             "against the current decomposition, then close it.")
    # Emptiness is judged on PRODUCT paths only. A stalled run still churns
    # .factory/ — the stage tracker and the events ledger move on every
    # command — so counting workflow paths would make this check pass for
    # exactly the runs it exists to catch.
    baseline = stage.get("dirty_at_start", {})
    split = [
        path for path in split_index_paths(base)
        if not path.startswith(WORKFLOW_PATHS)
    ]
    if split:
        fail(f"{stage_id} has staged content that differs from the tested "
             f"worktree for: {', '.join(split[:10])}. Make the index and "
             "worktree agree before closing the stage.")
    product = [
        path for path in changed_paths(base, base_sha, baseline)
        if not path.startswith(WORKFLOW_PATHS)
    ]
    contributions = contribution_paths(base, product, baseline, base_sha)
    if not contributions:
        fail(f"{stage_id} closes on an EMPTY diff — no product path changed since "
             f"{base_sha[:8]}, in commits or in the working tree. That is what a "
             "stalled or read-only run looks like. If the work is genuinely "
             f"partial, say so: forge stage done {stage_id} --incomplete \"<what "
             "is missing>\".")
    scope = task.get("write_scope") or []
    if scope:
        if not any(_covered(path, scope) for path in contributions):
            fail(f"{stage_id} closes without changing anything in its own "
                 "write_scope.")
        strays = out_of_scope(product, scope)
        if strays:
            fail(f"{stage_id} changed {len(strays)} path(s) outside its declared "
                 f"write_scope: {', '.join(strays[:10])}"
                 f"{'…' if len(strays) > 10 else ''}. Either the work exceeded the "
                 "task or the scope was wrong — re-record the decomposition with "
                 "the real scope rather than closing over it.")


def _require_successful_launch(base: Path, stage_id: str, stage: dict,
                               task: dict) -> None:
    from .delegate import argv_digest, brief_path, current_delegation

    digest = task_digest(task)
    brief = brief_path(base, stage_id)
    entry = current_delegation(
        base,
        stage_id,
        stage_started_at=stage.get("started_at", ""),
        task_sha256=digest,
        ignore_lock=True,
    )
    argv = entry.get("argv") if entry else None
    argv_valid = (
        isinstance(argv, list)
        and bool(argv)
        and all(isinstance(token, str) for token in argv)
        and Path(argv[0]).name == "node"
        and argv == [
            argv[0],
            entry.get("companion_path"),
            "task",
            "--json",
            "--cwd",
            str(base),
            "--model",
            entry.get("model"),
            "--effort",
            entry.get("effort"),
            "--prompt-file",
            brief.relative_to(base).as_posix(),
            "--write",
        ]
        and entry.get("argv_sha256") == argv_digest(argv)
    )
    valid = (
        entry
        and entry.get("launch_status") == "succeeded"
        and entry.get("write") is True
        and entry.get("task_sha256") == digest
        and entry.get("stage_started_at") == stage.get("started_at")
        and entry.get("brief_sha256") == sha256_of(brief)
        and argv_valid
    )
    if not valid:
        fail(f"{stage_id} has no successful write launch bound to this stage, "
             "task contract and brief. Run `forge delegate "
             f"{stage_id}` successfully; `--print-only` is diagnostic only.")


def _run_required_tests(base: Path, stage_id: str, task: dict) -> None:
    from .delegate import (
        blocked_termination_signals, _capture_spawn_identity, _process_table,
        _terminate_observed_process_tree, _wait_and_reap,
        unblock_termination_signals_in_child,
    )

    for proof in task.get("required_tests") or []:
        if not isinstance(proof, dict) or not all(
                isinstance(proof.get(key), str) for key in ("id", "path", "command")):
            fail(f"{stage_id} carries a legacy or malformed required_tests entry "
                 f"{proof!r}. Re-record the decomposition with id, path and command.")
        test_id = proof["id"]
        rel = proof["path"]
        command = proof["command"]
        if not (base / rel).is_file():
            fail(f"{stage_id} required test {test_id!r} is missing: {rel}")
        with tempfile.TemporaryDirectory(prefix="forge-required-test-") as tmp:
            report = Path(tmp) / "junit.xml"
            tokens = [token.replace("{report}", str(report))
                      .replace("{path}", rel).replace("{id}", test_id)
                      for token in shlex.split(command)]
            env = os.environ.copy()
            process_token = f"proof-{uuid.uuid4().hex}"
            env["FORGE_PROCESS_TOKEN"] = process_token
            while tokens and "=" in tokens[0] and not tokens[0].startswith("="):
                name, value = tokens.pop(0).split("=", 1)
                env[name] = value
            proc: subprocess.Popen[str] | None = None
            process_baseline: dict[int, tuple[int, str]] | None = None
            process_identity = ""
            stdout = ""
            stderr = ""
            with tempfile.TemporaryFile(mode="w+t") as stdout_log, \
                    tempfile.TemporaryFile(mode="w+t") as stderr_log:
                try:
                    with blocked_termination_signals():
                        process_baseline = _process_table()
                        proc = subprocess.Popen(
                            tokens, cwd=base, stdout=stdout_log,
                            stderr=stderr_log, text=True, env=env,
                            start_new_session=True,
                            preexec_fn=unblock_termination_signals_in_child,
                        )
                        process_identity = _capture_spawn_identity(proc)
                    if not _wait_and_reap(
                            proc, process_token, process_baseline,
                            process_identity):
                        fail(f"{stage_id} required test {test_id!r} left a "
                             "process tree alive; proof must be terminal")
                except OSError as exc:
                    if proc is not None:
                        with blocked_termination_signals():
                            _terminate_observed_process_tree(
                                proc, process_token, process_baseline,
                                process_identity)
                    action = (
                        "could not start" if proc is None
                        else "could not be registered"
                    )
                    fail(f"{stage_id} required test {test_id!r} "
                         f"{action}: {exc}")
                except BaseException:
                    if proc is not None:
                        with blocked_termination_signals():
                            _terminate_observed_process_tree(
                                proc, process_token, process_baseline,
                                process_identity)
                    raise
                stdout_log.seek(0)
                stderr_log.seek(0)
                stdout = stdout_log.read()
                stderr = stderr_log.read()
            if proc.returncode != 0:
                tail = (stderr or stdout or "").strip().splitlines()
                fail(f"{stage_id} required test {test_id!r} failed "
                     f"(exit {proc.returncode}): {command}\n"
                     + "\n".join(tail[-15:]))
            if not report.is_file():
                fail(f"{stage_id} required test {test_id!r} produced no fresh "
                     "JUnit report; its command must write {report}")
            try:
                root = ET.parse(report).getroot()
            except (ET.ParseError, OSError) as exc:
                fail(f"{stage_id} required test {test_id!r} produced invalid "
                     f"JUnit proof: {exc}")
            matches = [
                case for case in root.iter("testcase")
                if str(case.get("name", "")) == test_id
            ]
            if not matches:
                fail(f"{stage_id} required test {test_id!r} was not present in "
                     "the fresh JUnit report")
            attributed = [
                case for case in matches
                if str(case.get("file", "")).removeprefix("./") == rel
            ]
            if not attributed:
                fail(f"{stage_id} required test {test_id!r} was not attributed "
                     f"to its declared path {rel!r} in the fresh JUnit report")
            if any(case.find("failure") is not None
                   or case.find("error") is not None
                   or case.find("skipped") is not None for case in attributed):
                fail(f"{stage_id} required test {test_id!r} did not pass in the "
                     "fresh JUnit report")


def _run_verify_commands(base: Path, stage_id: str, task: dict) -> None:
    from .delegate import (
        blocked_termination_signals, _capture_spawn_identity, _process_table,
        _terminate_observed_process_tree, _wait_and_reap,
        unblock_termination_signals_in_child,
    )

    for command in task.get("verify_commands") or []:
        if not str(command).strip():
            continue
        proc: subprocess.Popen[str] | None = None
        process_baseline: dict[int, tuple[int, str]] | None = None
        process_identity = ""
        process_token = f"verify-{uuid.uuid4().hex}"
        env = os.environ.copy()
        env["FORGE_PROCESS_TOKEN"] = process_token
        with tempfile.TemporaryFile(mode="w+t") as stdout_log, \
                tempfile.TemporaryFile(mode="w+t") as stderr_log:
            try:
                with blocked_termination_signals():
                    process_baseline = _process_table()
                    proc = subprocess.Popen(
                        str(command), cwd=base, shell=True, stdout=stdout_log,
                        stderr=stderr_log, text=True, start_new_session=True,
                        env=env,
                        preexec_fn=unblock_termination_signals_in_child,
                    )
                    process_identity = _capture_spawn_identity(proc)
                if not _wait_and_reap(
                        proc, process_token, process_baseline,
                        process_identity):
                    fail(f"{stage_id} verify command left a process tree alive; "
                         "verification must be terminal")
            except OSError as exc:
                if proc is not None:
                    with blocked_termination_signals():
                        _terminate_observed_process_tree(
                            proc, process_token, process_baseline,
                            process_identity)
                action = (
                    "could not start" if proc is None
                    else "could not be registered"
                )
                fail(f"{stage_id} verify command {action}: {exc}")
            except BaseException:
                if proc is not None:
                    with blocked_termination_signals():
                        _terminate_observed_process_tree(
                            proc, process_token, process_baseline,
                            process_identity)
                raise
            stdout_log.seek(0)
            stderr_log.seek(0)
            stdout = stdout_log.read()
            stderr = stderr_log.read()
        if proc.returncode != 0:
            tail = (stderr or stdout or "").strip().splitlines()
            fail(f"{stage_id} verify command failed (exit {proc.returncode}): "
                 f"{command}\n" + "\n".join(tail[-15:]))


def _finish_stage(base: Path, args: argparse.Namespace, data: dict,
                  stage: dict, task: dict) -> None:
    # Validate the input tree, run the task proof once, then validate again.
    # Verify commands are executable shell and may mutate files; only the
    # post-command measurement is allowed to authorize completion.
    _measure(base, args.id, stage, task)
    _require_successful_launch(base, args.id, stage, task)
    proof_tree = product_tree_snapshot(base)
    authority_tree = protected_authority_snapshot(base)
    with termination_signal_guard():
        _run_verify_commands(base, args.id, task)
        _run_required_tests(base, args.id, task)
    if product_tree_snapshot(base) != proof_tree:
        fail(f"{args.id} proof commands changed the product tree; verification "
             "must be read-only")
    if protected_authority_snapshot(base) != authority_tree:
        fail(f"{args.id} proof commands changed protected Forge authority; "
             "stage completion refused")
    _measure(base, args.id, stage, task)
    final_task = task_for(base, args.id)
    _measure(base, args.id, stage, final_task)
    _require_successful_launch(base, args.id, stage, final_task)
    from .delegate import delegation_exclusion

    with delegation_exclusion(
            base, "stages", kind="stage-state", namespace="state"):
        data = load_stages(base)
        current = _find(data, args.id)
        identity = ("started_at", "base_sha", "dirty_at_start", "task_sha256")
        if (current.get("status") != "active"
                or any(current.get(key) != stage.get(key) for key in identity)):
            fail(f"{args.id} changed identity before its done transition could "
                 "be serialized; inspect `forge stage list` and retry.")
        locked_task = task_for(base, args.id)
        if (not current.get("task_sha256")
                or task_digest(locked_task) != current["task_sha256"]):
            fail(f"{args.id}'s task contract changed before its done transition "
                 "could be serialized; re-baseline and prove the current contract.")
        _measure(base, args.id, current, locked_task)
        _require_successful_launch(base, args.id, current, locked_task)
        if product_tree_snapshot(base) != proof_tree:
            fail(f"{args.id}'s product tree changed after its required proof; "
                 "rerun stage completion against the final snapshot")
        current.pop("incomplete", None)
        current.pop("attested_digests", None)
        current["status"] = "done"
        current["completed_at"] = now_iso()
        append_event(base, "stage-done", actor="implementer",
                     story=data.get("issue", ""),
                     detail=f"{args.id} {current.get('title', '')}")
        write_stages(base, data)
    remaining = [s for s in data["stages"] if s.get("status") != "done"]
    if remaining:
        print(f"Stage {args.id} done. Next: forge stage start {remaining[0]['id']} "
              f"— {remaining[0].get('title')} ({len(remaining)} to go)")
    else:
        print(f"Stage {args.id} done — all {len(data['stages'])} stage(s) complete. "
              "Continue the task loop: verify, then the ONE branch autoreview.")


def cmd_done(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_stages(base)
    if not data:
        fail("no .factory/stages.json — record the decomposition first")
    stage = _find(data, args.id)
    if stage.get("status") != "active":
        fail(f"{args.id} is {stage.get('status', 'pending')!r}, not active — "
             "`forge stage start` it first; done attests a stage that actually ran.")
    incomplete = (getattr(args, "incomplete", None) or "").strip()
    if incomplete:
        # A worker that genuinely finished part of the job had no vocabulary for
        # it: every signal kind presumes it wants to continue. This says so and
        # leaves the stage open, so nothing downstream reads it as delivered.
        from .delegate import delegation_exclusion
        with delegation_exclusion(base, args.id, kind="stage-close"):
            with delegation_exclusion(
                    base, "stages", kind="stage-state", namespace="state"):
                data = load_stages(base)
                stage = _find(data, args.id)
                if stage.get("status") != "active":
                    fail(f"{args.id} changed state before its incomplete note "
                         "could be serialized; inspect `forge stage list` and retry.")
                stage["incomplete"] = incomplete
                stage["updated_at"] = now_iso()
                append_event(base, "stage-incomplete", actor="implementer",
                             story=data.get("issue", ""),
                             detail=f"{args.id}: {incomplete}")
                write_stages(base, data)
        print(f"Stage {args.id} recorded INCOMPLETE and left active: {incomplete}")
        print("Nothing downstream treats it as delivered. Finish the gap, then "
              f"forge stage done {args.id}.")
        return
    from .delegate import delegation_exclusion

    # This is the commit point for a stage. The same per-task exclusion used by
    # `forge delegate` stays held from the first measurement through the
    # persisted done status, so no new writer can enter after the final check.
    with delegation_exclusion(base, args.id, kind="stage-close"):
        data = load_stages(base)
        stage = _find(data, args.id)
        if stage.get("status") != "active":
            fail(f"{args.id} changed state while stage close was waiting for "
                 "exclusive access; inspect `forge stage list` and retry.")
        _finish_stage(base, args, data, stage, task_for(base, args.id))


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_stages(base)
    if not data:
        print("No stage tracker (.factory/stages.json) — it is created when the "
              "decomposition is recorded.")
        return
    marks = {"pending": " ", "active": ">", "done": "x"}
    for stage in data.get("stages", []):
        status = stage.get("status", "pending")
        print(f"[{marks.get(status, '?')}] {stage['id']} — {stage.get('title')}")


def _cmd_migrate_locked(args: argparse.Namespace, base: Path) -> None:
    if not args.confirm_workspace_state:
        fail("migration trusts legacy workspace state exactly once; inspect "
             ".factory/decomposition.json and .factory/stages.json, then pass "
             "--confirm-workspace-state")
    protected_decomposition = protected_decomposition_state_path(base)
    protected_stages = authoritative_stages_path(base)
    if protected_decomposition.exists() != protected_stages.exists():
        fail("partial protected stage authority exists; Forge will not combine "
             "one protected artifact with one worker-writable workspace mirror. "
             "Restore or remove the incomplete protected migration as a unit, "
             "then retry.")
    if protected_decomposition.exists() and protected_stages.exists():
        fail("protected decomposition and stage authority already exist")
    decomposition = load_json(decomposition_state_path(base), default={})
    stages = load_json(stages_path(base), default={})
    issue = load_json(run_state_path(base), default={}).get("issue_key")
    tasks = {
        task.get("id"): task for task in decomposition.get("tasks") or []
        if isinstance(task, dict) and isinstance(task.get("id"), str)
    }
    stage_ids = {
        stage.get("id") for stage in stages.get("stages") or []
        if isinstance(stage, dict)
    }
    if (
        not tasks
        or not stages.get("stages")
        or stages.get("issue") != issue
        or stage_ids != set(tasks)
    ):
        fail("legacy workspace decomposition/stages do not form one complete "
             "tracker for the active story; migration refused")
    for stage in stages["stages"]:
        if stage.get("status") not in {"pending", "active", "done"}:
            fail(f"legacy stage {stage.get('id')} has invalid status")
        if stage.get("status") in {"active", "done"}:
            stage["task_sha256"] = task_digest(tasks[stage["id"]])
        stage.pop("parallel", None)
        stage.pop("attested_digests", None)
    if not protected_decomposition.exists():
        dump_json(protected_decomposition, decomposition)
    if not protected_stages.exists():
        write_stages(base, stages)
    append_event(base, "stage-authority-migrated", actor="orchestrator",
                 story=issue or "", detail=f"{len(tasks)} task(s)")
    print(f"Migrated {len(tasks)} task(s) into protected story authority.")


def cmd_migrate(args: argparse.Namespace) -> None:
    """Explicit one-time adoption of a pre-protected story workspace."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    from .delegate import delegation_exclusion

    with delegation_exclusion(
            base, "stages", kind="stage-state", namespace="state"):
        _cmd_migrate_locked(args, base)
