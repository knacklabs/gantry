"""Per-task review measures the TASK's delta and carries the lessons in force.

Two 2026-09-04 defects from the first per-task review on a client repo:
- the trunk had been merged into the task branch after the stage began, and
  `forge review` diffed from the stage's recorded base, so the bundle carried
  the whole vendored-harness delta, chunked into three passes, scored 0 on
  findings against code the task never touched, and recorded every contract
  as `partial` because the chunked reviewer never reached the verdict lines;
- the brief carried no lessons, so the reviewer re-raised as P1 the exact
  behaviour a recorded lesson pins as deliberate.
"""
from __future__ import annotations

import base64
import json
import copy
import hashlib
import subprocess

import pytest

from test_gates import (  # noqa: I001 — test_gates puts factory/scripts on sys.path
    DECOMP, _write_complete_automated, git, head, intake, record_task_grill, repo,
    run, save_plan, sign_off, skeletal_stage_task, task_skeleton,
)
from forge_cli.review import (  # noqa: E402
    _actual_passes, _project_combined_report, _tagged_finding, resolve_review_base,
)

__all__ = ["repo"]


def _combined_explanation(quality: str, performance: str, security: str) -> str:
    return (
        f"BEGIN FORGE ASSESSMENT quality\n{quality}\nEND FORGE ASSESSMENT quality\n"
        f"BEGIN FORGE ASSESSMENT performance\n{performance}\n"
        f"END FORGE ASSESSMENT performance\n"
        f"BEGIN FORGE ASSESSMENT security\n{security}\nEND FORGE ASSESSMENT security"
    )


def _combined_finding(lens: str, title: str, path: str, line: int) -> dict:
    return {
        "title": f"[{lens}] {title}", "body": "evidence", "priority": "P2",
        "confidence": 0.9, "category": "bug", "source_attribution": None,
        "code_location": {"file_path": path, "line": line},
    }


def _provider_report(explanation: str, findings: list[dict]) -> dict:
    return {
        "findings": findings,
        "overall_correctness": "patch is incorrect" if findings else "patch is correct",
        "overall_explanation": explanation,
        "overall_confidence": 0.9,
    }


def _processed(provider: dict, **metadata) -> dict:
    return {**copy.deepcopy(provider), "provider_report": copy.deepcopy(provider), **metadata}


def _pass(label: str, provider: dict, **metadata) -> dict:
    return {"label": label, "report": _processed(provider, **metadata)}


def test_combined_review_projects_tagged_lenses_and_preserves_ordered_pass_verdicts():
    task = {"id": "T1", "plan_contracts": [
        {"id": "T1-C1", "statement": "works", "source": "plan"},
    ]}
    first = _provider_report(_combined_explanation(
        "VERDICT T1-C1: implemented — src/a.py:1", "fast", "safe"), [
            _combined_finding("performance", "Avoid repeat work", "src/a.py", 4),
        ])
    category_distinct = _combined_finding(
        "performance", "Avoid repeat work", "src/a.py", 4)
    category_distinct["category"] = "maintainability"
    second = _provider_report(_combined_explanation(
        "VERDICT T1-C1: partial — src/a.py:8 race", "bounded", "isolated"), [
            category_distinct,
            _combined_finding("security", "Validate token", "src/b.py", 9),
        ])
    merged_performance = copy.deepcopy(first["findings"][0])
    merged_performance["body"] = "chunk 1/2:\n\nevidence"
    merged_distinct = copy.deepcopy(second["findings"][0])
    merged_distinct["body"] = "chunk 2/2:\n\nevidence"
    merged_security = copy.deepcopy(second["findings"][1])
    merged_security["body"] = "chunk 2/2:\n\nevidence"
    report = {
        "overall_explanation": "Review passes returned.",
        "overall_correctness": "patch is incorrect", "overall_confidence": 0.9,
        "findings": [merged_performance, merged_distinct, merged_security],
        "pass_reports": [_pass("chunk 1/2", first), _pass("chunk 2/2", second)],
        "review_status": "findings",
    }

    lenses = _project_combined_report(
        task, report, ["src/a.py", "src/b.py"], "a" * 40, "b" * 40, [], [task], {"T1": "active"}, ())

    assert lenses["quality"]["contract_verdicts"] == [{
        "contract_id": "T1-C1", "verdict": "partial", "evidence": "src/a.py:8 race",
    }]
    assert lenses["performance"]["non_blocking_findings"][0]["summary"].startswith(
        "Avoid repeat work (src/a.py:4)")
    assert len(lenses["performance"]["non_blocking_findings"]) == 1
    assert lenses["performance"]["non_blocking_findings"][0] == {
        "category": "bug", "area": "src",
        "summary": "Avoid repeat work (src/a.py:4): evidence.",
        "file_path": "src/a.py", "line": 4, "title": "Avoid repeat work",
    }
    assert lenses["security"]["non_blocking_findings"][0]["summary"].startswith(
        "Validate token (src/b.py:9)")


