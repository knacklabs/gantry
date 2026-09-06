"""The whole lifecycle, replayed from the story that motivated all of it.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

WF-1 T1's handover recorded what it cost: ~20 task-grill rounds, 50 Codex jobs,
26 interruptions of the human. Its own diagnosis named three causes — the
freshness chain, batching findings badly, and a large task. The first is the
harness's, and this replays it end to end with the real commands: approve,
open the stage, deliver, come back for the fix round, and reach the PR without
the human being asked anything they had already decided.

The unit tests prove each gate. This proves they compose — that fixing the
grill did not open the approval, and gating interruptions did not block the
work.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import (  # noqa: F401
    HARNESS, STAGE_TASK, fake_companion_env, git, intake, load_factory_lib,
    record_skeleton_then_frontier, record_task_grill, repo, run, save_plan,
    sign_off, story_state, view_plan_on_board,
)

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _stop_hook(repo: Path, payload: dict | None = None) -> dict:
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "stop_continue.py")],
        cwd=repo, input=json.dumps(payload or {}), capture_output=True,
        text=True)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"continue": True}


def test_approval_to_pr_without_asking_the_human_anything_settled(
        repo: Path, tmp_path):
    """The run the handover describes, with every gate in place."""
    lib = load_factory_lib(repo)

    # ---- planning: the human is in the loop, and questions are free --------
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    assert _stop_hook(repo).get("continue") is True, (
        "the gate must not touch planning")

    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out

    # ---- approval: only after the board actually showed the plan ----------
    code, out = run(repo, "forge.py", "task", "approve", "T1",
                    "--by", "Nandu")
    assert code != 0 and "has not been opened on the board" in out, out
    view_plan_on_board(repo, "T1")
    code, out = run(repo, "forge.py", "task", "approve", "T1",
                    "--by", "Nandu")
    assert code == 0, out

    # ---- the stage opens: from here the run is the agent's ----------------
    code, out = run(repo, "forge.py", "stage", "start", "T1", "--trunk")
    assert code == 0, out
    assert _stop_hook(repo).get("decision") == "block", (
        "the agent may not stop between approval and the PR")

    # ---- delivery: the implementation lands and is committed --------------
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "delivered.ts").write_text(
        "export const built = true;\n", encoding="utf-8")
    # Only the product file: `-A` sweeps in .factory/events/*.json, which the
    # harness may still hold open on Windows.
    git(repo, "add", "src/delivered.ts")
    git(repo, "commit", "-qm", "T1: the implementation lands")

    # ---- the fix round: THE loop. No re-grill, no re-approval. ------------
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, (
        "committing the implementation still blocks the fix round:\n" + out)

    # ---- the budget: raised, recorded, never a question -------------------
    from factory_lib import (  # noqa: E402
        dump_json, load_json, protected_decomposition_state_path,
    )
    path = protected_decomposition_state_path(repo)
    decomposition = load_json(path, default={})
    for entry in decomposition.get("tasks", []):
        if entry.get("id") == "T1":
            entry["review_budget"] = {"max_changed_files": 58,
                                      "max_changed_lines": 3600,
                                      "reason": "measured after implementing"}
    dump_json(path, decomposition)
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, ("raising the review budget still costs a grill:\n" + out)

    # ---- the interruption it must refuse ----------------------------------
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "should the review budget go from 38 to 58 or "
                              "should the task be split",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code != 0 and "ceiling on runaway scope" in out, out

    # ---- the interruption it must allow -----------------------------------
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "the client has never stated which designations "
                              "count as licensed for Form-A validation",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out
    assert _stop_hook(repo).get("continue") is True, (
        "a genuine missing decision must reach the human")

    # ---- and the escalation is spent, not a standing pass ------------------
    assert _stop_hook(repo).get("decision") == "block", (
        "one escalation authorised more than one interruption")


def test_a_change_to_what_was_agreed_still_reaches_the_human(repo: Path,
                                                             tmp_path):
    """The other direction: autonomy must not swallow a real change.

    The plan the human approved was edited twice after approval in the story
    this comes from — once cosmetically, once adding an `asOf` instant to a
    published contract. The second is a design change to something already
    signed off, and it must not be clearable by an agent re-grilling.
    """
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out
    view_plan_on_board(repo, "T1")
    code, out = run(repo, "forge.py", "task", "approve", "T1", "--by", "Nandu")
    assert code == 0, out

    saved = story_state(repo) / "task-plans" / "T1.md"
    saved.write_text(
        saved.read_text(encoding="utf-8")
        + "\nThe query now takes an `asOf` instant.\n", encoding="utf-8")

    code, out = run(repo, "forge.py", "task", "approve", "T1", "--by", "Nandu")
    assert code != 0, out
    assert "CHANGED after" in out and "Nandu" in out
    assert "does not need another grill" in out


def test_widening_the_scope_still_stops_the_next_delegate(repo: Path, tmp_path):
    # Autonomy is not permission. What the task may touch is the boundary the
    # human approved, and moving it re-opens the gate.
    from test_gates import start_stage  # noqa: E402
    from factory_lib import (  # noqa: E402
        dump_json, load_json, protected_decomposition_state_path,
    )

    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    path = protected_decomposition_state_path(repo)
    decomposition = load_json(path, default={})
    for entry in decomposition.get("tasks", []):
        if entry.get("id") == "T1":
            entry["write_scope"] = list(entry.get("write_scope") or []) + ["apps/"]
    dump_json(path, decomposition)

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0, f"a widened write scope no longer stops delegate:\n{out}"
