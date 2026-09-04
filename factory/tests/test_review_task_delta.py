"""Per-task review measures the TASK's delta and carries the lessons in force.

Two 2026-09-04 defects from the first per-task review on a client repo:
- the trunk had been merged into the task branch after the stage began, and
  `forge review` diffed from the stage's recorded base, so the bundle carried
  the whole vendored-harness delta, chunked into three passes, scored 0 on
  findings against code the task never touched, and recorded every contract
  as `partial` because the chunked reviewer never reached the verdict lines;
- the brief carried no lessons, so the reviewer re-raised as P1 the exact
  behaviour a recorded lesson pins as deliberate.
"""
from __future__ import annotations

import json

import pytest

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    DECOMP, git, head, intake, repo, run, save_plan, sign_off, skeletal_stage_task,
    task_skeleton,
)
from forge_cli.review import resolve_review_base  # noqa: E402

__all__ = ["repo"]


def _commit(repo, name: str, content: str) -> str:
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(content)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", f"add {name}")
    return head(repo)


def test_review_base_advances_past_a_trunk_merged_after_the_stage_began(repo):
    recorded = head(repo)                       # the stage's recorded base
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-T1")
    task_commit = _commit(repo, "src/task.py", "task work\n")

    # No trunk merge: the recorded base stands.
    assert resolve_review_base(repo, {"base_sha": recorded}, {}, head(repo)) == recorded

    # The trunk moves and is merged INTO the task branch.
    git(repo, "checkout", "-q", "-b", "trunk-work", recorded)
    trunk_commit = _commit(repo, "factory/vendored.py", "harness delta\n")
    git(repo, "update-ref", "refs/remotes/origin/main", trunk_commit)
    git(repo, "checkout", "-q", "feat/ENG-1-T1")
    git(repo, "merge", "-q", "--no-edit", "origin/main")
    tip = head(repo)

    advanced = resolve_review_base(repo, {"base_sha": recorded}, {}, tip)
    assert advanced == trunk_commit
    # The reviewed delta is the task's own work only.
    delta = git(repo, "diff", "--name-only", f"{advanced}...{tip}").splitlines()
    assert delta == ["src/task.py"]
    assert task_commit != tip

    # A trunk that moved WITHOUT being merged does not move the base.
    git(repo, "checkout", "-q", "trunk-work")
    unmerged = _commit(repo, "factory/later.py", "later\n")
    git(repo, "update-ref", "refs/remotes/origin/main", unmerged)
    git(repo, "checkout", "-q", "feat/ENG-1-T1")
    assert resolve_review_base(repo, {"base_sha": recorded}, {}, tip) == trunk_commit

    # A recorded base that is not an ancestor of HEAD is refused, not guessed.
    with pytest.raises(SystemExit):
        resolve_review_base(repo, {"base_sha": unmerged}, {}, tip)


def test_review_base_advances_when_the_recorded_base_is_a_branch_commit(repo):
    """A story branch carried planning commits BEFORE the stage started, so the
    recorded base is a branch commit — neither ancestor nor descendant of the
    trunk point once the trunk is merged in. The trunk point is still the base:
    the branch's own delta since divergence is reviewed, never the trunk's."""
    fork = head(repo)
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-story")
    _commit(repo, "plans/story-plan.md", "planning\n")
    recorded = head(repo)                       # stage started here, on the branch
    _commit(repo, "src/task.py", "task work\n")

    git(repo, "checkout", "-q", "-b", "trunk-work", fork)
    trunk_commit = _commit(repo, "factory/vendored.py", "harness delta\n")
    git(repo, "update-ref", "refs/remotes/origin/main", trunk_commit)
    git(repo, "checkout", "-q", "feat/ENG-1-story")
    git(repo, "merge", "-q", "--no-edit", "origin/main")
    tip = head(repo)

    advanced = resolve_review_base(repo, {"base_sha": recorded}, {}, tip)
    assert advanced == trunk_commit
    delta = sorted(git(repo, "diff", "--name-only", f"{advanced}...{tip}").splitlines())
    assert delta == ["plans/story-plan.md", "src/task.py"]
    assert "factory/vendored.py" not in delta


def test_review_brief_carries_the_lessons_in_force_for_the_task_paths(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**DECOMP["tasks"][0], "id": "T1", "reviewer_focus": "focus one",
             "write_scope": ["src/permission/gate.py", "test/gate_test.py"],
             "plan_contracts": [{"id": "C1", "statement": "first statement",
                                  "source": "plan.md#first"}]}
    second = {**skeletal_stage_task("T2", "second slice"), "dependencies": ["T1"]}
    skeletons = [task_skeleton(first), task_skeleton(second)]
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first, skeletons[1]]}))
    assert code == 0, out

    for topic, applies_to in (
        ("soft rail asks keep classifier eligibility", "src/permission/**"),
        ("unrelated discord lesson", "src/channels/discord/**"),
    ):
        code, out = run(repo, "forge.py", "lesson", "add", "--topic", topic,
                        "--lesson", f"{topic} — pinned by test", "--source", "review r1",
                        "--applies-to", applies_to, "--severity", "high",
                        "--by", "orchestrator", "--repo", str(repo))
        assert code == 0, out

    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code == 0, out
    brief = (repo / out.strip()).read_text()
    assert "### Lessons in force" in brief
    assert "soft rail asks keep classifier eligibility" in brief
    assert "pinned by test" in brief
    assert "unrelated discord lesson" not in brief


def test_review_tip_puts_harness_bookkeeping_back_at_the_task_base(repo, tmp_path):
    from forge_cli.review import product_only_tip

    base_sha = head(repo)
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-T1")
    (repo / "plans" / "exploration").mkdir(parents=True, exist_ok=True)
    (repo / "plans" / "exploration" / "grill-r1.md").write_text("x" * 5000)
    (repo / ".factory" / "stories" / "ENG-1").mkdir(parents=True, exist_ok=True)
    (repo / ".factory" / "stories" / "ENG-1" / "verify.json").write_text("{}")
    _commit(repo, "src/task.py", "task work\n")
    git(repo, "add", "-A", "plans", ".factory")
    git(repo, "commit", "-q", "-m", "planning artifacts")
    tip = head(repo)

    worktree = tmp_path / "review-wt"
    git(repo, "worktree", "add", "--detach", str(worktree), tip)
    review_tip = product_only_tip(worktree, base_sha)
    assert review_tip != tip
    delta = sorted(git(worktree, "diff", "--name-only", f"{base_sha}..{review_tip}").splitlines())
    assert delta == ["src/task.py"]
    # The task branch itself is untouched.
    assert head(repo) == tip
    git(repo, "worktree", "remove", "--force", str(worktree))


def test_review_brief_carries_the_recorded_verification_evidence(repo, tmp_path):
    from test_gates import write_passing_artifacts

    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**DECOMP["tasks"][0], "id": "T1", "reviewer_focus": "focus one",
             "write_scope": ["src/gate.py"],
             "plan_contracts": [{"id": "C1", "statement": "unit suites pass; tsc green",
                                  "source": "plan.md#first"}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [task_skeleton(first)]}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first]}))
    assert code == 0, out
    write_passing_artifacts(repo)

    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code == 0, out
    brief = (repo / out.strip()).read_text()
    assert "### Recorded evidence" in brief
    assert "verify.py: ok" in brief
    assert "automated tests: passed" in brief
