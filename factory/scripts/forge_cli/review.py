"""forge review <task-id> — release Codex for a task's three-lens review and
record the three artifacts as that task's proof (decisions 0011, 0049).

One command replaces the hand-assembled skill invocation the coordinator used
to get wrong: it pins the task tip in a clean detached worktree (so harness
writes in the main tree cannot abort the run), reviews the WHOLE task diff from
the task's recorded base (branch mode; `--mode commit` would see only the last
commit), runs the autoreview skill once per lens with Codex as the engine,
drops findings on harness bookkeeping paths, derives each lens artifact, parses
the quality verdicts from the reviewer's prose, and records all three through
the existing schema-validated recorder. It always ends by printing the exact
next command.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from factory_lib import (
    clean_git_env, evidence_path, load_json, protected_decomposition_state_path,
    repo_root, run_state_path, safe_factory_write_bytes, schema_path,
)

from .common import fail
from .review_brief import VERDICT_INSTRUCTION, _task_section, cmd_review_brief
# Reuse the task module's git helpers rather than adding another lossless
# capture site: theirs is already reviewed and content-pinned for path output.
from .tasks import _git, _require_git

LENSES = ("quality", "performance", "security")
# Harness bookkeeping is never the subject of a product review.
HARNESS_PREFIXES = (".factory/", "plans/", "docs/decisions/")
# The recorder's contract_verdicts shape: {contract_id, verdict, evidence}.
VERDICT_LINE = re.compile(
    r"^\s*VERDICT\s+(?P<id>[A-Za-z0-9._:-]+)\s*:\s*"
    r"(?P<verdict>implemented|partial|missing)\b\s*(?:[—–-]+\s*(?P<evidence>.*))?$",
    re.IGNORECASE | re.MULTILINE,
)
DEFAULT_SKILL = Path.home() / ".codex" / "skills" / "autoreview" / "scripts" / "autoreview"

COMMON_PREAMBLE = """\
You are one lens of a three-lens code review. You see ONLY the diff bundle for
this task (no repository access), so judge what the diff shows and say so when
something cannot be verified from it. Report every finding with its
file_path and line. Use ONLY these categories: bug, security, regression,
test_gap, maintainability. Priorities: P0/P1 block the task; P2/P3 must be
resolved or explicitly deferred with a reason before it ships.
"""

LENS_FOCUS = {
    "quality": """\
LENS: QUALITY. Correctness, regressions, gaps in the implementer's tests,
API/contract drift, and maintainability. Check approved-deliverable presence and
reachability FIRST: every deliverable a plan contract, acceptance criterion, or
the reviewer focus names must be genuinely implemented AND reachable (registered,
invoked — not merely defined in a file nothing imports); an absent or unreachable
deliverable is a blocking finding even when the rest is clean. Flag
single-responsibility violations and incoherent file/folder organisation against
the reviewer focus (never a mandated layout). Structure-for-growth in shared
infrastructure is NOT over-engineering; reserve that finding for speculative
abstraction. Enforce the minimal-diff discipline (a new dependency where the
stdlib suffices, reimplementing an existing helper, sprawl where a surgical
change would do) — but a diff that drops validation, error handling, security, or
accessibility to look smaller is the OPPOSITE finding. The constitution's coding
standards are law: flag deviations you can see in the diff. Assess cyclomatic
complexity of every changed function; genuinely knotted control flow (roughly
>10 independent paths) is blocking and must name its decomposition.
""",
    "performance": """\
LENS: PERFORMANCE. Hot paths, algorithmic complexity, query fanout (N+1),
I/O amplification, memory churn, concurrency bottlenecks, missing pagination or
bounds, work repeated per request that could be done once. Distinguish measured
evidence from inference and say which each finding is. Use category `bug` for a
performance defect that will bite in production and `maintainability` for a cost
worth reducing.
""",
    "security": """\
LENS: SECURITY. OWASP-style trust boundaries, authentication and authorization
(every new route/handler: who may call it, with what scope), secrets and
credential handling, injection (SQL/command/template), data exposure and
over-broad responses, unsafe defaults, privilege escalation, and abuse paths.
Use category `security` for these findings.
""",
}

QUALITY_VERDICT_FORMAT = """\
CONTRACT VERDICTS (mandatory, machine-parsed). In overall_explanation, emit ONE
line per plan contract listed under "Plan contracts" below, exactly in this form:

