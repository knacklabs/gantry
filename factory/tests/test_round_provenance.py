import json

from test_gates import (  # noqa: F401
    STAGE_TASK,
    grill_rounds,
    load_factory_lib,
    log_grill_rounds,
    repo,
    run,
    seed_task_grill_frontier,
    task_grill_payload,
)


def _payload(gate, rounds):
    return {
        "generated_by": "griller",
        "gate": gate,
        "verdict": "pass",
        "gaps": [],
        "contradictions": [],
        "resolutions": [],
        "rounds": rounds,
    }


def _record(repo, gate, rounds, *extra):
    return run(
        repo,
        "record_grill_from_json.py",
        "--gate",
        gate,
        *extra,
        stdin=json.dumps(_payload(gate, rounds)),
    )


def _story(repo, key="STORY-1"):
    lib = load_factory_lib(repo)
    lib.story_dir(repo, key).mkdir(parents=True, exist_ok=True)
    lib.dump_json(lib.run_state_path(repo), {"issue_key": key})


def _record_plan(repo, rounds):
    draft = repo / "draft.md"
    draft.write_text("# Plan\n")
    return _record(repo, "plan", rounds, "--input-digest", str(draft))


def _task_ready(repo, task):
    lib = load_factory_lib(repo)
    control = lib.protected_decomposition_state_path(repo)
    decomposition = lib.load_json(control, default={})
    decomposition["tasks"] = [task]
    lib.dump_json(control, decomposition)
    plan = lib.evidence_path(repo, "TEST-1", f"task-plans/{task['id']}.md")
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(f"# {task['id']}\n")


def _record_first_task(repo):
    seed_task_grill_frontier(repo, STAGE_TASK)
    _story(repo, "TEST-1")
    _task_ready(repo, STAGE_TASK)
    first = grill_rounds("owned-task", 1)
    assert log_grill_rounds(repo, first)[0] == 0
    command = ("record_grill_from_json.py", "--gate", "task", "--task", "T1")
    assert (
        run(
            repo,
            *command,
            stdin=json.dumps(task_grill_payload(STAGE_TASK, rounds=first)),
        )[0]
        == 0
    )
    return first, command


def test_re_recording_the_same_gate_reuses_its_round_after_an_edit(repo):
    first, command = _record_first_task(repo)
    second = grill_rounds("second", 1)
    assert log_grill_rounds(repo, second)[0] == 0
    first[0].pop("frontier_empty")
    code, out = run(
        repo,
        *command,
        stdin=json.dumps(task_grill_payload(STAGE_TASK, rounds=[*first, *second])),
    )
    assert code == 0, out


def test_a_round_is_refused_at_a_different_gate(repo):
    rounds = grill_rounds("shared", 1)
    assert log_grill_rounds(repo, rounds)[0] == 0
    spec = repo / "spec.md"
    spec.write_text("# Spec\n")
    assert _record(repo, "spec", rounds, "--input-digest", str(spec))[0] == 0
    assert _record(repo, "signoff", rounds)[0] != 0


def test_a_round_is_refused_for_a_different_story(repo):
    _story(repo)
    rounds = grill_rounds("story", 1)
    assert log_grill_rounds(repo, rounds)[0] == 0
    assert _record_plan(repo, rounds)[0] == 0
    _story(repo, "STORY-2")
    assert _record_plan(repo, rounds)[0] != 0


def test_a_round_is_refused_for_a_different_task_id(repo):
    rounds, _ = _record_first_task(repo)
    task = {**STAGE_TASK, "id": "T2"}
    _task_ready(repo, task)
    assert (
        run(
            repo,
            "record_grill_from_json.py",
            "--gate",
            "task",
            "--task",
            "T2",
            stdin=json.dumps(task_grill_payload(task, rounds=rounds)),
        )[0]
        != 0
    )


def test_a_global_gate_is_unchanged_when_no_story_is_active(repo):
    rounds = grill_rounds("global", 1)
    assert log_grill_rounds(repo, rounds)[0] == 0
    assert _record(repo, "signoff", rounds)[0] == 0


def test_a_story_gate_still_consumes_a_pre_story_round(repo):
    rounds = grill_rounds("prestory", 1)
    assert log_grill_rounds(repo, rounds)[0] == 0
    _story(repo)
    assert _record_plan(repo, rounds)[0] == 0


def test_the_floor_of_one_real_round_per_gate_still_holds(repo):
    assert _record(repo, "signoff", [])[0] != 0
    test_a_global_gate_is_unchanged_when_no_story_is_active(repo)