def test_combined_review_refuses_incomplete_noncontiguous_missing_copied_or_mixed_output(capsys):
    from forge_cli.review import _combined_prompt
    assert b"a verdict is a finding record" in _combined_prompt({})
    provider = _provider_report("preface\n" + _combined_explanation(
            "VERDICT C1: implemented — src/a.py:1", "measured", "bounded",
        ).replace(
            "END FORGE ASSESSMENT quality\nBEGIN FORGE ASSESSMENT performance",
            "END FORGE ASSESSMENT quality\nquality follow-up\n"
            "BEGIN FORGE ASSESSMENT performance",
        ).replace(
            "END FORGE ASSESSMENT performance\nBEGIN FORGE ASSESSMENT security",
            "END FORGE ASSESSMENT performance\nperformance follow-up\n"
            "BEGIN FORGE ASSESSMENT security",
        ) + "\nepilogue", [_combined_finding("quality", "One issue", "src/a.py", 3)])
    narrative = _processed(provider, review_status="findings")
    lenses = _project_combined_report(
        {"id": "T1", "plan_contracts": [{"id": "C1"}]}, narrative,
        ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, (),
    )
    assert lenses["quality"]["contract_verdicts"][0]["verdict"] == "implemented"

    for prose in ("preface", "quality follow-up", "measured", "performance follow-up", "bounded", "epilogue"):
        verdict = ("VERDICT C1: implemented — src/a.py:1" if prose == "preface"
                   else "VERDICT\nC1: implemented — src/a.py:1")
        invalid = copy.deepcopy(provider)
        invalid["overall_explanation"] = invalid["overall_explanation"].replace(prose, verdict)
        with pytest.raises(SystemExit):
            _project_combined_report(
                {"id": "T1", "plan_contracts": [{"id": "C1"}]},
                _processed(invalid, review_status="findings"),
                ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())

    for tag in ("[quality]", "[performance]", "[security]"):
        for whitespace in (" ", "\t", "\n", "\N{NO-BREAK SPACE}"):
            for title in (f"{tag}{whitespace}issue",
                          f"issue{whitespace}{tag}{whitespace}detail",
                          f"issue{whitespace}{tag}",
                          "[security],",
                          "validation:[performance]"):
                invalid = _processed(_provider_report(
                    _combined_explanation(
                        "VERDICT C1: implemented — src/a.py:1", "measured", "bounded"),
                    [_combined_finding("quality", title, "src/a.py", 3)]),
                    review_status="findings")
                with pytest.raises(SystemExit):
                    _project_combined_report(
                        {"id": "T1", "plan_contracts": [{"id": "C1"}]}, invalid,
                        ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())
    for title in ("Plain title", "Keep [custom] bracketed text"):
        lens, finding, *_ = _tagged_finding(
            _combined_finding("quality", title, "src/a.py", 3))
        assert (lens, finding["title"]) == ("quality", title)

    mutators = (
        lambda report: report.update(overall_explanation=report["overall_explanation"].replace(
            "BEGIN FORGE ASSESSMENT performance",
            "BEGIN FORGE ASSESSMENT security", 1)),
        lambda report: report["findings"].append(
            _combined_finding("quality", "Same issue", "src/./a.py", 3)),
        lambda report: report["findings"][0].update(title="Missing lens tag"),
        lambda report: report["findings"][0].update(title="[quality]  [security]"),
        lambda report: report["findings"][0].pop("source_attribution"),
        lambda report: report["findings"][0].update(source_attribution={}),
        lambda report: report.pop("overall_correctness"),
        lambda report: report.update(overall_correctness="maybe"),
        lambda report: report.update(overall_correctness=[]),
        lambda report: report.update(overall_confidence=True),
        lambda report: report["findings"][0].pop("body"),
        lambda report: report["findings"][0].update(priority="P4"),
        lambda report: report["findings"][0].update(confidence=1.1),
        lambda report: report["findings"][0].update(category="style"),
        lambda report: report.update(extra=True),
        lambda report: report.pop("provider_report"),
        lambda report: report.update(review_status=[]),
        lambda report: report.update(missing_required_findings=[""]),
        lambda report: report.update(available_source_records=[1]),
        lambda report: report.update(scope_rejected_findings={}),
        lambda report: report.update(scope_rejected_findings=[]),
    )
    for mutate in mutators:
        provider = _provider_report(_combined_explanation(
            "VERDICT C1: implemented — src/a.py:1", "measured", "bounded"), [
                _combined_finding("quality", "Same issue", "src/a.py", 3),
            ])
        report = _processed(provider, review_status="findings")
        mutate(report)
        with pytest.raises(SystemExit):
            _project_combined_report(
                {"id": "T1", "plan_contracts": [{"id": "C1"}]}, report,
                ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())

    provider_findings = [
        _combined_finding("quality", "Same issue", "src/./a.py", 3),
        _combined_finding("security", "  same   ISSUE ", "src/a.py", 3),
    ]
    provider = _provider_report(_combined_explanation(
        "VERDICT C1: implemented — src/a.py:1", "measured", "bounded"),
        provider_findings)
    processed_findings = copy.deepcopy(provider_findings)
    processed_findings[0]["code_location"]["file_path"] = "src/a.py"
    report = _processed(
        provider, findings=processed_findings, review_status="findings")
    capsys.readouterr()
    with pytest.raises(SystemExit):
        _project_combined_report(
            {"id": "T1", "plan_contracts": [{"id": "C1"}]}, report,
            ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())
    assert "cross-lens duplicate normalized finding" in capsys.readouterr().out
    first = _provider_report(_combined_explanation(
        "VERDICT C1: implemented — src/a.py:1", "measured", "bounded"), [
            _combined_finding("quality", "first", "src/a.py", 1)])
    second = _provider_report(first["overall_explanation"], [
        _combined_finding("security", "second", "src/a.py", 2)])
    report = {"overall_explanation": "passes", "overall_correctness": "patch is incorrect",
        "overall_confidence": 0.9, "findings": [*second["findings"], *first["findings"]],
        "pass_reports": [_pass("chunk 1/2", first), _pass("chunk 2/2", second)],
        "review_status": "findings"}
    with pytest.raises(SystemExit):
        _project_combined_report(
            {"id": "T1", "plan_contracts": [{"id": "C1"}]}, report,
            ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())
    report = copy.deepcopy(report)
    report["pass_reports"][0]["report"]["provider_report"].pop("overall_confidence")
    with pytest.raises(SystemExit):
        _project_combined_report(
            {"id": "T1", "plan_contracts": [{"id": "C1"}]}, report,
            ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())

    # Matching fingerprints cannot hide changed finding evidence in the
    # synthesized top-level report.
    report = {"overall_explanation": "passes", "overall_correctness": "patch is incorrect",
        "overall_confidence": 0.9, "findings": [copy.deepcopy(first["findings"][0])],
        "pass_reports": [_pass("chunk 1/1", first)], "review_status": "findings"}
    report["findings"][0]["body"] = "different evidence"
    with pytest.raises(SystemExit):
        _project_combined_report(
            {"id": "T1", "plan_contracts": [{"id": "C1"}]}, report,
            ["src/a.py"], "a" * 40, "b" * 40, [], [], {}, ())

    clean = _provider_report(_combined_explanation(
        "VERDICT C1: implemented — src/a.py:1", "measured", "bounded"), [])
    incorrect = {**clean, "overall_correctness": "patch is incorrect"}
    rejected = _combined_finding("quality", "outside", "outside.py", 1)
    with pytest.raises(SystemExit):
        _actual_passes(clean)
    assert _actual_passes(_processed(clean, review_status="scoped-clean"))[0][1][
        "review_status"] == "scoped-clean"
    for invalid in (
        _processed(incorrect, review_status="incorrect"),
        _processed(incorrect, review_status="incomplete", scope_rejected_findings=[rejected]),
    ):
        with pytest.raises(SystemExit):
            _actual_passes(invalid)

    filtered = _provider_report(clean["overall_explanation"], [{
        **_combined_finding("performance", "P3 only", "src/a.py", 4), "priority": "P3"}])
    chunked = {
        **incorrect, "pass_reports": [
            _pass("chunk 1/2", filtered,
                  priority_filtered_findings=filtered["findings"], findings=[]),
            _pass("chunk 2/2", clean),
        ], "priority_filtered_findings": filtered["findings"], "review_status": "filtered"}
    with pytest.raises(SystemExit):
        _actual_passes(chunked)
    pass_rejected = {
        **clean, "review_status": "scoped-clean",
        "pass_reports": [_pass("chunk 1/1", clean, scope_rejected_findings=[rejected])],
    }
    with pytest.raises(SystemExit):
        _actual_passes(pass_rejected)
    chunked_clean = {**clean, "review_status": "scoped-clean",
                     "pass_reports": [_pass("chunk 1/1", clean)]}
    assert len(_actual_passes(chunked_clean)) == 1
    chunked_provider = {**chunked_clean, "provider_report": clean}
    with pytest.raises(SystemExit):
        _actual_passes(chunked_provider)

    finding = _combined_finding("quality", "Normalized", "src/a.py", 3)
    raw = copy.deepcopy(finding)
    raw["code_location"]["file_path"] = r".\src\a.py"
    assert _actual_passes(_processed(
        _provider_report(clean["overall_explanation"], [raw]),
        findings=[finding], overall_correctness="patch is incorrect",
        review_status="findings"))[0][1]["findings"] == [finding]

    attribution = {"target": "index", "record_id": "r", "source_id": "s",
                   "side": "present", "column": 1, "excerpt": "x"}
    rejected_attribution = {**copy.deepcopy(finding), "source_attribution": attribution,
                            "attribution_rejection_reason": "mixed source refused"}
    with pytest.raises(SystemExit):
        _actual_passes(_processed(
            clean, review_status="incomplete",
            attribution_rejected_findings=[rejected_attribution]))

    for mutate in (
        lambda wrapper: wrapper.update(overall_confidence=0.1),
        lambda wrapper: wrapper.update(findings=[]),
        lambda wrapper: wrapper["findings"][0].update(body="invented"),
        lambda wrapper: wrapper["provider_report"].update(overall_correctness=[]),
        lambda wrapper: wrapper.update(priority_filtered_findings=[finding],
                                       review_status="filtered", findings=[]),
    ):
        invalid = _processed(_provider_report(
            clean["overall_explanation"], [copy.deepcopy(finding)]),
            review_status="findings")
        mutate(invalid)
        with pytest.raises(SystemExit):
            _actual_passes(invalid)

    aggregate = {
        **clean, "overall_correctness": "patch is correct", "review_status": "scoped-clean",
        "pass_reports": [_pass("chunk 1/1", incorrect)],
    }
    with pytest.raises(SystemExit):
        _actual_passes(aggregate)


