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
import threading
import time
import uuid
from pathlib import Path

from factory_lib import (
    branch_diff_digest, clean_git_env, evidence_path, load_json,
    proof_read_path,
    proof_path, protected_decomposition_state_path, repo_root, run_state_path,
    safe_factory_write_bytes, schema_path,
)

from .common import fail
from .review_brief import (
    LEFTOVER_INSTRUCTION, VERDICT_INSTRUCTION, _task_section, cmd_review_brief,
)
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


def review_excluded_prefixes(base: Path) -> tuple[str, ...]:
    """Paths a product review never judges: harness bookkeeping, the workflow
    ledgers, and — in a VENDORED client — the harness machinery itself
    (`factory/`, `.claude/`, `constitution/`, ...), which `forge upgrade`
    rewrites mid-task and which the stage measure already exempts
    (`workflow_prefixes`). A re-vendor commit on a task branch once put 36
    harness files into a client's review bundle and the quality lens raised
    P1s against harness code the task never touched."""
    # The same set the stage measures and the stamp binds to; one function,
    # so a path is product for every closeout check or for none.
    from factory_lib import product_excluded_prefixes
    return product_excluded_prefixes(base)


def _product_dirty(base: Path) -> list[str]:
    """Dirty product paths, from NUL-separated porcelain with no stripping.

    Stripping the status text ate the leading space of a first ` M path`
    entry, and `line[3:]` then cut the first character of the path itself --
    `plans/roadmap.json` became `lans/roadmap.json`, outside every excluded
    prefix, and a review refused on harness bookkeeping. Both sides of a
    rename count: either path being dirty is a dirty tree.
    """
    excluded = review_excluded_prefixes(base)
    proc = _git(base, "status", "--porcelain", "-z", "--untracked-files=all")
    if proc.returncode != 0:
        fail("reading working tree status failed"
             + (f": {proc.stderr.strip()}" if proc.stderr.strip() else ""))
    entries = proc.stdout.split("\0")
    dirty: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        paths = [path]
        if code[:1] in ("R", "C") and index < len(entries) and entries[index]:
            paths.append(entries[index])  # the rename/copy source follows
            index += 1
        for rel in paths:
            if rel and not rel.startswith(excluded):
                dirty.append(rel)
    return dirty


def _lens_prompt(task: dict, lens: str, base: Path | None = None) -> bytes:
    lines = [f"# Review brief — {task.get('id', '')} — {lens} lens", "",
             COMMON_PREAMBLE, LENS_FOCUS[lens], LEFTOVER_INSTRUCTION]
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
    # each non-blocking half a point but never more than two in total, so a
    # review with no blocking finding scores at least 8 — the seal floor. P2
    # findings are follow-ups, not a reason to refuse a task (five of them once
    # sank a clean review to 7 and blocked pr-ready). The recorded findings
    # carry the real content; the human reads those.
    return max(0, int(10 - 3 * blocking - min(2.0, 0.5 * non_blocking)))


def recorded_review_totals(base: Path, story: str, task_id: str,
                           lenses: list[str] | tuple[str, ...]) -> tuple[int, int, dict]:
    """Blocking and non-blocking counts from the recorded lens artifacts.

    The one source every gate agrees on: `stage done`, `task pr-ready` and CI
    all read these files. A verdict computed anywhere else can disagree with
    them, and did.
    """
    recorded: dict[str, dict] = {}
    for lens in lenses:
        artifact = load_json(
            proof_path(base, story, f"reviews/{lens}.json", task_id=task_id),
            default={})
        recorded[lens] = artifact if isinstance(artifact, dict) else {}
    blocking = sum(len(a.get("blocking_findings") or []) for a in recorded.values())
    caveats = sum(len(a.get("non_blocking_findings") or []) for a in recorded.values())
    return blocking, caveats, recorded


