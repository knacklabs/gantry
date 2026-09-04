"""forge audit — loop-health: the improvement loops are themselves watched.

The harness is a graph of improvement loops (findings escalation, lessons,
deferrals, structured reviews). Each emits advisories — and an advisory
nobody acts on decays into theater: the warning fires forever, the trigger
never re-checks, the lesson's globs rot after a rename. This audit is the
loop that watches the watchers (decision record: loop-health-audit). It is
ADVISORY, never a ship gate — audit output routes work to the roadmap; it
does not hold an unrelated task hostage.

Checks:
- ignored escalations: a RECURRING finding class with ships since it was
  flagged and no consolidating decision or refactor story
- stale deferrals: open rows past the age threshold — re-check the trigger
- decayed lessons: applies_to globs matching zero tracked files
- review drift: the latest shipped task's findings carry no structure, so
  they can never cluster
"""
from __future__ import annotations

import argparse
import datetime
import subprocess
from pathlib import Path

from factory_lib import factory_dir, repo_root, story_dir

from .deferrals import load_rows
from .findings import collect, recurring
from .lessons import _matches, load_lessons
from .roadmap import load_items

DEFERRAL_STALE_DAYS = 60


def _shipped(base: Path) -> list[str]:
    history = factory_dir(base) / "history"
    shipped = {p.name for p in history.iterdir() if p.is_dir()} \
        if history.is_dir() else set()
    shipped.update(
        str(item["key"])
        for item in load_items(base)
        if item.get("status") == "done" and item.get("key")
        and story_dir(base, str(item["key"])).is_dir()
    )
    return sorted(shipped)


def ignored_escalations(base: Path) -> list[str]:
    flagged = recurring(base)
    if not flagged:
        return []
    shipped = _shipped(base)
    decision_text = " ".join(
        p.read_text(encoding="utf-8").lower() for p in sorted((base / "docs" / "decisions").glob("*.md"))
    ) if (base / "docs" / "decisions").is_dir() else ""
    refactor_text = " ".join(
        f"{i.get('title', '')} {i.get('epic', '')}"
        for i in load_items(base) if i.get("kind") == "refactor"
    ).lower()
    out = []
    for cluster in flagged:
        needle = (cluster["category"] if cluster["category"] != "(uncategorized)"
                  else (cluster["examples"][0] if cluster["examples"] else "")).lower()
        if needle and (needle in decision_text or needle in refactor_text):
            continue  # routed: a decision or refactor story names the class
        flag_task = cluster.get("flagged_at", "")
        ships_since = sum(1 for t in shipped if t > flag_task) if flag_task in shipped else 0
        if ships_since >= 1:
            out.append(
                f"IGNORED ESCALATION: {cluster['category']}"
                f"{' @ ' + cluster['area'] if cluster['area'] else ''} went RECURRING at "
                f"{flag_task}; {ships_since} ship(s) since with no consolidating decision "
                "or refactor story — the escalation loop is being ignored"
            )
    return out


def stale_deferrals(base: Path) -> list[str]:
    today = datetime.date.today()
    out = []
    for row in load_rows(base):
        if row["status"] != "open":
            continue
        try:
            age = (today - datetime.date.fromisoformat(row["added"])).days
        except ValueError:
            age = DEFERRAL_STALE_DAYS + 1  # unparseable date is stale by definition
        if age > DEFERRAL_STALE_DAYS:
            out.append(
                f"STALE DEFERRAL: {row['id']} open {age} day(s) ({row['item']}) — "
                f"re-check its trigger ({row['trigger']}) or resolve it"
            )
    return out


def decayed_lessons(base: Path) -> list[str]:
    lessons = load_lessons(base)
    if not lessons:
        return []
    proc = subprocess.run(
        ["git", "ls-files"], cwd=base, capture_output=True, text=True,
        encoding="utf-8", errors="surrogateescape",
    )
    tracked = [line for line in proc.stdout.splitlines() if line] \
        if proc.returncode == 0 else []
    out = []
    for lesson in lessons:
        globs = lesson.get("applies_to", [])
        if not any(_matches(rel, pat) for pat in globs for rel in tracked):
            out.append(
                f"DECAYED LESSON: '{lesson.get('topic')}' matches zero tracked files "
                f"({', '.join(globs)}) — its sensor rotted (rename?); retarget the "
                "globs or retire it, or it can never resurface"
            )
    return out


