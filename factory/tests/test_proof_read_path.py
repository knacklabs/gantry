"""Per-task proof is visible to the readers, not only to the writers.

`forge task start` stamps `task_id` into the worktree's run pointer, and the
recorders resolve through `proof_path`, so a per-task run records verify.json
and tests.json under `.factory/stories/<story>/tasks/<task>/`. The ship gate
and `check_task_proof` already read task-first with a story fallback. Five
other readers did not: `forge review`, the board, the phase summary, the stage
rows and the review brief resolved story-only, so each of them looked where a
per-task run never writes. `forge review <task>` failed with "verify.json is
not recorded" while both files sat on disk, recorded minutes earlier.

`proof_read_path` is the reader-side counterpart: the task's copy when a task
owns the run and has recorded one, the story's otherwise. The fallback is what
keeps story-level runs and older stories working unchanged.
"""
from __future__ import annotations

import json

from test_gates import repo  # noqa: I001 — puts factory/scripts on sys.path
from factory_lib import (  # noqa: E402
    evidence_path, proof_read_path, run_state_path, task_evidence_path,
)

__all__ = ["repo"]

STORY = "STORY-1"
TASK = "STORY-1-T1"


def _point_at(root, **fields):
    path = run_state_path(root, STORY, for_write=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {}
    if path.is_file():
        state = json.loads(path.read_text(encoding="utf-8"))
    state.update(fields)
    path.write_text(json.dumps(state), encoding="utf-8")


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_a_task_run_reads_the_task_copy(repo):
    _point_at(repo, story=STORY, task_id=TASK)
    _write(task_evidence_path(repo, STORY, TASK, "verify.json"), {"scope": "task"})
    _write(evidence_path(repo, STORY, "verify.json"), {"scope": "story"})

    resolved = proof_read_path(repo, STORY, "verify.json")

    assert json.loads(resolved.read_text(encoding="utf-8")) == {"scope": "task"}


def test_a_task_run_falls_back_to_the_story_copy(repo):
    """A task that has not recorded its own proof still sees the story's."""
    _point_at(repo, story=STORY, task_id=TASK)
    _write(evidence_path(repo, STORY, "tests.json"), {"scope": "story"})

    resolved = proof_read_path(repo, STORY, "tests.json")

    assert json.loads(resolved.read_text(encoding="utf-8")) == {"scope": "story"}


def test_a_story_run_never_reaches_for_task_proof(repo):
    """No task stamp means the story's copy, even when a task copy exists."""
    _point_at(repo, story=STORY, task_id="")
    _write(task_evidence_path(repo, STORY, TASK, "verify.json"), {"scope": "task"})
    _write(evidence_path(repo, STORY, "verify.json"), {"scope": "story"})

    resolved = proof_read_path(repo, STORY, "verify.json")

    assert json.loads(resolved.read_text(encoding="utf-8")) == {"scope": "story"}
