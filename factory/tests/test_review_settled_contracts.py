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

import base64
import copy
import hashlib
import json
import subprocess

import pytest

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    DECOMP, STAGE_TASK, _write_complete_automated, git, head, intake,
    record_skeleton_then_frontier, record_task_grill, repo, run, save_plan,
    sign_off, skeletal_stage_task, write_stages,
)
from factory_lib import (  # noqa: E402
    effective_review_base, load_json, product_delta_digest,
    protected_decomposition_state_path,
    publish_review_generation, read_selected_review_generation,
    review_finding_fingerprint, review_lineage_paths,
)
from forge_cli.findings import _finding_rows  # noqa: E402
from forge_cli.review import (  # noqa: E402
    LENSES, _project_combined_report, rejected_findings_report,
)
from forge_cli.review_brief import _plan_section_bodies, _task_section  # noqa: E402
from forge_cli.stages import load_stages, stage_baseline, task_digest  # noqa: E402

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
    t1_statement = "a remembered exact Allow answers a destructive ask; the rail hardFloor flag never gates the remembered lookup"
    t1 = {**STAGE_TASK, "id": "T1", "title": "first",
          "acceptance_criteria": [t1_statement],
          "plan_contracts": [{"id": "T1-AC1", "statement": t1_statement,
                              "source": "plan#ac"}]}
    t2 = {**STAGE_TASK, "id": "T2", "title": "second",
          "dependencies": ["T1"],
          "acceptance_criteria": ["the next slice runs green"],
          "plan_contracts": [{"id": "T2-AC1", "statement": "the next slice runs green",
                              "source": "plan#ac"}]}
    record_skeleton_then_frontier(repo, [t1, {
        **skeletal_stage_task("T2"), "dependencies": ["T1"]}])
    base = head(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-q", "-m", "T2 work")
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "active", "task_sha256": task_digest(t1),
             "base_sha": base, "started_at": "2026-09-09T00:00:00+00:00",
             "dirty_at_start": {}},
            {"id": "T2", "title": "second", "status": "pending", "task_sha256": "def",
             "base_sha": base, "started_at": "2026-09-09T01:00:00+00:00",
             "dirty_at_start": {}},
        ],
    })
    code, out = record_task_grill(repo, t1)
    assert code == 0, out
    _write_complete_automated(repo, "T1")
    stages = load_stages(repo)
    stages["stages"][0]["status"] = t1_status
    stages["stages"][1]["status"] = "pending"
    write_stages(repo, stages)
    recorded_t1 = next(task for task in load_json(
        protected_decomposition_state_path(repo), default={})["tasks"]
                       if task["id"] == "T1")
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [recorded_t1, t2]}))
    assert code == 0, out
    stages = load_stages(repo)
    stages["stages"][1]["status"] = "active"
    write_stages(repo, stages)
    code, out = record_task_grill(repo, t2)
    assert code == 0, out
    _write_complete_automated(repo, "T2")


def test_brief_carries_plan_decisions_and_sealed_contracts(repo, tmp_path):
    _story(repo, tmp_path)
    plan = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    plan.write_text(plan.read_text() + "\n## Decisions\n0154 (amended): old rows are not listed.\n")
    task = next(t for t in load_json(
        protected_decomposition_state_path(repo), default={})["tasks"] if t["id"] == "T2")
    code, out = record_task_grill(repo, task)
    assert code == 0, out
    brief = "\n".join(_task_section(task, repo))
    assert "Settled — do not relitigate" in brief
    assert "0154 (amended): old rows are not listed." in brief
    assert "T1-AC1" in brief and "a remembered exact Allow answers a destructive ask" in brief
    # A task that is not sealed contributes nothing.
    _story_pending = load_stages(repo)
    _story_pending["stages"][0]["status"] = "pending"
    write_stages(repo, _story_pending)
    assert "T1-AC1" not in "\n".join(_task_section(task, repo))


