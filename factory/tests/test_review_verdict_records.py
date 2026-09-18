"""A contract verdict is a finding record, not a line in the capped summary
(decision 0077).

The helper caps overall_explanation at 3,000 characters and forge asked for
one VERDICT line per contract inside it. On WF-1A T1 pass 1 came out at 3,027,
cut mid-word before the security end marker, and the hour-long review was
refused. A record has its own 2,000-character body and there is no limit on
how many a pass carries, so the box no longer grows with the plan.
"""
from __future__ import annotations

import copy
import json
import sys

import pytest

from test_gates import HARNESS  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from forge_cli.review import (  # noqa: E402
    VERDICT_RECORD, _combined_prompt, _project_combined_report,
)

TASK = {"id": "T5", "user_facing": False, "plan_contracts": [
    {"id": "C1", "statement": "the queue is filtered by the server", "source": "plan#ac"},
    {"id": "C2", "statement": "the history read is authorised", "source": "plan#ac"},
]}
SECTIONS = (
    "BEGIN FORGE ASSESSMENT quality\nThe approvals screen never pages past 50.\n"
    "END FORGE ASSESSMENT quality\nBEGIN FORGE ASSESSMENT performance\n"
    "The queue predicate is shared.\nEND FORGE ASSESSMENT performance\n"
    "BEGIN FORGE ASSESSMENT security\nNo unsafe boundary.\nEND FORGE ASSESSMENT security"
)


def _finding(title, body, path="src/work.py", line=1, priority="P3",
             category="maintainability"):
    return {"title": title, "body": body, "priority": priority, "confidence": 1,
            "category": category, "source_attribution": None,
            "code_location": {"file_path": path, "line": line}}


def _report(findings, explanation=SECTIONS):
    provider = {"findings": findings,
                "overall_correctness": "patch is incorrect" if findings else "patch is correct",
                "overall_confidence": 1, "overall_explanation": explanation}
    return {**copy.deepcopy(provider), "provider_report": provider,
            "review_status": "findings" if findings else "scoped-clean"}


def _project(report):
    return _project_combined_report(
        TASK, report, ["src/work.py"], "base", "tip", [], [TASK], {"T5": "active"}, ())


def test_the_prompt_asks_for_records_and_its_box_no_longer_grows_with_the_plan():
    prompt = _combined_prompt(TASK).decode()
    assert "[quality] VERDICT <contract-id>: implemented|partial|missing" in prompt
    assert "never a line in overall_explanation" in prompt
    assert "VERDICT C1: implemented — file:line evidence" not in prompt
    # 200 contracts used to refuse ("boilerplate cannot fit"); now the box
    # holds three assessments whatever the plan's size.
    big = {**TASK, "plan_contracts": [
        {"id": f"C{n}", "statement": "s", "source": "plan#ac"} for n in range(200)]}
    assert _combined_prompt(big)


def test_verdict_records_fill_contract_verdicts_and_never_count_as_findings():
    lenses = _project(_report([
        _finding("[quality] VERDICT C1: partial",
                 "src/work.py:1 fixes the queue to its first 50 rows; totalPages is ignored",
                 priority="P1"),  # even a mis-prioritised record is not a defect
        _finding("[quality] VERDICT C2: implemented",
                 "src/api.py:3 authorises the history read", path="src/api.py", line=3),
        _finding("[quality] Paginate the approval queue",
                 "requests page 1 with limit 50 and renders no pager", priority="P2",
                 category="bug"),
    ]))
    quality = lenses["quality"]
    verdicts = {v["contract_id"]: v for v in quality["contract_verdicts"]}
    assert verdicts["C1"]["verdict"] == "partial"
    assert verdicts["C1"]["evidence"].startswith("src/work.py:1 fixes the queue")
    assert verdicts["C2"]["verdict"] == "implemented"
    assert "src/api.py:3" in verdicts["C2"]["evidence"]
    # The record itself is never a finding, whatever priority it carried; the
    # partial verdict IS the one blocker, fail-closed, in the structured shape.
    assert [f["category"] for f in quality["blocking_findings"]] == ["plan-contract-partial"]
    blocker = quality["blocking_findings"][0]
    assert blocker["summary"].startswith(
        "C1: the queue is filtered by the server — partial: src/work.py:1")
    assert (blocker["file_path"], blocker["line"], blocker["area"]) == ("src/work.py", 1, "plan#ac")
    assert quality["score"] < 8  # below the seal floor: never stamped clean
    assert [f["category"] for f in quality["non_blocking_findings"]] == ["bug"]
    assert not any("VERDICT" in f.get("summary", "") for f in quality["non_blocking_findings"])
    for lens in ("performance", "security"):
        assert lenses[lens]["blocking_findings"] == []


def test_a_legacy_verdict_line_in_the_summary_still_reads_and_the_worst_wins():
    legacy = SECTIONS.replace(
        "The approvals screen never pages past 50.",
        "VERDICT C1: implemented — src/work.py:1\nVERDICT C2: implemented — src/api.py:3\n"
        "The approvals screen never pages past 50.")
    lenses = _project(_report([], explanation=legacy))
    assert {v["contract_id"]: v["verdict"] for v in lenses["quality"]["contract_verdicts"]} == {
        "C1": "implemented", "C2": "implemented"}
    # A record and a line that disagree: the worst verdict wins, as across passes.
    lenses = _project(_report(
        [_finding("[quality] VERDICT C1: missing", "src/work.py:1 no server filter at all")],
        explanation=legacy))
    assert {v["contract_id"]: v["verdict"] for v in lenses["quality"]["contract_verdicts"]} == {
        "C1": "missing", "C2": "implemented"}


def test_a_contract_with_neither_record_nor_line_is_partial_fail_closed():
    lenses = _project(_report([
        _finding("[quality] VERDICT C1: implemented", "src/work.py:1 filters on the server")]))
    verdicts = {v["contract_id"]: v for v in lenses["quality"]["contract_verdicts"]}
    assert verdicts["C2"]["verdict"] == "partial" and "fail-closed" in verdicts["C2"]["evidence"]


def test_a_verdict_record_under_another_lens_is_refused():
    with pytest.raises(SystemExit):
        _project(_report([
            _finding("[security] VERDICT C1: implemented", "src/work.py:1 filters", category="security")]))


def test_the_record_title_form_is_strict():
    assert VERDICT_RECORD.match("VERDICT C7: partial")
    assert VERDICT_RECORD.match("VERDICT WF1-T5-C16: Implemented")
    assert not VERDICT_RECORD.match("VERDICT C7: partial — src/x.py:1")  # evidence goes in the body
    assert not VERDICT_RECORD.match("Paginate the approval queue")
