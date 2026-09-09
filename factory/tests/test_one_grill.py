"""One cold read per gate, with the human's questions asked inside it.

The loop was never a habit — it was forced. Fixing a finding means EDITING the
artifact, and the gates bind a recorded grill to the artifact's digest, so the
edit invalidated the grill that authorised it and a re-read became mandatory.
Re-reading is also what diverges: a fresh unconstrained reader has no memory of
the last one's findings, so it returns a DIFFERENT frontier. Each round
manufactured the next round's work; stories reached eleven, twenty-six and
forty rounds, the last costing six hours.

The shape under test: one unconstrained cold read → every finding put to the
human in that same grill → one amendment → a BOUNDED confirm read that is
handed the findings and the answers and may return nothing else. A confirm
cannot open a frontier, so it terminates.

Its own module for the same reason test_grill_round_cap.py is: test_gates.py is
one very large file where every added branch collides with every other.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _seed(repo: Path, story: str = "ENG-1") -> None:
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": story})


def _cold_read(repo: Path, gate: str = "plan", task_id: str = "",
               at: str = "2026-09-07T10:00:00+00:00") -> None:
    """A cold read, as the ledgered launcher records one."""
    from forge_cli.delegate import delegations_path  # noqa: E402
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "launch_id": f"{ledger_id}-{at}", "task": ledger_id, "at": at,
            "launch_status": "succeeded", "write": False,
        }) + "\n")


def _cold_read_with_digest(repo: Path, digest: str,
                           gate: str = "plan", task_id: str = "",
                           at: str = "2026-09-07T10:00:00+00:00") -> None:
    """A cold read that stamped WHICH bytes it was shown, as the launcher does."""
    from forge_cli.delegate import delegations_path  # noqa: E402
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "launch_id": f"{ledger_id}-{at}", "task": ledger_id, "at": at,
            "launch_status": "succeeded", "write": False,
            "task_sha256": digest,
        }) + "\n")


def _answer(repo: Path, story: str, question: str, chosen: str,
            options: list[str] | None = None,
            at: str = "2026-09-07T11:00:00+00:00") -> None:
    """An AskUserQuestion round, as post_tool_use.py ledgers one.

    The recorder matches question AND options exactly, so a fixture that
    invents its own options proves nothing about provenance.
    """
    lib = load_factory_lib(repo)
    directory = lib.evidence_path(repo, story, "grill-rounds", for_write=True)
    directory.mkdir(parents=True, exist_ok=True)
    lib.dump_json(directory / f"{abs(hash((question, at)))}.json", {
        "at": at,
        "questions": [{"question": question,
                       "options": options or [chosen, "No"],
                       "chosen": chosen}],
    })


def _refuse(repo: Path, gate: str = "plan", task_id: str = "",
            reread: str = "") -> None:
    from forge_cli.grill import _refuse_a_second_cold_read  # noqa: E402
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    _refuse_a_second_cold_read(repo, ledger_id, gate, task_id, reread)


# --------------------------------------------------------- one read per pass


def test_the_first_cold_read_is_allowed(repo: Path):
    _seed(repo)
    _refuse(repo)  # must not raise


def test_a_second_cold_read_is_refused_and_names_what_to_do_instead(repo: Path, capsys):
    _seed(repo)
    _cold_read(repo)
    try:
        _refuse(repo)
    except SystemExit:
        message = capsys.readouterr().out
    else:
        raise AssertionError("the second cold read was allowed")

    # It must name the way forward, or it is a wall: the frontier is not
    # closed, so nothing records and nothing proceeds.
    assert "record_grill_from_json.py" in message
    # And say WHY, or it reads as bureaucracy rather than the reason the
    # twenty-six-round grill happened.
    assert "different frontier" in message.lower()
    assert "--reread" in message


def test_a_reread_with_a_reason_is_allowed(repo: Path):
    """Not a wall. Answers that change an artifact's SHAPE need a real read.

    A choice with a recorded reason, like `stage start --trunk` — never an
    omission that happens to work.
    """
    _seed(repo)
    _cold_read(repo)
    _refuse(repo, reread="the human dropped the whole sync component")


def test_another_gate_is_unaffected(repo: Path):
    # A task grill must not consume the plan gate's single read.
    _seed(repo)
    _cold_read(repo, gate="task", task_id="T1")
    _refuse(repo, gate="plan")


def test_a_recorded_pass_releases_the_next_read(repo: Path):
    """A later legitimate grill starts fresh.

    Without this the first story to record a pass could never be grilled
    again, because its one read is spent forever.
    """
    _seed(repo)
    lib = load_factory_lib(repo)
    _cold_read(repo, at="2026-09-05T10:00:00+00:00")
    try:
        _refuse(repo)
    except SystemExit:
        pass
    else:
        raise AssertionError("expected the second read to be refused")

    record = lib.evidence_path(repo, "ENG-1", "grills/plan.json", for_write=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    lib.dump_json(record, {"verdict": "pass",
                           "recorded_at": "2026-09-06T00:00:00+00:00"})
    _refuse(repo)  # must not raise


def test_an_unreadable_ledger_never_refuses_a_grill(repo: Path):
    # A check that cannot check must not block the gate: a missed refusal
    # costs a round, a false refusal costs the story.
    _seed(repo)
    from forge_cli.delegate import delegations_path  # noqa: E402
    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json\n", encoding="utf-8")
    _refuse(repo)  # must not raise


# ------------------------------------------------- the confirm is bounded


# ------------------------------------------- the recorder demands the confirm


def _grill_payload(gaps: list[str]) -> dict:
    rounds = [{"question": gap, "options": ["Fix it", "Leave it"],
               "chosen": "Fix it"} for gap in gaps]
    rounds.append({"question": "Any remaining gap before we hand off?",
                   "options": ["No", "Yes"], "chosen": "No",
                   "frontier_empty": True})
    return {
        "gate": "plan",
        "generated_by": "griller", "verdict": "pass", "gaps": gaps,
        "contradictions": [], "resolutions": ["Amended the plan"],
        "inspected_refs": ["plans/x.md"], "current_flow": "n/a",
        "criteria_map": {}, "decision": "keep", "new_abstractions": ["None"],
        "rounds": rounds,
        "citations": [{"finding": gap, "source": "plans/x.md"} for gap in gaps],
        "open_items": [],
    }


# -------------------------------------------------------- the contracts agree


def test_the_griller_contract_no_longer_says_loop(repo: Path):
    text = (HARNESS / "factory" / "prompts" / "griller.md").read_text(
        encoding="utf-8")
    flat = " ".join(text.split())
    assert "Codex grill again, until a round is clean" not in flat
    assert "ONE COLD READ PER GATE" in flat
    assert "the WHOLE grill" in flat
    # Findings the repo answers are the coordinator's, not a menu for the human.
    assert "resolve every finding the REPOSITORY answers yourself" in flat
    # The cost of one read has to be stated, not buried.
    assert "is not caught by a second reader at this gate" in flat


def test_the_adapter_no_longer_says_loop_until_clean(repo: Path):
    text = (HARNESS / ".claude" / "CLAUDE.md").read_text(encoding="utf-8")
    flat = " ".join(text.split())
    assert "loop until clean AND stable" not in flat
    assert "That is the WHOLE grill" in flat
    # check_dual_runtime caps this file; a rewrite that grew it would fail CI
    # somewhere far from here.
    assert len(text.splitlines()) <= 40


def test_forge_next_describes_one_read(repo: Path):
    text = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py"
            ).read_text(encoding="utf-8")
    flat = " ".join(text.split())
    assert "LOOP until a round" not in flat
    # Assert within ONE source line: the step is a concatenation of string
    # literals, so a phrase spanning two of them carries quotes in the source
    # that collapsing whitespace never removes.
    assert "cold read is the WHOLE grill" in flat
    assert "resolve every finding the REPO answers yourself" in flat


# ------------------------------------------------------ the whole way through


def test_a_plan_still_saves_and_approves_through_the_new_flow(
        repo: Path, tmp_path: Path):
    """draft -> ONE cold read -> resolve the findings -> amend -> save.

    Every other test here checks one gate in isolation. The question that
    matters is whether the sequence a dev actually performs still ends with an
    approved plan on disk, because the gates bind the recorded grill to the
    plan's digest: a grill that cannot be recorded is a plan that can never be
    saved. That is what would break first if the one-read rule were wrong.

    The Codex process cannot run in a test, so the row `grill run` leaves in
    the ledger is written the way the launcher writes it. Everything after it
    is the real harness: the real recorder, the real digest binding, the real
    `plan save` and `plan approve`.
    """
    from test_gates import (  # noqa: E402
        PLAN_BODY, ensure_story, intake, log_grill_rounds, plan_draft,
        record_grill, run_state, sign_off,
    )
    from forge_cli.grill import _artifact_digest, _artifact_text  # noqa: E402

    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")

    # 1. The dev reads the repo and drafts a plan.
    draft = tmp_path / "plan.md"
    draft.write_text(plan_draft(repo), encoding="utf-8")

    # 2. ONE cold read, stamping the bytes it was shown -- what `grill run`
    #    records through the ledgered launcher.
    _, read_bytes = _artifact_text(repo, "plan", "", str(draft))
    _cold_read_with_digest(repo, _artifact_digest(read_bytes),
                           at="2026-09-07T10:00:00+00:00")

    # 3. A second cold read is refused. This is the whole mechanism.
    try:
        _refuse(repo)
    except SystemExit:
        pass
    else:
        raise AssertionError("a second cold read was allowed")

    # 4. Its findings are settled -- in the repo where the repo answers, with
    #    the human where it does not.
    gap = "the plan never says which service owns invoice numbering"
    rounds = [
        {"question": gap, "options": ["Ledger owns it", "Billing owns it"],
         "chosen": "Ledger owns it"},
        {"question": "Any remaining gap before we hand off?",
         "options": ["No", "Yes"], "chosen": "No", "frontier_empty": True},
    ]
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out

    # 5. The plan is amended ONCE, and the pass records against the AMENDED
    #    version -- no second Codex run anywhere in here.
    draft.write_text(
        plan_draft(repo, body=PLAN_BODY
                   + "\nThe ledger service owns invoice numbering.\n"),
        encoding="utf-8")
    code, out = record_grill(
        repo, "plan", digest_of=draft, rounds=rounds, gaps=[gap],
        resolutions=["The ledger service owns invoice numbering."],
        citations=[{"finding": gap, "source": "docs/architecture/"}])
    assert code == 0, out

    # 6. And it saves, then approves.
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out, out

    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    # The awaiting copy is a different file with its own digest, so it carries
    # its own grill. Unchanged by this PR, and still no extra Codex run.
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    code, out = record_grill(
        repo, "plan", digest_of=active, rounds=rounds, gaps=[gap],
        resolutions=["The ledger service owns invoice numbering."],
        citations=[{"finding": gap, "source": "docs/architecture/"}])
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Nandu")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")
    assert code == 0, out
    assert run_state(repo)["plan_status"] == "approved"


def test_exactly_one_codex_launch_is_ledgered_for_the_plan_gate(repo: Path):
    """The count is the point of the whole change.

    Grilling used to cost a launch per round -- eleven, twenty-six, forty. The
    ledger is what those launches were counted from, so it is what proves the
    new shape: one row for the plan gate, and the second attempt refused before
    a brief is even composed.
    """
    from forge_cli.delegate import load_delegations  # noqa: E402
    _seed(repo)
    _cold_read(repo)
    try:
        _refuse(repo)
    except SystemExit:
        pass
    rows = [r for r in load_delegations(repo)
            if r.get("task") == "grill-plan"]
    assert len({r["launch_id"] for r in rows}) == 1


# ------------------------------------------------- downstream of the plan gate


def test_the_awaiting_copy_can_be_cold_read_after_the_draft_records(repo: Path):
    """`plan save` writes a second file, and it carries its own grill.

    The draft and the awaiting copy have different digests, so the awaiting
    one needs its own recorded grill -- which needs its own cold read. If
    recording the draft's pass did not release the next read, no plan could
    ever reach approval.
    """
    _seed(repo)
    lib = load_factory_lib(repo)
    _cold_read(repo, at="2026-09-07T10:00:00+00:00")
    try:
        _refuse(repo)
    except SystemExit:
        pass
    else:
        raise AssertionError("the draft's read did not consume the gate")

    record = lib.evidence_path(repo, "ENG-1", "grills/plan.json", for_write=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    lib.dump_json(record, {"verdict": "pass",
                           "recorded_at": "2026-09-07T11:00:00+00:00"})
    _refuse(repo)  # the awaiting copy may be read


def test_a_stale_task_grill_can_be_re_read(repo: Path):
    """Committing product code stales a task grill, and the loop re-grills.

    That is the JIT contract loop working as designed, not a coordinator
    grinding, so the rule must not stand in its way: a recorded pass releases
    the next read.
    """
    _seed(repo)
    lib = load_factory_lib(repo)
    _cold_read(repo, gate="task", task_id="T1", at="2026-09-07T10:00:00+00:00")
    record = lib.evidence_path(repo, "ENG-1", "grills/tasks/T1.json",
                               for_write=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    lib.dump_json(record, {"verdict": "pass",
                           "recorded_at": "2026-09-07T11:00:00+00:00"})
    _refuse(repo, gate="task", task_id="T1")  # stale -> re-read is allowed

    # And the re-read then consumes the gate again, so the loop cannot come
    # back through the same door.
    _cold_read(repo, gate="task", task_id="T1", at="2026-09-07T12:00:00+00:00")
    try:
        _refuse(repo, gate="task", task_id="T1")
    except SystemExit:
        pass
    else:
        raise AssertionError("the re-read did not consume the gate")


def test_one_task_does_not_spend_another_task_read(repo: Path):
    """Tasks in a story are ground through sequentially, one grill each."""
    _seed(repo)
    _cold_read(repo, gate="task", task_id="T1")
    _refuse(repo, gate="task", task_id="T2")  # must not raise
    _refuse(repo, gate="plan")                # nor the story plan


def test_a_read_that_stales_before_recording_still_has_a_way_through(
        repo: Path, capsys):
    """The one case with no recorded pass to reset the count.

    A doc commit between the cold read and the record stales the grill, so the
    read cannot be recorded AND cannot be repeated. Without a stated way
    through this would be the wall: nothing records, nothing proceeds.
    """
    _seed(repo)
    _cold_read(repo)
    try:
        _refuse(repo)
    except SystemExit:
        message = capsys.readouterr().out
    else:
        raise AssertionError("expected the refusal")
    assert "--reread" in message

    # And it is a choice with a reason, not a flag that merely has to be present.
    _refuse(repo, reread="a decision landed and re-scoped the plan")