def _publish(repo, blocking=(), *, recorded_at="2026-09-11T01:00:00+00:00"):
    code, out = run(repo, "forge.py", "review-brief", "--all")
    assert code == 0, out
    token = load_json(repo / ".factory/stories/ENG-1/review-run.json", default={})
    stage = next(row for row in load_stages(repo)["stages"] if row["id"] == "T2")
    review_base = effective_review_base(repo, "T2")
    delta = product_delta_digest(repo, review_base)
    raw_findings = [{"title": f"[security] {item['summary']}", "body": item["summary"],
                     "priority": "P1", "confidence": 1, "category": "security",
                     "source_attribution": None,
                     "code_location": {"file_path": "src/work.py", "line": index}}
                    for index, item in enumerate(blocking, 1)]
    provider = {"findings": raw_findings,
        "overall_correctness": "patch is incorrect" if raw_findings else "patch is correct",
        "overall_confidence": 1, "overall_explanation":
        "BEGIN FORGE ASSESSMENT quality\n"
        "VERDICT T2-AC1: implemented — src/work.py:1\n"
        "END FORGE ASSESSMENT quality\n"
        "BEGIN FORGE ASSESSMENT performance\nfast\n"
        "END FORGE ASSESSMENT performance\n"
        "BEGIN FORGE ASSESSMENT security\nsafe\n"
        "END FORGE ASSESSMENT security"}
    raw = json.dumps({**copy.deepcopy(provider), "provider_report": provider,
        "review_status": "findings" if raw_findings else "scoped-clean"},
        separators=(",", ":")).encode()
    decomposition = load_json(protected_decomposition_state_path(repo), default={})
    tasks = decomposition["tasks"]
    task = next(item for item in tasks if item["id"] == "T2")
    started = {item["id"]: item["status"] for item in load_stages(repo)["stages"]}
    lenses = _project_combined_report(
        task, json.loads(raw), ["src/work.py"], review_base,
        head(repo), [], tasks, started, (),
    )
    for artifact in lenses.values():
        artifact.update({"review_run_id": token["review_run_id"],
                         "brief_sha256": token["brief_sha256"],
                         "branch_diff_digest": delta, "commit": head(repo)})
    candidate = {"format": "forge-review-generation/v1", "origin": "combined",
        "generated_by": "autoreview", "story": "ENG-1", "task_id": "T2",
        "review_run_id": token["review_run_id"], "brief_sha256": token["brief_sha256"],
        "inspected_commit": head(repo), "delta_id": delta,
        "helper": {"path": "/helper", "version": "v1", "sha256": "a" * 64},
        "input": {"sha256": "b" * 64, "bytes": 1},
        "raw_result": {"encoding": "base64", "sha256": hashlib.sha256(raw).hexdigest(),
                       "bytes": len(raw), "data": base64.b64encode(raw).decode()},
        "lenses": lenses, "recorded_at": recorded_at}
    return publish_review_generation(repo, "ENG-1", "T2", candidate)


