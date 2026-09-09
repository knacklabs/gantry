"""`task reopen --review-fix`: a done stage goes back to active for review fixes.

`forge review` tells the coordinator to delegate the fixes, but delegate writes
only inside an active stage and a done stage never reopened; the heavy
`task reopen` resets the stage to pending and stales the plan approval, which
is a re-grill for an unchanged contract. ASKFLOOR-1-T5a spent six degraded
windows on review fixes for that reason.

The light reopen keeps the stage's identity (base, contract digest, start
time) so `stage done` still measures the task's real delta, and drops only the
stage-local review stamp, which is bound to the pre-fix tree.
"""
from __future__ import annotations

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    git, head, intake, record_skeleton_then_frontier, repo, run, save_plan,
    sign_off, skeletal_stage_task, write_stages,
)
from forge_cli.stages import load_stages  # noqa: E402

__all__ = ["repo"]


def _stage(repo, task_id: str) -> dict:
    return next(s for s in load_stages(repo)["stages"] if s["id"] == task_id)


def _done_t1(repo, tmp_path) -> str:
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(
        repo, [skeletal_stage_task("T1"), skeletal_stage_task("T2")])
    base = head(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-q", "-m", "T1 work")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "done", "task_sha256": "abc",
             "started_at": "2026-09-09T00:00:00+00:00", "base_sha": base,
             "dirty_at_start": {}, "completed_at": "2026-09-09T01:00:00+00:00",
             "local_review_stamp": {"score": 9}},
            {"id": "T2", "title": "second", "status": "pending"},
        ],
    })
    return base


def test_review_fix_reopen_keeps_identity_and_drops_only_the_stamp(repo, tmp_path):
    base = _done_t1(repo, tmp_path)
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--review-fix")
    assert code == 0 and "review fix (round 1)" in out, out
    t1 = _stage(repo, "T1")
    assert t1["status"] == "active"
    assert t1["base_sha"] == base
    assert t1["task_sha256"] == "abc"
    assert t1["started_at"] == "2026-09-09T00:00:00+00:00"
    assert "local_review_stamp" not in t1
    assert "completed_at" not in t1
    assert t1["review_fix_count"] == 1
    assert _stage(repo, "T2")["status"] == "pending"

    # A second review round reopens again and counts.
    t1["status"] = "done"
    t1["local_review_stamp"] = {"score": 8}
    data = load_stages(repo)
    data["stages"][0] = t1
    write_stages(repo, data)
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--review-fix")
    assert code == 0 and "round 2" in out, out
    assert _stage(repo, "T1")["review_fix_count"] == 2


def test_review_fix_reopen_refuses_a_stage_that_is_not_done(repo, tmp_path):
    _done_t1(repo, tmp_path)
    data = load_stages(repo)
    data["stages"][0]["status"] = "active"
    write_stages(repo, data)
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--review-fix")
    assert code != 0 and "not done" in out, out


def test_review_fix_reopen_refuses_when_a_later_stage_built_on_it(repo, tmp_path):
    _done_t1(repo, tmp_path)
    data = load_stages(repo)
    data["stages"][1]["status"] = "active"
    write_stages(repo, data)
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--review-fix")
    assert code != 0 and "T2 already built on it" in out, out
    assert _stage(repo, "T1")["status"] == "done"
