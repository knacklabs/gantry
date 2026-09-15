"""Closeout binds to the product diff, and closes with one command.

Marking a task done took longer than building it. The review stamp hashed
the contract text, the brief text and every tracked file; the launch hashed
the contract and the brief; the grill hashed the measurement fields. None of
those is the code a reviewer read, so a scope widening, a decision record or
a contract re-record staled a review of unchanged code -- and one contract
edit orphaned the launch, staled the stamp and staled the grill at once. On
WF-1 T2 that was 4.5 hours, six reviews, one grill, a plan rewrite, a human
re-approval and a no-op Codex launch after a clean build.

Its own module: test_gates.py is one very large file where every added
branch collides with every other.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from test_gates import (  # noqa: F401
    DECOMP, HARNESS, STAGE_TASK, delegation_ledger, fake_gh_env, git, head,
    load_factory_lib, measured_stage, record_stage_local, repo, run,
    stamp_and_commit, start_stage, story_state, write_in_scope,
)

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from factory_lib import (  # noqa: E402
    load_json, plan_digest_without_assumptions, product_delta_digest,
    protected_decomposition_state_path,
)
from forge_cli.stages import (  # noqa: E402
    _legacy_stamp_binding, load_stages, stamp_is_fresh, task_digest, task_for,
)


def _stage(repo: Path, task_id: str = "T1") -> dict:
    return next(s for s in load_stages(repo)["stages"] if s["id"] == task_id)


def _rerecord(repo: Path, task: dict) -> tuple[int, str]:
    return run(repo, "record_decomposition_from_json.py",
               stdin=json.dumps({**DECOMP, "tasks": [task]}))


def _commit_decision(repo: Path, name: str = "0099-mid-stage-call") -> None:
    path = repo / "docs" / "decisions" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# {name}\n\nAnswered a worker signal.\n", encoding="utf-8")
    git(repo, "add", path.relative_to(repo).as_posix())
    git(repo, "commit", "-qm", f"decision {name}")


# ------------------------------------------------- the stamp is about the diff


def test_the_stamp_survives_everything_that_is_not_the_diff(repo, tmp_path):
    """A decision record, a contract re-record, a scope widening: none of
    them change a product byte, so none of them stale the review."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
    stage, task = _stage(repo), task_for(repo, "T1")
    assert stamp_is_fresh(repo, stage, task)
    assert "delta_id" in stage["local_review_stamp"]
    assert "product_tree_digest" not in stage["local_review_stamp"]
    assert "brief_sha256" not in stage["local_review_stamp"]

    _commit_decision(repo)
    assert stamp_is_fresh(repo, _stage(repo), task), "a decision record staled the review"

    code, out = _rerecord(repo, {**STAGE_TASK, "write_scope": ["src/", "lib/"]})
    assert code == 0, out
    assert stamp_is_fresh(repo, _stage(repo), task_for(repo, "T1")), \
        "a contract re-record staled the review"