def test_review_set_recorder_validates_origin_specific_shape_and_raw_bytes(
        repo, tmp_path, monkeypatch):
    from test_review_settled_contracts import _publish, _story
    from factory_lib import protected_decomposition_state_path, validate_review_document
    from forge_cli.review import _combined_prompt, _helper_identity, resolve_skill
    _story(repo, tmp_path)
    generation, _pointer = _publish(repo)
    candidate = {key: value for key, value in generation.items() if key != "generation_id"}
    task = next(item for item in json.loads(
        protected_decomposition_state_path(repo).read_text())["tasks"]
        if item["id"] == "T2")
    prompt = _combined_prompt(task)
    safe_helper = tmp_path / "autoreview"
    safe_helper.write_text("safe helper\n")
    monkeypatch.setenv("AUTOREVIEW", str(safe_helper))
    candidate["helper"] = _helper_identity(resolve_skill(None))[0]
    candidate["input"] = {
        "sha256": hashlib.sha256(prompt).hexdigest(), "bytes": len(prompt),
    }
    malformed = copy.deepcopy(candidate)
    malformed["raw_result"]["bytes"] += 1
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(malformed))
    assert code != 0 and "decoded byte count" in out
    empty_raw = {"encoding": "base64", "sha256": hashlib.sha256(b"").hexdigest(),
                 "bytes": 0, "data": ""}
    empty = copy.deepcopy(candidate)
    empty["raw_result"] = empty_raw
    with pytest.raises(SystemExit, match="valid combined helper report"):
        validate_review_document(repo, empty, allow_missing_generation_id=True)
    selected = repo / ".factory/stories/ENG-1/tasks/T2/reviews/selected.json"
    before_selection = selected.read_bytes()
    for value in (None, 7, [], "invalid"):
        raw = json.dumps(value).encode()
        invalid = copy.deepcopy(candidate)
        invalid["raw_result"] = {
            "encoding": "base64", "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw), "data": base64.b64encode(raw).decode(),
        }
        code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                        stdin=json.dumps(invalid))
        assert code != 0 and "valid combined helper report" in out
        assert selected.read_bytes() == before_selection
    malformed = copy.deepcopy(candidate)
    malformed["origin"] = "rejection"
    malformed["rejection"] = {
        "source_generation_id": generation["generation_id"],
        "source_generation_sha256": _pointer["generation_sha256"],
        "root_generation_id": generation["generation_id"],
        "history": [{"finding_fingerprint": "f" * 64, "reason": "reason",
                     "citation": "T1-AC1", "actor": "autoreview",
                     "lesson_path": "plans/lessons/review-rejection-test.json",
                     "lesson_sha256": "a" * 64}],
    }
    malformed["raw_result"] = empty_raw
    with pytest.raises(SystemExit, match="valid combined helper report"):
        validate_review_document(repo, malformed, allow_missing_generation_id=True)
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(malformed))
    assert code != 0 and "only accepts origin=combined" in out
    fabricated = copy.deepcopy(candidate)
    fabricated["lenses"]["security"]["summary"] = "fabricated clean proof"
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(fabricated))
    assert code != 0 and "do not match the raw helper result" in out

    wrong_helper = copy.deepcopy(candidate)
    wrong_helper["helper"]["sha256"] = "0" * 64
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(wrong_helper))
    assert code != 0 and "installed helper" in out
    wrong_input = copy.deepcopy(candidate)
    wrong_input["input"]["sha256"] = "0" * 64
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(wrong_input))
    assert code != 0 and "current combined prompt" in out

    stale = copy.deepcopy(candidate)
    token_path = repo / ".factory/stories/ENG-1/review-run.json"
    token = json.loads(token_path.read_text())
    token["branch_diff_digest"] = "0" * 64
    token["review_run_id"] = hashlib.sha256(
        (token["brief_sha256"] + token["branch_diff_digest"]).encode()
    ).hexdigest()
    token_path.write_text(json.dumps(token))
    stale["review_run_id"] = token["review_run_id"]
    for lens in stale["lenses"].values():
        lens["review_run_id"] = token["review_run_id"]
    code, out = run(repo, "record_review_from_json.py", "--set", "--task", "T2",
                    stdin=json.dumps(stale))
    assert code != 0 and "current task delta" in out


