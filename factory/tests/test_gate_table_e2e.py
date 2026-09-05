"""Every gate, end to end: run it, then record it.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

The unit tests prove the table's shape. These prove the two things the table
exists to guarantee, for each of the six gates in turn: the runner can locate
the artifact and compose a brief for it, and the recorder accepts a real
ledger-matched round and refuses one short of the floor. Before the table, four
gates failed the first and two skipped the second entirely.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from test_gates import (  # noqa: F401
    HARNESS, git, grill_rounds, load_factory_lib, log_grill_rounds, repo, run,
)

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from grill_gates import GATES  # noqa: E402


ALL_GATES = sorted(GATES)


def test_the_table_covers_every_gate_the_recorder_accepts():
    # The eight scattered copies drifted precisely because nothing compared
    # them. This is that comparison, and it is why a seventh gate cannot ship
    # runnable-but-unfloored or recordable-but-unrunnable.
    recorder = (HARNESS / "factory" / "scripts"
                / "record_grill_from_json.py").read_text(encoding="utf-8")
    schema = json.loads((HARNESS / "factory" / "schemas" / "grill.json"
                         ).read_text(encoding="utf-8"))
    documented = schema["recorded_by"].split("--gate ", 1)[1].split()[0]
    assert set(documented.split("|")) == set(ALL_GATES), (
        "the schema's gate list disagrees with the table")
    # The recorder derives its choices from the table rather than restating.
    assert "choices=gate_names()" in recorder
    assert "GATE_ROUND_FLOORS = {name: gate.min_rounds" in recorder
    # And the floor check can no longer be skipped for any gate.
    assert "if args.gate in GATE_ROUND_FLOORS:" not in recorder


@pytest.mark.parametrize("gate", ALL_GATES)
def test_every_gate_has_a_floor_of_at_least_one(gate):
    # signoff and epics were absent from the floor map, and the provenance
    # check ran only for gates that were in it — so those two recorded a pass
    # with an empty rounds list and satisfied their downstream gate.
    assert GATES[gate].min_rounds >= 1
    assert GATES[gate].story_scoped in (True, False)
    assert GATES[gate].evidence_name("T1").startswith("grills/")


@pytest.mark.parametrize("gate", ALL_GATES)
def test_every_gate_can_be_located_and_composed(repo, gate):
    """The runner must reach a brief for all six.

    Four gates used to stop at "no artifact resolver yet", which is what sent
    the coordinator around the ledgered launcher — the only path that records
    a pid — and left a dead grill detectable only by a 20-minute silence.
    """
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import _artifact_text, _compose_brief  # noqa: E402

    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})

    marker = f"UNIQUE-MARKER-FOR-{gate}"
    task_id, file_arg = "", ""

    if gate == "task":
        task_id = "T1"
        plan = lib.evidence_path(repo, "ENG-1", "task-plans/T1.md",
                                 for_write=True)
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(f"# T1\n\n{marker}\n", encoding="utf-8")
    elif gate == "spec":
        spec = repo / "docs" / "specs" / "thing.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text(f"# Thing\n\n{marker}\n", encoding="utf-8")
        file_arg = "docs/specs/thing.md"
    elif gate == "epics":
        proposal = repo / "proposal.json"
        proposal.write_text(json.dumps({"epics": [{"id": marker}]}),
                            encoding="utf-8")
        file_arg = "proposal.json"
    elif gate == "plan":
        draft = repo / "draft.md"
        draft.write_text(f"# Draft\n\n{marker}\n", encoding="utf-8")
        file_arg = "draft.md"
    elif gate == "signoff":
        brief = repo / "docs" / "product" / "BRIEF.md"
        brief.parent.mkdir(parents=True, exist_ok=True)
        brief.write_text(f"# Brief\n\n{marker}\n", encoding="utf-8")
    elif gate == "requirements":
        spec = repo / "docs" / "specs" / "linked.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text(f"# Linked\n\n{marker}\n", encoding="utf-8")
        roadmap = repo / "plans" / "roadmap.json"
        roadmap.parent.mkdir(parents=True, exist_ok=True)
        roadmap.write_text(json.dumps({"items": [
            {"key": "ENG-1", "spec": "docs/specs/linked.md"}]}),
            encoding="utf-8")

    label, artifact = _artifact_text(repo, gate, task_id, file_arg)
    assert marker in artifact, f"{gate}: located the wrong artifact"
    brief_text = _compose_brief(repo, gate, label, artifact)
    # The reader is cold, so the document must travel INSIDE the brief.
    assert marker in brief_text
    assert "You did NOT write what follows" in brief_text
    # And every brief carries the same floor-is-not-a-target rule.
    assert "FLOOR, not a target" in brief_text


@pytest.mark.parametrize("gate", ["signoff", "epics"])
def test_the_two_unfloored_gates_now_refuse_an_empty_grill(repo, gate):
    """The regression that mattered: these two passed on nothing.

    Recorded end to end rather than asserted on the floor map, because the
    defect was never the map — it was `if args.gate in GATE_ROUND_FLOORS`
    skipping the check for exactly these two gates.
    """
    payload = {
        "generated_by": "griller", "gate": gate, "verdict": "pass",
        "gaps": [], "contradictions": [], "resolutions": [], "rounds": [],
    }
    args = ["record_grill_from_json.py", "--gate", gate]
    if gate == "epics":
        proposal = repo / "proposal.json"
        proposal.write_text(json.dumps({"epics": []}), encoding="utf-8")
        args += ["--input-digest", str(proposal)]
    code, out = run(repo, *args, stdin=json.dumps(payload))
    assert code != 0, f"{gate} still records an empty grill:\n{out}"
    assert "logged round(s)" in out
    # The refusal must not read as a counting exercise.
    assert "not a target" in out


@pytest.mark.parametrize("gate", ["signoff", "epics"])
def test_the_two_unfloored_gates_accept_a_ledger_matched_round(repo, gate):
    # The other half: the new floor must be SATISFIABLE, or the gates are
    # simply broken in the opposite direction.
    rounds = grill_rounds(gate, GATES[gate].min_rounds)
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out

    payload = {
        "generated_by": "griller", "gate": gate, "verdict": "pass",
        "gaps": [], "contradictions": [], "resolutions": [], "rounds": rounds,
    }
    args = ["record_grill_from_json.py", "--gate", gate]
    if gate == "epics":
        proposal = repo / "proposal.json"
        proposal.write_text(json.dumps({"epics": []}), encoding="utf-8")
        args += ["--input-digest", str(proposal)]
    code, out = run(repo, *args, stdin=json.dumps(payload))
    assert code == 0, f"{gate} cannot be recorded at all now:\n{out}"

    lib = load_factory_lib(repo)
    recorded = lib.load_json(
        lib.evidence_path(repo, "", GATES[gate].evidence_name()), default={})
    assert recorded.get("verdict") == "pass"
    assert len(recorded.get("rounds", [])) >= GATES[gate].min_rounds


def test_a_fabricated_round_is_still_refused_for_the_new_gates(repo):
    # Bringing signoff under the floor is worth nothing if the round can be
    # invented; the whole point is that only the hook writes the ledger.
    rounds = grill_rounds("signoff", 1)
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    rounds[0]["chosen"] = "Something nobody was ever asked"
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "signoff",
        stdin=json.dumps({
            "generated_by": "griller", "gate": "signoff", "verdict": "pass",
            "gaps": [], "contradictions": [], "resolutions": [],
            "rounds": rounds,
        }))
    assert code != 0 and "does not match an AskUserQuestion ledger record" in out


def test_the_schema_does_not_require_rounds(repo):
    """The floor belongs to the recorder, not the schema.

    Two call sites re-validate a grill READ FROM DISK — `task plan save` when
    it re-stamps the plan digest, and `task approve`. Requiring `rounds` in the
    schema enforces nothing new (a payload short of the floor never reaches
    disk in the first place) but hands both of those a way to refuse a record
    written before rounds existed. A gate that cannot approve a task because of
    a field added later is a worse failure than the one being prevented.
    """
    schema = json.loads((HARNESS / "factory" / "schemas" / "grill.json"
                         ).read_text(encoding="utf-8"))
    assert "rounds" in schema["optional"]
    assert "rounds" not in schema["required"]

    # The floor is still real — proven where it is actually enforced.
    lib = load_factory_lib(repo)
    legacy = {"generated_by": "griller", "gate": "task", "verdict": "pass",
              "gaps": [], "contradictions": [], "resolutions": []}
    lib.validate_payload(repo, "grill", legacy)  # must not raise
