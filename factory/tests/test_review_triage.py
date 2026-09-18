"""The host triages a review's findings before the fix round (decision 0075).

WF-1 T5 took six reviews and eight fix rounds. Eleven of the first
twenty-five blockers were wrong and died only when the coordinator opened the
callee; the real ones were relayed one file at a time, so the same class came
back from the next file for four rounds. `forge review <id> --triage` records
the host's verdict with the line that proves it and every instance still
failing; the fix brief carries it beside the finding; `forge delegate` warns on
any finding left without one. No refusal: enforcement by visibility.
"""
from __future__ import annotations

import json
import sys

from test_gates import (  # noqa: F401
    HARNESS, _write_complete_automated, fake_companion_env, git, repo, run,
)
from test_review_settled_contracts import _publish, _story  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from factory_lib import (  # noqa: E402
    load_json, protected_decomposition_state_path, task_evidence_path,
)
from forge_cli.delegate import _review_findings_section  # noqa: E402
from forge_cli.review import (  # noqa: E402
    _next_hint, rejected_findings_report, selected_generation, untriaged_blocking,
)

__all__ = ["repo"]

HARD = {"summary": "the form stays editable while the write is uncertain"}
OTHER = {"summary": "the retry replays a decision the screen no longer shows"}


def _t2_task(repo):
    return next(t for t in load_json(
        protected_decomposition_state_path(repo), default={})["tasks"] if t["id"] == "T2")


def _triage_file(repo):
    return task_evidence_path(repo, "ENG-1", "T2", "review-triage.json")


def _built(repo, tmp_path, blocking):
    """A story with two product files and a selected review generation whose
    security lens carries the given blocking findings."""
    _story(repo, tmp_path)
    (repo / "src" / "work.py").write_text("task work\nsecond line\nthird line\n")
    (repo / "src" / "other.py").write_text("more of the same\nsecond line\n")
    git(repo, "add", "src/work.py", "src/other.py")
    git(repo, "commit", "-q", "-m", "T2 two forms")
    _write_complete_automated(repo, "T2")  # proof binds to the commit it was recorded at
    _publish(repo, blocking)


def test_the_hint_after_a_blocking_review_says_triage_first():
    hint = _next_hint("T5", "active", 4, 1)
    assert hint.index("triage them yourself") < hint.index("delegate the fixes")
    assert "open the cited line and the code it calls" in hint
    assert "every other place the same contract applies" in hint
    assert "review T5 --triage" in hint and "--instance" in hint
    assert "--not-a-defect --evidence" in hint
    # The loop verbs the coordinator already relies on are still named.
    assert "task close T5" in hint and "lesson add" in hint
    assert "triage" not in _next_hint("T5", "active", 0, 0)


def test_a_real_triage_records_proof_and_instances_and_the_brief_carries_them(repo, tmp_path):
    _built(repo, tmp_path, [HARD])
    generation = selected_generation(repo, "ENG-1", "T2")
    assert untriaged_blocking(repo, "ENG-1", "T2") == (1, 1)
    before = _review_findings_section(repo, _t2_task(repo), "ENG-1")
    assert "0 of 1 triaged by the host" in before
    assert "HOST TRIAGE: none recorded" in before and "unverified" in before

    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--real", "--evidence", "src/work.py:1",
                    "--instance", "src/work.py:1", "--instance", "./src/other.py:2",
                    "--keep", "the 409 branch keeps reconciling", "--by", "orchestrator")
    assert code == 0, out
    assert "Triaged security finding as REAL" in out
    assert "fix at every one of: src/work.py:1, src/other.py:2" in out
    assert "1 of 1 blocking finding(s) triaged" in out
    record = load_json(_triage_file(repo), default={})["findings"][0]
    assert "stays editable" in record["finding"]["summary"] and record["verdict"] == "real"
    assert record["instances"] == ["src/work.py:1", "src/other.py:2"]
    assert record["triaged_by"] == "orchestrator"
    assert record["delta_id"] == generation["delta_id"]
    assert record["generation_id"] == generation["generation_id"]
    # The generation itself is untouched: a real finding still blocks the close.
    after_gen = selected_generation(repo, "ENG-1", "T2")
    assert after_gen["generation_id"] == generation["generation_id"]
    assert len(after_gen["lenses"]["security"]["blocking_findings"]) == 1
    assert untriaged_blocking(repo, "ENG-1", "T2") == (0, 1)

    after = _review_findings_section(repo, _t2_task(repo), "ENG-1")
    assert "1 of 1 triaged by the host" in after
    assert "HOST TRIAGE (real, orchestrator): proof src/work.py:1." in after
    assert "Fix at EVERY one of: src/work.py:1, src/other.py:2." in after
    assert "Keep unchanged: the 409 branch keeps reconciling" in after
    assert "none recorded" not in after

    # Triaging the same finding again replaces the record rather than stacking.
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--real", "--evidence", "src/other.py:1",
                    "--instance", "src/other.py:1", "--by", "orchestrator")
    assert code == 0, out
    records = load_json(_triage_file(repo), default={})["findings"]
    assert len(records) == 1 and records[0]["evidence"] == "src/other.py:1"