def _commit(repo, name: str, content: str) -> str:
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(content)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", f"add {name}")
    return head(repo)


def test_review_base_advances_past_a_trunk_merged_after_the_stage_began(repo):
    recorded = head(repo)                       # the stage's recorded base
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-T1")
    task_commit = _commit(repo, "src/task.py", "task work\n")

    # No trunk merge: the recorded base stands.
    assert resolve_review_base(repo, {"base_sha": recorded}, {}, head(repo)) == recorded

    # The trunk moves and is merged INTO the task branch.
    git(repo, "checkout", "-q", "-b", "trunk-work", recorded)
    trunk_commit = _commit(repo, "factory/vendored.py", "harness delta\n")
    git(repo, "update-ref", "refs/remotes/origin/main", trunk_commit)
    git(repo, "checkout", "-q", "feat/ENG-1-T1")
    git(repo, "merge", "-q", "--no-edit", "origin/main")
    tip = head(repo)

    advanced = resolve_review_base(repo, {"base_sha": recorded}, {}, tip)
    assert advanced == trunk_commit
    # The reviewed delta is the task's own work only.
    delta = git(repo, "diff", "--name-only", f"{advanced}...{tip}").splitlines()
    assert delta == ["src/task.py"]
    assert task_commit != tip
    from factory_lib import product_delta_digest
    expected = subprocess.run(
        ["git", "diff", "--binary", "--no-ext-diff", advanced, tip,
         "--", "src/task.py"], cwd=repo, capture_output=True, check=True,
    ).stdout
    historical_delta = product_delta_digest(repo, advanced, tip)
    assert historical_delta == hashlib.sha256(expected).hexdigest()
    (repo / "src/task.py").write_text("later unreviewed edit\n")
    git(repo, "add", "src/task.py")
    assert product_delta_digest(repo, advanced, tip) == historical_delta
    git(repo, "restore", "--source", tip, "--staged", "--worktree", "src/task.py")

    # A trunk that moved WITHOUT being merged does not move the base.
    git(repo, "checkout", "-q", "trunk-work")
    unmerged = _commit(repo, "factory/later.py", "later\n")
    git(repo, "update-ref", "refs/remotes/origin/main", unmerged)
    git(repo, "checkout", "-q", "feat/ENG-1-T1")
    assert resolve_review_base(repo, {"base_sha": recorded}, {}, tip) == trunk_commit

    # A recorded base that is not an ancestor of HEAD is refused, not guessed.
    with pytest.raises(SystemExit):
        resolve_review_base(repo, {"base_sha": unmerged}, {}, tip)


