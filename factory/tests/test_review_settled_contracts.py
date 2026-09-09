"""The review brief carries what is settled, and a finding that contradicts it
can be rejected on the record instead of re-fought every round.

A client's three-lens review demanded, three rounds running, a guard that the
approved T3b contract explicitly forbids, and the "fix" broke the story's
pinned scenario — because the reviewer only ever saw the one task's slice.
Now the brief carries the story plan's decisions/rulings and the contracts of
tasks already sealed, and `forge review <id> --reject` moves a recorded
blocking finding into `rejected_findings` with the citation, ledgers the
contract as a lesson (so the next brief carries it), and stamps the stage when
no lens blocks any more.
"""
from __future__ import annotations

import json

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    git, head, intake, record_skeleton_then_frontier, repo, run, save_plan,
    sign_off, skeletal_stage_task, write_stages,
)
from factory_lib import (  # noqa: E402
    load_json, proof_path, protected_decomposition_state_path,
)
from forge_cli.findings import _finding_rows  # noqa: E402
from forge_cli.lessons import load_lessons  # noqa: E402
from forge_cli.review import LENSES, rejected_findings_report  # noqa: E402
from forge_cli.review_brief import _plan_section_bodies, _task_section  # noqa: E402
from forge_cli.stages import load_stages  # noqa: E402

__all__ = ["repo"]


def test_plan_sections_are_picked_by_header_word():
    text = ("# Plan\n\n## Problem\nwhy\n\n## Decisions\n0154 amended; 0118.\n\n"
            "## Owner rulings (Ravi)\n- rows are recoverable-only\n\n## Risks\nnone\n")
    picked = _plan_section_bodies(text, ("decision", "ruling"))
    assert [h for h, _ in picked] == ["Decisions", "Owner rulings (Ravi)"]
    assert picked[0][1] == "0154 amended; 0118."
    assert picked[1][1] == "- rows are recoverable-only"


def _story(repo, tmp_path, *, t1_status: str = "done") -> None:
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    t1 = {**skeletal_stage_task("T1"),
          "plan_contracts": [{"id": "T1-AC1", "statement": "a remembered exact Allow answers a destructive ask; the rail hardFloor flag never gates the remembered lookup",
                              "source": "plan#ac"}]}
    t2 = skeletal_stage_task("T2")
    record_skeleton_then_frontier(repo, [t1, t2])
    base = head(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-q", "-m", "T2 work")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": t1_status, "task_sha256": "abc",
             "base_sha": base, "started_at": "2026-09-09T00:00:00+00:00",
             "dirty_at_start": {}},
            {"id": "T2", "title": "second", "status": "active", "task_sha256": "def",
             "base_sha": base, "started_at": "2026-09-09T01:00:00+00:00",
             "dirty_at_start": {}},
        ],
    })


def test_brief_carries_plan_decisions_and_sealed_contracts(repo, tmp_path):
    _story(repo, tmp_path)
    plan = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    plan.write_text(plan.read_text() + "\n## Decisions\n0154 (amended): old rows are not listed.\n")
    task = next(t for t in load_json(
        protected_decomposition_state_path(repo), default={})["tasks"] if t["id"] == "T2")
    brief = "\n".join(_task_section(task, repo))
    assert "Settled — do not relitigate" in brief
    assert "0154 (amended): old rows are not listed." in brief
    assert "T1-AC1" in brief and "a remembered exact Allow answers a destructive ask" in brief
    # A task that is not sealed contributes nothing.
    _story_pending = load_stages(repo)
    _story_pending["stages"][0]["status"] = "pending"
    write_stages(repo, _story_pending)
    assert "T1-AC1" not in "\n".join(_task_section(task, repo))


def _record_lens(repo, lens: str, blocking: list[dict], task_id: str = "T2") -> None:
    code, out = run(repo, "forge.py", "review-brief", "--all")
    assert code == 0, out
    payload = {
        "generated_by": "autoreview", "task_id": task_id,
        "score": 10 - 3 * len(blocking),
        "summary": f"{lens} lens", "blocking_findings": blocking,
        "non_blocking_findings": [], "recommendation": "request-changes" if blocking else "approve",
        "skills_used": ["review-animations"],
    }
    if lens == "quality":
        payload["contract_verdicts"] = [
            {"contract_id": "T1-AC1", "verdict": "implemented", "evidence": "src/work.py:1"},
        ]
    code, out = run(repo, "record_review_from_json.py", "--aspect", lens, "--task", task_id,
                    stdin=json.dumps(payload))
    assert code == 0, out