def test_a_triage_rests_on_lines_that_exist(repo, tmp_path):
    _built(repo, tmp_path, [HARD])
    base_args = ["forge.py", "review", "T2", "--triage", "stays editable",
                 "--lens", "security", "--real", "--by", "orchestrator"]
    code, out = run(repo, *base_args, "--evidence", "src/nope.py:1",
                    "--instance", "src/work.py:1")
    assert code != 0 and "src/nope.py:1 names a file that does not exist" in out, out
    code, out = run(repo, *base_args, "--evidence", "src/work.py:40",
                    "--instance", "src/work.py:1")
    assert code != 0 and "src/work.py:40 is past the end of the file (3 line(s))" in out, out
    code, out = run(repo, *base_args, "--evidence", "src/work.py",
                    "--instance", "src/work.py:1")
    assert code != 0 and "--evidence must be <file>:<line>" in out, out
    code, out = run(repo, *base_args, "--evidence", "src/work.py:1")
    assert code != 0 and "--real needs at least one --instance" in out, out
    code, out = run(repo, *base_args, "--evidence", "src/work.py:1",
                    "--instance", "src/work.py:9")
    assert code != 0 and "--instance src/work.py:9 is past the end" in out, out
    # Nothing was recorded by any refused attempt.
    assert not _triage_file(repo).exists()
    # Exactly one verdict flag.
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--evidence", "src/work.py:1", "--by", "o")
    assert code != 0 and "exactly one of --real or --not-a-defect" in out, out


def test_not_a_defect_rejects_on_a_proof_line_without_a_citation(repo, tmp_path):
    _built(repo, tmp_path, [HARD, OTHER])
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--not-a-defect", "--evidence", "src/work.py:1",
                    "--by", "orchestrator")
    assert code != 0 and "--not-a-defect needs --reason" in out, out
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--not-a-defect", "--evidence", "src/work.py:1",
                    "--reason", "request() already throws on a non-2xx before .json()",
                    "--by", "orchestrator")
    assert code == 0, out
    assert "Rejected security finding" in out and "proof: src/work.py:1" in out
    generation = selected_generation(repo, "ENG-1", "T2")
    assert generation["origin"] == "rejection"
    security = generation["lenses"]["security"]
    assert len(security["blocking_findings"]) == 1
    assert "replays a decision" in security["blocking_findings"][0]["summary"]
    entry = security["rejected_findings"][0]
    assert "stays editable" in entry["finding"]["summary"]
    # The generation format is unchanged: the line travels as the citation.
    assert entry["cite"] == "evidence src/work.py:1"
    lessons = list((repo / "plans" / "lessons").glob("review-rejection-*.json"))
    assert any("Not a defect (evidence src/work.py:1)" in p.read_text(encoding="utf-8")
               for p in lessons)
    report = rejected_findings_report(repo, "ENG-1", "T2")
    assert "cites: evidence src/work.py:1" in report
    # The other finding is still blocking, and still untriaged.
    assert untriaged_blocking(repo, "ENG-1", "T2") == (1, 1)
    # `--reject` accepts the same ground directly, and still needs one of the two.
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "replays a decision",
                    "--lens", "security", "--reason", "r", "--by", "orchestrator")
    assert code != 0 and "--cite or --evidence must be non-empty" in out, out
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "replays a decision",
                    "--lens", "security", "--reason", "the saved body is what the retry "
                    "sends, and the screen re-reads it", "--evidence", "src/other.py:2",
                    "--by", "orchestrator")
    assert code == 0 and "proof: src/other.py:2" in out, out
    assert "review stamp recorded" in out
    assert untriaged_blocking(repo, "ENG-1", "T2") == (0, 0)