def test_review_base_advances_when_the_recorded_base_is_a_branch_commit(repo):
    """A story branch carried planning commits BEFORE the stage started, so the
    recorded base is a branch commit — neither ancestor nor descendant of the
    trunk point once the trunk is merged in. The trunk point is still the base:
    the branch's own delta since divergence is reviewed, never the trunk's."""
    fork = head(repo)
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-story")
    _commit(repo, "plans/story-plan.md", "planning\n")
    recorded = head(repo)                       # stage started here, on the branch
    _commit(repo, "src/task.py", "task work\n")

    git(repo, "checkout", "-q", "-b", "trunk-work", fork)
    trunk_commit = _commit(repo, "factory/vendored.py", "harness delta\n")
    git(repo, "update-ref", "refs/remotes/origin/main", trunk_commit)
    git(repo, "checkout", "-q", "feat/ENG-1-story")
    git(repo, "merge", "-q", "--no-edit", "origin/main")
    tip = head(repo)

    advanced = resolve_review_base(repo, {"base_sha": recorded}, {}, tip)
    assert advanced == trunk_commit
    delta = sorted(git(repo, "diff", "--name-only", f"{advanced}...{tip}").splitlines())
    assert delta == ["plans/story-plan.md", "src/task.py"]
    assert "factory/vendored.py" not in delta


