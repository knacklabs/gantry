"""What actually forces a re-grill, and what must never.

Its own module — test_gates.py is one 690-test file where every added branch
collides with every other.

Measured cost of the old rule on one story: eighteen grill rounds. The grill
bound the WHOLE task contract plus the whole product tree, so resolving a grill
finding — which is done by editing the contract — invalidated the grill that
found it, and committing the implementation invalidated it again. Neither loop
can converge. Raising a review-budget ceiling from 38 files to 58, pure
bookkeeping, cost a full adversarial round.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from factory_lib import GROUNDING_CONTRACT_FIELDS  # noqa: E402


TASK = {
    "id": "T1",
    "title": "core slice",
    "epic_id": "E1",
    "objective": "Build the slice.",
    "acceptance_criteria": ["the slice runs green"],
    "plan_contracts": [{"id": "C1", "statement": "the slice runs green",
                        "source": "plans/active/TEST-1-test-plan.md#ac"}],
    "write_scope": ["src/"],
    "required_tests": [{"id": "t1", "path": "a.spec.ts", "command": "run"}],
    "verify_commands": ["npm test"],
    "user_facing": False,
    "review_budget": {"max_changed_files": 38, "max_changed_lines": 2000,
                      "reason": "foundation"},
    "reviewer_focus": "watch the boundaries",
}


def _seed(repo: Path):
    """A minimal repo where grounding_digest can be derived."""
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    plan = repo / "plans" / "active" / "TEST-1-test-plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# Plan\n\nThe approved story plan.\n", encoding="utf-8")
    lib.dump_json(control / "run.json",
                  {"issue_key": "TEST-1", "plan_file": "plans/active/TEST-1-test-plan.md"})
    lib.dump_json(control / "decomposition.json",
                  {"plan_file": "plans/active/TEST-1-test-plan.md", "tasks": [TASK]})
    return lib


# --------------------------------------------------------------- bookkeeping
@pytest.mark.parametrize("field,value", [
    ("review_budget", {"max_changed_files": 999, "max_changed_lines": 9,
                       "reason": "raised after measuring"}),
    ("reviewer_focus", "a completely rewritten focus"),
    ("title", "renamed"),
    ("epic_id", "E9"),
])
def test_bookkeeping_never_forces_a_regrill(repo: Path, field, value):
    """The signal that interrupted the human to raise a file count.

    A review budget is a stop on runaway scope, not a statement about what the
    task must do. Binding the grill to it meant the human's own instruction —
    "raise it and do not stop again" — was itself a stop.
    """
    lib = _seed(repo)
    before = lib.grounding_digest(repo, TASK, in_stage=True)
    after = lib.grounding_digest(repo, {**TASK, field: value}, in_stage=True)
    assert before == after, f"changing {field} forced a re-grill"


# --------------------------------------------------------------- substantive
@pytest.mark.parametrize("field,value", [
    ("objective", "Build something else entirely."),
    ("acceptance_criteria", ["a different bar for done"]),
    ("plan_contracts", [{"id": "C9", "statement": "different", "source": "x"}]),
    ("write_scope", ["src/", "apps/api/src/NEW.ts"]),
    ("required_tests", [{"id": "t2", "path": "b.spec.ts", "command": "run"}]),
    ("verify_commands", ["npm run other"]),
    ("user_facing", True),
])
def test_changing_what_the_work_is_forces_a_regrill(repo: Path, field, value):
    # The gate has to keep working. Narrowing write_scope or adding a required
    # test changes what was authorised, and the grill that read the old version
    # does not speak to the new one.
    lib = _seed(repo)
    before = lib.grounding_digest(repo, TASK, in_stage=True)
    after = lib.grounding_digest(repo, {**TASK, field: value}, in_stage=True)
    assert before != after, f"changing {field} did NOT force a re-grill"


def test_every_substantive_field_is_actually_bound(repo: Path):
    # A field named in the tuple but absent from the payload would be silently
    # unbound — the shape of the original defect.
    lib = _seed(repo)
    base = lib.grounding_digest(repo, TASK, in_stage=True)
    for field in GROUNDING_CONTRACT_FIELDS:
        mutated = {**TASK, field: ["mutated-sentinel"]}
        assert lib.grounding_digest(repo, mutated, in_stage=True) != base, field


# -------------------------------------------------------------- product tree
def test_the_work_does_not_invalidate_its_own_authorisation(repo: Path):
    """The circularity, stated as a test.

    delegate refuses without a fresh grill; committing the implementation moved
    the tree; the tree was part of the grill's binding. So the only way to fix
    delivered code was blocked by having delivered it.
    """
    lib = _seed(repo)
    before = lib.grounding_digest(repo, TASK, in_stage=True)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "implementation.ts").write_text(
        "export const built = true;\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit",
        "-m", "the implementation lands")
    assert lib.grounding_digest(repo, TASK, in_stage=True) == before, (
        "committing the implementation still stales the grill")


def test_before_the_stage_opens_the_tree_still_counts(repo: Path):
    # The other half. A plan is grilled against a codebase; if that codebase
    # moves BEFORE the work is authorised, the grill read something else.
    lib = _seed(repo)
    before = lib.grounding_digest(repo, TASK, in_stage=False)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "elsewhere.ts").write_text("export const x = 1;\n",
                                               encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit",
        "-m", "unrelated work lands first")
    assert lib.grounding_digest(repo, TASK, in_stage=False) != before


def test_in_stage_is_decided_by_the_stage_not_the_caller(repo: Path):
    # Four call sites asked this question three different ways; the read-only
    # one never asked it at all, so the board and `forge next` reported STALE
    # for delivered work and kept routing it back to the grill.
    lib = _seed(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    lib.dump_json(control / "stages.json", {"stages": [
        {"id": "T1", "status": "pending"}]})
    assert lib.task_in_stage(repo, "T1") is False
    for status in ("active", "done"):
        lib.dump_json(control / "stages.json", {"stages": [
            {"id": "T1", "status": status}]})
        assert lib.task_in_stage(repo, "T1") is True, status


# ------------------------------------------------------------- compatibility
def test_a_grill_recorded_by_older_tooling_still_verifies(repo: Path):
    """Upgrading must not demand a re-grill of every in-flight task.

    The legacy digest covers a SUPERSET of what the current rule covers, so
    accepting it as an alternative cannot let through anything the current rule
    would refuse.
    """
    lib = _seed(repo)
    legacy = lib.legacy_grounding_digest(repo, TASK)
    assert lib.grounding_matches(repo, TASK, legacy, in_stage=True)
    assert not lib.grounding_matches(repo, TASK, "not-a-digest", in_stage=True)

    # And it is not a bypass: a legacy record whose contract changed is still
    # refused, because the legacy digest covered that field too.
    moved = {**TASK, "write_scope": ["src/", "src/extra.ts"]}
    assert not lib.grounding_matches(repo, moved, legacy, in_stage=True)


def test_a_missing_digest_is_never_treated_as_a_match(repo: Path):
    lib = _seed(repo)
    for empty in ("", None):
        assert not lib.grounding_matches(repo, TASK, empty, in_stage=True)


def test_opening_the_stage_does_not_stale_the_grill_that_authorised_it(repo: Path):
    """The transition, which is the normal order of events.

    grill -> approve -> stage start. The grill is stamped while the stage is
    still pending, so the product tree IS part of its binding. If the checker
    simply stopped counting the tree once the stage opened, the act of opening
    the stage would stale every grill — the opposite of the bug being fixed,
    at the worst possible moment. The stage pins that same tree as its
    baseline, so measuring against the baseline reproduces what was recorded.
    """
    lib = _seed(repo)
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit",
        "-m", "the tree the grill was recorded against")
    head = git(repo, "rev-parse", "HEAD")

    # Recorded BEFORE the stage opened: tree included.
    recorded = lib.grounding_digest(repo, TASK, in_stage=False)

    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "stages.json", {"stages": [
        {"id": "T1", "status": "active", "base_sha": head}]})

    assert lib.grounding_matches(repo, TASK, recorded, in_stage=True), (
        "opening the stage staled the grill that authorised it")

    # And the gate still bites on a real contract change afterwards.
    moved = {**TASK, "write_scope": ["src/", "src/unplanned.ts"]}
    assert not lib.grounding_matches(repo, moved, recorded, in_stage=True)


def test_a_second_delegate_after_committing_needs_no_new_grill(repo: Path, tmp_path):
    """The loop, replayed end to end with the real commands.

    From the story's own handover: "committing the code stales the gate that
    authorises fixing the code. Every fix cycle therefore costs a grill round."
    Twenty rounds. This is that cycle: grill, approve, open the stage, deliver
    the implementation, then go back for the fix round — which is where the
    harness used to demand a fresh grill before it would let anyone write.
    """
    from test_gates import (  # noqa: E402
        STAGE_TASK, fake_companion_env, start_stage,
    )

    start_stage(repo, tmp_path, STAGE_TASK, launch=False)

    # Codex delivers, and the delivery is committed — the step that used to
    # stale the gate.
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "delivered.ts").write_text(
        "export const implementation = true;\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit",
        "-m", "WF-1 T1: the implementation lands")

    # The fix round. No re-grill, no re-approval, no contract edit.
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, (
        "delegate still demands a fresh grill after the implementation was "
        f"committed — the loop is intact:\n{out}")


def test_a_contract_change_still_stops_the_next_delegate(repo: Path, tmp_path):
    # The other half: the gate must still refuse when what was authorised
    # actually changed, or the fix has simply removed the gate.
    from test_gates import (  # noqa: E402
        STAGE_TASK, fake_companion_env, start_stage,
    )
    from factory_lib import (  # noqa: E402
        dump_json, load_json, protected_decomposition_state_path,
    )

    start_stage(repo, tmp_path, STAGE_TASK, launch=False)

    path = protected_decomposition_state_path(repo)
    decomposition = load_json(path, default={})
    for task in decomposition.get("tasks", []):
        if task.get("id") == "T1":
            task["write_scope"] = list(task.get("write_scope") or []) + ["apps/"]
    dump_json(path, decomposition)

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0, f"a widened write scope no longer stops delegate:\n{out}"
    assert "STALE" in out or "grill" in out.lower()
