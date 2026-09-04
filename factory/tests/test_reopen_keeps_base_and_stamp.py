"""Issue #171: a done-but-unshipped task must stay sealable, and a reopened
task must measure its real delta.

- Re-recording the decomposition (the NEXT task's JIT contract) regenerates
  stages.json; it dropped the done stage's `local_review_stamp`, so `task
  pr-ready` could no longer seal a task whose stage had closed clean.
- `task reopen` popped the stage base, so `stage start` pinned today's HEAD and
  the reopened stage measured an EMPTY diff for work already on the branch —
  it could neither close nor seal. Reopen now keeps the base (or takes
  `--base`), `stage start` pins it, and an active stage that closed
  `--incomplete` may be reopened.
"""
from __future__ import annotations

import json

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    DECOMP, git, head, intake, record_skeleton_then_frontier, repo, run, save_plan,
    sign_off, skeletal_stage_task, write_stages,
)
from factory_lib import load_json, protected_decomposition_state_path  # noqa: E402
from forge_cli.stages import load_stages, task_digest  # noqa: E402

__all__ = ["repo"]


def _stage(repo, task_id: str) -> dict:
    return next(s for s in load_stages(repo)["stages"] if s["id"] == task_id)


def test_re_recording_the_decomposition_keeps_a_done_stage_seal_tokens(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(
        repo, [skeletal_stage_task("T1"), skeletal_stage_task("T2")])
    stamp = {"score": 9, "brief_sha256": "b" * 64, "product_tree_digest": "p" * 64}
    recorded = load_json(protected_decomposition_state_path(repo), default={})
    t1_contract = next(t for t in recorded["tasks"] if t["id"] == "T1")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "done",
             "task_sha256": task_digest(t1_contract),
             "base_sha": "c" * 40, "local_review_stamp": stamp,
             "contract_changed": {"from": "a" * 64, "to": "b" * 64}},
            {"id": "T2", "title": "second", "status": "pending"},
        ],
    })
    # Author the next task's contract: the decomposition is re-recorded.
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [skeletal_stage_task("T1"),
                             {**skeletal_stage_task("T2"), "title": "second slice"}]}))
    assert code == 0, out
    t1 = _stage(repo, "T1")
    assert t1["status"] == "done"
    assert t1["local_review_stamp"] == stamp
    assert t1["contract_changed"] == {"from": "a" * 64, "to": "b" * 64}
    assert t1["base_sha"] == "c" * 40


def test_reopen_keeps_the_base_and_stage_start_pins_it(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [skeletal_stage_task("T1")])
    original_base = head(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-q", "-m", "T1 work")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "done", "task_sha256": "abc",
             "base_sha": original_base, "local_review_stamp": {"score": 9}},
        ],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code == 0 and "Reopened" in out, out
    t1 = _stage(repo, "T1")
    assert t1["status"] == "pending"
    assert t1["reopen_base_sha"] == original_base
    assert "base_sha" not in t1

    # An explicit --base wins and must be an ancestor of HEAD.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "first", "status": "done", "task_sha256": "abc"}],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--base", "deadbeef")
    assert code != 0 and "not a commit" in out, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "first", "status": "done", "task_sha256": "abc"}],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1", "--base", original_base)
    assert code == 0, out
    assert _stage(repo, "T1")["reopen_base_sha"] == original_base


def test_reopen_accepts_an_active_stage_that_closed_incomplete(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [skeletal_stage_task("T1")])
    base_sha = head(repo)
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "active", "task_sha256": "abc",
             "base_sha": base_sha, "incomplete": "empty diff after a reopen"},
        ],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code == 0 and "Reopened" in out, out
    assert _stage(repo, "T1")["status"] == "pending"
    assert _stage(repo, "T1")["reopen_base_sha"] == base_sha

    # A plainly active stage (no incomplete marker) still refuses.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "first", "status": "active", "task_sha256": "abc"}],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code != 0 and "not done" in out, out