def _next_hint(task_id: str, stage_status: str, blocking: int, caveats: int) -> str:
    """The one instruction after a review. Blocking findings go back to Codex;
    a clean run has already stamped the stage, and `task close` takes it from
    there -- re-reviewing only if the diff moves again, reopening a done stage
    itself, then measuring, closing and sealing."""
    # These are instructions, not options. A coordinator that turns a review
    # finding into a menu for the human ("fix now / ship and defer / fix it
    # myself") is asking them to arbitrate something the harness has already
    # decided: fixing a finding the review just raised is the work, and it goes
    # to Codex like every other write.
    if blocking:
        return (f"NEXT: {blocking} blocking finding(s) -- delegate the fixes "
                f"to Codex (`./forge delegate {task_id}`), commit, then "
                f"`./forge task close {task_id}`: it re-reviews the new diff, "
                "and a done stage reopens itself for the fix. Loop until no "
                "lens blocks. Do this WITHOUT asking the human to choose: a "
                "blocking finding cannot be deferred or shipped past (the seal "
                "refuses it). A finding that contradicts an accepted contract "
                "is not a defect: record the contract as a lesson "
                "(`./forge lesson add`) so the next round carries it. Host-side "
                "fixing is the single exception, and only when the defect cannot "
                "be reproduced or fixed inside the Codex sandbox -- then open a "
                "ledgered degraded window and say why.")
    seal = f"`./forge task close {task_id}` measures, closes and seals it"
    if caveats:
        return (f"NEXT: no blocking finding; {caveats} non-blocking finding(s) "
                "recorded as follow-ups. The stage is stamped -- " + seal + ". Fix a "
                "follow-up in this task only when it is cheap and in scope; "
                "otherwise `./forge defer` it with a revisit trigger.")
    return "NEXT: all lenses clean; the stage is stamped -- " + seal + "."

def _recommendation(blocking: int, non_blocking: int) -> str:
    if blocking:
        return "request-changes"
    return "approve-with-caveats" if non_blocking else "approve"


_VERDICT_SEVERITY = {"implemented": 0, "partial": 1, "missing": 2}


def _parse_verdicts(texts: list[str]) -> dict[str, tuple[str, str]]:
    """One verdict per contract across every text; when a contract is verdicted
    more than once (a chunked review emits one VERDICT line per pass) the WORST
    verdict wins — missing over partial over implemented — so a pass that saw
    a defect is never outvoted by a pass that only saw the files exist."""
    verdicts: dict[str, tuple[str, str]] = {}
    for text in texts:
        for match in VERDICT_LINE.finditer(text or ""):
            cid = match.group("id").strip()
            found = (match.group("verdict").lower(),
                     (match.group("evidence") or "").strip() or "reviewer verdict")
            current = verdicts.get(cid)
            if current is None or (_VERDICT_SEVERITY[found[0]]
                                   > _VERDICT_SEVERITY[current[0]]):
                verdicts[cid] = found
    return verdicts


def _verdict_texts(reviewed: dict) -> list[str]:
    """The merged explanation and findings, PLUS every preserved pass report: a
    chunked autoreview keeps the reviewer's conclusions (and its VERDICT lines)
    per pass and replaces the top-level explanation with a summary line."""
    texts = [reviewed.get("overall_explanation", "")]
    texts += [f.get("body", "") for f in reviewed.get("findings", []) or []]
    for entry in reviewed.get("pass_reports", []) or []:
        report = entry.get("report") if isinstance(entry, dict) else None
        if not isinstance(report, dict):
            continue
        texts.append(report.get("overall_explanation", ""))
        texts += [f.get("body", "") for f in report.get("findings", []) or []]
    return texts