def test_a_triage_of_an_older_review_does_not_dress_the_new_one(repo, tmp_path):
    _built(repo, tmp_path, [HARD])
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--real", "--evidence", "src/work.py:1",
                    "--instance", "src/work.py:1", "--by", "orchestrator")
    assert code == 0, out
    assert untriaged_blocking(repo, "ENG-1", "T2") == (0, 1)
    # The diff moves. A triage cannot be recorded against a review the diff
    # has outrun, and once the review runs again and raises the same words,
    # that is a new claim about new code: the old triage says nothing about it.
    (repo / "src" / "later.py").write_text("more work\n")
    git(repo, "add", "src/later.py")
    git(repo, "commit", "-q", "-m", "T2 more work")
    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--real", "--evidence", "src/work.py:1",
                    "--instance", "src/work.py:1", "--by", "orchestrator")
    assert code != 0 and "cannot triage from selected proof" in out and "stale" in out, out
    _write_complete_automated(repo, "T2")
    _publish(repo, [HARD])
    assert untriaged_blocking(repo, "ENG-1", "T2") == (1, 1)
    assert "HOST TRIAGE: none recorded" in _review_findings_section(
        repo, _t2_task(repo), "ENG-1")


def test_delegate_warns_on_untriaged_findings_and_goes_quiet_once_triaged(repo, tmp_path):
    from forge_cli.delegate import diagnostic_briefs_dir
    _built(repo, tmp_path, [HARD])
    code, out = run(repo, "forge.py", "delegate", "T2", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out
    assert "WARNING: 1 of 1 blocking finding(s) on T2 are untriaged" in out
    assert "review T2 --triage" in out
    brief = (diagnostic_briefs_dir(repo) / "T2.md").read_text(encoding="utf-8")
    assert "0 of 1 triaged by the host" in brief
    assert "HOST TRIAGE: none recorded" in brief

    code, out = run(repo, "forge.py", "review", "T2", "--triage", "stays editable",
                    "--lens", "security", "--real", "--evidence", "src/work.py:1",
                    "--instance", "src/work.py:1", "--keep", "the busy flag as it is",
                    "--by", "orchestrator")
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T2", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out
    assert "WARNING" not in out
    brief = (diagnostic_briefs_dir(repo) / "T2.md").read_text(encoding="utf-8")
    assert "1 of 1 triaged by the host" in brief
    assert "HOST TRIAGE (real, orchestrator): proof src/work.py:1." in brief
    assert "Fix at EVERY one of: src/work.py:1." in brief
    assert "Keep unchanged: the busy flag as it is" in brief


def test_the_contract_and_the_adapter_say_triage_comes_before_the_fix_round():
    workflow = (HARNESS / "WORKFLOW.md").read_text(encoding="utf-8")
    assert "never relays a finding unread" in workflow and "--triage" in workflow
    adapter = (HARNESS / ".claude" / "CLAUDE.md").read_text(encoding="utf-8")
    assert "TRIAGE before every fix round" in adapter
    assert list((HARNESS / "docs" / "decisions").glob("0075-*.md"))
    hint_source = (HARNESS / "factory" / "scripts" / "forge_cli" / "review.py").read_text(
        encoding="utf-8")
    assert "triage them yourself" in hint_source
