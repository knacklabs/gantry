"""Five cold reads without a pass, and the human is brought in.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

Three stories reached eleven, twenty-six and forty rounds; the last cost six
hours. Past a handful of rounds the reader has stopped converging on the
artifact and started circling something nobody has decided, and another round
cannot settle that.

The cap does NOT stop the grill. Stopping outright would be a wall — the
frontier is not closed, so nothing records and nothing proceeds. It stops the
agent grilling ALONE.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from forge_cli.grill import ROUNDS_BEFORE_ESCALATING  # noqa: E402


def _launches(repo: Path, ledger_id: str, count: int, at: str = "2026-09-07") -> None:
    """Write `count` distinct launch rows for a gate, as the launcher would."""
    lib = load_factory_lib(repo)
    from forge_cli.delegate import delegations_path  # noqa: E402
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for index in range(count):
            fh.write(json.dumps({
                "launch_id": f"{ledger_id}-{index}",
                "task": ledger_id,
                "at": f"{at}T1{index:01d}:00:00+00:00",
                "launch_status": "succeeded",
                "write": False,
            }) + "\n")


def _rounds(repo: Path, gate: str = "plan", task_id: str = "") -> int:
    from forge_cli.grill import _rounds_since_last_pass  # noqa: E402
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    return _rounds_since_last_pass(repo, ledger_id, gate, task_id)


def _seed(repo: Path) -> None:
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})


def test_a_fresh_gate_has_no_rounds(repo: Path):
    _seed(repo)
    assert _rounds(repo) == 0


def test_each_launch_counts_once(repo: Path):
    # A single launch appends several rows as it starts, runs and finishes.
    # Counting rows instead of launches would trip the cap in two real rounds.
    _seed(repo)
    lib = load_factory_lib(repo)
    from forge_cli.delegate import delegations_path  # noqa: E402
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for status in ("starting", "running", "succeeded"):
            fh.write(json.dumps({
                "launch_id": "grill-plan-0", "task": "grill-plan",
                "at": "2026-09-07T10:00:00+00:00",
                "launch_status": status, "write": False,
            }) + "\n")
    assert _rounds(repo) == 1


def test_another_gate_does_not_count_against_this_one(repo: Path):
    # A task grill must not push the plan gate over its cap.
    _seed(repo)
    _launches(repo, "grill-task-T1", 9)
    assert _rounds(repo, "plan") == 0


def test_recording_a_pass_resets_the_count(repo: Path):
    """A later legitimate re-grill starts fresh.

    Without this, a story that converged at four rounds would arrive at its
    next gate already one away from the cap, and the tally would only ever
    grow.
    """
    _seed(repo)
    lib = load_factory_lib(repo)
    _launches(repo, "grill-plan", 6, at="2026-09-05")
    assert _rounds(repo) == 6

    record = lib.evidence_path(repo, "ENG-1", "grills/plan.json", for_write=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    lib.dump_json(record, {"verdict": "pass",
                           "recorded_at": "2026-09-06T00:00:00+00:00"})
    assert _rounds(repo) == 0

    _launches(repo, "grill-plan", 2, at="2026-09-07")
    assert _rounds(repo) == 2


def test_the_cap_refuses_and_says_what_to_do(repo: Path, capsys):
    _seed(repo)
    _launches(repo, "grill-plan", ROUNDS_BEFORE_ESCALATING)

    from forge_cli.grill import _refuse_past_the_cap  # noqa: E402
    try:
        _refuse_past_the_cap(repo, "grill-plan", "plan", "")
    except SystemExit:
        # fail() prints and raises SystemExit(1); the text is on stdout, so
        # str(exc) is "1" and asserting on it would pass vacuously.
        message = capsys.readouterr().out
    else:
        raise AssertionError("the cap did not fire")

    assert "without a recorded pass" in message
    # It must name the way through, or it is the wall this deliberately is not.
    assert "signal escalate" in message
    assert "--missing-decision" in message
    # And say why another round will not help, or it reads as bureaucracy.
    assert "cannot settle that" in message


def test_below_the_cap_is_silent(repo: Path):
    _seed(repo)
    _launches(repo, "grill-plan", ROUNDS_BEFORE_ESCALATING - 1)
    from forge_cli.grill import _refuse_past_the_cap  # noqa: E402
    _refuse_past_the_cap(repo, "grill-plan", "plan", "")  # must not raise


def test_an_escalation_lets_grilling_continue(repo: Path):
    """The cap stops grilling ALONE, not grilling.

    Refusing outright would be a wall: the frontier is not closed, so nothing
    can be recorded and nothing can proceed.
    """
    _seed(repo)
    _launches(repo, "grill-plan", ROUNDS_BEFORE_ESCALATING + 3)

    code, out = run(
        repo, "forge.py", "signal", "escalate",
        "--missing-decision", "nobody has decided whether stock ownership sits "
                              "with SAP or MineOps",
        "--checked", "contract,plan,constitution,decisions,lessons")
    assert code == 0, out

    from forge_cli.grill import _refuse_past_the_cap  # noqa: E402
    _refuse_past_the_cap(repo, "grill-plan", "plan", "")  # must not raise


def test_an_uncountable_ledger_never_refuses(repo: Path):
    # A counter that cannot count must not block the gate: a missed cap costs
    # a round, a false cap costs the story.
    _seed(repo)
    from forge_cli.delegate import delegations_path  # noqa: E402
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json\n", encoding="utf-8")

    assert _rounds(repo) == 0
    from forge_cli.grill import _refuse_past_the_cap  # noqa: E402
    _refuse_past_the_cap(repo, "grill-plan", "plan", "")  # must not raise


def test_the_cap_is_enforced_by_the_command(repo: Path):
    # The unit is worthless if cmd_grill_run never calls it.
    #
    # Scoped to cmd_grill_run's own body. Searching the whole module takes the
    # FIRST match, so any other function resolving the same artifact the same
    # way captures it and this reports a reversed order inside a function it
    # never looked at -- which is exactly what happened once already.
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "grill.py"
              ).read_text(encoding="utf-8")
    body = source[source.index("def cmd_grill_run("):]
    call = body.index("_refuse_past_the_cap(base, ledger_id, gate, task_id)")
    compose = body.index("label, artifact = _artifact_text(")
    assert call < compose, "the cap must fire before a launch is composed"
    # Same claim, same place: nothing is composed before EITHER guard, so a
    # capped or refused run never pays for a brief it will not send.
    assert body.index("_refuse_a_second_cold_read(") < compose