def _contract_verdicts(
    task: dict, reviewed: dict, all_tasks: list[dict], started: dict[str, str],
) -> list[dict]:
    """Verdicts for the reviewed task come from the reviewer; contracts of other
    tasks already done are attested as shipped at their own seal; contracts of
    tasks that have not started are not required (recorder, decision 0049)."""
    out: list[dict] = []
    parsed = _parse_verdicts(_verdict_texts(reviewed))
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
    started: dict[str, str], excluded: tuple[str, ...] = HARNESS_PREFIXES,
) -> dict:
    findings = [
        f for f in report.get("findings", [])
        if isinstance(f, dict) and not str(
            (f.get("code_location") or {}).get("file_path", "")
        ).startswith(excluded)
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
        "task_id": task.get("id"),
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
    prefixes = review_excluded_prefixes(worktree)
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


# One file, appended by every lens launch. The launches happen in this
# process, so a lock here is what keeps three concurrent lenses from
# interleaving half-lines into it.
_CODEX_RUN_LOCK = threading.Lock()


def _append_codex_run(root: Path, record: dict) -> None:
    try:
        path = codex_runs_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with _CODEX_RUN_LOCK, path.open("a", encoding="utf-8") as handle:
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


def _skill_argv(skill: Path, base_sha: str, prompt_rel: str, json_out: Path,
                engine: str, max_priority: str) -> list[str]:
    return [
        sys.executable, str(skill), "--mode", "branch", "--base", base_sha,
        "--engine", engine, "--max-priority", max_priority,
        "--prompt-file", prompt_rel, "--json-output", str(json_out),
    ]


def _run_skill(skill: Path, worktree: Path, base_sha: str, prompt_rel: str,
               json_out: Path, engine: str, max_priority: str,
               ledger_root: Path | None = None) -> dict:
    argv = _skill_argv(skill, base_sha, prompt_rel, json_out, engine, max_priority)
    # The ledger goes to the REPO's control dir: the review worktree is removed
    # when the review ends and its control dir pruned with it, so rows written
    # there never reach `forge codex status`.
    ledger = ledger_root or worktree
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
    started = _record_codex_run(ledger, prompt_rel, argv)
    process = subprocess.Popen(argv, cwd=worktree,
                               env={**os.environ, "PYTHONUTF8": "1"})
    _stamp_codex_run(ledger, started, pid=process.pid)
    try:
        returncode = process.wait()
    finally:
        _close_codex_run(ledger, started, getattr(process, "returncode", None))
    if returncode not in (0, 1):  # 1 == findings present, not an error
        fail(f"autoreview exited {returncode} for {prompt_rel}; see its output above")
    if not json_out.is_file():
        fail(f"autoreview produced no JSON for {prompt_rel} (the run aborted?)")
    return json.loads(json_out.read_text(encoding="utf-8"))


def review_log_dir(base: Path, task_id: str) -> Path:
    """Where each lens's streamed output lands when lenses run together.

    Beside the run ledger in git's control directory, not under .factory/:
    nothing in the product tree changes, so a review never dirties the
    working copy or needs an ignore rule.
    """
    return codex_runs_path(base).parent / "review-logs" / task_id


def review_log_path(base: Path, task_id: str, lens: str) -> Path:
    return review_log_dir(base, task_id) / f"{lens}.log"


def run_lenses(skill: Path, worktree: Path, base_sha: str, lenses: list[str],
               prompts: dict[str, tuple[str, bytes]], tmp: Path, engine: str,
               max_priority: str, *, parallel: bool, log_dir: Path,
               ledger_root: Path | None = None,
               heartbeat_every: float = 60.0) -> dict[str, dict]:
    """Release every lens and return its report, keyed by lens.

    Sequential keeps the old shape: one lens at a time, stdio inherited so the
    skill's heartbeat is the watch. Parallel launches all of them at once --
    each with its own ledger row, pid, prompt, output file and log -- and
    prints one combined heartbeat. Nothing downstream needs one lens before
    another; the artifacts are recorded only after all have returned. If one
    lens crashes the others are still waited for and reaped, then the failure
    names the lens and its log, so a crash never orphans a running review.
    """
    if not parallel or len(lenses) == 1:
        reports: dict[str, dict] = {}
        for lens in lenses:
            reports[lens] = _run_skill(
                skill, worktree, base_sha, prompts[lens][0], tmp / f"{lens}.json",
                engine, max_priority, ledger_root=ledger_root)
        return reports

    ledger = ledger_root or worktree  # same rule as _run_skill
    log_dir.mkdir(parents=True, exist_ok=True)
    launched: dict[str, dict] = {}
    try:
        for lens in lenses:
            json_out = tmp / f"{lens}.json"
            argv = _skill_argv(skill, base_sha, prompts[lens][0], json_out,
                               engine, max_priority)
            log = (log_dir / f"{lens}.log").open("wb")
            run_id = _record_codex_run(ledger, prompts[lens][0], argv)
            process = subprocess.Popen(
                argv, cwd=worktree, stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, "PYTHONUTF8": "1"})
            _stamp_codex_run(ledger, run_id, pid=process.pid)
            launched[lens] = {"process": process, "run_id": run_id, "log": log,
                              "json": json_out, "started": time.monotonic(),
                              "returncode": None}
        print(f"lenses running together: {', '.join(lenses)} -- one heartbeat "
              f"line per {int(heartbeat_every)}s; each lens's own output is in "
              f"{log_dir.as_posix()}/<lens>.log", flush=True)

        last_beat = time.monotonic()
        while any(item["returncode"] is None for item in launched.values()):
            for lens, item in launched.items():
                if item["returncode"] is not None:
                    continue
                code = item["process"].poll()
                if code is None:
                    continue
                item["returncode"] = code
                _close_codex_run(ledger, item["run_id"], code)
                item["log"].close()
                took = int(time.monotonic() - item["started"])
                print(f"== {lens} lens finished (exit {code}, {took}s) ==", flush=True)
            now = time.monotonic()
            if now - last_beat >= heartbeat_every:
                last_beat = now
                status = " · ".join(
                    f"{lens} {int(now - item['started'])}s"
                    for lens, item in launched.items() if item["returncode"] is None)
                print(f"review still running: {status}", flush=True)
            time.sleep(1.0)
    finally:
        # A KeyboardInterrupt or a fail() above must not leave lenses running.
        for lens, item in launched.items():
            if item["returncode"] is None:
                try:
                    item["process"].terminate()
                except OSError:
                    pass
                _close_codex_run(ledger, item["run_id"], None)
            try:
                item["log"].close()
            except OSError:
                pass

    crashed = [lens for lens, item in launched.items()
               if item["returncode"] not in (0, 1)]  # 1 == findings, not an error
    if crashed:
        where = ", ".join(f"{lens} (exit {launched[lens]['returncode']}, "
                          f"{(log_dir / f'{lens}.log').as_posix()})" for lens in crashed)
        fail(f"autoreview crashed on {where}; the other lens(es) finished and "
             "were reaped. Read the log, fix the cause, rerun the review.")
    reports = {}
    for lens, item in launched.items():
        if not item["json"].is_file():
            fail(f"autoreview produced no JSON for the {lens} lens (the run "
                 f"aborted?); see {(log_dir / f'{lens}.log').as_posix()}")
        reports[lens] = json.loads(item["json"].read_text(encoding="utf-8"))
    return reports