VERDICT <contract-id>: implemented|partial|missing — <file:line evidence>

Every listed contract must get a line. Do not rename contract ids.
"""


def resolve_skill(explicit: str | None) -> Path:
    """The autoreview skill helper: --skill, $AUTOREVIEW, the standard install,
    or PATH — in that order."""
    for candidate in (explicit, os.environ.get("AUTOREVIEW")):
        if candidate:
            path = Path(candidate).expanduser()
            if path.is_file():
                return path
            fail(f"autoreview skill not found at {path}")
    if DEFAULT_SKILL.is_file():
        return DEFAULT_SKILL
    found = shutil.which("autoreview")
    if found:
        return Path(found)
    fail("autoreview skill not found: install it under ~/.codex/skills/autoreview "
         "or set AUTOREVIEW to its scripts/autoreview path")
    raise AssertionError("unreachable")


def _product_dirty(base: Path) -> list[str]:
    from .stages import WORKFLOW_PATHS
    status = _require_git(base, "reading working tree status", "status",
                          "--porcelain", "--untracked-files=all")
    dirty = []
    for line in status.splitlines():
        path = line[3:].strip()
        if path and not path.startswith(WORKFLOW_PATHS):
            dirty.append(path)
    return dirty


def _lens_prompt(task: dict, lens: str, base: Path | None = None) -> bytes:
    lines = [f"# Review brief — {task.get('id', '')} — {lens} lens", "",
             COMMON_PREAMBLE, LENS_FOCUS[lens]]
    if lens == "quality":
        lines += [QUALITY_VERDICT_FORMAT, VERDICT_INSTRUCTION, ""]
    lines += _task_section(task, base)
    return ("\n".join(lines).rstrip() + "\n").encode()


def resolve_review_base(base: Path, stage: dict, state: dict, tip_sha: str) -> str:
    """The commit the task diff is measured from.

    The stage records the trunk commit the task started on. When the trunk is
    merged INTO the task branch later (a harness re-vendor, a sibling task
    landing), everything the trunk gained since that recorded base is reachable
    from HEAD but is not the task's work — reviewing `base...HEAD` then bundles
    the whole trunk delta, chunks the pass, and returns findings on code the
    task never touched (observed 2026-09-04: a per-task review scored 0 on five
    vendored-harness findings and recorded every contract as partial because
    the chunked reviewer never reached the verdict lines). The task's own delta
    is `merge-base(origin/<trunk>, HEAD)...HEAD`. Use that point unless it is
    an ancestor of the recorded base — i.e. no trunk landed in the branch since
    the stage began (the trunk may have moved without being merged; then the
    diff still starts where the task did). The recorded base may itself be a
    branch commit (a story branch that carried planning commits before the
    stage started, then merged the trunk): it is then neither ancestor nor
    descendant of the trunk point, no single commit means "base plus trunk",
    and the trunk point is still the right base — the branch's own commits
    since divergence are the task under the per-task flow, and on a legacy
    story branch they are the story's earlier planning artifacts, which the
    harness-path filter drops."""
    from factory_lib import default_trunk_branch
    trunk = default_trunk_branch(base)
    recorded = stage.get("base_sha") or state.get("base_main_sha")
    base_sha = recorded if isinstance(recorded, str) and recorded else None
    if base_sha is None:
        base_sha = _require_git(base, "resolving the task base", "merge-base",
                                f"origin/{trunk}", "HEAD")
    if _git(base, "merge-base", "--is-ancestor", base_sha, tip_sha).returncode != 0:
        fail(f"task base {base_sha[:12]} is not an ancestor of HEAD")
    merged = _git(base, "merge-base", f"origin/{trunk}", tip_sha)
    trunk_point = merged.stdout.strip() if merged.returncode == 0 else ""
    if (trunk_point and trunk_point != base_sha
            and _git(base, "merge-base", "--is-ancestor", trunk_point, base_sha).returncode != 0):
        print(f"task base advanced {base_sha[:12]} -> {trunk_point[:12]}: the trunk was "
              "merged into this branch after the stage began; only the branch's own "
              "delta since it diverged from the trunk is reviewed")
        return trunk_point
    return base_sha


def _area(path: str) -> str:
    parts = path.split("/")
    return "/".join(parts[:-1]) if len(parts) > 1 else path


def _structured(finding: dict) -> dict:
    location = finding.get("code_location") or {}
    where = f"{location.get('file_path', '?')}:{location.get('line', '?')}"
    body = str(finding.get("body", "")).strip()
    # Chunked runs prefix bodies with "chunk N/M:\n\n"; strip that noise.
    body = re.sub(r"^chunk \d+/\d+:\s*", "", body)
    first = body.split(". ")[0].strip()
    summary = f"{finding.get('title', '').strip()} ({where})"
    if first:
        summary += f": {first.rstrip('.')}."
    return {
        "category": str(finding.get("category", "maintainability")),
        "area": _area(str(location.get("file_path", ""))),
        "summary": summary,
    }


def _score(blocking: int, non_blocking: int) -> int:
    # A documented heuristic, not a judgement: each blocking finding costs 3,
    # each non-blocking half a point; a clean review is 10. The recorded
    # findings carry the real content; the human reads those.
    return max(0, int(10 - 3 * blocking - 0.5 * non_blocking))


def _recommendation(blocking: int, non_blocking: int) -> str:
    if blocking:
        return "request-changes"
    return "approve-with-caveats" if non_blocking else "approve"


def _parse_verdicts(texts: list[str]) -> dict[str, tuple[str, str]]:
    verdicts: dict[str, tuple[str, str]] = {}
    for text in texts:
        for match in VERDICT_LINE.finditer(text or ""):
            verdicts.setdefault(
                match.group("id").strip(),
                (match.group("verdict").lower(),
                 (match.group("evidence") or "").strip() or "reviewer verdict"),
            )
    return verdicts


def _contract_verdicts(
    task: dict, reviewed: dict, all_tasks: list[dict], started: dict[str, str],
) -> list[dict]:
    """Verdicts for the reviewed task come from the reviewer; contracts of other
    tasks already done are attested as shipped at their own seal; contracts of
    tasks that have not started are not required (recorder, decision 0049)."""
    out: list[dict] = []
    parsed = _parse_verdicts([reviewed.get("overall_explanation", "")]
                             + [f.get("body", "") for f in reviewed.get("findings", [])])
    for contract in task.get("plan_contracts") or []:
        cid = contract.get("id")
        if not isinstance(cid, str):
            continue
        if cid in parsed:
            verdict, evidence = parsed[cid]
        else:
            verdict, evidence = "partial", (
                "the reviewer emitted no VERDICT line for this contract; "
                "recorded as partial (fail-closed) — re-review or verdict it")
        out.append({"contract_id": cid, "verdict": verdict, "evidence": evidence})
    for other in all_tasks:
        oid = other.get("id")
        if oid == task.get("id") or started.get(oid) != "done":
            continue
        for contract in other.get("plan_contracts") or []:
            cid = contract.get("id")
            if isinstance(cid, str):
                out.append({
                    "contract_id": cid, "verdict": "implemented",
                    "evidence": f"shipped under {oid} at its own per-task seal "
                                "(stage done); unchanged by this task's diff",
                })
    return out


def _artifact(
    lens: str, task: dict, report: dict, scope: list[str], base_sha: str,
    tip_sha: str, skills_used: list[str], all_tasks: list[dict],
    started: dict[str, str],
) -> dict:
    findings = [
        f for f in report.get("findings", [])
        if isinstance(f, dict) and not str(
            (f.get("code_location") or {}).get("file_path", "")
        ).startswith(HARNESS_PREFIXES)
    ]
    blocking = [f for f in findings if f.get("priority") in ("P0", "P1")]
    non_blocking = [f for f in findings if f.get("priority") not in ("P0", "P1")]
    explanation = re.sub(r"^Chunked review complete\.\s*", "",
                         str(report.get("overall_explanation", "")).strip())
    summary = (
        f"{lens} lens over {task.get('id')} ({len(scope)} product path(s), "
        f"{base_sha[:7]}..{tip_sha[:7]}, Codex via the autoreview skill at "
        f"--max-priority P2): {len(blocking)} blocking, {len(non_blocking)} "
        f"non-blocking. {explanation}"
    ).strip()[:3000]
    artifact = {
        "generated_by": "autoreview",
        "score": _score(len(blocking), len(non_blocking)),
        "summary": summary,
        "blocking_findings": [_structured(f) for f in blocking],
        "non_blocking_findings": [_structured(f) for f in non_blocking],
        "recommendation": _recommendation(len(blocking), len(non_blocking)),
        "reviewed_scope": scope,
        "skills_used": skills_used,
    }
    if lens == "quality":
        artifact["contract_verdicts"] = _contract_verdicts(
            task, report, all_tasks, started)
    return artifact


def product_only_tip(worktree: Path, base_sha: str) -> str:
    """Commit a review tip in the detached worktree with every harness
    bookkeeping path (`.factory/`, `plans/`, `docs/decisions/`, the context
    ledger) put back to the task base, and return its sha.

    The scope list already drops those paths, but the autoreview skill builds
    its own bundle from `base..HEAD`, so a story branch carrying hundreds of
    planning artifacts handed the reviewer a >1 MB bundle: chunked into several
    passes, the reviewer never reached the contract VERDICT lines, every
    contract was recorded `partial` (fail-closed -> blocking), and the task-proof
    gate refused a task whose product review was clean (observed 2026-09-04,
    issue #171). With the bookkeeping at the base, the bundle is the product
    delta only. The base is untouched and stays an ancestor of the new tip."""
    from .stages import WORKFLOW_PATHS
    prefixes = tuple(sorted(set(HARNESS_PREFIXES) | set(WORKFLOW_PATHS)))
    changed = [
        p for p in _require_git(worktree, "listing the review diff", "diff",
                                "--name-only", f"{base_sha}..HEAD").splitlines()
        if p.strip() and p.startswith(prefixes)
    ]
    if not changed:
        return _require_git(worktree, "resolving the review tip", "rev-parse", "HEAD")
    for rel in changed:
        at_base = _git(worktree, "cat-file", "-e", f"{base_sha}:{rel}").returncode == 0
        if at_base:
            _require_git(worktree, f"restoring {rel} to the task base",
                         "checkout", base_sha, "--", rel)
        else:
            _require_git(worktree, f"dropping {rel} from the review tip",
                         "rm", "-q", "--cached", "--", rel)
            path = worktree / rel
            if path.is_file():
                path.unlink()
    _require_git(worktree, "committing the review tip",
                 "-c", "user.name=forge-review", "-c", "user.email=forge-review@local",
                 "commit", "-q", "--no-verify", "-m",
                 f"review tip: harness bookkeeping at task base {base_sha[:12]}")
    print(f"review tip excludes {len(changed)} harness bookkeeping path(s); the "
          "bundle is the product delta only")
    return _require_git(worktree, "resolving the review tip", "rev-parse", "HEAD")


def codex_runs_path(root: Path) -> Path:
    """Advisory ledger of Codex releases that are not delegations.

    The delegation ledger is gate authority and has a schema to match; a review
    is neither, so it gets its own append-only file rather than smuggling rows
    into an artifact that `stage done` reads.
    """
    from factory_lib import git_control_dir
    return git_control_dir(root) / "codex_runs.jsonl"


def _append_codex_run(root: Path, record: dict) -> None:
    try:
        path = codex_runs_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except (OSError, SystemExit):
        return  # advisory: never fail a review because bookkeeping failed


def _record_codex_run(root: Path, label: str, argv: list) -> str:
    from factory_lib import now_iso
    run_id = f"review-{uuid.uuid4().hex[:12]}"
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review", "label": label,
        "status": "starting", "at": now_iso(), "argv0": argv[0] if argv else "",
    })
    return run_id


def _stamp_codex_run(root: Path, run_id: str, *, pid: int) -> None:
    from factory_lib import now_iso
    identity = ""
    try:
        from .delegate import _process_start_identity
        identity = str(_process_start_identity(pid) or "")
    except (Exception, SystemExit):
        identity = ""
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review", "status": "running",
        "pid": pid, "pid_started": identity, "at": now_iso(),
    })


def _close_codex_run(root: Path, run_id: str, returncode) -> None:
    from factory_lib import now_iso
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review",
        "status": "finished" if returncode in (0, 1) else "failed",
        "exit_code": returncode, "at": now_iso(),
    })


def _run_skill(skill: Path, worktree: Path, base_sha: str, prompt_rel: str,
               json_out: Path, engine: str, max_priority: str) -> dict:
    argv = [
        sys.executable, str(skill), "--mode", "branch", "--base", base_sha,
        "--engine", engine, "--max-priority", max_priority,
        "--prompt-file", prompt_rel, "--json-output", str(json_out),
    ]
    # Inherit stdio: the skill's heartbeat ("review still running ...") and any
    # streamed engine output are how the coordinator WATCHES this Codex release.
    #
    # Ledger the pid before waiting. This command BLOCKS, so a crash of the
    # review itself already surfaces as a non-zero exit -- but if this launcher
    # is killed uncatchably (a job-object teardown, TerminateProcess, SIGKILL)
    # no handler runs, and without a recorded pid nothing afterwards can say a
    # review was ever in flight. A delegation is covered by its own ledger; a
    # review was the blind spot, and it is the release the coordinator is told
    # to watch every time.
    started = _record_codex_run(worktree, prompt_rel, argv)
    process = subprocess.Popen(argv, cwd=worktree,
                               env={**os.environ, "PYTHONUTF8": "1"})
    _stamp_codex_run(worktree, started, pid=process.pid)
    try:
        returncode = process.wait()
    finally:
        _close_codex_run(worktree, started, getattr(process, "returncode", None))
    if returncode not in (0, 1):  # 1 == findings present, not an error
        fail(f"autoreview exited {returncode} for {prompt_rel}; see its output above")
    if not json_out.is_file():
        fail(f"autoreview produced no JSON for {prompt_rel} (the run aborted?)")
    return json.loads(json_out.read_text(encoding="utf-8"))


def cmd_review(args: argparse.Namespace) -> None:
    from .stages import WORKFLOW_PATHS, load_stages, task_for

    base = Path(args.repo).resolve() if args.repo else repo_root()
    task = task_for(base, args.id)
    if not task:
        fail(f"task {args.id} is not in the recorded decomposition")
    stages = load_stages(base).get("stages") or []
    started = {s.get("id"): s.get("status") for s in stages if isinstance(s, dict)}
    stage = next((s for s in stages if s.get("id") == args.id), {})
    if started.get(args.id) not in ("active", "done"):
        fail(f"task {args.id} has not started (stage '{started.get(args.id)}'); "
             "review runs once implementation is complete and verified")
    dirty = _product_dirty(base)
    if dirty:
        fail(f"commit the task's work first — uncommitted product paths: "
             f"{', '.join(dirty[:6])}{' …' if len(dirty) > 6 else ''}")

    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        fail("review requires an active story")
    for artifact in ("verify.json", "tests.json"):
        if not evidence_path(base, story, artifact).is_file():
            fail(f"{artifact} is not recorded for {story}; review runs after "
                 "`python3 factory/scripts/verify.py` and "
                 "`record_test_from_json.py --kind automated`")

    tip_sha = _require_git(base, "resolving HEAD", "rev-parse", "--verify", "HEAD^{commit}")
    base_sha = resolve_review_base(base, stage, state, tip_sha)
    scope = sorted(
        p for p in _require_git(base, "listing the task diff", "diff",
                                "--name-only", f"{base_sha}...HEAD").splitlines()
        if p.strip() and not p.startswith(WORKFLOW_PATHS)
        and not p.startswith(HARNESS_PREFIXES)
    )
    if not scope:
        fail(f"no product paths changed between {base_sha[:12]} and HEAD — nothing to review")

    # Mint the branch review run the recorder binds every artifact to.
    cmd_review_brief(argparse.Namespace(id=None, all=True, repo=str(base)))

    decomposition = load_json(protected_decomposition_state_path(base), default={})
    all_tasks = [t for t in decomposition.get("tasks") or [] if isinstance(t, dict)]
    skills_used: list[str] = []
    if task.get("user_facing"):
        schema = json.loads(schema_path(base, "review").read_text(encoding="utf-8"))
        skills_used = list((schema.get("required_skills") or {}).get("user_facing", []))

    skill = resolve_skill(getattr(args, "skill", None))
    lenses = [args.lens] if getattr(args, "lens", None) else list(LENSES)
    prompts: dict[str, tuple[str, bytes]] = {}
    for lens in lenses:
        rel = f"review-briefs/{args.id}.{lens}.md"
        body = _lens_prompt(task, lens, base)
        if not safe_factory_write_bytes(base, rel, body):
            fail(f"could not write .factory/{rel}")
        prompts[lens] = (f".factory/{rel}", body)

    tmp = Path(tempfile.mkdtemp(prefix="forge-review-"))
    worktree = tmp / "wt"
    reports: dict[str, dict] = {}
    try:
        # A clean detached checkout at the task tip: the skill refuses to finish
        # if the reviewed tree changes mid-run, and the main tree is exactly
        # where the harness keeps writing. Reviewing here also keeps the run
        # scoped to the committed task diff.
        _require_git(base, "creating the review worktree", "worktree", "add",
                     "--detach", str(worktree), tip_sha)
        review_tip = product_only_tip(worktree, base_sha)
        for lens in lenses:
            rel, body = prompts[lens]
            target = worktree / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        for lens in lenses:
            print(f"== {lens} lens: releasing Codex over {len(scope)} path(s) "
                  f"({base_sha[:7]}..{review_tip[:7]}, task tip {tip_sha[:7]}) — "
                  "watch the heartbeat below ==", flush=True)
            reports[lens] = _run_skill(
                skill, worktree, base_sha, prompts[lens][0], tmp / f"{lens}.json",
                args.engine, args.max_priority,
            )
    finally:
        _git(base, "worktree", "remove", "--force", str(worktree))
        _git(base, "worktree", "prune")

    recorder = base / "factory" / "scripts" / "record_review_from_json.py"
    outcome: dict[str, dict] = {}
    for lens in lenses:
        artifact = _artifact(lens, task, reports[lens], scope, base_sha, tip_sha,
                             skills_used, all_tasks, started)
        payload = tmp / f"{lens}.artifact.json"
        payload.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(recorder), "--aspect", lens, "--input", str(payload)],
            cwd=base, capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        if proc.returncode != 0:
            fail(f"recording the {lens} artifact failed:\n"
                 f"{proc.stdout.strip()}\n{proc.stderr.strip()}")
        outcome[lens] = artifact
    shutil.rmtree(tmp, ignore_errors=True)

    blocking_total = sum(len(a["blocking_findings"]) for a in outcome.values())
    caveats_total = sum(len(a["non_blocking_findings"]) for a in outcome.values())
    for lens, artifact in outcome.items():
        print(f"{lens:<12} score {artifact['score']:>2}  {artifact['recommendation']:<21}"
              f" blocking={len(artifact['blocking_findings'])} "
              f"non-blocking={len(artifact['non_blocking_findings'])}")
    print(f"Recorded {len(outcome)} review artifact(s) for {args.id} under "
          f".factory/stories/{story}/reviews/.")
    # These are instructions, not options. A coordinator that turns a review
    # finding into a menu for the human ("fix now / ship and defer / fix it
    # myself") is asking them to arbitrate something the harness has already
    # decided: fixing a finding the review just raised is the work, and it goes
    # to Codex like every other write.
    if blocking_total:
        print(f"NEXT: {blocking_total} blocking finding(s) — delegate the fixes to "
              f"Codex (`./forge delegate {args.id}`), commit, then rerun "
              f"`./forge review {args.id}`. Loop until every lens is clean. "
              "Do this WITHOUT asking the human to choose: a blocking finding "
              "cannot be deferred or shipped past (pr-ready refuses it), so "
              "there is no decision to put to them. Host-side fixing is the "
              "single exception, and only when the defect cannot be reproduced "
              "or fixed inside the Codex sandbox — then open a ledgered "
              "degraded window and say why.")
    elif caveats_total:
        print(f"NEXT: {caveats_total} non-blocking finding(s) — delegate the fixes "
              f"to Codex (`./forge delegate {args.id}`) and rerun "
              f"`./forge review {args.id}`; that is the default, and it does not "
              "need the human's permission. Defer one ONLY when it is genuinely "
              "outside this task's scope, with a reason and a revisit trigger "
              f"(`./forge defer`). Then `./forge task pr-ready {args.id}`.")
    else:
        print(f"NEXT: all lenses clean — `./forge task pr-ready {args.id}`.")