def test_the_stamp_goes_stale_on_exactly_a_product_change(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py", "version = 1\n")
    stamp_and_commit(repo)
    assert stamp_is_fresh(repo, _stage(repo), task_for(repo, "T1"))
    write_in_scope(repo, "src/core.py", "version = 2\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "the diff moved")
    assert not stamp_is_fresh(repo, _stage(repo), task_for(repo, "T1"))
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "STALE stage-local review stamp" in out, out
    assert "task close T1" in out


# --------------------------------------- the T2 cascade, replayed and ended


def test_stage_done_survives_a_contract_rerecord(repo, tmp_path):
    """The cascade that cost T2 its morning: widen scope -> re-record ->
    launch orphaned + stamp stale + grill stale -> re-grill, re-approve,
    no-op delegate, re-review. Now: widen scope -> re-record -> stage done."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
    ledger = [json.loads(line) for line in
              delegation_ledger(repo).read_text().splitlines()]
    launched_under = ledger[-1]["task_sha256"]

    code, out = _rerecord(repo, {**STAGE_TASK, "write_scope": ["src/", "lib/"]})
    assert code == 0, out
    assert "changed only in how the work is MEASURED" in out
    # The launch that built the code was made under the OLD contract digest
    # and still counts: it proves Codex wrote inside this stage.
    assert task_digest(task_for(repo, "T1")) != launched_under

    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    stage = measured_stage(repo)
    assert stage["status"] == "done"
    assert stage["contract_changed"]["from"] == launched_under


def test_legacy_stamp_converts_in_place_when_still_fresh(repo, tmp_path):
    """Migration without a launch. A stamp recorded under the old rule and
    still fresh by that rule is accepted and given a delta_id on first check;
    one stale under the old rule stays stale."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "work")
    data = load_stages(repo)
    stage = next(s for s in data["stages"] if s["id"] == "T1")
    legacy = {**_legacy_stamp_binding(repo, stage, task_for(repo, "T1")),
              "recorded_at": "2026-09-09T00:00:00+00:00",
              "generated_by": "autoreview"}
    stage["local_review_stamp"] = legacy
    from forge_cli.stages import write_stages
    write_stages(repo, data)

    assert stamp_is_fresh(repo, _stage(repo), task_for(repo, "T1"))
    converted = _stage(repo)["local_review_stamp"]
    assert converted["delta_id"] == product_delta_digest(repo, stage["base_sha"])
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out

    # Stale under the old rule: the tree moved after it was recorded.
    start = None
    data = load_stages(repo)
    stage = next(s for s in data["stages"] if s["id"] == "T1")
    stage["status"] = "active"
    stage.pop("completed_at", None)
    stage["local_review_stamp"] = {**legacy, "product_tree_digest": "0" * 64}
    write_stages(repo, data)
    assert not stamp_is_fresh(repo, _stage(repo), task_for(repo, "T1"))


# -------------------------------------------------------- the grill and plan


def test_the_grill_reads_the_recorded_contract_and_the_amended_scope(repo, tmp_path):
    """The cold reader used to see only the plan's hand-written copy of the
    contract; a path added with amend-scope was invisible to it, which is
    what pushed T2 into re-recording. It now reads the contract itself."""
    from forge_cli.grill import _contract_section
    start_stage(repo, tmp_path, STAGE_TASK)
    section = _contract_section(repo, "task", "T1")
    assert "The contract as recorded" in section
    assert "- src/" in section
    assert "the slice runs green" in section

    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, "lib/helper.py")
    git(repo, "add", "src/core.py", "lib/helper.py")
    git(repo, "commit", "-qm", "touches a path outside scope")
    code, out = run(repo, "forge.py", "stage", "amend-scope", "T1",
                    "--reason", "the helper is the only seam for the criterion")
    assert code == 0, out
    section = _contract_section(repo, "task", "T1")
    assert "lib/helper.py" in section and "only seam" in section


def test_the_task_plan_carries_a_rendered_contract_outside_its_digest(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    plan = story_state(repo) / "task-plans" / "T1.md"
    text = plan.read_text(encoding="utf-8")
    assert "<!-- forge:contract -->" in text and "- src/" in text
    before = plan_digest_without_assumptions(plan)

    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, "lib/helper.py")
    git(repo, "add", "src/core.py", "lib/helper.py")
    git(repo, "commit", "-qm", "touches a path outside scope")
    code, out = run(repo, "forge.py", "stage", "amend-scope", "T1",
                    "--reason", "the helper is the only seam for the criterion")
    assert code == 0, out
    text = plan.read_text(encoding="utf-8")
    assert "lib/helper.py" in text, "the amendment was not rendered into the plan"
    assert plan_digest_without_assumptions(plan) == before, \
        "re-rendering the contract block changed the plan's approval digest"


# --------------------------------------------------------- one command


def _ship_ready(repo: Path, tmp_path: Path) -> dict:
    """A built, reviewed, committed task with an origin and a fake gh."""
    git(repo, "config", "user.email", "test@knacklabs.dev")
    git(repo, "config", "user.name", "Gate Tests")
    remote = tmp_path / "origin.git"
    proc = subprocess.run(["git", "init", "--bare", str(remote)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    if "origin" not in git(repo, "remote").split():
        git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "origin", f"{head(repo)}:refs/heads/main")
    git(repo, "fetch", "-q", "origin")
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
    # The seal pushes the run pointer's branch; the intake fixture names a
    # story branch it never creates. Point it at the branch we are on, as
    # `forge task start` would have (and as prepare_task_pr_ready does).
    control = delegation_ledger(repo).parent
    pointer = json.loads((control / "run.json").read_text(encoding="utf-8"))
    pointer.update({
        "task_id": "T1",
        "branch": git(repo, "symbolic-ref", "--short", "HEAD"),
        "base_main_sha": git(repo, "rev-parse", "origin/main"),
    })
    (control / "run.json").write_text(json.dumps(pointer), encoding="utf-8")
    env, _ = fake_gh_env(tmp_path)
    return env


def test_task_close_goes_from_built_to_pr_and_is_idempotent(repo, tmp_path):
    env = _ship_ready(repo, tmp_path)
    marker = story_state(repo) / "tasks" / "T1" / "pr-ready.json"

    code, out = run(repo, "forge.py", "task", "close", "T1",
                    "--skill", str(tmp_path / "no-such-autoreview"), env=env)
    assert code == 0, out
    # The stamp covered this diff, so no review ran -- the missing skill
    # would have failed it.
    assert "no review needed" in out
    assert measured_stage(repo)["status"] == "done"
    assert marker.is_file()
    sealed_head = head(repo)

    # Run it again with nothing changed: nothing is redone, nothing is
    # re-committed.
    code, out = run(repo, "forge.py", "task", "close", "T1",
                    "--skill", str(tmp_path / "no-such-autoreview"), env=env)
    assert code == 0, out
    assert "already sealed" in out
    assert head(repo) == sealed_head


def test_task_close_reopens_a_done_stage_whose_diff_moved(repo, tmp_path):
    """A post-seal fix used to need `reopen --review-fix` and the whole
    ladder again. Now the same command notices the delta moved, reopens the
    stage itself, and goes straight to the one review the new diff owes."""
    env = _ship_ready(repo, tmp_path)
    code, out = run(repo, "forge.py", "task", "close", "T1",
                    "--skill", str(tmp_path / "no-such-autoreview"), env=env)
    assert code == 0, out

    write_in_scope(repo, "src/core.py", "version = 2\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "post-seal fix")
    code, out = run(repo, "forge.py", "task", "close", "T1",
                    "--skill", str(tmp_path / "no-such-autoreview"), env=env)
    # It got as far as the review -- which is exactly what the new diff owes
    # -- and nothing else was demanded on the way. The review's own inputs
    # (story verify/tests, the autoreview skill) are what stop it here.
    assert code != 0, out
    assert ("autoreview skill not found" in out
            or "is not recorded for ENG-1; review runs after" in out), out
    assert "reopened: the diff moved" in out
    stage = _stage(repo)
    assert stage["status"] == "active"
    assert stage["review_fix_count"] == 1
    assert "local_review_stamp" not in stage
    events = [json.loads(p.read_text()) for p in (repo / ".factory" / "events").glob("*.json")]
    assert any(e.get("event") == "stage-reopened" for e in events)


def test_task_close_runs_the_proof_before_it_spends_a_review(repo, tmp_path):
    """T2 at 08:25: review clean, then stage done found a failing required
    test, then the fix cost a second review. Proof first means the failing
    test is the cheapest possible stop."""
    env = _ship_ready(repo, tmp_path)
    write_in_scope(repo, "src/core.py", "version = 2\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "unreviewed change")
    code, out = _rerecord(repo, {**STAGE_TASK, "verify_commands": ["false"]})
    assert code == 0, out
    code, out = run(repo, "forge.py", "task", "close", "T1",
                    "--skill", str(tmp_path / "no-such-autoreview"), env=env)
    assert code != 0, out
    assert "verify command" in out, out
    assert "autoreview skill not found" not in out, "the review ran before the proof"
    assert "is not recorded for ENG-1" not in out, "the review ran before the proof"


def test_task_close_stops_early_and_names_the_next_step(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "task", "close", "T1")
    assert code != 0, out
    assert "close stopped at tree" in out and "commit the product tree" in out


# ------------------------------------------------- the contracts say close


def test_forge_next_and_the_review_hint_name_close(repo, tmp_path):
    from forge_cli.review import _next_hint
    assert "task close T1" in _next_hint("T1", "active", 0, 0)
    assert "task close T1" in _next_hint("T1", "done", 2, 0)
    phase = (HARNESS / "factory" / "scripts" / "forge_cli" / "phase.py").read_text(encoding="utf-8")
    assert "./forge task close {id}" in phase
    workflow = (HARNESS / "WORKFLOW.md").read_text(encoding="utf-8")
    assert "forge task close <id>" in workflow
    assert "delta_id" in workflow


# --------------------------------------- the review verdict has one source


def _record_quality_with_a_partial_contract(repo: Path) -> None:
    """What the recorder does with a partial verdict: it BECOMES a blocking
    finding in the recorded file, whatever the payload's own list said."""
    code, out = run(repo, "forge.py", "review-brief", "--all")
    assert code == 0, out
    payload = {
        "generated_by": "autoreview", "task_id": "T1", "score": 10,
        "summary": "quality lens", "blocking_findings": [],
        "non_blocking_findings": [], "recommendation": "approve",
        "skills_used": ["review-animations"],
        "contract_verdicts": [
            {"contract_id": "C1", "verdict": "partial", "evidence": "half of it"},
        ],
    }
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    "--task", "T1", stdin=json.dumps(payload))
    assert code == 0, out


def test_the_review_verdict_is_counted_from_what_was_recorded(repo, tmp_path):
    """G2. `forge review` printed blocking=0 from the composed artifact while
    the recorder had written a blocking contract verdict into the file CI
    reads. Two gates, one artifact, two answers."""
    from forge_cli.review import recorded_review_totals
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "work")
    _record_quality_with_a_partial_contract(repo)
    blocking, caveats, recorded = recorded_review_totals(
        repo, "ENG-1", "T1", ("quality",))
    assert blocking == 1 and caveats == 0
    assert recorded["quality"]["blocking_findings"][0]["category"] == "plan-contract-partial"


def test_the_delegate_brief_carries_the_recorded_findings(repo, tmp_path):
    """G4. A fix launch used to get a brief that said nothing about the
    findings it existed to fix; one made zero edits. The recorded findings
    are the channel."""
    from forge_cli.delegate import compose_brief
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "work")
    task = task_for(repo, "T1")
    before = compose_brief(repo, task, write=True, user_facing=False, story="ENG-1")
    assert "Review findings to fix" not in before

    _record_quality_with_a_partial_contract(repo)
    after = compose_brief(repo, task, write=True, user_facing=False, story="ENG-1")
    assert "Review findings to fix" in after
    assert "BLOCKING" in after
    assert "[quality] plan-contract-partial: C1: the slice runs green" in after


# --------------------------------------------- the porcelain parse bug


def test_product_dirty_does_not_eat_the_first_path_character(repo):
    """The first porcelain entry for an unstaged edit starts with a space;
    stripping the output then `line[3:]` cut a character off the path, so a
    dirty `plans/roadmap.json` read as `lans/roadmap.json` and refused a review
    on harness bookkeeping. Every path must come back whole."""
    from forge_cli.review import _product_dirty
    # Two tracked files: one under an excluded prefix, one product.
    (repo / "plans").mkdir(exist_ok=True)
    (repo / "plans" / "roadmap.json").write_text("{}\n", encoding="utf-8")
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "core.py").write_text("v = 1\n", encoding="utf-8")
    git(repo, "add", "plans/roadmap.json", "src/core.py")
    git(repo, "commit", "-qm", "seed")
    assert _product_dirty(repo) == []
    # An UNSTAGED modification to the excluded file is the first entry.
    (repo / "plans" / "roadmap.json").write_text("{\"x\": 1}\n", encoding="utf-8")
    assert _product_dirty(repo) == []
    # A product edit is reported with its full path, whether or not an excluded
    # entry precedes it.
    (repo / "src" / "core.py").write_text("v = 2\n", encoding="utf-8")
    assert _product_dirty(repo) == ["src/core.py"]