def reject_finding(base: Path, task_id: str, lens: str, match: str, *,
                   reason: str, cite: str, by: str) -> dict:
    """Move a recorded blocking finding that contradicts an accepted contract
    out of the blocking list, ledger the contract as a lesson so the next
    round's brief carries it, and stamp the stage if no lens blocks any more.

    Rejection is for contradictions of settled decisions, never for taste:
    `cite` names the decision, plan line or sealed contract. The finding stays
    in the artifact under `rejected_findings` with the reason, so the record
    shows what was raised and why it did not block."""
    from factory_lib import append_ledger_record, dump_json, now_iso
    from .lessons import lessons_path, load_lessons
    from .stages import load_stages, stamp_stage_review

    if lens not in LENSES:
        fail(f"--lens must be one of {', '.join(LENSES)}")
    for name, value in (("--reason", reason), ("--cite", cite), ("--by", by)):
        if not (value or "").strip():
            fail(f"{name} must be non-empty: a rejection names the accepted "
                 "contract it rests on")
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        fail("review reject requires an active story")
    resolved, settled_text = _cite_resolves(base, story, cite, task_id)
    if not resolved:
        fail(f"--cite {cite!r} names nothing settled. A rejection cites a decision "
             "record (its NNNN id under docs/decisions/), a plan contract id of a "
             "task whose stage is DONE (never this task's own or a pending task's), "
             "or a `## ` section of the story plan; a finding no settled text "
             "contradicts is a defect to fix, not to reject.")
    rel = f"reviews/{lens}.json"
    path = proof_path(base, story, rel, task_id=task_id)
    artifact = load_json(path, default={})
    if not artifact:
        fail(f"no recorded {lens} review for {task_id}; run `forge review {task_id}`")
    if artifact.get("task_id") not in (None, task_id):
        fail(f"the recorded {lens} review belongs to task {artifact.get('task_id')}, "
             f"not {task_id}; rerun `forge review {task_id}` first")
    # A finding on a tree that is no longer the branch's is not this diff's
    # finding: refuse before touching the record, so a rejection can never
    # be applied to an artifact the next review will overwrite anyway.
    if artifact.get("branch_diff_digest") != branch_diff_digest(base):
        fail(f"the recorded {lens} review predates the current branch diff; run "
             f"`forge review {task_id}` on this tree, then reject what it raises")
    needle = match.strip().lower()
    hits = [f for f in artifact.get("blocking_findings") or []
            if needle in json.dumps(f).lower()]
    if not hits:
        fail(f"no blocking {lens} finding matches {match!r}")
    if len(hits) > 1:
        fail(f"{len(hits)} blocking {lens} findings match {match!r}; narrow it")
    finding = hits[0]
    shared = _shared_terms(finding, settled_text)
    if not shared:
        fail(f"--cite {cite!r} resolves to {resolved}, but that text shares no "
             "substantive term with the finding; a citation must be ABOUT the "
             "finding it sets aside. Cite the decision, contract or section that "
             "actually contradicts it, or fix the finding.")
    at = now_iso()
    artifact["blocking_findings"] = [
        f for f in artifact["blocking_findings"] if f is not finding]
    artifact.setdefault("rejected_findings", []).append({
        "finding": finding, "reason": reason.strip(), "cite": cite.strip(),
        "rejected_at": at, "rejected_by": by.strip(), "task_id": task_id,
    })
    blocking = len(artifact["blocking_findings"])
    non_blocking = len(artifact.get("non_blocking_findings") or [])
    artifact["score"] = _score(blocking, non_blocking)
    artifact["recommendation"] = _recommendation(blocking, non_blocking)
    dump_json(proof_path(base, story, rel, task_id=task_id, for_write=True), artifact)
    area = str(finding.get("area", "")).strip() if isinstance(finding, dict) else ""
    # `area` is a directory for structured findings; a file-shaped value (an
    # extension in its last segment) is kept as the file itself.
    if not area:
        applies_to = ["**"]
    elif "." in area.rsplit("/", 1)[-1]:
        applies_to = [area]
    else:
        applies_to = [f"{area}/**"]
    summary = (str(finding.get("summary", ""))[:160] if isinstance(finding, dict)
               else str(finding)[:160])
    lesson = {
        "topic": f"rejected-review-finding-{lens}",
        "lesson": f"Not a defect ({cite.strip()}): {reason.strip()} — raised as "
                  f"\"{summary}\"",
        "source": f"review reject {task_id} {lens} at {at}",
        "applies_to": applies_to,
        "severity": "medium",
        "generated_by": by.strip(),
        "added_at": at,
    }
    existing = load_lessons(base)
    if not any(l.get("lesson", "").strip().lower() == lesson["lesson"].lower()
               for l in existing):
        record_id = f"{at.replace(':', '').replace('-', '')}-{lesson['topic']}"
        append_ledger_record(lessons_path(base), lesson, record_id)
    print(f"Rejected {lens} finding: {summary}\n  reason: {reason.strip()}\n  "
          f"cite: {resolved} (shared terms: {', '.join(shared[:4])})\n  "
          f"ledgered as a lesson for {', '.join(applies_to)}")
    # A rejection only ever REMOVES one finding; it stamps the stage only when
    # the review set is complete and current — every lens recorded for THIS
    # task on THIS branch diff — so a lone lens or a stale run cannot seal.
    problem = _review_set_problem(base, story, task_id)
    stage = next((s for s in load_stages(base).get("stages", [])
                  if s.get("id") == task_id), {})
    if problem:
        print(f"No stamp: {problem}")
    elif stage.get("status") in ("active", "done"):
        stamp_stage_review(base, task_id, lenses=LENSES)
        print(f"No lens blocks any more; stage {task_id} review stamp recorded. "
              + ("`./forge stage done` then " if stage.get("status") == "active" else "")
              + f"`./forge task pr-ready {task_id}`.")
    return artifact


