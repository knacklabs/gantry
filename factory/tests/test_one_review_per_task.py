"""One review per task: `forge review` stamps the stage when no lens blocks.

Before: a stage-local autoreview loop had to produce a clean stamp (recorded by
hand through `record_review_from_json.py --aspect stage-local`) before
`stage done`, and the three-lens `forge review` then reviewed the same diff
again with a narrower brief. On ASKFLOOR-1-T5a that was nine stage rounds plus
three lens rounds by the same engine, and the second review contradicted an
approved contract. Now the lens review IS the stamp: a run with no blocking
finding binds itself to the tree, `stage done` and `task pr-ready` seal on it,
and P2 findings are follow-ups that never sink the score below the seal floor.
"""
from __future__ import annotations

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    git, head, intake, record_skeleton_then_frontier, repo, save_plan,
    sign_off, skeletal_stage_task, write_stages,
)
from forge_cli.readiness import MIN_SCORE, review_passed  # noqa: E402
from forge_cli.review import _next_hint, _score  # noqa: E402
from forge_cli.stages import (  # noqa: E402
    load_stages, revoke_stage_review_stamp, stamp_stage_review,
)

__all__ = ["repo"]


def test_non_blocking_findings_never_sink_a_review_below_the_seal_floor():
    assert _score(0, 0) == 10
    assert _score(0, 4) == 8
    assert _score(0, 9) == MIN_SCORE
    assert review_passed({"score": _score(0, 12), "blocking_findings": []})
    assert _score(1, 0) == 7
    assert not review_passed({"score": _score(1, 0), "blocking_findings": ["x"]})


def test_next_hint_names_the_single_loop_for_each_stage_state():
    active_block = _next_hint("T1", "active", 2, 0)
    assert "delegate the fixes" in active_block and "--review-fix" not in active_block
    done_block = _next_hint("T1", "done", 1, 3)
    assert "task reopen T1 --review-fix" in done_block
    assert "lesson add" in done_block
    assert "stage done T1" in _next_hint("T1", "active", 0, 0)
    assert "task pr-ready T1" in _next_hint("T1", "done", 0, 0)
    caveats = _next_hint("T1", "active", 0, 2)
    assert "follow-ups" in caveats and "stamped" in caveats and "defer" in caveats


def _stage(repo, task_id: str) -> dict:
    return next(s for s in load_stages(repo)["stages"] if s["id"] == task_id)


def _story_with_stage(repo, tmp_path, status: str) -> None:
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [skeletal_stage_task("T1")])
    base = head(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-q", "-m", "T1 work")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "first", "status": status,
                    "task_sha256": "abc", "base_sha": base,
                    "started_at": "2026-09-09T00:00:00+00:00", "dirty_at_start": {}}],
    })


def _set_status(repo, status: str) -> None:
    data = load_stages(repo)
    data["stages"][0]["status"] = status
    data["stages"][0].pop("local_review_stamp", None)
    write_stages(repo, data)


def test_stamp_binds_the_current_tree_on_an_active_and_a_done_stage(repo, tmp_path):
    _story_with_stage(repo, tmp_path, "active")
    for status in ("active", "done"):
        _set_status(repo, status)
        stamp = stamp_stage_review(repo, "T1", lenses=("quality", "performance", "security"))
        recorded = _stage(repo, "T1")["local_review_stamp"]
        assert recorded == stamp
        assert recorded["stage_id"] == "T1"
        assert recorded["generated_by"] == "autoreview"
        assert recorded["lenses"] == ["quality", "performance", "security"]
        assert len(recorded["product_tree_digest"]) == 64
        assert _stage(repo, "T1")["status"] == status


def test_stamp_refuses_a_pending_stage(repo, tmp_path, capsys):
    _story_with_stage(repo, tmp_path, "active")
    _set_status(repo, "pending")
    try:
        stamp_stage_review(repo, "T1")
    except SystemExit:
        assert "only an active or done stage" in capsys.readouterr().out
    else:
        raise AssertionError("a pending stage took a review stamp")
    assert "local_review_stamp" not in _stage(repo, "T1")


def test_a_blocking_review_revokes_an_earlier_clean_stamp(repo, tmp_path):
    _story_with_stage(repo, tmp_path, "active")
    stamp_stage_review(repo, "T1", lenses=("quality", "performance", "security"))
    assert "local_review_stamp" in _stage(repo, "T1")
    assert revoke_stage_review_stamp(repo, "T1") is True
    assert "local_review_stamp" not in _stage(repo, "T1")
    assert revoke_stage_review_stamp(repo, "T1") is False
