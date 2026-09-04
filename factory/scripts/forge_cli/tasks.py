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
    require_task_sealed,
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


# A task plan is read by two people the author is not: the human approving it,
# and whoever has to confirm the thing actually works. Neither is served by a
# file-by-file work order, so these sections are required rather than suggested
# (decision 0050). A diagram is asked for in words, not enforced: a fenced
# ```mermaid block is the cheap way to render one on the board, and demanding
# one mechanically would only produce box-and-arrow filler.
REQUIRED_TASK_PLAN_SECTIONS = (
    ("## Workflow", "the end-to-end flow this task builds or changes — what "
                    "moves through it, and where this task starts and stops. "
                    "A ```mermaid diagram renders on the board and is worth "
                    "far more than prose here"),
    ("## Manual Verification", "the steps a human runs to see it work, in "
                               "order, with what they should observe. "
                               "Automated tests prove it did not break; this "
                               "is how someone confirms it does the job"),
)


def require_task_plan_sections(content: str, task_id: str) -> None:
    lowered = content.lower()
    missing = [
        (heading, why) for heading, why in REQUIRED_TASK_PLAN_SECTIONS
        # Match the heading text, not its exact level: an author who writes
        # `### Workflow` inside a deeper structure has still written it.
        if heading.lstrip("# ").lower() not in lowered
    ]
    if missing:
        detail = "; ".join(f"{heading} — {why}" for heading, why in missing)
        fail(f"task plan for {task_id} is missing {len(missing)} required "
             f"section(s): {detail}. Add them and re-save.")