def rejected_findings_report(base: Path, story: str, task_id: str) -> str:
    """Markdown for the PR body: every finding the task's review rejected on a
    citation, so the human merging sees what was set aside and why. A
    rejection is the coordinator's call; this is where a person checks it."""
    lines: list[str] = []
    for lens in LENSES:
        recorded = load_json(
            proof_path(base, story, f"reviews/{lens}.json", task_id=task_id), default={})
        for entry in recorded.get("rejected_findings") or []:
            if not isinstance(entry, dict):
                continue
            finding = entry.get("finding") or {}
            summary = (str(finding.get("summary", "")) if isinstance(finding, dict)
                       else str(finding)).strip()
            lines.append(f"- **{lens}**: {summary}\n  - rejected because: "
                         f"{str(entry.get('reason', '')).strip()}\n  - cites: "
                         f"{str(entry.get('cite', '')).strip()}")
    if not lines:
        return ""
    return ("## Review findings rejected on a citation\n\n"
            "The reviewer raised these as blocking; the coordinator set them aside "
            "as contradicting settled text. Check the citation before merging.\n\n"
            + "\n".join(lines) + "\n")


def _review_set_problem(base: Path, story: str, task_id: str) -> str:
    """Why the recorded lens artifacts cannot seal `task_id` right now — empty
    when every lens is recorded for this task against the current branch diff
    with no blocking finding left."""
    current = branch_diff_digest(base)
    for lens in LENSES:
        recorded = load_json(
            proof_path(base, story, f"reviews/{lens}.json", task_id=task_id), default={})
        if not recorded:
            return f"the {lens} lens is not recorded; run `forge review {task_id}`"
        if recorded.get("task_id") != task_id:
            return (f"the {lens} lens was recorded for "
                    f"{recorded.get('task_id') or 'an earlier task'}; run "
                    f"`forge review {task_id}`")
        if recorded.get("branch_diff_digest") != current:
            return (f"the {lens} lens predates the current branch diff; run "
                    f"`forge review {task_id}` on this tree")
        if recorded.get("blocking_findings"):
            return (f"{len(recorded['blocking_findings'])} blocking {lens} "
                    "finding(s) remain")
    return ""


