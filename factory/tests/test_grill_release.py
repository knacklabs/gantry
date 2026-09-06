"""The grill release goes through the ledgered launcher.

In its own module on purpose. test_gates.py is one 680-test file, so every
branch that adds a test lands in the same region and re-conflicts whenever
another merges first — three times over for this change alone. Separate files
do not collide, and the resolution stops being a keep-both merge that can
silently duplicate a definition (Python shadows a repeated `def` without
complaint).
"""
from __future__ import annotations

import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo, run  # noqa: F401


def test_grill_runs_through_the_ledgered_launcher_read_only(repo, tmp_path):
    # The grill was the one Codex release the harness could not see: a
    # delegation records a pid and a review does too, so a launcher killed
    # uncatchably stays detectable — but a grill went out through the plugin
    # directly and nothing on the forge side knew it had started. It is also
    # the release the coordinator is told to WATCH every round.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import _artifact_text, _compose_brief  # noqa: E402

    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})
    plan = lib.evidence_path(repo, "ENG-1", "task-plans/T1.md", for_write=True)
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# T1\n\nAdd the invoice endpoint.\n", encoding="utf-8")

    label, artifact = _artifact_text(repo, "task", "T1")
    brief = _compose_brief(repo, "task", label, artifact)
    # The reader has no memory of the session that wrote it, so the artifact
    # must travel IN the brief.
    assert "Add the invoice endpoint." in brief
    assert "You did NOT write what follows" in brief
    assert "READ-ONLY" in brief
    # Recording stays with the coordinating session: only it produces the
    # AskUserQuestion ledger entries the recorder matches against.
    assert "Do not record a gate" in brief

    # The model pin lives in harness.yaml beside every other pin, not in code.
    from forge_cli.delegate import mode_run_config  # noqa: E402
    model, effort, _ = mode_run_config(repo, "grill")
    assert (model, effort) == ("gpt-5.6-terra", "xhigh")

    # A gate whose artifact is absent refuses, naming the command that makes it.
    code, out = run(repo, "forge.py", "grill", "run", "--gate", "task")
    assert code != 0 and "--task" in out
    # The plan gate points at the DRAFT, not at a saved plan: plan save refuses
    # without a passing grill, so a plan on disk is the fallback and an
    # unsaved draft is the normal case. Demanding the saved copy made the one
    # gate that worked work at the wrong moment.
    code, out = run(repo, "forge.py", "grill", "run", "--gate", "plan")
    assert code != 0 and "--file" in out


def test_griller_contract_names_the_ledgered_release(repo):
    # Guidance and mechanism must agree: if the contract still told the reader
    # to release through the plugin, the ledger would stay empty and the
    # watcher would keep its blind spot.
    contract = (HARNESS / "factory" / "prompts" / "griller.md").read_text(
        encoding="utf-8")
    assert "./forge grill run --gate" in contract
    assert "/codex:rescue" not in contract
    assert "read-only" in contract and "stage done" in contract


def test_grill_skill_section_inlines_the_technique_not_the_pointer(repo):
    # What doctor installs as `grill-me` is a stub whose whole body is "Call
    # the Skill tool with 'grilling'". Naming it would hand a Codex reader a
    # pointer to a skill its runtime may not have, so the technique is inlined
    # — the same reason delegate inlines ponytail rather than trusting an
    # install to be present.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.grill import _grill_skill_section  # noqa: E402

    section = _grill_skill_section()
    assert "Call the Skill tool" not in section, (
        "the stub is a pointer, not technique — it must never be inlined")
    assert "Interrogation technique" in section