def cmd_plan_save(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    require_ready_task(
        base, args.id, require_approval=False, require_grill=False,
    )
    source = Path(args.source).expanduser()
    if not source.is_file():
        fail(f"task plan source {source} not found — pass the plan file via --from")
    try:
        content = source.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        fail("task plan source must be UTF-8 Markdown")
    if not content.strip():
        fail("task plan source must not be empty")
    require_task_plan_sections(content, args.id)
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


def require_fresh_task_grill(
    base: Path, task_id: str, plan: Path, grill: dict,
) -> None:
    """Refuse approval unless the grill passed against THIS plan text.

    `cmd_approve` used to claim in a comment that a fresh passing grill was
    required and then check nothing. The board already withholds a task plan
    until its grill both passed and was recorded against the current digest —
    so a stale or failing grill could be approved for a plan the board would
    refuse to display, and the approval gate and the board disagreed about
    whether the same plan was ready. Same predicate, one source of truth.
    """
    if not grill:
        fail(f"task approval refused: {task_id} has no recorded grill. Grill "
             f"the plan first (factory/prompts/griller.md --gate task), then "
             f"`./forge task approve {task_id} --by \"<name>\"`.")
    verdict = grill.get("verdict")
    if verdict != "pass":
        fail(f"task approval refused: the grill for {task_id} recorded verdict "
             f"{str(verdict)!r}, not 'pass'. Fix what it found, re-grill until a "
             "round is clean, then approve.")
    digest = plan_digest_without_assumptions(plan)
    if digest not in (grill.get("task_plan_sha256"),
                      grill.get("approved_task_plan_sha256")):
        fail(f"task approval refused: the grill for {task_id} was recorded "
             "against different plan text — the plan was edited after it passed, "
             "so the grill no longer covers what you are approving (this is why "
             "the board is not showing it). Re-grill the current plan, then "
             "approve.")


def cmd_approve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    # allow_completed: a done/active task can be RE-approved after a legitimate
    # re-grill (a re-decomposition or a post-approval plan edit re-grilled it and
    # the frontier has moved past it). A fresh passing grill is still required
    # below — this only lifts the "must be the earliest unfinished task"
    # frontier gate for a task already under way.
    require_ready_task(base, args.id, require_approval=False, allow_completed=True)
    approved_by = args.by.strip()
    if not approved_by:
        fail("task approval requires a non-empty human name via --by")
    plan = _task_plan_path(base, args.id)
    if not plan.is_file():
        fail(
            f"task approval refused: no saved task plan for {args.id}. "
            f"Run `./forge task plan save {args.id} --from <path>` first."
        )
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    grill_path = evidence_path(
        base, story, f"grills/tasks/{args.id}.json", for_write=True,
    )
    grill = load_json(grill_path, default={})
    require_fresh_task_grill(base, args.id, plan, grill)
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
    # A done task reopens. So does an ACTIVE task that closed `--incomplete`: the
    # harness's own "partial work" marker leaves the stage active on purpose,
    # and the only way forward from a stage that cannot close (an empty
    # measured diff after a reopen) is to reopen it with the right base.
    status = target.get("status")
    if not (status == "done" or (status == "active" and target.get("incomplete"))):
        fail(f"task {args.id} is '{status}', not done (or active-and-incomplete). "
             "An active task's contract is amended in place, and a pending task "
             "has not started.")
    # The base the task's work started from survives the reopen: `stage start`
    # pins the stage ref to it, so the reopened stage measures the task's real
    # delta instead of an empty diff from today's HEAD (symphony-forge #171).
    # `--base` names it explicitly when the record no longer carries it.
    explicit = (getattr(args, "base", None) or "").strip()
    if explicit:
        resolved = _git(base, "rev-parse", "--verify", "--quiet", f"{explicit}^{{commit}}")
        if resolved.returncode != 0:
            fail(f"--base {explicit} is not a commit in this repository")
        explicit = resolved.stdout.strip()
        if _git(base, "merge-base", "--is-ancestor", explicit, "HEAD").returncode != 0:
            fail(f"--base {explicit[:12]} is not an ancestor of HEAD")
    reopen_base = explicit or target.get("reopen_base_sha") or target.get("base_sha") or ""
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
    if reopen_base:
        stages[idx]["reopen_base_sha"] = reopen_base
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


def cmd_task_reconcile(args: argparse.Namespace) -> None:
    """Adopt a task that was merged to the trunk OUT OF BAND — via a story-level
    PR or a direct PR — without ever running `forge task pr-ready`. It writes the
    task's completion marker and flips its stage to done so the frontier stops
    reporting the task 'await-merge' forever and advances to the next one.

    This is the sanctioned reconcile for the run-pointer drift that happens when
    work ships outside the per-task PR flow. It verifies the work is genuinely on
    the trunk, opens NO new PR, and records a `stage-reconciled` event so the
    bypass is on the timeline. The regular `stage done` gates (a non-empty delta,
    a bound delegate launch, a fresh review stamp) are all unsatisfiable for
    already-merged work, which is exactly why they cannot close it.
    """
    from forge_cli.stages import load_stages, write_stages, task_for
    from forge_cli.events import append_event
    from factory_lib import task_digest

    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    key = state.get("issue_key") or state.get("story")
    if not isinstance(key, str) or not key.strip():
        from .story import ensure_active_pointer
        key = ensure_active_pointer(base)
    if not isinstance(key, str) or not key.strip():
        fail("reconcile requires an active story. Start a new one with intake, or "
             "if a decomposed story lost its git-local pointer on this checkout, "
             "rebuild it with `forge story resume <key>`.")

    data = load_stages(base)
    stages = data.get("stages") or []
    idx = next((i for i, s in enumerate(stages) if s.get("id") == args.id), None)
    if idx is None:
        fail(f"task {args.id} is not in the current decomposition")
    stage = stages[idx]
    status = stage.get("status")
    if status not in ("active", "done"):
        fail(f"task {args.id} is '{status}', not active or done — reconcile adopts a "
             "task whose work already SHIPPED; a task that never started has nothing "
             "to reconcile.")

    task = task_for(base, args.id)
    if not task:
        fail(f"task {args.id} has no contract in the decomposition; cannot reconcile.")

    default_branch = _default_branch(base)
    marker = task_marker_path(key, args.id)

    fetched = _git(base, "fetch", "origin", default_branch)
    if fetched.returncode != 0:
        fail(f"reconcile needs origin/{default_branch} to confirm {args.id} shipped, "
             "but the fetch failed. Reconcile only a task whose PR has actually "
             "merged, on a checkout that can reach origin.")

    already = _git(
        base, "cat-file", "-e", f"origin/{default_branch}:{marker.as_posix()}",
    ).returncode == 0

    if not already:
        # Confirm the task's work is genuinely on the trunk before adopting it: at
        # least one of its write_scope paths must resolve on origin/<trunk>. This
        # guards against reconciling work that never actually shipped.
        write_scope = [p.rstrip("/") for p in (task.get("write_scope") or [])
                       if isinstance(p, str) and p.strip()]
        on_trunk = any(
            _git(base, "cat-file", "-e",
                 f"origin/{default_branch}:{path}").returncode == 0
            for path in write_scope
        )
        if write_scope and not on_trunk:
            fail(f"none of {args.id}'s write_scope paths are on origin/"
                 f"{default_branch} — its work does not look shipped. Reconcile "
                 "only a genuinely merged task (or ship it with `forge task "
                 "pr-ready`).")

        commit = args.commit or _require_git(
            base, "resolving trunk head", "rev-parse", "--verify",
            f"origin/{default_branch}^{{commit}}")
        if args.commit:
            anc = _git(base, "merge-base", "--is-ancestor", commit,
                       f"origin/{default_branch}")
            if anc.returncode != 0:
                fail(f"--commit {commit} is not an ancestor of origin/"
                     f"{default_branch}; pass the merge commit of the task's PR.")
        recorded_base = stage.get("base_sha")
        pointer_base = state.get("base_main_sha")
        base_main_sha = (
            (recorded_base if isinstance(recorded_base, str) and recorded_base else None)
            or (pointer_base if isinstance(pointer_base, str) and pointer_base else None)
            or _require_git(base, "resolving integration base", "merge-base",
                            f"origin/{default_branch}", commit)
        )
        branch = args.branch or f"feat/{key}-{args.id}"
        payload = {
            "task_id": args.id,
            "branch": branch,
            "base_main_sha": base_main_sha,
            "commit": commit,
            "sealed_at": now_iso(),
        }
        if any(not isinstance(value, str) or not value.strip()
               for value in payload.values()):
            fail("reconcile marker fields must all be non-empty strings")
        # Marks the marker as ADOPTED, not sealed: the PR proof gate
        # (check_task_proof.py) does not demand recorded proof for work that was
        # already on the trunk before the harness learned about it. It cannot be
        # abused to skip proof for new work — reconcile refuses unless the work
        # is genuinely on the trunk already.
        payload["reconciled"] = True
        dump_json(base / marker, payload)

    # Flip the stage to done directly (bypassing the unsatisfiable stage-done
    # gates) and stamp its task digest so the row reads 'done' locally too.
    if status != "done":
        stage["status"] = "done"
        stage["completed_at"] = now_iso()
    if not stage.get("task_sha256"):
        stage["task_sha256"] = task_digest(task)
    write_stages(base, data)
    append_event(base, "stage-reconciled", actor="orchestrator", story=key,
                 detail=f"{args.id} adopted as shipped out of band "
                        f"(marker {'confirmed on trunk' if already else 'written'}, "
                        "no PR)")

    # Commit the marker + committed stage mirror as an evidence-only commit the
    # command owns. No push, no PR — the work already shipped; this records it so
    # the marker can land on the trunk via the reconcile PR.
    candidates = [marker.as_posix(), ".factory/stages.json",
                  f".factory/stories/{key}/stages.json"]
    to_add = [path for path in candidates if (base / path).is_file()]
    if to_add:
        _git(base, "add", "--", *to_add)
    if _git(base, "diff", "--cached", "--quiet").returncode != 0:
        _require_git(base, "committing the reconcile marker", "commit", "-m",
                     f"{key} {args.id}: task reconcile marker (adopted as shipped)")
        print(f"Reconciled {args.id}: marker {marker.as_posix()} written, stage "
              "done, evidence committed. Push this branch and open a PR so the "
              f"marker lands on origin/{default_branch}, then rerun `forge next`.")
    else:
        print(f"Reconciled {args.id}: stage done and marker present; nothing new "
              "to commit.")