def test_review_brief_carries_the_lessons_in_force_for_the_task_paths(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**DECOMP["tasks"][0], "id": "T1", "reviewer_focus": "focus one",
             "acceptance_criteria": ["first statement"],
             "write_scope": ["src/permission/gate.py", "test/gate_test.py"],
             "plan_contracts": [{"id": "C1", "statement": "first statement",
                                  "source": "plan.md#first"}]}
    second = {**skeletal_stage_task("T2", "second slice"), "dependencies": ["T1"]}
    skeletons = [task_skeleton(first), task_skeleton(second)]
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first, skeletons[1]]}))
    assert code == 0, out
    code, out = record_task_grill(repo, first)
    assert code == 0, out
    _write_complete_automated(repo)

    for topic, applies_to in (
        ("soft rail asks keep classifier eligibility", "src/permission/**"),
        ("unrelated discord lesson", "src/channels/discord/**"),
    ):
        code, out = run(repo, "forge.py", "lesson", "add", "--topic", topic,
                        "--lesson", f"{topic} — pinned by test", "--source", "review r1",
                        "--applies-to", applies_to, "--severity", "high",
                        "--by", "orchestrator", "--repo", str(repo))
        assert code == 0, out

    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code == 0, out
    brief = (repo / out.strip()).read_text()
    assert "### Lessons in force" in brief
    assert "soft rail asks keep classifier eligibility" in brief
    assert "pinned by test" in brief
    assert "unrelated discord lesson" not in brief


def test_review_tip_puts_harness_bookkeeping_back_at_the_task_base(repo, tmp_path):
    from forge_cli.review import product_only_tip

    base_sha = head(repo)
    git(repo, "checkout", "-q", "-b", "feat/ENG-1-T1")
    (repo / "plans" / "exploration").mkdir(parents=True, exist_ok=True)
    (repo / "plans" / "exploration" / "grill-r1.md").write_text("x" * 5000)
    (repo / ".factory" / "stories" / "ENG-1").mkdir(parents=True, exist_ok=True)
    (repo / ".factory" / "stories" / "ENG-1" / "verify.json").write_text("{}")
    _commit(repo, "src/task.py", "task work\n")
    git(repo, "add", "-A", "plans", ".factory")
    git(repo, "commit", "-q", "-m", "planning artifacts")
    tip = head(repo)

    worktree = tmp_path / "review-wt"
    git(repo, "worktree", "add", "--detach", str(worktree), tip)
    review_tip = product_only_tip(worktree, base_sha)
    assert review_tip != tip
    delta = sorted(git(worktree, "diff", "--name-only", f"{base_sha}..{review_tip}").splitlines())
    assert delta == ["src/task.py"]
    # The task branch itself is untouched.
    assert head(repo) == tip
    git(repo, "worktree", "remove", "--force", str(worktree))


