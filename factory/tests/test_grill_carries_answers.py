"""A grill round is told what was already answered — and nothing more.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

The brief carried only the artifact, so round 11 knew nothing of rounds 1-10. A
cold reader with no memory does not re-find the same gaps; it finds DIFFERENT
ones, so the rounds never shrink. One story reached eleven with the coordinator
asking the human how to escape; another ran forty-four across its gates.

The answers were on disk the whole time — `grill-rounds/*.json` is what the
recorder validates rounds against. Measured on that story: 64 questions, 14.5 KB,
2.8% of the launcher's prompt budget.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _round(repo: Path, name: str, at: str, pairs: list[tuple[str, str]]) -> None:
    lib = load_factory_lib(repo)
    path = lib.evidence_path(repo, "ENG-1", f"grill-rounds/{name}.json",
                             for_write=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    lib.dump_json(path, {
        "generated_by": "post_tool_use", "at": at,
        "questions": [{"question": q, "options": ["A", "B"], "chosen": a}
                      for q, a in pairs],
    })


def _seed_story(repo: Path) -> None:
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})


def _settled(repo: Path, gate: str = "plan") -> str:
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import _settled_rounds  # noqa: E402
    return _settled_rounds(repo, gate)


def test_nothing_answered_yet_adds_nothing(repo: Path):
    # A first round must read exactly as it does today: no empty scaffolding
    # for the reader to wonder about.
    _seed_story(repo)
    assert _settled(repo) == ""


def test_every_answered_question_reaches_the_reader(repo: Path):
    """The whole point: round 11 must know what rounds 1-10 settled."""
    _seed_story(repo)
    _round(repo, "r1", "2026-09-01T10:00:00+00:00",
           [("Does GRN come from SAP or MineOps?", "SAP is the source")])
    _round(repo, "r2", "2026-09-01T11:00:00+00:00",
           [("Two migrations or three?", "three, named in section 4"),
            ("Who approves an NML?", "two named approvers")])

    text = _settled(repo)
    for fragment in ("Does GRN come from SAP", "SAP is the source",
                     "Two migrations or three", "three, named in section 4",
                     "Who approves an NML", "two named approvers"):
        assert fragment in text, fragment


def test_the_reader_is_told_to_audit_the_answers(repo: Path):
    """The capability this adds, not just the token saving.

    A wrong answer, or a right answer nobody applied, was invisible at any
    round count — the reader did not know the question had been asked.
    """
    _seed_story(repo)
    _round(repo, "r1", "2026-09-01T10:00:00+00:00", [("Q?", "A")])
    text = _settled(repo)
    assert "do not re-ask" in text.lower()
    assert "check each answer still holds" in text.lower()
    assert "contradict" in text.lower()
    # And that an answer can be right yet unapplied — the case a plan diff hides.
    assert "never applied" in text.lower()


def test_the_reader_is_never_told_where_to_concentrate(repo: Path):
    """The steer is the thing we deliberately did not add.

    griller.md justified it as "a fraction of the tokens"; the whole history of
    a 44-round story is 2.8% of the budget, so the saving is not worth buying —
    and a cold read is worth having precisely because it is unconstrained.
    Steering it at the diff is how the thing nobody looked at survives every
    round.
    """
    _seed_story(repo)
    _round(repo, "r1", "2026-09-01T10:00:00+00:00", [("Q?", "A")])
    text = _settled(repo).lower()
    for steer in ("concentrate", "focus on", "look here", "since the last round"):
        assert steer not in text, f"the brief steers the reader: {steer!r}"

    contract = (HARNESS / "factory" / "prompts" / "griller.md").read_text(
        encoding="utf-8")
    assert "Do NOT tell the reader where to concentrate" in contract
    assert "tell it to concentrate there" not in contract


def test_an_unanswered_round_settles_nothing(repo: Path):
    # A question asked but never answered is still open. Presenting it as
    # settled would suppress the one thing the reader should raise.
    _seed_story(repo)
    _round(repo, "r1", "2026-09-01T10:00:00+00:00", [("Still open?", "")])
    assert _settled(repo) == ""


def test_the_same_question_is_not_repeated(repo: Path):
    # The ledger holds one record per hook call, and a re-asked question with
    # the same answer is one settled fact, not two.
    _seed_story(repo)
    for name in ("r1", "r2"):
        _round(repo, name, f"2026-09-01T1{name[-1]}:00:00+00:00",
               [("Same question?", "Same answer")])
    assert _settled(repo).count("Same question?") == 1


def test_answers_arrive_in_the_order_they_were_given(repo: Path):
    _seed_story(repo)
    _round(repo, "later", "2026-09-02T10:00:00+00:00", [("Second?", "2")])
    _round(repo, "earlier", "2026-09-01T10:00:00+00:00", [("First?", "1")])
    text = _settled(repo)
    assert text.index("First?") < text.index("Second?")


def test_truncation_drops_the_oldest_and_says_so(repo: Path):
    """Silence is the failure mode that matters.

    A chunked review dropped its verdicts quietly and every contract recorded
    `partial`. If this ever has to cut, it cuts the oldest settled ground and
    prints that it did.
    """
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import SETTLED_BUDGET_CHARS  # noqa: E402

    _seed_story(repo)
    filler = "x" * 2_000
    count = (SETTLED_BUDGET_CHARS // 2_000) + 5
    for index in range(count):
        _round(repo, f"r{index:03d}", f"2026-09-01T{index // 60:02d}:{index % 60:02d}:00+00:00",
               [(f"Question {index} {filler}", f"Answer {index}")])

    text = _settled(repo)
    assert "omitted for length" in text, "content vanished without saying so"
    assert f"Question {count - 1}" in text, "the newest answer was dropped"
    assert "Question 000" not in text, "the oldest should be cut first"


def test_a_broken_round_record_never_breaks_the_brief(repo: Path):
    # The grill must still run against a malformed ledger; losing the settled
    # section costs one noisier round, losing the brief costs the gate.
    _seed_story(repo)
    lib = load_factory_lib(repo)
    path = lib.evidence_path(repo, "ENG-1", "grill-rounds/broken.json",
                             for_write=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    _round(repo, "good", "2026-09-01T10:00:00+00:00", [("Good?", "Yes")])
    assert isinstance(_settled(repo), str)


def test_the_brief_actually_carries_the_section(repo: Path):
    # The unit is worthless if _compose_brief never calls it.
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "grill.py"
              ).read_text(encoding="utf-8")
    assert "_settled_rounds(base, gate)" in source

    _seed_story(repo)
    _round(repo, "r1", "2026-09-01T10:00:00+00:00",
           [("Does GRN come from SAP?", "SAP is the source")])
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import _compose_brief  # noqa: E402
    brief = _compose_brief(repo, "plan", "the plan", "# Plan\n\nbody\n")
    assert "SAP is the source" in brief
    assert "# Plan" in brief


def test_answers_are_quoted_not_summarised(repo: Path):
    """A summary would be written by the party being audited.

    The recorder matches recorded rounds against this same ledger, so a
    paraphrase would also break the provenance the gate depends on.
    """
    _seed_story(repo)
    exact = "Three migrations, named 0001_worker, 0002_site, 0003_form_a"
    _round(repo, "r1", "2026-09-01T10:00:00+00:00",
           [("How many migrations?", exact)])
    assert exact in _settled(repo)
