"""forge task plan save/approve — per-task implementation plan evidence."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from factory_lib import (
    clean_git_env, default_trunk_branch, dump_json, evidence_path,
    git_control_dir, load_json, now_iso,
    plan_digest_without_assumptions, repo_root, require_ready_task,
    require_plan_mode_marker, require_task_sealed,
    protected_decomposition_state_path, run_state_path,
    task_marker_on_main, task_marker_path, validate_payload,
)

from .common import fail


def _git(base: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=base, capture_output=True, text=True,
        env=clean_git_env(), encoding="utf-8", errors="surrogateescape",
    )


def _require_git(base: Path, description: str, *args: str) -> str:
    proc = _git(base, *args)
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip()
        fail(f"{description} failed" + (f": {detail}" if detail else ""))
    return proc.stdout.strip()


def _default_branch(base: Path) -> str:
    """The integration branch a task PR targets: origin's default branch, not a
    hardcoded 'main'. Delegates to the single canonical resolver so PR targeting,
    the task-start base, task markers, and the review diff all agree on the trunk."""
    return default_trunk_branch(base)


def _task_plan_path(base: Path, task_id: str, *, for_write: bool = False) -> Path:
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        from .story import ensure_active_pointer
        story = ensure_active_pointer(base)
    if not isinstance(story, str) or not story:
        fail("task plan requires an active story. Start a new one with intake, or "
             "if a decomposed story lost its git-local pointer on this checkout, "
             "rebuild it with `forge story resume <key>`.")
    return evidence_path(
        base, story, f"task-plans/{task_id}.md", for_write=for_write,
    )


def cmd_plan_save(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    require_ready_task(
        base, args.id, require_approval=False, require_grill=False,
    )
    source = Path(args.source).expanduser()
    if not source.is_file():
        fail(f"task plan source {source} not found — pass the plan-mode file via --from")
    try:
        content = source.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        fail("task plan source must be UTF-8 Markdown")
    if not content.strip():
        fail("task plan source must not be empty")
    require_plan_mode_marker(base, source)
    dest = _task_plan_path(base, args.id, for_write=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    grill_path = evidence_path(
        base, story, f"grills/tasks/{args.id}.json", for_write=True,
    )
    grill = load_json(grill_path, default={})
    if grill and "task_plan_sha256" not in grill:
        try:
            grilled_at = datetime.fromisoformat(grill["recorded_at"])
            if grilled_at.tzinfo is None:
                grilled_at = grilled_at.replace(tzinfo=timezone.utc)
            saved_at = datetime.fromtimestamp(dest.stat().st_mtime, timezone.utc)
        except (KeyError, TypeError, ValueError, OSError):
            pass
        else:
            if grilled_at <= saved_at:
                grill["task_plan_sha256"] = plan_digest_without_assumptions(dest)
                validate_payload(base, "grill", grill)
                dump_json(grill_path, grill)
    print(f"Saved task plan: {dest.relative_to(base)}")


def cmd_approve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    require_ready_task(base, args.id, require_approval=False)
    approved_by = args.by.strip()
    if not approved_by:
        fail("task approval requires a non-empty human name via --by")
    plan = _task_plan_path(base, args.id)
    if not plan.is_file():
        fail(
            f"task approval refused: no saved task plan for {args.id}. "
            f"Run `./forge task plan save {args.id} --from <path>` first."
        )
    require_plan_mode_marker(base, plan)
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    grill_path = evidence_path(
        base, story, f"grills/tasks/{args.id}.json", for_write=True,
    )
    grill = load_json(grill_path, default={})
    grill["approved_task_plan_sha256"] = plan_digest_without_assumptions(plan)
    grill["approved_by"] = approved_by
    grill["approved_at"] = now_iso()
    validate_payload(base, "grill", grill)
    dump_json(grill_path, grill)
    print(f"Approved task plan for {args.id} by {approved_by}")


def cmd_task_start(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    key = state.get("issue_key") or state.get("story")
    if not isinstance(key, str) or not key:
        from .story import ensure_active_pointer
        key = ensure_active_pointer(base)
    if not isinstance(key, str) or not key:
        fail("task start requires an active story. Start a new one with intake, or "
             "if a decomposed story lost its git-local pointer on this checkout "
             "(e.g. a fresh trunk clone between tasks), rebuild it with "
             "`forge story resume <key>`.")
    decomposition_path = protected_decomposition_state_path(base)
    decomposition = load_json(decomposition_path, default={})
    tasks = decomposition.get("tasks") or []
    index = next(
        (position for position, task in enumerate(tasks)
         if isinstance(task, dict) and task.get("id") == args.id),
        None,
    )
    if index is None:
        fail(f"{args.id!r} is not a task in the protected decomposition")
    task_marker_path(key, args.id)  # validates both branch/path components

    trunk = default_trunk_branch(base)
    if index:
        predecessor = tasks[index - 1].get("id")
        if not task_marker_on_main(base, key, predecessor):
            marker = task_marker_path(key, predecessor)
            fail(
                f"task {args.id} cannot start: predecessor {predecessor} marker "
                f"is absent from fetched origin/{trunk} ({marker.as_posix()})"
            )
    else:
        _require_git(base, f"fetching origin/{trunk}", "fetch", "origin", trunk)
    base_main_sha = _require_git(
        base, f"resolving fetched origin/{trunk}", "rev-parse", "--verify",
        f"origin/{trunk}^{{commit}}",
    )

    branch = f"feat/{key}-{args.id}"
    worktree = base.parent / f"{base.name}-{key}-{args.id}"
    if _git(base, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
        fail(f"task branch already exists: {branch}")
    if worktree.exists() or worktree.is_symlink():
        fail(f"task worktree already exists: {worktree}")

    plan_file = state.get("plan_file")
    if not isinstance(plan_file, str) or not plan_file:
        fail("task start requires the approved plan path in the run pointer")
    plan_source = (base / plan_file).resolve()
    try:
        plan_relative = plan_source.relative_to(base)
    except ValueError:
        fail(f"approved plan path escapes the planning worktree: {plan_file!r}")
    if (
        plan_relative.parent.as_posix() != "plans/active"
        or not plan_relative.name.startswith(f"{key}-")
    ):
        fail(f"approved plan must be plans/active/{key}-*.md")

    sources = {
        plan_relative: plan_source,
        Path(".factory") / "stories" / key / "decomposition.json": decomposition_path,
        Path(".factory") / "stories" / key / "grills" / "tasks" / f"{args.id}.json":
            evidence_path(base, key, f"grills/tasks/{args.id}.json"),
        Path(".factory") / "stories" / key / "task-plans" / f"{args.id}.md":
            evidence_path(base, key, f"task-plans/{args.id}.md"),
    }
    missing = [path for path in sources.values() if not path.is_file()]
    if missing:
        fail("task start hydration inputs are missing: " + ", ".join(
            path.relative_to(base).as_posix() if path.is_relative_to(base) else str(path)
            for path in missing
        ))
    payloads = {relative: source.read_bytes() for relative, source in sources.items()}
    decomposition_bytes = decomposition_path.read_bytes()
    stages_bytes = (json.dumps({
        "issue": key,
        "stages": [
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "status": "done" if position < index else "pending",
            }
            for position, task in enumerate(tasks)
        ],
    }, indent=2) + "\n").encode()

    _require_git(
        base, "creating task worktree", "worktree", "add", str(worktree),
        "-b", branch, base_main_sha,
    )
    for relative, content in payloads.items():
        destination = worktree / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    control = git_control_dir(worktree)
    control.mkdir(parents=True, exist_ok=True)
    (control / "decomposition.json").write_bytes(decomposition_bytes)
    (control / "stages.json").write_bytes(stages_bytes)
    dump_json(control / "run.json", {
        **state,
        "issue_key": key,
        "task_id": args.id,
        "branch": branch,
        "base_main_sha": base_main_sha,
    })
    print(f"Started task {args.id}: {branch} at {worktree} ({base_main_sha})")


def cmd_task_reopen(args: argparse.Namespace) -> None:
    """Reopen a done-but-unshipped task: move the frontier back to it (and the
    unshipped done-tail built on top of it) so it can be re-grilled and
    re-implemented. Refused for shipped work — that is immutable; add a new
    follow-up task instead."""
    from forge_cli.stages import load_stages, write_stages
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    key = state.get("issue_key") or state.get("story")
    if not isinstance(key, str) or not key.strip():
        from .story import ensure_active_pointer
        key = ensure_active_pointer(base)
    if not isinstance(key, str) or not key.strip():
        fail("reopen requires an active story. Start a new one with intake, or "
             "if a decomposed story lost its git-local pointer on this checkout, "
             "rebuild it with `forge story resume <key>`.")
    data = load_stages(base)
    stages = data.get("stages") or []
    idx = next((i for i, s in enumerate(stages) if s.get("id") == args.id), None)
    if idx is None:
        fail(f"task {args.id} is not in the current decomposition")
    target = stages[idx]
    if target.get("status") != "done":
        fail(f"task {args.id} is '{target.get('status')}', not done. Only a done "
             "task is reopened: an active task's contract is amended in place, and "
             "a pending task has not started.")
    # Shipped work is immutable. The task marker rides onto the integration branch
    # at merge; if it is there, the work is shipped — add a follow-up task instead.
    default_branch = _default_branch(base)
    marker = task_marker_path(key, args.id)
    fetched = _git(base, "fetch", "origin", default_branch)
    if fetched.returncode == 0:
        present = _git(base, "cat-file", "-e",
                       f"origin/{default_branch}:{marker.as_posix()}")
        if present.returncode == 0:
            fail(f"task {args.id} is already SHIPPED (its marker is on "
                 f"origin/{default_branch}); shipped work is immutable — add a new "
                 "follow-up task rather than reopening it.")
    else:
        print(f"WARNING: could not reach origin/{default_branch} to confirm "
              f"{args.id} is unshipped; proceeding on local state. Do NOT reopen a "
              "task whose PR has already merged.")
    # Reopening ripples forward: the done-tail built on this task has a changed
    # base, so it returns to pending too. Clear the evidence so every reopened
    # stage is re-grilled + re-implemented from scratch.
    reopened = []
    for stage in stages[idx:]:
        if stage.get("status") not in ("done", "active"):
            continue
        for field in ("task_sha256", "local_review_stamp", "completed_at",
                      "started_at", "base_sha", "dirty_at_start",
                      "contract_changed", "incomplete"):
            stage.pop(field, None)
        stage["status"] = "pending"
        reopened.append(stage.get("id"))
    write_stages(base, data)
    print(
        f"Reopened {', '.join(reopened)} -> pending; the frontier is back at "
        f"{args.id}. Re-grill and re-implement from there. The plan approval is now "
        "STALE — re-present the change to the human and re-approve before the next "
        "stage start / delegate."
    )


def cmd_task_pr_ready(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    task = require_task_sealed(base, args.id)
    state = load_json(run_state_path(base), default={})
    key = state.get("issue_key") or state.get("story")
    if not isinstance(key, str) or not key.strip():
        fail("task PR marker requires a non-empty story in the task run pointer")

    # A task started via `forge stage start` (not `forge task start`) has no
    # branch/base pointer in run.json. Derive both from git so the stage-based
    # per-task PR flow seals cleanly instead of dead-ending — the branch is
    # wherever the sealed work lives, the base is where it forked from the
    # integration branch.
    default_branch = _default_branch(base)
    branch = state.get("branch")
    if not isinstance(branch, str) or not branch.strip():
        branch = _require_git(
            base, "resolving current branch", "rev-parse", "--abbrev-ref", "HEAD",
        )
        if branch == "HEAD":
            fail("task PR ready: detached HEAD — check out the task branch first")
    base_main_sha = state.get("base_main_sha")
    if not isinstance(base_main_sha, str) or not base_main_sha.strip():
        base_main_sha = _require_git(
            base, "resolving integration base", "merge-base",
            f"origin/{default_branch}", "HEAD",
        )

    commit = _require_git(
        base, "resolving task HEAD", "rev-parse", "--verify", "HEAD^{commit}",
    )
    marker = task_marker_path(key, args.id)
    payload = {
        "task_id": args.id,
        "branch": branch,
        "base_main_sha": base_main_sha,
        "commit": commit,
        "sealed_at": now_iso(),
    }
    if any(not isinstance(value, str) or not value.strip() for value in payload.values()):
        fail("task PR marker fields must all be non-empty strings")
    dump_json(base / marker, payload)

    # The marker is committed and pushed by this command (an evidence-only commit
    # the command owns) so it rides the branch onto the PR; AC2's advance signal
    # is that marker landing on origin/main at merge (task 8's cat-file gate).
    _require_git(base, "staging the task PR marker", "add", "--", marker.as_posix())
    _require_git(
        base, "committing the task PR marker",
        "commit", "-m", f"{key} {args.id}: task PR marker",
    )
    _require_git(base, "pushing the task branch", "push", "-u", "origin", branch)

    if shutil.which("gh", path=os.environ.get("PATH")) is None:
        fail(
            f"task {args.id} is sealed at {marker.as_posix()}, but gh is unavailable. "
            "Install GitHub CLI, run `gh auth login`, then retry to open the PR."
        )
    title = f"{key} {args.id}: {task.get('title', '').strip()}".rstrip(": ")
    body = (
        f"Task marker: {marker.as_posix()}\n\n"
        f"Sealed commit: {commit}\n"
    )
    # Resolve owner/repo from origin so `gh` targets THIS repo — a bare
    # `gh pr create` can resolve a PR number against the wrong repo when a
    # local checkout tracks a differently-numbered upstream.
    origin_url = _require_git(base, "resolving origin url", "remote", "get-url", "origin")
    slug = re.sub(r"^.*github\.com[:/]", "", origin_url).removesuffix(".git")
    cmd = ["gh", "pr", "create", "--base", default_branch, "--head", branch,
           "--title", title, "--body", body]
    if slug and "/" in slug:
        cmd += ["--repo", slug]
    proc = subprocess.run(
        cmd, cwd=base, capture_output=True, text=True,
        encoding="utf-8", errors="surrogateescape",
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip()
        fail(
            f"task {args.id} is sealed at {marker.as_posix()}, but opening the PR "
            f"to {default_branch} failed{f': {detail}' if detail else ''}. "
            "Run `gh auth login`, then retry."
        )
    print(f"Task {args.id} PR ready: {marker.as_posix()}")
    if proc.stdout.strip():
        print(proc.stdout.strip())