def test_review_brief_carries_the_recorded_verification_evidence(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**DECOMP["tasks"][0], "id": "T1", "reviewer_focus": "focus one",
             "acceptance_criteria": ["unit suites pass; tsc green"],
             "write_scope": ["src/gate.py"],
             "plan_contracts": [{"id": "C1", "statement": "unit suites pass; tsc green",
                                  "source": "plan.md#first"}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [task_skeleton(first)]}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first]}))
    assert code == 0, out
    code, out = record_task_grill(repo, first)
    assert code == 0, out
    _write_complete_automated(repo)

    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code == 0, out
    brief = (repo / out.strip()).read_text()
    assert "### Approved task inputs" in brief
    assert "#### Full task-owned automated report" in brief
    assert '"status": "passed"' in brief
    assert '"commands_run"' in brief


def test_contract_verdicts_read_every_preserved_pass_report_and_keep_the_worst():
    """A chunked autoreview replaces the top-level explanation with a summary
    line and keeps each pass's conclusions (with its VERDICT lines) under
    pass_reports; the recorder must read those, and when two passes disagree
    the worse verdict wins (a pass that saw a defect is never outvoted by a
    pass that only saw the files exist)."""
    from forge_cli.review import _contract_verdicts

    task = {"id": "T1", "plan_contracts": [
        {"id": "T1-AC1", "statement": "a", "source": "p"},
        {"id": "T1-AC2", "statement": "b", "source": "p"},
        {"id": "T1-AC3", "statement": "c", "source": "p"},
    ]}
    reviewed = {
        "overall_explanation": "Review passes returned. chunk 1/2: 1 finding(s), "
                               "chunk 2/2: 0 finding(s). See preserved pass reports.",
        "findings": [],
        "pass_reports": [
            {"report": {"overall_explanation":
                        "VERDICT T1-AC1: implemented — src/a.py:1 present\n"
                        "VERDICT T1-AC2: partial — src/b.py:9 races the index\n",
                        "findings": []}},
            {"report": {"overall_explanation":
                        "VERDICT T1-AC1: implemented — src/a.py:1\n"
                        "VERDICT T1-AC2: implemented — src/b.py:1 exists\n"
                        "VERDICT T1-AC3: missing — nothing in this chunk\n",
                        "findings": []}},
        ],
    }
    out = {v["contract_id"]: v for v in _contract_verdicts(task, reviewed, [task], {})}
    assert out["T1-AC1"]["verdict"] == "implemented"
    assert out["T1-AC2"]["verdict"] == "partial"
    assert "races the index" in out["T1-AC2"]["evidence"]
    assert out["T1-AC3"]["verdict"] == "missing"
    assert "no VERDICT line" not in out["T1-AC1"]["evidence"]


def test_every_lens_brief_hunts_for_compatibility_leftovers():
    """Owner ruling: no legacy code. Every lens prompt carries the leftover
    instruction (wrappers, shims, aliases, retained symbols, dead branches,
    'legacy' naming are blocking and verdict the contract partial)."""
    from forge_cli.review import _lens_prompt
    from forge_cli.review_brief import LEFTOVER_INSTRUCTION

    task = {"id": "T1", "plan_contracts": [], "reviewer_focus": "focus"}
    for lens in ("quality", "performance", "security"):
        text = _lens_prompt(task, lens).decode()
        assert LEFTOVER_INSTRUCTION in text, lens
        assert "BLOCKING" in LEFTOVER_INSTRUCTION


def test_vendored_client_review_excludes_the_harness_machinery(repo):
    """A re-vendor commit on a task branch put 36 harness files into a client's
    review bundle and the quality lens raised P1s against harness code the task
    never touched. In a vendored client the review drops the same machinery
    prefixes the stage measure already exempts."""
    from forge_cli.review import HARNESS_PREFIXES, review_excluded_prefixes
    from forge_cli.stages import HARNESS_MACHINERY_PATHS, WORKFLOW_PATHS
    marker = repo / "constitution" / "VENDORED_FROM"
    marker.parent.mkdir(exist_ok=True)
    marker.write_text("symphony-forge @ deadbeef\n")
    vendored = review_excluded_prefixes(repo)
    assert "factory/" in vendored and ".claude/" in vendored and "constitution/" in vendored
    assert set(vendored) == set(HARNESS_PREFIXES) | set(WORKFLOW_PATHS) | set(HARNESS_MACHINERY_PATHS)
    marker.unlink()
    harness_only = review_excluded_prefixes(repo)
    assert set(harness_only) == set(HARNESS_PREFIXES) | set(WORKFLOW_PATHS)
    assert "factory/" not in harness_only


