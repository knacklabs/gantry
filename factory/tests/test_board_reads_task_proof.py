"""The board reads a task's own proof.

Proof became task-owned (tasks/<id>/verify.json, tests.json) and the review
became one selected generation (0069); the board kept reading story-level
fixed files and showed every task-level story's five gate rows as "not
recorded" (WF-1A, 2026-09-15). The story rows now roll up from the tasks and
the drawer lists each task's own record.
"""
from __future__ import annotations

import sys

from test_gates import HARNESS, repo  # noqa: F401
from test_review_lenses_in_parallel import _built, _fake_skill

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from forge_cli.board import rolled_up_evidence, story_detail, task_proof_records  # noqa: E402
from forge_cli.review import review_task  # noqa: E402


def test_the_board_reads_task_level_proof_and_the_selected_generation(repo, tmp_path):
    _built(repo, tmp_path)
    review_task(repo, "T1", skill=str(_fake_skill(tmp_path)), engine="claude")

    proof = task_proof_records(repo, "ENG-1", "T1")
    assert proof["verify"]["ok"] is True
    assert proof["tests"]["automated"]["status"] == "passed"
    assert {aspect: record["score"] for aspect, record in proof["reviews"].items()} == {
        "quality": 10, "performance": 10, "security": 10}
    assert "contract_verdicts" in proof["reviews"]["quality"]

    detail = story_detail(repo, "ENG-1")
    assert detail is not None
    evidence = detail["evidence"]
    # No story-level files exist for a task-level run; the rows come from T1.
    assert list(evidence["task_proof"]) == ["T1"]
    assert evidence["verify"] == {"ok": True, "tasks": {"T1": True}}
    assert evidence["tests"]["automated"]["status"] == "passed"
    assert evidence["reviews"]["quality"]["score"] == 10
    assert evidence["reviews"]["quality"]["summary"].startswith("T1: ")
    task = next(item for item in detail["tasks"] if item["id"] == "T1")
    assert task["proof"]["verify_ok"] is True


def test_a_story_row_passes_only_when_every_task_recorded_and_passed():
    clean = {"score": 10, "blocking_findings": [], "non_blocking_findings": [], "summary": "fine"}
    decomposition = {"tasks": [{"id": "T1"}, {"id": "T2"}]}
    one_of_two = {"T1": {"verify": {"ok": True}, "tests": {"automated": {"status": "passed"}},
                         "reviews": {"quality": clean, "performance": clean, "security": clean}}}
    rolled = rolled_up_evidence(one_of_two, decomposition)
    assert rolled["verify"]["ok"] is False and rolled["verify"]["tasks"] == {"T1": True}
    assert rolled["tests"]["automated"]["status"] == "incomplete"
    assert rolled["reviews"]["quality"]["score"] == 7  # below the seal floor until T2 records

    both = dict(one_of_two, T2={"verify": {"ok": True}, "tests": {"automated": {"status": "passed"}},
                                "reviews": {"quality": {**clean, "score": 9}, "performance": clean,
                                            "security": clean}})
    rolled = rolled_up_evidence(both, decomposition)
    assert rolled["verify"]["ok"] is True
    assert rolled["tests"]["automated"]["status"] == "passed"
    assert rolled["reviews"]["quality"]["score"] == 9  # the lowest task's record is shown
    assert rolled["reviews"]["quality"]["summary"] == "T1: fine; T2: fine"