def _cite_resolves(base: Path, story: str, cite: str, task_id: str = "") -> tuple[str, str]:
    """(label, settled text) a rejection rests on, or ('', '') when nothing matches.

    Accepted forms, any token of `cite` split on `;`, `,` or whitespace:
    a decision id (`0154`, `decision 0154`) with a record under docs/decisions/;
    a plan contract id of a task whose stage is DONE (`T3b-AC3`) — never the
    task under review's own contract nor a pending task's, which are not
    settled; a `## ` section header of the story plan (`S4`, `Decisions`),
    matched as a whole word inside the header."""
    from .stages import load_stages
    tokens = [t.strip("`'\"() ") for t in re.split(r"[;,\s]+", cite or "") if t.strip()]
    decisions = base / "docs" / "decisions"
    decomposition = load_json(protected_decomposition_state_path(base), default={})
    sealed = {s.get("id") for s in load_stages(base).get("stages", [])
              if isinstance(s, dict) and s.get("status") == "done"}
    contract_ids = {
        str(c.get("id")): str(c.get("statement", ""))
        for t in decomposition.get("tasks") or [] if isinstance(t, dict)
        if t.get("id") in sealed and t.get("id") != task_id
        for c in t.get("plan_contracts") or [] if isinstance(c, dict)
    }
    from .review_brief import _plan_section_bodies
    sections: list[tuple[str, str]] = []
    for plan in sorted((base / "plans" / "active").glob(f"{story}-*.md"))[:1]:
        sections = _plan_section_bodies(_read_text(plan), ("",))
    # Scaffolding headers every plan carries name nothing settled; a citation
    # of "Risks" or "Problem" is not a contract.
    generic = {"problem", "context", "scope / non-goals", "scope", "risks",
               "verify plan", "surface impact", "technical approach",
               "task decomposition", "grill provenance", "acceptance criteria",
               "manual verification", "workflow"}
    for token in tokens:
        if re.fullmatch(r"\d{4}", token):
            record = next(iter(sorted(decisions.glob(f"{token}-*.md"))), None)
            if record is not None:
                return f"decision {token}", _read_text(record)
        if token in contract_ids:
            return f"contract {token}", contract_ids[token]
        if len(token) < 2 or (len(token) < 3 and not re.fullmatch(r"[A-Z]\d+", token)):
            continue
        for header, body in sections:
            if header.strip().lower() in generic:
                continue
            if re.search(rf"(?<![\w-]){re.escape(token)}(?![\w-])", header, re.I):
                return f"plan section '{header}'", f"{header}\n{body}"
    return "", ""


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