def test_a_clients_own_ci_is_product_not_vendored_machinery(repo):
    """`.github/` must NOT be a harness-machinery prefix.

    The harness vendors no workflow into a client — VENDOR_MANIFEST.json has no
    entry under `.github/` — so a client's CI is its own product. While the
    prefix was excluded, the review bundle reset `.github/` to the task base,
    so a lens judging an acceptance criterion that REQUIRES a CI change saw a
    local gate wired to a step that was not there and correctly called the
    criterion partial. Any such criterion was permanently unprovable.
    """
    from forge_cli.review import review_excluded_prefixes
    from forge_cli.stages import HARNESS_MACHINERY_PATHS

    assert ".github/" not in HARNESS_MACHINERY_PATHS
    assert not any(p.startswith(".github") for p in HARNESS_MACHINERY_PATHS)
    # Nor via the composed exclusion list a review bundle actually reads.
    assert ".github/" not in review_excluded_prefixes(repo)
    # The genuinely vendored machinery is still excluded.
    for vendored in ("factory/", "constitution/", ".claude/", ".codex/"):
        assert vendored in HARNESS_MACHINERY_PATHS

    # And nothing under a manifest entry claims .github.
    manifest = repo / "VENDOR_MANIFEST.json"
    if manifest.is_file():
        import json as _json
        entries = _json.loads(manifest.read_text())
        paths = entries if isinstance(entries, list) else entries.get("paths", [])
        assert not [p for p in paths if str(p).startswith(".github")]


def test_an_edit_into_a_sibling_worktree_is_governed_by_that_worktree(repo, tmp_path):
    """An Edit/Write whose absolute target lies outside the session cwd's root
    must be governed by the TARGET checkout's lock and mode window, not the
    cwd's.

    This is the normal shape of orchestration: the session sits in the planning
    worktree while the work happens in a task worktree beside it. Before the
    fix the hook resolved state from the cwd, so such a write was neither
    locked nor counted against a degraded window — it simply escaped
    governance.
    """
    import json as _json
    import subprocess

    sibling = tmp_path / "sibling-worktree"
    subprocess.run(["git", "worktree", "add", "--detach", str(sibling), "HEAD"],
                   cwd=repo, check=True, capture_output=True)
    try:
        target = sibling / "apps" / "core" / "src" / "thing.ts"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export const x = 1;\n")

        code, out = run(repo, "pre_tool_use.py",
                        stdin=_json.dumps({
                            "tool_name": "Edit",
                            "tool_input": {"file_path": str(target)},
                        }),
                        env={"FORGE_PROCESS_TOKEN": "", "FORGE_LAUNCH_ID": ""})
        assert code == 0, out

        # The decision must be made about the SIBLING, so it cites that root's
        # governance rather than silently allowing an ungoverned product write.
        # Either outcome proves the switch happened; an unconditional allow
        # with no reason is the regression this pins.
        assert out.strip(), "the hook returned nothing for a sibling-worktree edit"
        decision = _json.loads(out) if out.strip().startswith("{") else {}
        governed = (
            "deny" in out
            or "lockout" in out
            or "degraded" in out
            or decision.get("hookSpecificOutput", {}).get("permissionDecision")
            in {"deny", "ask"}
        )
        assert governed, (
            "a product write into a sibling worktree was neither denied nor "
            f"claimed by a window — it escaped governance: {out!r}"
        )

        # A NESTED Git root on the way up must not stop the search. A vendored
        # dependency or sub-project carrying its own .git used to be picked as
        # the governing root; it has no factory/scripts, so resolution gave up
        # and fell back to the session cwd — ungoverned again.
        nested = sibling / "vendor" / "sub-project"
        (nested / ".git").mkdir(parents=True, exist_ok=True)
        deep = nested / "apps" / "core" / "src" / "deep.ts"
        deep.parent.mkdir(parents=True, exist_ok=True)
        deep.write_text("export const y = 2;\n")

        code, out = run(repo, "pre_tool_use.py",
                        stdin=_json.dumps({
                            "tool_name": "Edit",
                            "tool_input": {"file_path": str(deep)},
                        }),
                        env={"FORGE_PROCESS_TOKEN": "", "FORGE_LAUNCH_ID": ""})
        assert code == 0, out
        decision = _json.loads(out) if out.strip().startswith("{") else {}
        governed_nested = (
            "deny" in out
            or "lockout" in out
            or "degraded" in out
            or decision.get("hookSpecificOutput", {}).get("permissionDecision")
            in {"deny", "ask"}
        )
        assert governed_nested, (
            "a write beneath a NESTED git root escaped governance — the search "
            f"stopped at the nested root instead of the harness worktree: {out!r}"
        )
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(sibling)],
                       cwd=repo, check=False, capture_output=True)