def test_reject_republishes_one_complete_pointer_selected_set(repo, tmp_path):
    _story(repo, tmp_path)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "commit lifecycle fixture state")
    branch = git(repo, "branch", "--show-current")
    stage = next(row for row in load_stages(repo)["stages"] if row["id"] == "T2")
    recorded_base = stage_baseline(repo, stage)
    git(repo, "checkout", "-q", "-b", "trunk-work", recorded_base)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src/work.py").write_text("trunk work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-qm", "trunk touches task path")
    trunk_commit = head(repo)
    git(repo, "update-ref", "refs/remotes/origin/main", trunk_commit)
    git(repo, "checkout", "-q", branch)
    merge = subprocess.run(
        ["git", "-c", "user.email=test@knacklabs.dev", "-c",
         "user.name=Gate Tests", "merge", "-q", "--no-edit", "origin/main"], cwd=repo,
        capture_output=True, text=True,
    )
    assert merge.returncode != 0
    assert git(repo, "diff", "--name-only", "--diff-filter=U").splitlines() == [
        "src/work.py"
    ]
    (repo / "src/work.py").write_text("task work\n")
    git(repo, "add", "src/work.py")
    git(repo, "commit", "-qm", "resolve trunk merge")
    _write_complete_automated(repo, "T2")

    _publish(repo)
    from forge_cli.review import _review_set_problem
    assert _review_set_problem(repo, "ENG-1", "T2") == ""
    blockers = [
        {"category": "security", "area": "src/runtime",
         "summary": "remembered hardFloor lookup 1"},
        {"category": "security", "area": "src/runtime",
         "summary": "remembered hardFloor lookup 2"},
    ]
    root, first_pointer = _publish(repo, blockers)
    pointer_path = repo / ".factory/stories/ENG-1/tasks/T2/reviews/selected.json"

    def refused(match, cite="T1-AC1"):
        before = pointer_path.read_bytes()
        code, output = run(
            repo, "forge.py", "review", "T2", "--reject", match,
            "--lens", "security", "--reason", "settled contract",
            "--cite", cite, "--by", "autoreview",
        )
        assert code != 0 and pointer_path.read_bytes() == before
        return output

    assert "no blocking" in refused("does not exist")
    assert "narrow it" in refused("lookup")
    plan = next((repo / "plans/active").glob("ENG-1-*.md"))
    plan_before = plan.read_bytes()
    plan.write_text(plan.read_text() + "\n## Cabbages\nleafy vegetable contract\n")
    assert "shares no substantive term" in refused("lookup 1", "Cabbages")
    plan.write_bytes(plan_before)
    valid_pointer = pointer_path.read_bytes()
    copied = json.loads(valid_pointer)
    copied["task_id"] = "COPIED"
    pointer_path.write_text(json.dumps(copied))
    assert "copied" in refused("lookup 1")
    pointer_path.write_bytes(valid_pointer)
    stale = json.loads(valid_pointer)
    stale["delta_id"] = "f" * 64
    pointer_path.write_text(json.dumps(stale))
    assert "stale" in refused("lookup 1")
    pointer_path.write_bytes(valid_pointer)
    pointer_path.write_text(json.dumps(root["lenses"]["security"]))
    assert "selected proof" in refused("lookup 1")
    pointer_path.write_bytes(valid_pointer)
    upgrade = copy.deepcopy(root)
    upgrade.pop("generation_id")
    upgrade["origin"] = "upgrade"
    upgrade["generated_by"] = "upgrade"
    for field in ("review_run_id", "brief_sha256", "helper", "input", "raw_result"):
        upgrade.pop(field)
    upgrade["upgrade"] = {
        "inventory_digest": "c" * 64, "source_kind": "sealed",
        "legacy_artifacts": [
            {"aspect": name, "path": f"reviews/{name}.json",
             "sha256": chr(100 + index) * 64}
            for index, name in enumerate(sorted(LENSES))
        ],
        "sealed_commit": "f" * 40,
    }
    publish_review_generation(repo, "ENG-1", "T2", upgrade)
    assert "selected proof" in refused("lookup 1")
    pointer_path.write_bytes(valid_pointer)
    raw = root["raw_result"]
    quality = root["lenses"]["quality"]
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "lookup 1",
                    "--lens", "security", "--reason", "remembered hardFloor contract",
                    "--cite", "T1-AC1", "--by", "autoreview")
    assert code == 0, out
    assert "1 blocking security finding(s) remain" in out
    first_rejection, first_rejection_pointer, problems = read_selected_review_generation(
        repo, "ENG-1", "T2")
    assert not problems and first_rejection["origin"] == "rejection"
    assert "no blocking" in refused("lookup 1")
    root_path = repo / ".factory/stories/ENG-1/tasks/T2/reviews/generations" / (
        root["generation_id"] + ".json")
    hidden_root = root_path.with_suffix(".missing")
    root_path.rename(hidden_root)
    assert "source is invalid" in refused("lookup 2")
    hidden_root.rename(root_path)
    code, out = run(repo, "forge.py", "review", "T2", "--reject", "lookup 2",
                    "--lens", "security", "--reason", "remembered hardFloor contract",
                    "--cite", "T1-AC1", "--by", "autoreview")
    assert code == 0, out
    assert "review stamp recorded" in out
    selected, pointer, problems = read_selected_review_generation(repo, "ENG-1", "T2")
    assert not problems and selected["origin"] == "rejection"
    assert len(selected["rejection"]["history"]) == 2
    assert selected["rejection"]["source_generation_id"] == first_rejection["generation_id"]
    assert selected["rejection"]["source_generation_sha256"] == (
        first_rejection_pointer["generation_sha256"])
    assert selected["rejection"]["root_generation_id"] == root["generation_id"]
    for entry in selected["rejection"]["history"]:
        lesson = repo / entry["lesson_path"]
        assert lesson.is_file()
        assert hashlib.sha256(lesson.read_bytes()).hexdigest() == entry["lesson_sha256"]
    assert [entry["finding_fingerprint"] for entry in selected["rejection"]["history"]] == [
        review_finding_fingerprint(finding)
        for finding in root["lenses"]["security"]["blocking_findings"]
    ]
    lineage = {path.as_posix() for path in review_lineage_paths(repo, "ENG-1", "T2")}
    assert {
        f".factory/stories/ENG-1/tasks/T2/reviews/generations/{generation_id}.json"
        for generation_id in (
            root["generation_id"], first_rejection["generation_id"],
            selected["generation_id"],
        )
    }.issubset(lineage)
    assert {entry["lesson_path"] for entry in selected["rejection"]["history"]}.issubset(
        lineage)
    assert selected["raw_result"] == raw and selected["lenses"]["quality"] == quality
    assert pointer["generation_id"] != first_pointer["generation_id"]
    assert "lookup 1" in rejected_findings_report(repo, "ENG-1", "T2")
    stages = load_stages(repo)
    next(item for item in stages["stages"] if item["id"] == "T2")["status"] = "done"
    write_stages(repo, stages)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "seal two-rejection lineage")
    assert not git(repo, "status", "--porcelain")