_STOPWORDS = {"about", "after", "before", "should", "would", "could", "their",
              "there", "these", "those", "which", "while", "where", "being",
              "every", "never", "always", "still", "other", "under", "against",
              "within", "without", "review", "finding", "blocking", "task"}


def _shared_terms(finding: dict | str, source: str) -> list[str]:
    """Substantive words (5+ letters, not stopwords) the finding and the cited
    settled text have in common. A citation that shares none is not about
    this finding, whatever it resolves to."""
    def terms(text: str) -> set[str]:
        return {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z_]{4,}", text)
                if w.lower() not in _STOPWORDS}
    finding_text = json.dumps(finding) if isinstance(finding, dict) else str(finding)
    return sorted(terms(finding_text) & terms(source))


def cmd_review(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if getattr(args, "reject", None):
        reject_finding(base, args.id, getattr(args, "lens", None) or "",
                       args.reject, reason=getattr(args, "reason", "") or "",
                       cite=getattr(args, "cite", "") or "",
                       by=getattr(args, "by", "") or "")
        return
    outcome = review_task(
        base, args.id, lens=getattr(args, "lens", None),
        engine=getattr(args, "engine", "codex"),
        max_priority=getattr(args, "max_priority", "P2"),
        skill=getattr(args, "skill", None),
        parallel=not getattr(args, "sequential", False),
    )
    print(_next_hint(args.id, outcome["stage_status"], outcome["blocking"],
                     outcome["caveats"]))


def review_task(base: Path, task_id: str, *, lens: str | None = None,
                engine: str = "codex", max_priority: str = "P2",
                skill: str | None = None, parallel: bool | None = None) -> dict:
    """Release the three-lens review for one task and record its proof.

    Returns {"blocking", "caveats", "stamped", "stage_status"}. `cmd_review`
    prints the next-step hint; `task close` reads the numbers and decides.
    """
    from .stages import load_stages, task_for

    class _Args:  # the body below reads these as it always did
        pass
    args = _Args()
    args.id = task_id
    args.lens = lens
    args.engine = engine
    args.max_priority = max_priority
    args.skill = skill

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
        # Proof follows the writer: a per-task run records under the task.
        if not proof_read_path(base, story, artifact).is_file():
            fail(f"{artifact} is not recorded for {story}; review runs after "
                 "`python3 factory/scripts/verify.py` and "
                 "`record_test_from_json.py --kind automated`")

    tip_sha = _require_git(base, "resolving HEAD", "rev-parse", "--verify", "HEAD^{commit}")
    base_sha = resolve_review_base(base, stage, state, tip_sha)
    excluded = review_excluded_prefixes(base)
    scope = sorted(
        p for p in _require_git(base, "listing the task diff", "diff",
                                "--name-only", f"{base_sha}...HEAD").splitlines()
        if p.strip() and not p.startswith(excluded)
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
        # Together by default: the lenses share nothing but the diff they
        # read. FORGE_REVIEW_SEQUENTIAL=1 or --sequential restores one at a
        # time (an account that rate-limits three sessions, or a debug run).
        together = (parallel if parallel is not None
                    else not os.environ.get("FORGE_REVIEW_SEQUENTIAL"))
        for lens in lenses:
            print(f"== {lens} lens: releasing Codex over {len(scope)} path(s) "
                  f"({base_sha[:7]}..{review_tip[:7]}, task tip {tip_sha[:7]})"
                  f"{' ==' if together and len(lenses) > 1 else ' — watch the heartbeat below =='}",
                  flush=True)
        reports = run_lenses(
            skill, worktree, base_sha, lenses, prompts, tmp, args.engine,
            args.max_priority, parallel=together,
            log_dir=review_log_dir(base, args.id), ledger_root=base)
    finally:
        _git(base, "worktree", "remove", "--force", str(worktree))
        _git(base, "worktree", "prune")

    recorder = base / "factory" / "scripts" / "record_review_from_json.py"
    outcome: dict[str, dict] = {}
    for lens in lenses:
        artifact = _artifact(lens, task, reports[lens], scope, base_sha, tip_sha,
                             skills_used, all_tasks, started, excluded)
        # A rejection is part of the task's review record: a later round must
        # not erase it (the ledgered lesson keeps the reviewer from re-raising
        # it; the artifact keeps the human able to see it was set aside).
        previous = load_json(
            proof_path(base, story, f"reviews/{lens}.json", task_id=args.id), default={})
        carried = [r for r in previous.get("rejected_findings") or []
                   if isinstance(r, dict) and r.get("task_id") == args.id]
        if carried:
            artifact["rejected_findings"] = carried
        payload = tmp / f"{lens}.artifact.json"
        payload.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(recorder), "--aspect", lens, "--task", args.id,
             "--input", str(payload)],
            cwd=base, capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        if proc.returncode != 0:
            fail(f"recording the {lens} artifact failed:\n"
                 f"{proc.stdout.strip()}\n{proc.stderr.strip()}")
        outcome[lens] = artifact
    shutil.rmtree(tmp, ignore_errors=True)

    # Count what was RECORDED, not what was composed. The recorder turns a
    # partial or missing contract verdict into a blocking finding, and CI
    # reads the recorded file; counting the pre-record artifact printed
    # "blocking=0", stamped the stage, and let CI refuse it (WF-1 T2).
    blocking_total, caveats_total, recorded = recorded_review_totals(
        base, story, args.id, lenses)
    for lens, artifact in recorded.items():
        print(f"{lens:<12} score {str(artifact.get('score', '?')):>2}  "
              f"{str(artifact.get('recommendation', '')):<21}"
              f" blocking={len(artifact.get('blocking_findings') or [])} "
              f"non-blocking={len(artifact.get('non_blocking_findings') or [])}")
    print(f"Recorded {len(outcome)} review artifact(s) for {args.id} under "
          f".factory/stories/{story}/reviews/.")
    # ONE review per task: a run with no blocking finding is the stage's review
    # stamp as well (bound to this exact tree), so `stage done` and
    # `task pr-ready` seal on it; no separate stage-local autoreview loop.
    if not blocking_total and len(lenses) == len(LENSES):
        from .stages import stamp_stage_review
        stamp_stage_review(base, args.id, lenses=lenses)
        print(f"Stage {args.id} review stamp recorded (tree "
              f"{tip_sha[:12]}; {len(lenses)} lenses).")
    elif not blocking_total:
        print(f"NOTE: a single-lens run does not stamp the stage; run all lenses "
              f"(`./forge review {args.id}`) for the seal.")
    else:
        # A blocking review on a tree an earlier run stamped clean revokes that
        # stamp: the seal must reflect the latest verdict, not the first.
        from .stages import revoke_stage_review_stamp
        if revoke_stage_review_stamp(base, args.id):
            print(f"Stage {args.id}'s earlier review stamp revoked: this run blocks.")
    return {
        "blocking": blocking_total,
        "caveats": caveats_total,
        "stamped": bool(not blocking_total and len(lenses) == len(LENSES)),
        "stage_status": str(started.get(args.id)),
    }