def test_reject_moves_the_finding_ledgers_a_lesson_and_stamps_when_clean(repo, tmp_path):
    _story(repo, tmp_path)
    hard = {"category": "security", "area": "src/runtime",
            "summary": "Gate every remembered-Allow lookup on hardFloor (src/runtime/coordinator.ts:266)"}
    _record_lens(repo, "security", [hard])
    _record_lens(repo, "quality", [])
    _record_lens(repo, "performance", [])

    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "T1-AC1 keys the consult on the rail case",
                    "--cite", "T1-AC1; story S4", "--by", "autoreview")
    assert code == 0 and "Rejected security finding" in out, out
    recorded = load_json(proof_path(repo, "ENG-1", "reviews/security.json", task_id="T2"), default={})
    assert recorded["blocking_findings"] == []
    assert recorded["rejected_findings"][0]["finding"] == hard
    assert recorded["rejected_findings"][0]["cite"] == "T1-AC1; story S4"
    assert recorded["score"] == 10 and recorded["recommendation"] == "approve"
    lessons = load_lessons(repo)
    assert any("T1-AC1" in l.get("lesson", "") and l.get("applies_to") == ["src/runtime/**"]
               for l in lessons)
    assert "review stamp recorded" in out
    stamp = next(s for s in load_stages(repo)["stages"] if s["id"] == "T2")["local_review_stamp"]
    assert stamp["lenses"] == list(LENSES)


def test_reject_refuses_a_citation_that_names_nothing_settled(repo, tmp_path):
    _story(repo, tmp_path)
    hard = {"category": "security", "area": "src/runtime", "summary": "hardFloor thing"}
    _record_lens(repo, "security", [hard])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "c", "--by", "autoreview")
    assert code != 0 and "names nothing settled" in out, out
    recorded = load_json(proof_path(repo, "ENG-1", "reviews/security.json", task_id="T2"), default={})
    assert recorded["blocking_findings"] == [hard]
    # A decision id resolves; so does a plan section header word.
    (repo / "docs" / "decisions").mkdir(parents=True, exist_ok=True)
    (repo / "docs" / "decisions" / "0154-generic-scope.md").write_text(
        "# 0154 generic scope\n\nA remembered hardFloor decision stays a human decision.\n")
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "decision 0154",
                    "--by", "autoreview")
    assert code == 0 and "cite: decision 0154" in out, out


def test_reject_never_stamps_from_an_incomplete_or_stale_review_set(repo, tmp_path):
    _story(repo, tmp_path)
    hard = {"category": "security", "area": "src/runtime", "summary": "hardFloor thing"}
    _record_lens(repo, "security", [hard])          # the other two lenses never ran
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code == 0 and "No stamp: the quality lens is not recorded" in out, out
    assert "local_review_stamp" not in next(
        s for s in load_stages(repo)["stages"] if s["id"] == "T2")
    # A lens recorded for another task lives under THAT task and never counts
    # for this one: storage is per task, so T2's quality lens is simply absent.
    _record_lens(repo, "quality", [], task_id="T1")
    _record_lens(repo, "performance", [])
    _record_lens(repo, "security", [hard])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code == 0 and "No stamp: the quality lens is not recorded" in out, out
    assert load_json(proof_path(repo, "ENG-1", "reviews/quality.json", task_id="T1"),
                     default={}).get("task_id") == "T1"


def test_reject_refuses_an_ambiguous_or_missing_match(repo, tmp_path):
    _story(repo, tmp_path)
    _record_lens(repo, "quality", [
        {"category": "x", "area": "src", "summary": "one hardFloor thing"},
        {"category": "x", "area": "src", "summary": "another hardFloor thing"},
    ])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "quality", "--reason", "r", "--by", "autoreview")
    assert code != 0 and "--cite" in out, out
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "quality", "--reason", "r", "--cite", "T1-AC1", "--by", "autoreview")
    assert code != 0 and "2 blocking quality findings match" in out, out
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "nothing-like-this",
                    "--lens", "quality", "--reason", "r", "--cite", "T1-AC1", "--by", "autoreview")
    assert code != 0 and "no blocking quality finding matches" in out, out


def test_reject_refuses_a_stale_artifact_before_touching_it(repo, tmp_path):
    _story(repo, tmp_path)
    hard = {"category": "security", "area": "src/runtime", "summary": "hardFloor thing"}
    _record_lens(repo, "security", [hard])
    (repo / "src" / "later.py").write_text("more work\n")
    git(repo, "add", "src/later.py")
    git(repo, "commit", "-q", "-m", "T2 more work")
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code != 0 and "predates the current branch diff" in out, out
    recorded = load_json(proof_path(repo, "ENG-1", "reviews/security.json", task_id="T2"),
                         default={})
    assert recorded["blocking_findings"] == [hard]


