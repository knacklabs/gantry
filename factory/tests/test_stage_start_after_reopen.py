"""`stage start` on a reopened task pins the stage ref to the base the task's
work started from (#171 follow-up: the first cut called `.returncode` on a
helper that returns stdout, and crashed the first real `stage start`)."""
from __future__ import annotations

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    STAGE_TASK, git, head, record_task_grill, repo, run, start_stage,
    write_in_scope, write_stages,
)
from forge_cli.stages import load_stages  # noqa: E402

__all__ = ["repo"]


def test_stage_start_pins_a_reopened_base_and_measures_the_real_delta(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    original = git(repo, "rev-parse", "refs/forge/stage/T1")
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "the task's work")
    worked = head(repo)

    # The stage closed done (fixture), then something moved HEAD on the branch.
    data = load_stages(repo)
    stage = next(s for s in data["stages"] if s["id"] == "T1")
    stage.update({"status": "done", "local_review_stamp": {"score": 9}})
    write_stages(repo, data)
    (repo / "NOTES.md").write_text("later commit\n")
    git(repo, "add", "NOTES.md")
    git(repo, "commit", "-qm", "later, unrelated")

    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code == 0 and "Reopened" in out, out
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0 and "Stage baseline restored" in out, out
    assert git(repo, "rev-parse", "refs/forge/stage/T1") == original
    delta = git(repo, "diff", "--name-only", f"{original}..HEAD").splitlines()
    assert "src/core.py" in delta and worked != original

    # A reopened base that is not an ancestor falls back to HEAD with a warning.
    data = load_stages(repo)
    stage = next(s for s in data["stages"] if s["id"] == "T1")
    stage.update({"status": "done", "local_review_stamp": {"score": 9}})
    write_stages(repo, data)
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code == 0, out
    data = load_stages(repo)
    next(s for s in data["stages"] if s["id"] == "T1")["reopen_base_sha"] = "0" * 40
    write_stages(repo, data)
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0 and "not an ancestor of HEAD" in out, out
    assert git(repo, "rev-parse", "refs/forge/stage/T1") == head(repo)