def test_selected_upgrade_generation_requires_exact_sealed_binding(repo, tmp_path):
    _story(repo, tmp_path)
    combined, _ = _publish(repo)
    upgrade = copy.deepcopy(combined)
    upgrade.pop("generation_id")
    upgrade["origin"] = "upgrade"
    upgrade["generated_by"] = "upgrade"
    for field in ("review_run_id", "brief_sha256", "helper", "input", "raw_result"):
        upgrade.pop(field)
    upgrade["upgrade"] = {"inventory_digest": "c" * 64, "source_kind": "sealed",
        "legacy_artifacts": [{"aspect": lens, "path": f"reviews/{lens}.json",
                              "sha256": chr(100 + index) * 64}
                             for index, lens in enumerate(sorted(LENSES))],
        "sealed_commit": "f" * 40}
    publish_review_generation(repo, "ENG-1", "T2", upgrade)
    assert not read_selected_review_generation(
        repo, "ENG-1", "T2", sealed_commit="f" * 40)[2]
    assert "exact sealed binding" in read_selected_review_generation(
        repo, "ENG-1", "T2", sealed_commit="e" * 40)[2][0]


def test_rejection_compare_and_swap_refuses_interleaved_selection(
        repo, tmp_path, monkeypatch):
    import factory_lib as lib

    _story(repo, tmp_path)
    blocker = {"category": "security", "area": "src", "summary": "hardFloor lookup"}
    source, pointer = _publish(repo, [blocker])
    successor = copy.deepcopy(source)
    successor.pop("generation_id")
    successor["origin"] = "rejection"
    successor["recorded_at"] = "2026-09-11T02:00:00+00:00"
    source_finding = source["lenses"]["security"]["blocking_findings"][0]
    lesson_body = b'{"lesson":"settled"}\n'
    lesson_sha = hashlib.sha256(lesson_body).hexdigest()
    lesson_path = f"plans/lessons/review-rejection-{lesson_sha}.json"
    entry = {"finding_fingerprint": review_finding_fingerprint(source_finding), "reason": "r",
             "citation": "T1-AC1", "actor": "autoreview",
             "lesson_path": lesson_path, "lesson_sha256": lesson_sha}
    successor["rejection"] = {"source_generation_id": source["generation_id"],
        "source_generation_sha256": pointer["generation_sha256"],
        "root_generation_id": source["generation_id"], "history": [entry]}
    lens = successor["lenses"]["security"]
    lens["blocking_findings"] = []
    lens["score"], lens["recommendation"] = 10, "approve"
    lens["rejected_findings"] = [{"finding": source_finding, "reason": "r", "cite": "T1-AC1",
        "rejected_at": successor["recorded_at"], "rejected_by": "autoreview", "task_id": "T2"}]
    pointer_path = repo / ".factory/stories/ENG-1/tasks/T2/reviews/selected.json"
    before = pointer_path.read_bytes()
    real_publish = lib._publish_immutable_review_file
    def fail_lesson(root, destination, body):
        if destination == repo / lesson_path:
            raise SystemExit("lesson write failed")
        return real_publish(root, destination, body)
    monkeypatch.setattr(lib, "_publish_immutable_review_file", fail_lesson)
    with pytest.raises(SystemExit, match="lesson write failed"):
        lib.publish_review_generation(
            repo, "ENG-1", "T2", successor,
            expected_source_id=source["generation_id"],
            lesson_records=[(lesson_path, lesson_body)],
        )
    assert pointer_path.read_bytes() == before
    monkeypatch.setattr(lib, "_publish_immutable_review_file", real_publish)
    lib.publish_review_generation(
        repo, "ENG-1", "T2", successor,
        expected_source_id=source["generation_id"],
        lesson_records=[(lesson_path, lesson_body)],
    )
    with pytest.raises(SystemExit, match="selection changed"):
        lib.publish_review_generation(repo, "ENG-1", "T2", successor,
                                      expected_source_id=source["generation_id"])


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
