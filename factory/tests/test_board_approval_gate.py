"""A task plan is approved only after the board put it in front of a human.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

The rule already existed in words: the human reviews the plan on the BOARD, not
in chat. Words were all there was. `forge next` announced that the plan "is now
visible on the board" without checking one was running and without naming its
address, and `task approve` accepted the approval with no evidence anyone had
opened it — it checked a fresh passing grill and a non-empty `--by`, and that
was the whole gate. So a session did exactly what it was told, asked in chat,
and the plan was approved by someone who never saw it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _lib(repo: Path):
    return load_factory_lib(repo)


def test_a_view_is_recorded_against_the_exact_text(repo: Path):
    # Digest-keyed, not a boolean: "they saw the plan" must not survive an
    # edit. Approving text nobody read is the defect whether the reading never
    # happened or happened to a different draft.
    lib = _lib(repo)
    assert not lib.plan_was_viewed(repo, "ENG-1", "T1", "abc123")

    lib.record_plan_view(repo, "ENG-1", "T1", "abc123")
    assert lib.plan_was_viewed(repo, "ENG-1", "T1", "abc123")
    assert not lib.plan_was_viewed(repo, "ENG-1", "T1", "def456")

    # A later edit supersedes; the old digest stops counting.
    lib.record_plan_view(repo, "ENG-1", "T1", "def456")
    assert lib.plan_was_viewed(repo, "ENG-1", "T1", "def456")
    assert not lib.plan_was_viewed(repo, "ENG-1", "T1", "abc123")

    # Other tasks are unaffected by this one being read.
    assert not lib.plan_was_viewed(repo, "ENG-1", "T2", "def456")


def test_the_record_is_local_and_uncommitted(repo: Path):
    # "This human saw this plan" is true of one machine at one moment. Carried
    # in a commit it would approve on someone else's behalf on every clone.
    lib = _lib(repo)
    lib.record_plan_view(repo, "ENG-1", "T1", "abc123")
    path = lib.board_views_path(repo)
    assert path.is_file()
    control = Path(git(repo, "rev-parse", "--absolute-git-dir"))
    assert control in path.parents, "the view record must live outside the tree"


def test_repeated_polling_does_not_grow_the_record(repo: Path):
    # The drawer re-fetches every few seconds while it is open. An append-only
    # ledger of the same fact would be thousands of entries by the time anyone
    # approved.
    lib = _lib(repo)
    for _ in range(25):
        lib.record_plan_view(repo, "ENG-1", "T1", "abc123")
    views = json.loads(lib.board_views_path(repo).read_text(encoding="utf-8"))
    assert list(views) == ["ENG-1/T1"]
    assert views["ENG-1/T1"]["digest"] == "abc123"


def test_the_board_records_only_a_plan_it_actually_released(repo: Path):
    """A plan withheld from the board must not count as seen.

    `task_plan_view` sends the plan body only once the grill is clean and
    fresh; an ungrilled or stale plan is withheld entirely. The recorder keys
    off that same released payload, so the two can never disagree about what
    the human could read.
    """
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.board import _record_plan_views  # noqa: E402

    lib = _lib(repo)
    plan = lib.evidence_path(repo, "ENG-1", "task-plans/T1.md", for_write=True)
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# T1\n\nThe body.\n", encoding="utf-8")
    digest = lib.plan_digest_without_assumptions(plan)
    relative = plan.relative_to(repo).as_posix()

    # Withheld: the board never sent it, so it was never read.
    for state in ("none", "ungrilled", "stale"):
        _record_plan_views(repo, "ENG-1", {"tasks": [
            {"id": "T1", "plan_state": state, "plan_path": relative}]})
        assert not lib.plan_was_viewed(repo, "ENG-1", "T1", digest), state

    # Released: the text left the server for a reader.
    _record_plan_views(repo, "ENG-1", {"tasks": [{
        "id": "T1", "plan_state": "clean", "plan": plan.read_text(
            encoding="utf-8"), "plan_path": relative}]})
    assert lib.plan_was_viewed(repo, "ENG-1", "T1", digest)


def test_a_broken_payload_never_takes_the_board_down(repo: Path):
    # The gate refusing an approval is recoverable. A board that 500s while the
    # human is trying to read the plan is the thing that would push the review
    # back into chat.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.board import _record_plan_views  # noqa: E402

    _record_plan_views(repo, "ENG-1", None)
    _record_plan_views(repo, "ENG-1", {})
    _record_plan_views(repo, "ENG-1", {"tasks": "not a list"})
    _record_plan_views(repo, "ENG-1", {"tasks": [
        {"id": "T1", "plan_state": "clean", "plan": "x",
         "plan_path": "does/not/exist.md"}]})


def test_forge_next_hands_over_the_address(repo: Path):
    # Saying "it is on the board" without a link is what left the human with
    # nothing to open, so the review happened in chat.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.phase import _board_handoff  # noqa: E402

    handoff = _board_handoff(repo)
    assert "http://127.0.0.1:" in handoff
    # And it must say so plainly when nothing is serving, rather than claiming
    # the plan is visible somewhere the human cannot reach.
    assert "NO BOARD IS RUNNING" in handoff or "board is running" in handoff

    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py"
              ).read_text(encoding="utf-8")
    step = source[source.index("plan is ready for review"):][:900]
    assert "GIVE THE HUMAN THAT LINK" in step
    assert "REFUSED" in step, "the step must say the approval is gated"


def test_the_board_port_is_named_once(repo: Path):
    # Two copies of the address is how `forge next` would come to point
    # somewhere the board is not.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.board import DEFAULT_PORT  # noqa: E402

    forge = (HARNESS / "factory" / "scripts" / "forge.py").read_text(
        encoding="utf-8")
    assert "default=board_mod.DEFAULT_PORT" in forge
    assert "default=8765" not in forge
    assert isinstance(DEFAULT_PORT, int)


def test_approve_refuses_until_the_board_has_shown_the_plan(repo: Path, tmp_path):
    """The gate itself, end to end — the thing guidance could not do.

    A grilled, converged, digest-fresh plan is still not approvable until the
    board has put that text in front of someone. This is the case that
    happened: the coordinator was told the plan was "visible on the board",
    no board was running, and the approval was recorded anyway.
    """
    from test_gates import (  # noqa: E402
        STAGE_TASK, intake, record_skeleton_then_frontier, record_task_grill,
        save_plan, sign_off, view_plan_on_board,
    )

    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out

    code, out = run(
        repo, "forge.py", "task", "approve", "T1", "--by", "Test Human")
    assert code != 0, f"approved a plan nobody opened:\n{out}"
    assert "has not been opened on the board" in out
    # The refusal has to say what to DO, or it just moves the confusion.
    assert "./forge board" in out

    # And it must be satisfiable the moment the human actually looks.
    view_plan_on_board(repo, "T1")
    code, out = run(
        repo, "forge.py", "task", "approve", "T1", "--by", "Test Human")
    assert code == 0, out
    assert "Approved task plan" in out


def test_an_edit_after_the_human_looked_needs_a_second_look(repo: Path, tmp_path):
    # A view recorded against the old text must not approve new text: that is
    # the same defect as never looking, just harder to notice.
    from test_gates import (  # noqa: E402
        STAGE_TASK, intake, record_skeleton_then_frontier, record_task_grill,
        save_plan, sign_off, story_state, view_plan_on_board,
    )

    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out
    view_plan_on_board(repo, "T1")

    saved = story_state(repo) / "task-plans" / "T1.md"
    saved.write_text(saved.read_text(encoding="utf-8") + "\nEdited after.\n",
                     encoding="utf-8")

    code, out = run(
        repo, "forge.py", "task", "approve", "T1", "--by", "Test Human")
    assert code != 0, f"approved text the human never saw:\n{out}"
