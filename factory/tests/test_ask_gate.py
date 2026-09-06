"""Asking the human is gated once the plan is approved and a stage is open.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

Every other fix removes REASONS to stop. This is the only one that gates the
act of stopping, which is why it exists: the rule about which interruptions the
orchestrator settles itself was written down in WORKFLOW.md and ignored, and 19
of one story's 26 interruptions were mechanical anyway. Prose does not bind.

Deliberately an allow-list of DENIALS. A reason the harness cannot self-answer
passes — after the challenge — because a novel situation probably does need the
human. It is recorded, so a repeated one becomes a number rather than an
impression formed over eighteen rounds.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, post_hook, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _ask_payload() -> dict:
    return {
        "tool_name": "AskUserQuestion",
        "tool_input": {"questions": [{
            "question": "Raise the budget to 58, or split the task?",
            "options": [{"label": "Raise"}, {"label": "Split"}],
        }]},
    }


def _open_a_stage(repo: Path) -> None:
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "stages.json",
                  {"stages": [{"id": "T1", "status": "active"}]})


def _pre_hook(repo: Path, payload: dict):
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "pre_tool_use.py")],
        cwd=repo, input=json.dumps(payload), capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def test_asking_is_free_while_the_plan_is_still_being_made(repo: Path):
    # No stage open: this is planning, which is exactly where questions belong.
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out


def test_asking_is_denied_once_a_stage_is_open(repo: Path):
    """The stop the human never should have seen.

    The question in the payload is the real one from a shipped story: "raise
    the budget to 58, or split?" — asked mid-implementation, answered by the
    human, and answerable from the contract the whole time.
    """
    _open_a_stage(repo)
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' in out, out
    # The refusal must carry the answer, not just the refusal.
    assert "review budget ceiling" in out or "review budget" in out
    assert "CONTINUE" in out
    # And it must name the way through, or it is a wall.
    assert "signal escalate" in out
    assert "--missing-decision" in out


def test_a_recorded_escalation_lets_the_question_through(repo: Path):
    # The gate must be satisfiable, or a genuine question can never be asked.
    _open_a_stage(repo)
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "the client has never stated which designations "
                              "count as licensed",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out

    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out


def test_one_escalation_authorises_one_question(repo: Path):
    # Otherwise the first genuine question buys unlimited interruptions.
    _open_a_stage(repo)
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "nobody has decided the retention period for "
                              "archived worker documents",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out

    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' in out, "the escalation was not spent"


def test_a_self_answerable_reason_is_refused_with_the_answer(repo: Path):
    """The stress. A stop it cannot honestly write down is a stop it cannot make."""
    for missing, expect in (
        ("should we raise the review budget from 38 to 58 files or split",
         "ceiling on runaway scope"),
        ("pnpm-lock.yaml is outside the write scope but the work needs it",
         "scope completion"),
        ("pnpm install is blocked by the sandbox network policy",
         "documented path"),
    ):
        code, out = run(
            repo, "forge.py", "signal", "escalate",
            "--missing-decision", missing,
            "--checked", "contract,plan,constitution,decisions,lessons")
        assert code != 0, f"escalated something answerable: {missing}"
        assert expect in out, out


def test_it_must_say_where_it_already_looked(repo: Path):
    # "I need input" is not a missing decision. Naming the five sources is the
    # cheap part when the question is real and the impossible part when it is
    # not.
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "nobody has decided the archive retention period")
    assert code != 0
    assert "where you already looked" in out
    assert "contract" in out and "lessons" in out


def test_a_vague_escalation_is_refused(repo: Path):
    code, out = run(repo, "forge.py", "signal", "escalate",
                    "--missing-decision", "need input",
                    "--checked", "contract,plan,constitution,decisions,lessons")
    assert code != 0
    assert "NAME the decision" in out


def test_a_novel_reason_passes_and_is_recorded(repo: Path):
    """The shape the human asked for: deny what is known, let the rest through.

    A permit-list would block the genuine cases nobody foresaw, which is worse
    than letting a novel stop reach the human once. It is recorded, so the
    second time it is a number instead of a surprise.
    """
    _open_a_stage(repo)
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "no decision covers whether a transferred worker "
                              "keeps their employee code across organisations",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out

    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.signal import escalations_path  # noqa: E402
    records = [json.loads(line) for line in
               escalations_path(repo).read_text(encoding="utf-8").splitlines()
               if line.strip()]
    assert records and records[-1]["missing_decision"].startswith("no decision")
    assert set(records[-1]["checked"]) == {
        "contract", "plan", "constitution", "decisions", "lessons"}


def test_the_gate_never_breaks_the_session(repo: Path):
    # A gate that crashes on unreadable state would make the harness unusable;
    # it must fail open, because the cost of a missed stop is one interruption
    # and the cost of a broken hook is the whole session.
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    (control / "stages.json").write_text("{not json", encoding="utf-8")
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out


# --------------------------------------------------------------- stop gate --
def _stop_hook(repo: Path, payload: dict | None = None):
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "stop_continue.py")],
        cwd=repo, input=json.dumps(payload or {}), capture_output=True,
        text=True)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"continue": True}


def test_ending_the_turn_is_refused_mid_task(repo: Path):
    """The exit a pre-tool gate cannot close.

    Nothing stops an agent ending its turn and asking in prose instead of
    through the question tool. Until this hook blocked, that was the whole
    gate's back door.
    """
    _open_a_stage(repo)
    result = _stop_hook(repo)
    assert result.get("decision") == "block", result
    assert "Do not stop here" in result.get("reason", "")
    assert "signal escalate" in result["reason"]
    # It must say what to do next, or it is a wall.
    assert "forge next" in result["reason"]


def test_ending_the_turn_is_free_during_planning(repo: Path):
    # No stage open means the plan is still being made, which is exactly where
    # the human belongs.
    assert _stop_hook(repo).get("continue") is True


def test_an_escalation_lets_the_turn_end(repo: Path):
    _open_a_stage(repo)
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "nobody has decided whether a transferred worker "
                              "keeps their employee code",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out
    assert _stop_hook(repo).get("continue") is True


def test_the_hook_never_loops_the_session(repo: Path):
    # Claude Code sets stop_hook_active after it has blocked once. Ignoring it
    # would trap an agent that cannot satisfy the gate.
    _open_a_stage(repo)
    assert _stop_hook(repo).get("decision") == "block"
    assert _stop_hook(repo, {"stop_hook_active": True}).get("continue") is True


def test_the_gate_lets_go_when_the_stage_closes(repo: Path):
    """The window is the open stage — approval to PR — and nothing narrower.

    An earlier version released once the three-lens review proof existed. That
    is a PROXY for "nearly done" and wrong in both directions: `stage done`,
    `outcome set`, `pr_ready`, the push and CI all follow it, so an agent could
    stop with no PR raised. The way out is to FINISH the task.
    """
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1", "task_id": "T1"})

    _open_a_stage(repo)
    assert _stop_hook(repo).get("decision") == "block"

    # Recorded reviews are NOT a way out while the stage is still open.
    for lens in ("quality", "performance", "security"):
        path = lib.evidence_path(
            repo, "ENG-1", f"tasks/T1/reviews/{lens}.json", for_write=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        lib.dump_json(path, {"aspect": lens, "blocking": []})
    assert _stop_hook(repo).get("decision") == "block", (
        "review proof released the gate before the PR")

    # Closing the stage is.
    lib.dump_json(control / "stages.json",
                  {"stages": [{"id": "T1", "status": "done"}]})
    assert _stop_hook(repo).get("continue") is True


def test_both_hooks_ask_the_same_rule(repo: Path):
    # The defect this whole PR exists to fix was one question answered three
    # ways in four places. Two hooks deciding "may I interrupt?" separately
    # would be the same mistake again.
    for name in ("pre_tool_use.py", "stop_continue.py"):
        source = (HARNESS / "factory" / "scripts" / name).read_text(
            encoding="utf-8")
        assert "may_interrupt" in source, name


# ------------------------------------------------------------ stress cases --
def test_the_gate_cannot_be_walked_past_by_a_reworded_budget_question(repo: Path):
    """The obvious evasion: say the same thing in other words.

    Matching is on the substance an escalation NAMES, so paraphrase does not
    help — and it must not, or the gate is theatre.
    """
    for wording in (
        "the review_budget of 38 files is too small for this work",
        "we have hit the file ceiling and need a bigger budget",
        "max_changed_files needs to go up",
    ):
        code, out = run(
            repo, "forge.py", "signal", "escalate",
            "--missing-decision", wording,
            "--checked", "contract,plan,constitution,decisions,lessons")
        assert code != 0, f"walked past the gate with: {wording}"


def test_a_partial_checked_list_is_refused(repo: Path):
    # Claiming three of the five sources is how "I looked" becomes a formality.
    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "nobody has decided the document retention window",
        "--checked", "contract,plan")
    assert code != 0
    assert "constitution" in out and "decisions" in out and "lessons" in out


def test_an_escalation_survives_only_until_it_is_used(repo: Path):
    # Recording several up front must not buy a session's worth of stops...
    _open_a_stage(repo)
    for n in range(3):
        code, out = run(
            repo, "forge.py", "signal", "escalate",
            "--missing-decision", f"nobody has decided policy question {n} "
                                  f"about cross-organisation transfers",
            "--checked", "contract,plan,constitution,decisions,lessons")
        assert code == 0, out
    # ...but three genuine questions may genuinely be asked three times.
    for _ in range(3):
        code, out = _pre_hook(repo, _ask_payload())
        assert '"permissionDecision": "deny"' not in out, out
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' in out, "the fourth was not refused"


def test_a_closed_stage_releases_the_gate(repo: Path):
    # Between tasks the human is back in the loop; the gate must not persist.
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "stages.json",
                  {"stages": [{"id": "T1", "status": "done"}]})
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out
    assert _stop_hook(repo).get("continue") is True


def test_the_gate_ignores_every_other_tool(repo: Path):
    # It must gate interrupting the human, not working. A gate that slowed the
    # ordinary path would be removed within a day.
    _open_a_stage(repo)
    for tool in ("Bash", "Read", "Edit", "Write", "Grep"):
        code, out = _pre_hook(repo, {"tool_name": tool, "tool_input": {}})
        assert '"permissionDecision": "deny"' not in out, f"{tool}: {out}"


def test_a_missing_control_directory_fails_open(repo: Path):
    # A fresh clone, a worktree mid-prune: the gate must not be the reason a
    # session cannot speak.
    import shutil
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    if control.exists():
        shutil.rmtree(control)
    code, out = _pre_hook(repo, _ask_payload())
    assert '"permissionDecision": "deny"' not in out, out
    assert _stop_hook(repo).get("continue") is True