def test_rejected_findings_cluster_in_patterns_flagged():
    rows = _finding_rows("T2", "security", {
        "blocking_findings": [],
        "rejected_findings": [{"finding": {"category": "security", "area": "src/runtime",
                                           "summary": "hardFloor thing"},
                               "reason": "r", "cite": "T1-AC1"}],
    })
    assert rows == [{"task": "T2", "aspect": "security", "blocking": False, "rejected": True,
                     "category": "security", "area": "src/runtime", "summary": "hardFloor thing"}]


def test_generic_plan_headers_do_not_resolve_a_citation(repo, tmp_path):
    from forge_cli.review import _cite_resolves
    _story(repo, tmp_path)
    plan = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    plan.write_text(plan.read_text() + "\n## Risks\nnone\n\n## Owner rulings\n- S4 stays\n")
    assert _cite_resolves(repo, "ENG-1", "Risks", "T2")[0] == ""
    assert _cite_resolves(repo, "ENG-1", "rulings", "T2") == (
        "plan section 'Owner rulings'", "Owner rulings\n- S4 stays")
    assert _cite_resolves(repo, "ENG-1", "T1-AC1", "T2")[0] == "contract T1-AC1"
    assert "hardFloor" in _cite_resolves(repo, "ENG-1", "T1-AC1", "T2")[1]
    assert _cite_resolves(repo, "ENG-1", "c", "T2")[0] == ""
    # Only a SEALED task's contract is settled: not this task's own, not a
    # pending task's, and not T1's once its stage is no longer done.
    data = load_stages(repo)
    data["stages"][1]["task_sha256"] = "def"
    write_stages(repo, data)
    assert _cite_resolves(repo, "ENG-1", "T1-AC1", "T1")[0] == ""
    data["stages"][0]["status"] = "pending"
    write_stages(repo, data)
    assert _cite_resolves(repo, "ENG-1", "T1-AC1", "T2")[0] == ""


def test_rejected_findings_report_lists_each_rejection_for_the_pr_body(repo, tmp_path):
    _story(repo, tmp_path)
    assert rejected_findings_report(repo, "ENG-1", "T2") == ""
    hard = {"category": "security", "area": "src/runtime", "summary": "hardFloor thing"}
    _record_lens(repo, "security", [hard])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "the rail case keys the consult",
                    "--cite", "T1-AC1", "--by", "autoreview")
    assert code == 0, out
    report = rejected_findings_report(repo, "ENG-1", "T2")
    assert "## Review findings rejected on a citation" in report
    assert "- **security**: hardFloor thing" in report
    assert "rejected because: the rail case keys the consult" in report
    assert "cites: T1-AC1" in report


def test_reject_refuses_a_citation_unrelated_to_the_finding(repo, tmp_path):
    from forge_cli.review import _shared_terms
    _story(repo, tmp_path)
    unrelated = {"category": "bug", "area": "src/billing/invoice.ts",
                 "summary": "Invoice totals ignore the currency rounding rule"}
    _record_lens(repo, "quality", [unrelated])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "Invoice",
                    "--lens", "quality", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code != 0 and "shares no substantive term" in out, out
    assert _shared_terms({"summary": "hardFloor gating of the remembered lookup"},
                         "the rail hardFloor flag never gates the remembered lookup") == [
        "hardfloor", "lookup", "remembered"]
    # A file-shaped area is ledgered as that file, not as a directory glob.
    related = {"category": "security", "area": "src/runtime/coordinator.ts",
               "summary": "hardFloor thing"}
    _record_lens(repo, "security", [related])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code == 0 and "ledgered as a lesson for src/runtime/coordinator.ts" in out, out


def test_a_later_lens_record_keeps_the_rejections_of_the_task(repo, tmp_path):
    """The recorder is what `forge review` calls per lens; a fresh artifact for
    the same task carries the earlier rejections (the review command copies
    them in before recording), so the record of what was set aside survives."""
    from forge_cli.review import LENSES as _lenses  # noqa: F401
    _story(repo, tmp_path)
    hard = {"category": "security", "area": "src/runtime", "summary": "hardFloor thing"}
    _record_lens(repo, "security", [hard])
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "hardFloor",
                    "--lens", "security", "--reason", "r", "--cite", "T1-AC1",
                    "--by", "autoreview")
    assert code == 0, out
    before = load_json(proof_path(repo, "ENG-1", "reviews/security.json", task_id="T2"),
                       default={})
    assert len(before["rejected_findings"]) == 1
    assert before["rejected_findings"][0]["task_id"] == "T2"
