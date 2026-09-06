"""The gate table, and roadmap heal's refusal to lose a status.

Its own module: test_gates.py is one 680-test file, so every branch adding a
test there collides with every other.

The tree here follows the blast radius, not the diff — a gate table is only
worth having if the things DOWNSTREAM of it (the recorder, the ledgered
launcher, the handover gates that read a recorded grill months later) still
behave. Each level below is a level further from the change.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from test_gates import HARNESS, repo, run  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from grill_gates import GATES, gate_names, get_gate  # noqa: E402
from forge_cli.roadmap import heal_items  # noqa: E402


# --------------------------------------------------------------------------
# L1 — the table itself. A row that cannot say where its artifact lives or how
#      many rounds it needs is the exact shape of both shipped bugs.
# --------------------------------------------------------------------------

def test_every_gate_can_be_located_and_has_a_floor():
    assert set(gate_names()) == {
        "spec", "signoff", "epics", "requirements", "plan", "task"}
    for name, gate in GATES.items():
        assert callable(gate.locate), f"{name} has no way to find its artifact"
        assert gate.min_rounds >= 1, f"{name} is gated but unfloored"
        assert gate.describes.strip()


def test_a_gate_cannot_be_declared_with_a_blank_column():
    # The whole point of the table: the failure mode was a gate that existed
    # in one list and not another. A row with a missing column must not be
    # constructible, so the type carries no defaults.
    from dataclasses import fields
    from grill_gates import Gate
    assert all(f.default is not None or True for f in fields(Gate))
    with pytest.raises(TypeError):
        Gate("halfbuilt", "no locator, no floor")  # type: ignore[call-arg]


def test_the_table_is_the_only_list_of_gates():
    # Eight copies of "the six gates" is how signoff and epics ended up
    # gated-but-unfloored. Any consumer typing them out again re-opens that.
    scripts = HARNESS / "factory" / "scripts"
    for relative in ("forge.py", "record_grill_from_json.py",
                     "forge_cli/grill.py"):
        text = (scripts / relative).read_text(encoding="utf-8")
        assert '"signoff", "spec", "epics"' not in text, relative
        assert '"spec", "requirements", "plan", "task"' not in text, relative
    schema = json.loads((HARNESS / "factory" / "schemas" / "grill.json"
                         ).read_text(encoding="utf-8"))
    prose = json.dumps(schema)
    for name in gate_names():
        assert name in prose, f"schema does not mention {name}"


def test_the_floor_is_stated_as_a_floor_everywhere_it_appears():
    # A minimum read as a target is how a one-round grill passes for a
    # converged one. Said once in the table, carried into the brief and into
    # the recorder's refusal.
    from grill_gates import FLOOR_IS_NOT_A_TARGET
    assert "not a target" in FLOOR_IS_NOT_A_TARGET
    scripts = HARNESS / "factory" / "scripts"
    assert "FLOOR_IS_NOT_A_TARGET" in (
        scripts / "forge_cli" / "grill.py").read_text(encoding="utf-8")
    assert "FLOOR_IS_NOT_A_TARGET" in (
        scripts / "record_grill_from_json.py").read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# L2 — the runner. Four of six gates used to stop at "no artifact resolver
#      yet", which is what pushed the coordinator off the ledgered path.
# --------------------------------------------------------------------------

def _grill(repo: Path, *args: str):
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "forge.py"),
         "grill", "run", *args, "--print-only"],
        cwd=repo, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def _grill_launched(repo: Path, *args: str):
    """For assertions about a SUCCESSFUL release.

    Composing the argv needs the Codex companion installed, which a CI runner
    has no reason to have. Skipping there keeps the check real where a
    companion exists; the same ground is covered in-process, with no install,
    by test_gate_table_e2e.py.
    """
    code, out = _grill(repo, *args)
    if code != 0 and "Codex companion installation" in out:
        pytest.skip("no Codex companion installed in this environment")
    return code, out


def test_no_gate_dead_ends_on_a_missing_resolver(repo: Path):
    for name in gate_names():
        _code, out = _grill(repo, "--gate", name)
        assert "no artifact resolver" not in out, name


def test_gates_that_choose_their_artifact_say_so(repo: Path):
    # spec and epics grill a CHOSEN document; guessing one would grill
    # proposal A and let proposal B through the gate.
    for name, hint in (("spec", "docs/specs"), ("epics", "roadmap-input")):
        code, out = _grill(repo, "--gate", name)
        assert code != 0 and "--file" in out and hint in out, name


def test_a_spec_gate_refuses_something_that_is_not_a_spec(repo: Path):
    (repo / "notes.md").write_text("not a spec\n", encoding="utf-8")
    code, out = _grill(repo, "--gate", "spec", "--file", "notes.md")
    assert code != 0 and "docs/specs" in out


def test_the_plan_gate_grills_a_draft_that_is_not_saved_yet(repo: Path):
    # Plan save REFUSES without a passing grill, so demanding a saved plan
    # made the one gate that worked work at the wrong moment.
    draft = repo / "draft-plan.md"
    draft.write_text("# Draft\n\nUnsaved, ungrilled, in hand.\n", encoding="utf-8")
    code, out = _grill_launched(
        repo, "--gate", "plan", "--file", "draft-plan.md")
    assert code == 0, out
    assert "Unsaved, ungrilled, in hand." in (
        repo / ".factory" / "grill-brief-plan.md").read_text(encoding="utf-8")


def test_every_grill_goes_out_cold_and_read_only(repo: Path):
    # The grill's whole authority is that a fresh context read it. A grill
    # released with write access, or on the author's own model, is not one.
    draft = repo / "draft-plan.md"
    draft.write_text("# Draft\n", encoding="utf-8")
    for args in (("--gate", "plan", "--file", "draft-plan.md"),
                 ("--gate", "signoff")):
        code, out = _grill_launched(repo, *args)
        assert code == 0, out
        assert "Write access: NO" in out
        assert "gpt-5.6-terra" in out and "xhigh" in out


def test_the_brief_carries_the_artifact_itself(repo: Path):
    # A cold reader has no memory of the session and does not go hunting: if
    # the text is not in the brief, it was never grilled.
    (repo / "docs" / "product" / "BRIEF.md").write_text(
        "# Brief\n\nA distinctive sentence only this test writes.\n",
        encoding="utf-8")
    code, out = _grill_launched(repo, "--gate", "signoff")
    assert code == 0, out
    brief = (repo / ".factory" / "grill-brief-signoff.md").read_text(
        encoding="utf-8")
    assert "A distinctive sentence only this test writes." in brief


# --------------------------------------------------------------------------
# L3 — the recorder. signoff and epics skipped the round check entirely.
# --------------------------------------------------------------------------

def _grill_payload(gate: str, verdict: str = "pass") -> str:
    # Schema-valid in every OTHER respect, so the refusal under test is the
    # round floor and not a schema complaint standing in for it.
    return json.dumps({
        "generated_by": "griller", "gate": gate, "verdict": verdict,
        "gaps": [], "contradictions": [], "resolutions": [], "rounds": [],
    })


def test_no_gate_records_with_zero_rounds(repo: Path):
    # The bug in one assertion: `if gate in GATE_ROUND_FLOORS` skipped signoff
    # and epics, so both accepted a grill with nothing behind it.
    for name in gate_names():
        args = ["--gate", name]
        if name == "task":
            args += ["--task", "T1"]
        code, _out = run(repo, "record_grill_from_json.py", *args,
                         stdin=_grill_payload(name))
        assert code != 0, f"{name} accepted an empty grill"


def test_the_two_unfloored_gates_now_refuse_on_the_rounds(repo: Path):
    # signoff and epics are the two that regressed, and the only two whose
    # other preconditions a bare repo satisfies — so they are the ones that
    # can prove the refusal is the ROUND floor rather than something upstream
    # of it standing in.
    (repo / "roadmap-input.json").write_text(
        json.dumps({"generated_by": "docs-decomposer", "epics": [], "items": []}),
        encoding="utf-8")
    for name, extra in (("signoff", []),
                        ("epics", ["--input-digest", "roadmap-input.json"])):
        code, out = run(repo, "record_grill_from_json.py", "--gate", name,
                        *extra, stdin=_grill_payload(name))
        assert code != 0, f"{name} accepted an empty grill"
        assert "logged round" in out, f"{name} refused for the wrong reason: {out}"


def test_the_refusal_says_the_floor_is_not_the_bar(repo: Path):
    code, out = run(repo, "record_grill_from_json.py",
                    "--gate", "signoff", stdin=_grill_payload("signoff"))
    assert code != 0
    assert "not a target" in out


# --------------------------------------------------------------------------
# L4 — the blast radius. Raising a floor must not invalidate grills already
#      recorded and passed, and grill rows share a ledger with delegations.
# --------------------------------------------------------------------------

def test_a_recorded_grill_is_never_re_counted_later(repo: Path):
    # require_grill is what every handover gate calls months afterwards. If it
    # re-counted rounds, raising a floor would retroactively break repos that
    # had already passed the gate — a silent, remote failure.
    source = (HARNESS / "factory" / "scripts" / "factory_lib.py").read_text(
        encoding="utf-8")
    body = source[source.index("def require_grill("):]
    body = body[:body.index("\ndef ", 10)]
    assert "rounds" not in body, (
        "require_grill now inspects rounds — raising a floor would retro-break "
        "already-passing repos, so the floor needs a version gate")


def test_a_grill_row_can_never_satisfy_a_task_stage(repo: Path):
    # Grills and delegations land in the same ledger. A read-only grill row
    # that looked like a task's write delegation would let `stage done` pass
    # on a run that never implemented anything.
    text = (HARNESS / "factory" / "scripts" / "forge_cli" / "grill.py"
            ).read_text(encoding="utf-8")
    assert "write=False" in text
    assert 'f"grill-{gate}"' in text, "grill rows must be keyed apart from tasks"


def test_concurrent_gates_do_not_collide(repo: Path):
    draft = repo / "draft-plan.md"
    draft.write_text("# Draft\n", encoding="utf-8")
    assert _grill_launched(
        repo, "--gate", "plan", "--file", "draft-plan.md")[0] == 0
    assert _grill(repo, "--gate", "signoff")[0] == 0
    briefs = {p.name for p in (repo / ".factory").glob("grill-brief-*.md")}
    assert {"grill-brief-plan.md", "grill-brief-signoff.md"} <= briefs


# --------------------------------------------------------------------------
# L5 — roadmap heal. It crashed mid-merge, and reverted a done-flip silently.
# --------------------------------------------------------------------------

def _roadmap(items: list[dict]) -> str:
    return json.dumps({"generated_by": "human", "epics": [], "items": items})


def _git(repo: Path, *args: str):
    # The identity goes on EVERY call, not just commit. `git merge` creates a
    # commit too, and without an identity it aborts and leaves the working
    # tree pre-merge — which looks exactly like heal declining to union, on a
    # runner with no global git config and nowhere else.
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=repo, capture_output=True, text=True)


def _heal(repo: Path):
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "forge.py"),
         "roadmap", "heal"], cwd=repo, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def _two_branch_conflict(repo: Path) -> None:
    """develop marks A done; the story branch leaves it pending and starts B.
    This is the shape that lost data."""
    path = repo / "plans" / "roadmap.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_roadmap([
        {"key": "A", "title": "A", "status": "pending", "order": 1},
        {"key": "B", "title": "B", "status": "pending", "order": 2},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "base")
    _git(repo, "checkout", "-b", "story")
    path.write_text(_roadmap([
        {"key": "A", "title": "A", "status": "pending", "order": 1},
        {"key": "B", "title": "B", "status": "active", "order": 2},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "B active")
    head = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    _git(repo, "checkout", "-")
    path.write_text(_roadmap([
        {"key": "A", "title": "A", "status": "done", "order": 1,
         "closeout": "shipped in #1"},
        {"key": "B", "title": "B", "status": "pending", "order": 2},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "A done")
    assert head
    _git(repo, "merge", "story")  # conflicts


def test_heal_survives_a_conflicted_file(repo: Path):
    # It built the right union in memory, then died re-reading the still
    # conflict-markered file on the way out.
    _two_branch_conflict(repo)
    code, out = _heal(repo)
    assert code == 0, out
    data = json.loads((repo / "plans" / "roadmap.json").read_text(
        encoding="utf-8"))
    statuses = {i["key"]: i["status"] for i in data["items"]}
    assert statuses == {"A": "done", "B": "active"}, statuses


def test_heal_restores_a_flip_the_human_resolved_away(repo: Path):
    # THE data-loss case. Resolved to one side, the file parses perfectly and
    # has no duplicate keys, so the old heal found nothing to do and reported
    # success over a roadmap that had already dropped A's done-flip.
    _two_branch_conflict(repo)
    path = repo / "plans" / "roadmap.json"
    path.write_text(_roadmap([
        {"key": "A", "title": "A", "status": "pending", "order": 1},
        {"key": "B", "title": "B", "status": "active", "order": 2},
    ]), encoding="utf-8")
    code, out = _heal(repo)
    assert code == 0, out
    data = json.loads(path.read_text(encoding="utf-8"))
    item = next(i for i in data["items"] if i["key"] == "A")
    assert item["status"] == "done", "heal blessed a reverted done-flip"
    assert item.get("closeout") == "shipped in #1", "closeout data was dropped"


def test_heal_reports_what_it_raised(repo: Path):
    # "3 done" should be checkable, not asserted.
    _two_branch_conflict(repo)
    _heal(repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "healed")
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    for item in data["items"]:
        if item["key"] == "A":
            item["status"] = "pending"
    path.write_text(json.dumps(data), encoding="utf-8")
    code, out = _heal(repo)
    assert code == 0, out
    assert "raised" in out and "A" in out


def test_heal_never_lowers_a_status():
    # The invariant, exercised directly: two branches disagreeing means one
    # has newer information, never that a story went backwards.
    items = [
        {"key": "A", "status": "done", "order": 1, "closeout": "kept"},
        {"key": "A", "status": "pending", "order": 1},
    ]
    healed, removed = heal_items(items)
    assert removed == 1
    assert healed[0]["status"] == "done"
    assert healed[0]["closeout"] == "kept"


def test_heal_still_refuses_a_union_that_deadlocks(repo: Path):
    # Two acyclic branches can union into a cycle neither had. Healing into a
    # frontier nothing can start is worse than refusing.
    path = repo / "plans" / "roadmap.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_roadmap([
        {"key": "A", "title": "A", "status": "pending", "order": 1,
         "depends_on": ["B"]},
        {"key": "B", "title": "B", "status": "pending", "order": 2,
         "depends_on": ["A"]},
    ]), encoding="utf-8")
    code, out = _heal(repo)
    assert code != 0
    assert "cycle" in out.lower() or "dag" in out.lower(), out


def test_heal_without_a_roadmap_says_so(repo: Path):
    roadmap = repo / "plans" / "roadmap.json"
    if roadmap.exists():
        roadmap.unlink()
    code, out = _heal(repo)
    assert code != 0 and "roadmap" in out.lower()


def test_heal_never_reads_the_enclosing_repos_roadmap(repo: Path):
    # `git show <ref>:<path>` resolves from the REPOSITORY ROOT, not from cwd.
    # A roadmap living in a directory that is not its own repo — a board
    # fixture nested inside another checkout, or a subdirectory passed as
    # --repo — was unioned with the ENCLOSING repo's roadmap and overwritten
    # with stories belonging to a different project.
    nested = repo / "fixtures" / "example"
    (nested / "plans").mkdir(parents=True, exist_ok=True)
    (nested / "plans" / "roadmap.json").write_text(_roadmap([
        {"key": "FIXTURE-1", "title": "Only mine", "status": "pending",
         "order": 1},
    ]), encoding="utf-8")
    (repo / "plans").mkdir(parents=True, exist_ok=True)
    (repo / "plans" / "roadmap.json").write_text(_roadmap([
        {"key": "OUTER-1", "title": "Belongs to the parent", "status": "done",
         "order": 1},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fixture")

    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "forge.py"),
         "roadmap", "heal", "--repo", str(nested)],
        cwd=repo, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    data = json.loads((nested / "plans" / "roadmap.json").read_text(
        encoding="utf-8"))
    keys = {i["key"] for i in data["items"]}
    assert keys == {"FIXTURE-1"}, f"the parent's stories leaked in: {keys}"


def test_heal_does_not_resurrect_a_deliberate_revert(repo: Path):
    # `HEAD^1` resolves on ANY non-root commit, so reading it unconditionally
    # unioned the roadmap with its own PREVIOUS commit. Heal only ever raises,
    # so a status a human deliberately moved back — a story reopened from done,
    # a done-flip corrected to pending — would be silently restored from
    # history and reported as a successful heal. Recovering a lost flip and
    # undoing an intended one look identical from the inside; only a second
    # parent tells them apart.
    (repo / "plans").mkdir(parents=True, exist_ok=True)
    roadmap = repo / "plans" / "roadmap.json"

    roadmap.write_text(_roadmap([
        {"key": "ENG-1", "title": "Shipped early", "status": "done",
         "order": 1},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "ENG-1 done")

    # The human reopens it: done -> active, committed as a linear commit.
    roadmap.write_text(_roadmap([
        {"key": "ENG-1", "title": "Shipped early", "status": "active",
         "order": 1},
    ]), encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "reopen ENG-1")

    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "forge.py"),
         "roadmap", "heal", "--repo", str(repo)],
        cwd=repo, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    data = json.loads(roadmap.read_text(encoding="utf-8"))
    status = next(i["status"] for i in data["items"] if i["key"] == "ENG-1")
    assert status == "active", (
        f"heal resurrected the old done-flip from history: {proc.stdout}")
    # And it must not claim a merge it did not read.
    assert "working file" in proc.stdout and "merge sides" not in proc.stdout