def review_drift(base: Path) -> list[str]:
    """Only the LATEST shipped task with findings is judged — early tasks may
    predate structured findings; current drift is what matters."""
    rows_by_task: dict[str, list[dict]] = {}
    for row in collect(base):
        rows_by_task.setdefault(row["task"], []).append(row)
    shipped_with_findings = [t for t in _shipped(base) if rows_by_task.get(t)]
    if not shipped_with_findings:
        return []
    latest = shipped_with_findings[-1]
    if any(r["category"] for r in rows_by_task[latest]):
        return []
    return [
        f"REVIEW DRIFT: every finding on {latest} (the latest shipped task with "
        "findings) is an unstructured string — they can never cluster, so the "
        "escalation loop is blind; re-align reviews with factory/prompts/reviewer.md"
    ]


# ---------------------------------------------------------------- state audit
#
# The harness validates TRANSITIONS -- "may I move from A to B?" -- and never
# re-validates STATE. Every gate checks its own precondition at the moment of
# the move and then trusts the record forever after. So an artifact that was
# hand-written, or a claim that was true once and is not any more, is
# undetectable: nothing ever asks whether what is recorded still agrees with
# the repository.
#
# These checks re-derive each recorded claim from the repo and report where the
# two disagree. Read-only, and deliberately so: it reports, it never repairs.
# A repair would be the same act of asserting-without-checking that makes the
# records untrustworthy in the first place.


def _tasks_and_stages(base: Path):
    from factory_lib import (load_json, protected_decomposition_state_path,
                             git_control_dir)
    tasks = load_json(protected_decomposition_state_path(base),
                      default={}).get("tasks", [])
    stages = load_json(git_control_dir(base) / "stages.json",
                       default={}).get("stages", [])
    return tasks, {s.get("id"): s for s in stages if isinstance(s, dict)}


def decomposition_agrees_with_stages(base: Path) -> list[str]:
    """Every stage names a task, and every task has a stage."""
    tasks, stage_by_id = _tasks_and_stages(base)
    if not tasks:
        return []
    task_ids = {t.get("id") for t in tasks if isinstance(t, dict)}
    problems = []
    for stage_id in stage_by_id:
        if stage_id not in task_ids:
            problems.append(
                f"stage {stage_id} has no task in the recorded decomposition — "
                "the tracker is describing work the contract does not define")
    for task_id in task_ids:
        if task_id not in stage_by_id:
            problems.append(
                f"task {task_id} has no stage — it cannot be started, measured "
                "or closed until the decomposition is re-recorded")
    return problems


def grills_still_ground(base: Path) -> list[str]:
    """Recompute each task grill's grounding and compare with what it claims."""
    from factory_lib import (evidence_path, grounding_digest, load_json,
                             run_state_path, task_stage_record)
    key = load_json(run_state_path(base), default={}).get("issue_key", "")
    if not key:
        return []
    tasks, _ = _tasks_and_stages(base)
    problems = []
    for task in tasks:
        task_id = task.get("id")
        record = load_json(
            evidence_path(base, key, f"grills/tasks/{task_id}.json"), default={})
        if not record:
            continue
        stage = task_stage_record(base, task_id)
        treeish = ""
        if stage.get("status") == "done":
            from .stages import stage_baseline
            from factory_lib import task_state_root
            treeish = stage_baseline(task_state_root(base, task_id), stage)
        try:
            expected = grounding_digest(base, task, treeish=treeish)
        except SystemExit as exc:
            problems.append(f"{task_id} grill cannot be re-derived: {exc}")
            continue
        if record.get("input_sha256") != expected:
            basis = record.get("grounding_basis") or "unrecorded"
            problems.append(
                f"{task_id} grill no longer grounds: it claims "
                f"{str(record.get('input_sha256'))[:12]} (basis {basis}), the "
                f"repo derives {expected[:12]}")
    return problems


