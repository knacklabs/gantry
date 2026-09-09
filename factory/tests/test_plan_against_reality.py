"""Planning reads the system, and the harness says which skill it uses.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

One story's plan grill recorded twenty inspected refs. All twenty were
documents; none was app source. The plan then asserted what a type carries,
which enum values exist and which routes touch a binding — facts that live in
code, not in an architecture note. So the planner described the system as
DESIGNED while the cold reader checked the system as BUILT, and every gap
became a finding. Twenty-six rounds of them.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, post_hook, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _flat(text: str) -> str:
    """Collapse whitespace.

    These are hard-wrapped documents. A phrase assertion against raw text
    breaks the moment someone re-flows a paragraph, which is a false failure
    about formatting dressed as a failure about content.
    """
    return " ".join(text.split())



# --------------------------------------------------- reading is not blocked
def test_nothing_actually_prevents_reading_the_repo(repo: Path):
    """The rule was obeyed as a prohibition and ignored as an instruction.

    "Do NOT grep/read app code yourself — delegate instead" has two halves.
    Nothing enforces either: no hook denies Read, Grep or Glob, the
    permissions file is empty, and the planning lock blocks WRITES. So the
    half that removes knowledge is free and the half that restores it costs a
    launch. Only the free half happened.
    """
    hook = (HARNESS / "factory" / "scripts" / "pre_tool_use.py").read_text(
        encoding="utf-8")
    for tool in ('"Read"', '"Grep"', '"Glob"'):
        assert tool not in hook, (
            f"a read tool is now gated ({tool}) — planning would go blind")

    settings = json.loads(
        (HARNESS / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert not (settings.get("permissions") or {}).get("deny"), (
        "a deny rule would silently re-create the prohibition")


def test_the_contract_tells_the_planner_to_read_first(repo: Path):
    claude = (HARNESS / ".claude" / "CLAUDE.md").read_text(encoding="utf-8")
    assert "do NOT grep/read app code yourself" not in claude, (
        "the prohibition is back")
    # CLAUDE.md is capped at 40 lines by check_dual_runtime — it points, and
    # planner.md carries the rule. Assert the pointer here and the substance
    # there, or the cap and the test fight each other.
    assert "READ BEFORE YOU ASSERT" in claude
    assert "Delegate BREADTH" in claude

    planner = (HARNESS / "factory" / "prompts" / "planner.md").read_text(
        encoding="utf-8")
    flat = _flat(planner)
    assert "FIRST, READ THE SYSTEM YOU ARE PLANNING AGAINST" in flat
    # And it must say WHY docs are not enough, or it reads as a style note.
    assert "as designed" in flat and "what was built" in flat
    # The distinction that makes delegation safe: breadth yes, facts no.
    assert "a summary of a type is not the type" in flat.lower()


def test_forge_next_makes_reading_a_step_not_a_parenthesis(repo: Path):
    """It was mentioned three times, never as a step.

    `forge next` said "MANDATORY: plan per planner.md (... exploration via
    /codex:rescue read-only)" — the mandatory half was writing, and reading was
    an aside inside a bracket. The grill gets a step of its own; so should this.
    """
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py"
              ).read_text(encoding="utf-8")
    first = source.index("FIRST read the system this plan will assert about")
    then = source.index("THEN plan per factory/prompts/planner.md")
    assert first < then, "authoring must not come before reading"
    step = source[first:then]
    assert "types, enums, routes" in step
    assert "/codex:rescue" in step, "breadth still delegates"


# ------------------------------------------------------- the grill skill ---
def test_the_harness_names_the_skill_a_reader_can_actually_load(repo: Path):
    """`grill-me` carries disable-model-invocation: no model invokes it.

    It is the human's `/grill-me` alias, redirecting to `grilling`, which
    holds the technique and which `doctor` mirrors into both runtimes.
    Instructing a cold reader to load the alias described something that
    cannot happen.
    """
    contract = (HARNESS / "factory" / "prompts" / "griller.md").read_text(
        encoding="utf-8")
    assert "LOADS and RUNS the `grill-me` skill" not in contract
    assert "disable-model-invocation" in contract, (
        "say WHY the alias is not the thing to load")
    assert "`grilling`" in contract

    grill = (HARNESS / "factory" / "scripts" / "forge_cli" / "grill.py"
             ).read_text(encoding="utf-8")
    assert "installed only on the Claude side" not in grill, (
        "doctor mirrors grilling into ~/.codex/skills; the claim was false")


def test_doctor_requires_the_skill_that_is_used(repo: Path):
    # Requiring the Codex mirror of an un-invocable stub sent anyone missing it
    # to fix something no reader can use.
    doctor = (HARNESS / "factory" / "scripts" / "forge_cli" / "doctor.py"
              ).read_text(encoding="utf-8")
    assert '"grilling skill (both runtimes)"' in doctor
    assert "(grill_me_codex / \"SKILL.md\").is_file()" not in doctor


# ------------------------------------------------- the unrecordable grill --
def test_the_frontier_refusal_names_the_remedy(repo: Path):
    """Twenty-two rounds recorded nothing because of this message.

    The ledger records {question, options, chosen} and never `frontier_empty`,
    while the provenance check requires the submitted rounds to MATCH the
    ledger. So building the payload from the ledger — the obvious thing —
    can never satisfy the gate, and the refusal named the requirement without
    saying the flag is added by hand.
    """
    recorder = (HARNESS / "factory" / "scripts" / "record_grill_from_json.py"
                ).read_text(encoding="utf-8")
    start = recorder.index("requires frontier_empty true")
    message = recorder[start:start + 900]
    assert "BY HAND" in message
    assert "ledger never carries this flag" in message
    # And it must say what to do when the frontier is genuinely NOT closed,
    # or the flag becomes something to set to get past the gate.
    assert "has not converged" in message


# ------------------------------------------------------------- dead code ---
def test_the_plan_mode_marker_recording_is_gone(repo: Path):
    """Decision 0050 removed the gate; nothing has read a marker since.

    Keeping the write kept `permission_mode == "plan"` in the hook's dispatch,
    which reads as if plan mode were still load-bearing three decisions after
    it stopped being.
    """
    hook = (HARNESS / "factory" / "scripts" / "post_tool_use.py").read_text(
        encoding="utf-8")
    assert 'permission_mode") == "plan"' not in hook
    assert '"plan-mode"' not in hook

    # The grill round recording must be untouched — it is what every gate
    # validates against.
    assert 'tool == "AskUserQuestion"' in hook
    assert '"grill-rounds"' in hook


def test_grill_rounds_are_still_recorded_after_the_removal(repo: Path):
    # The only branch that matters must still fire end to end.
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})

    code, out = post_hook(repo, {
        "tool_name": "AskUserQuestion",
        "tool_input": {"questions": [{
            "question": "Does GRN come from SAP?",
            "options": [{"label": "SAP"}, {"label": "MineOps"}],
        }]},
        "tool_response": {"answers": {"Does GRN come from SAP?": "SAP"}},
    })
    assert code == 0, out
    rounds = list(lib.evidence_path(repo, "ENG-1", "grill-rounds").glob("*.json"))
    assert rounds, "the grill round was not recorded"
    record = json.loads(rounds[0].read_text(encoding="utf-8"))
    assert record["questions"][0]["chosen"] == "SAP"


# ------------------------------------------------- the TASK plan, equally --
def test_the_task_plan_authoring_step_reads_first_too(repo: Path):
    """Both plans are written by the same session against the same codebase.

    Only the story plan got the read-first step at first. The task plan is the
    worse case: it names the exact files, types and routes the implementer
    writes against, so a fact taken from a drifted doc does not cost a grill
    round — it costs a worker paused mid-implementation against a contract
    asking for something that is not there.
    """
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py"
              ).read_text(encoding="utf-8")
    first = source.index("FIRST read what {task_id} will touch")
    then = source.index("THEN author the {task_id} plan")
    assert first < then, "authoring must not come before reading"

    step = source[first:then]
    assert "migrations" in step, "a task plan names migrations; they must be read"
    assert "permission codes" in step
    assert "/codex:rescue" in step, "breadth still delegates"
    # It must say what a wrong fact COSTS here, or it reads as the same
    # boilerplate as the story-plan step and gets skimmed.
    assert "paused mid-" in step


def test_the_planner_contract_covers_both_plans(repo: Path):
    # planner.md is the contract both authoring steps point at. If it reads as
    # story-only, the task-plan step points at a document that does not
    # obviously apply to it.
    planner = (HARNESS / "factory" / "prompts" / "planner.md").read_text(
        encoding="utf-8")
    flat = _flat(planner)
    assert "governs BOTH the story plan and each per-task plan" in flat
    assert "binds harder for a TASK plan" in flat


def test_both_authoring_steps_say_the_same_thing(repo: Path):
    """One rule, two places — they must not drift.

    This is the defect this whole PR exists to fix, applied to itself: the
    story step and the task step are the same instruction, and a change to one
    that misses the other re-creates the gap.
    """
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py"
              ).read_text(encoding="utf-8")
    story = source[source.index("FIRST read the system this plan will assert"):
                   source.index("THEN plan per factory/prompts/planner.md")]
    task = source[source.index("FIRST read what {task_id} will touch"):
                  source.index("THEN author the {task_id} plan")]
    for shared in ("Not the ", "architecture note", "/codex:rescue",
                   "look up specific facts yourself"):
        assert shared in story, f"story step lost: {shared!r}"
        assert shared in task, f"task step lost: {shared!r}"