def launches_still_bind(base: Path) -> list[str]:
    """The recorded write launch must still describe THIS contract and brief."""
    from factory_lib import load_json, sha256_of, task_digest
    tasks, stage_by_id = _tasks_and_stages(base)
    try:
        from .delegate import brief_path, load_delegations
        entries = load_delegations(base)
    except (Exception, SystemExit):
        return []
    latest = {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("task"):
            latest[str(entry["task"])] = entry
    problems = []
    for task in tasks:
        task_id = task.get("id")
        entry = latest.get(task_id)
        if not entry or entry.get("launch_status") != "succeeded":
            continue
        if entry.get("task_sha256") != task_digest(task):
            problems.append(
                f"{task_id} recorded launch is bound to a contract that no "
                "longer exists — the contract changed after the work ran "
                f"(`forge stage amend-scope {task_id}` records a measured scope "
                "correction without breaking this binding)")
        brief = brief_path(base, task_id)
        if brief.is_file() and entry.get("brief_sha256") != sha256_of(brief):
            problems.append(
                f"{task_id} recorded launch is bound to a brief that has since "
                "changed on disk")
    return problems


def worktrees_agree_on_stages(base: Path) -> list[str]:
    """No two working copies may disagree about a task's status.

    This is the split that made a passing grill unverifiable: the main repo
    called a task active while its own worktree called it done, so the recorder
    and the seal ground the same attestation against different trees.
    """
    from factory_lib import git_control_dir, linked_worktree_roots, load_json
    seen: dict[str, dict[str, str]] = {}
    for root in linked_worktree_roots(base):
        try:
            stages = load_json(git_control_dir(root) / "stages.json", default={})
        except (OSError, SystemExit):
            continue
        for stage in stages.get("stages", []):
            if not isinstance(stage, dict) or not stage.get("id"):
                continue
            seen.setdefault(str(stage["id"]), {})[root.name] = str(
                stage.get("status"))
    problems = []
    for task_id, by_root in sorted(seen.items()):
        if len(set(by_root.values())) > 1:
            detail = ", ".join(f"{name}={status}"
                               for name, status in sorted(by_root.items()))
            problems.append(
                f"{task_id} status differs between working copies ({detail}) — "
                "the task's own worktree is authoritative; close or re-sync the "
                "stale copy before sealing")
    return problems


def required_tests_exist(base: Path) -> list[str]:
    """A required test that names a file which is not there proves nothing."""
    tasks, _ = _tasks_and_stages(base)
    problems = []
    for task in tasks:
        for entry in task.get("required_tests") or []:
            if not isinstance(entry, dict):
                continue
            rel = str(entry.get("path") or "")
            if rel and not (base / rel).is_file():
                problems.append(
                    f"{task.get('id')} requires test {entry.get('id')!r} at "
                    f"{rel}, which does not exist in the repository")
    return problems


def state_issues(base: Path) -> list[str]:
    checks = (
        decomposition_agrees_with_stages,
        worktrees_agree_on_stages,
        grills_still_ground,
        launches_still_bind,
        required_tests_exist,
    )
    problems = []
    for check in checks:
        try:
            problems.extend(check(base))
        except (Exception, SystemExit) as exc:
            # A check that cannot run is itself worth reporting, and must never
            # take the audit down with it.
            problems.append(f"{check.__name__} could not run: {exc}")
    return problems


def issues(base: Path) -> list[str]:
    return (ignored_escalations(base) + stale_deferrals(base)
            + decayed_lessons(base) + review_drift(base))


def cmd_audit(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if getattr(args, "state", False):
        problems = state_issues(base)
        if not problems:
            print("State: every recorded claim re-derives from the repository.")
            return
        for problem in problems:
            print(f"- {problem}")
        raise SystemExit(
            f"\n{len(problems)} recorded claim(s) disagree with the repository. "
            "These are not advisory: a gate that already passed is resting on "
            "one of them. Fix the cause — do not hand-edit a record to match.")
    problems = issues(base)
    if not problems:
        print("Loop health: clean — escalations routed, deferrals fresh, lessons "
              "live, reviews clustering.")
        return
    for problem in problems:
        print(f"- {problem}")
    print(f"\n{len(problems)} loop-health issue(s). These are advisory: route the "
          "work (refactor story, defer resolve, lesson edit via PR) — do not "
          "silence the audit.")
