"""Gate regression suite.

Every case here is either the factory happy path or a defect found and fixed
during review (autoreview rounds 1-8, architecture review, forge-next
walk-through). Tests run against a fresh `forge init` scaffold — the vendored
artifact client repos actually receive. Pure stdlib + pytest; scripts are
exercised through their real CLI surface.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[2]
FORGE_INIT_FIXTURE = HARNESS / ".factory" / "history" / "FORGE-INIT-1"
sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from forge_cli.stages import task_digest
from record_signoff import REQUIRED_BRIEF_HEADINGS


def run(repo: Path, script: str, *args: str, stdin: str | None = None,
        env: dict[str, str] | None = None):
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / script), *args],
        cwd=repo, capture_output=True, text=True, input=stdin,
        env={**os.environ, **(env or {})},
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_upgrade_project_skill_structure_and_registration():
    skill_path = (
        HARNESS / "install" / "claude" / "knacklabs-upgrade-project" / "SKILL.md"
    )
    skill = skill_path.read_text()
    setup = (HARNESS / "setup").read_text()

    assert skill_path.is_file()
    assert "name: knacklabs-upgrade-project" in skill
    for trigger in (
        "Upgrade this repo to the latest harness",
        "Update my-app to the latest harness",
    ):
        assert trigger in skill
    for locate_contract in (
        'HARNESS="{{HARNESS_PATH}}"',
        'git -C "$HARNESS" remote get-url origin',
        'git -C "$HARNESS" symbolic-ref --quiet HEAD',
        'git -C "$HARNESS" status --porcelain',
        'git -C "$HARNESS" pull --ff-only',
        "Harness pull failed; the client was not upgraded.",
    ):
        assert locate_contract in skill
    for client_command in (
        '"$TARGET/forge" audit --repo "$TARGET"',
        '"$TARGET/forge" project backfill --repo "$TARGET"',
        '"$TARGET/forge" roadmap list --pending --repo "$TARGET"',
        '"$TARGET/forge" roadmap fill "$KEY"',
        '"$TARGET/forge" next --repo "$TARGET"',
    ):
        assert client_command in skill
    client_forge_lines = [
        line.strip() for line in skill.splitlines()
        if line.strip().startswith('"$TARGET/forge"')
    ]
    assert client_forge_lines
    assert client_forge_lines.count('"$TARGET/forge" doctor --fix') == 1
    assert all(
        '--repo "$TARGET"' in line
        for line in client_forge_lines
        if line != '"$TARGET/forge" doctor --fix'
    )
    assert '"$HOME/.claude/skills"' in setup
    assert '"$HOME/.codex/skills"' in setup
    assert '(cd "$HARNESS" && ./forge upgrade --target "$TARGET")' in skill
    bootstrap_loop = re.search(r"for SKILL in ([^;]+); do", setup)
    assert bootstrap_loop
    assert "knacklabs-upgrade-project" in bootstrap_loop.group(1).split()


def test_upgrade_project_skill_uses_fill_not_import():
    skill = (
        HARNESS / "install" / "claude" / "knacklabs-upgrade-project" / "SKILL.md"
    ).read_text()

    assert '"$TARGET/forge" roadmap fill "$KEY"' in skill
    assert '--repo "$TARGET"' in skill
    assert "roadmap import" not in skill.lower()
    assert 'roadmap list --pending --repo "$TARGET"' in skill
    assert "Never select or rewrite a completed" in skill


def test_sanitise_skill_structure_and_registration():
    skill_path = (
        HARNESS / "install" / "claude" / "knacklabs-sanitise-project" / "SKILL.md"
    )
    skill = skill_path.read_text()
    setup = (HARNESS / "setup").read_text()

    assert skill_path.is_file()
    assert "name: knacklabs-sanitise-project" in skill
    assert '"$TARGET/forge" sanitise --check --repo "$TARGET"' in skill
    assert '"$TARGET/forge" sanitise --repo "$TARGET"' in skill
    assert "on-demand maintenance action" in skill
    for resolve_command in (
        '"$TARGET/forge" pr-link',
        '"$TARGET/forge" project mark-predates',
        '"$TARGET/forge" roadmap fill',
        "--discard-active",
        '"$TARGET/forge" mode abandon',
    ):
        assert resolve_command in skill
    assert '"$HOME/.claude/skills"' in setup
    assert '"$HOME/.codex/skills"' in setup
    bootstrap_loop = re.search(r"for SKILL in ([^;]+); do", setup)
    assert bootstrap_loop
    assert "knacklabs-sanitise-project" in bootstrap_loop.group(1).split()


def jsonl_append_rules(attributes: str) -> list[str]:
    """Rule lines still routing through the hanging per-clone driver.

    Comments naming it are history, not configuration — the harness explains
    in .gitattributes why the driver was removed, and that prose must not read
    as a violation of the rule it documents.
    """
    return [line for line in attributes.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
            and "jsonl-append" in line]

def load_factory_lib(repo: Path):
    path = repo / "factory" / "scripts" / "factory_lib.py"
    spec = importlib.util.spec_from_file_location("factory_lib_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GIT_ID = ["-c", "user.email=test@knacklabs.dev", "-c", "user.name=Gate Tests"]

# Minimal payload satisfying factory/schemas/decomposition.json
DECOMP = {"status": "recorded", "generated_by": "docs-decomposer",
          "user_facing": True,
          "tasks": [{"id": "T1", "title": "core slice", "write_scope": ["src/"],
                     "objective": "Build the core slice so the feature works end to end.",
                     "acceptance_criteria": ["the slice runs green"]}]}

# Minimal plan body passing every `plan save` section gate.
PLAN_SECTIONS = (
    "Problem",
    "Scope / Non-goals",
    "Acceptance Criteria",
    "Technical Approach",
    "Decisions",
    "Surface Impact",
    "Task Decomposition",
    "Risks",
    "Verify Plan",
)
PLAN_BODY = "\n\n".join(
    f"## {section}\nTest content for {section}." for section in PLAN_SECTIONS
) + "\n"

def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *GIT_ID, *args], cwd=repo,
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout.strip()


def head(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD")


def dirty_digests(repo: Path) -> dict[str, str]:
    """What `stage start` records: the content of every already-dirty path, so
    a later edit to one of them is still attributable to the stage."""
    out = {}
    for line in git(repo, "status", "--porcelain", "-uall").splitlines():
        rel = line[3:].split(" -> ")[-1].strip().strip('"')
        if not rel:
            continue
        path = repo / rel
        out[rel] = (hashlib.sha256(path.read_bytes()).hexdigest()
                    if path.is_file() else "")
    return out


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    target = tmp_path / "app"
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "app", "--target", str(target)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "scaffold")
    return target


def record_grill(repo: Path, gate: str, verdict: str = "pass",
                 digest_of: Path | None = None, **over) -> tuple[int, str]:
    payload = {"generated_by": "griller", "gate": gate, "verdict": verdict,
               "gaps": [], "contradictions": [], "resolutions": [], **over}
    extra = ["--input-digest", str(digest_of)] if digest_of else []
    return run(repo, "record_grill_from_json.py", "--gate", gate, *extra,
               stdin=json.dumps(payload))


def record_task_grill(repo: Path, task: dict,
                      verdict: str = "pass") -> tuple[int, str]:
    payload = {"generated_by": "griller", "gate": "task", "verdict": verdict,
               "gaps": [], "contradictions": [], "resolutions": []}
    return run(
        repo, "record_grill_from_json.py", "--gate", "task",
        "--task", task["id"], "--task-digest", task_digest(task),
        stdin=json.dumps(payload),
    )


def delegate_task_grill_test(test):
    """Keep the required test IDs selectable by the stage's focused keyword."""
    test.delegate_task_grill = True
    return test


def active_decision_ids(repo: Path) -> list[str]:
    active = []
    for record in sorted((repo / "docs" / "decisions").glob("[0-9][0-9][0-9][0-9]-*.md")):
        frontmatter = record.read_text().split("---", 2)[1]
        if "status: accepted" in frontmatter:
            active.append(record.stem)
    return active


def plan_draft(repo: Path, body: str = PLAN_BODY,
               decisions: list[str] | None = None) -> str:
    reviewed = active_decision_ids(repo) if decisions is None else decisions
    listed = "\n".join(f"  - {decision}" for decision in reviewed)
    value = f"\n{listed}" if listed else " []"
    return f"---\ndecisions_reviewed:{value}\n---\n\n{body}"


def ensure_story(repo: Path, key: str, title: str | None = None) -> None:
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text()) if path.exists() else {
        "generated_by": "docs-decomposer", "epics": [], "items": [],
    }
    if not any(item.get("key") == key for item in data["items"]):
        data["items"].append({
            "key": key,
            "title": title or key,
            "spec": "docs/specs/base.md",
            "status": "pending",
            "order": len(data["items"]) + 1,
        })
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")


def seed_signoff_inputs(repo: Path) -> None:
    specs = repo / "docs" / "specs"
    specs.mkdir(parents=True, exist_ok=True)
    spec = specs / "base.md"
    if not spec.exists():
        spec.write_text(
            "---\nslug: base\ntitle: Base\nstatus: confirmed\n"
            "saved: 2026-07-24T00:00:00+00:00\n---\n\n# Base\n"
        )
    roadmap = repo / "plans" / "roadmap.json"
    if not roadmap.exists():
        roadmap.parent.mkdir(parents=True, exist_ok=True)
        roadmap.write_text(json.dumps({
            "generated_by": "docs-decomposer",
            "epics": [],
            "items": [{
                "key": "SIGNOFF-0",
                "title": "Sign-off coverage",
                "spec": "docs/specs/base.md",
                "status": "done",
                "order": 1,
            }],
        }, indent=2) + "\n")
    tracked = ["docs/specs/base.md", "plans/roadmap.json"]
    git(repo, "add", *tracked)
    if git(repo, "diff", "--cached", "--name-only"):
        git(repo, "commit", "-q", "-m", "seed signoff inputs")


def sign_off(repo: Path) -> None:
    if signed_off(repo):
        return  # idempotent: already signed off
    seed_signoff_inputs(repo)
    code, out = record_grill(repo, "signoff")
    assert code == 0, out
    code, out = run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    assert code == 0, out
    record = next((repo / "docs" / "decisions").glob("*-client-signoff.md"))
    record.write_text(
        record.read_text()
        .replace("status: proposed", "status: accepted")
        .replace('confirmed_by: ""', 'confirmed_by: "Client PM"')
    )
    code, out = run(repo, "record_signoff.py")
    assert code == 0, out


def intake(repo: Path, key: str = "ENG-1", title: str = "Invoices", *extra: str) -> tuple[int, str]:
    ensure_story(repo, key, title)
    return run(repo, "intake.py", "--issue", key, "--title", title, *extra)


def save_plan(repo: Path, tmp_path: Path) -> tuple[int, str]:
    state = run_state(repo)
    story = state.get("issue_key", "ENG-1")
    ensure_story(repo, story, state.get("title"))
    plan = tmp_path / "plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)  # grill bound to THIS draft
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", story)
    if code == 0 or "awaiting-approval" not in out:
        return code, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    return run(repo, "forge.py", "plan", "save", "--from", str(plan), "--story", story)


def save_plan_raw(repo: Path, tmp_path: Path) -> tuple[int, str]:
    state = run_state(repo)
    story = state.get("issue_key", "ENG-1")
    ensure_story(repo, story, state.get("title"))
    plan = tmp_path / "plan.md"
    plan.write_text(plan_draft(repo))
    return run(repo, "forge.py", "plan", "save", "--from", str(plan), "--story", story)


def write_passing_artifacts(repo: Path, commit: str | None = None) -> None:
    sha = commit or head(repo)
    f = repo / ".factory"
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    protected_decomposition = control / "decomposition.json"
    decomposition = (
        json.loads(protected_decomposition.read_text())
        if protected_decomposition.exists() else DECOMP
    )
    decomposition = {**decomposition, "commit": sha}
    (f / "decomposition.json").write_text(json.dumps(decomposition))
    protected_decomposition.write_text(json.dumps(decomposition))
    (f / "verify.json").write_text(json.dumps({"ok": True, "commit": sha}))
    (f / "tests.json").write_text(json.dumps({
        "automated": {"status": "passed", "generated_by": "implementer",
                      "skills_used": ["emil-design-eng", "frontend-design"]},
        "functional": {"status": "passed", "score": 9,
                       "generated_by": "functional-checker"},
        "commit": sha,
    }))
    stages = {
        "issue": run_state(repo).get("issue_key", ""),
        "stages": [
            {"id": task["id"], "title": task["title"], "status": "done"}
            for task in decomposition["tasks"]
        ],
    }
    (f / "stages.json").write_text(json.dumps(stages))
    (control / "stages.json").write_text(json.dumps(stages))
    (f / "reviews").mkdir(exist_ok=True)
    for aspect in ("quality", "performance", "security"):
        (f / "reviews" / f"{aspect}.json").write_text(
            json.dumps({"score": 9, "blocking_findings": [],
                        "generated_by": "autoreview",
                        "skills_used": ["review-animations"], "commit": sha})
        )
    (f / "outcome.json").write_text(json.dumps({
        "generated_by": "implementer", "commit": sha,
        "outcome": "The invoice list now loads for every account and can be filtered "
                   "by date, which previously required a support request."}))


def run_state(repo: Path) -> dict:
    return json.loads((repo / ".factory" / "run.json").read_text())


def signed_off(repo: Path) -> bool:
    """Sign-off is DERIVED from the committed harness.yaml pin, never from
    per-worktree run.json — that is the whole point of the pin."""
    match = re.search(r'^signoff_record:\s*"([^"]*)"', (repo / "harness.yaml").read_text(),
                      re.MULTILINE)
    return bool(match and match.group(1))


def refresh_manifest(repo: Path) -> None:
    """What a real forge upgrade does after touching the gate surface."""
    proc = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; "
         "from check_vendor_integrity import write_manifest; "
         "write_manifest(Path(sys.argv[2]), 'test')",
         str(repo / "factory" / "scripts"), str(repo)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


# ---------------------------------------------------------------- happy path

def test_full_lifecycle_and_archive(repo, tmp_path):
    sign_off(repo)
    assert signed_off(repo)
    code, _ = intake(repo)
    assert code == 0
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code == 0, out
    write_passing_artifacts(repo)
    # D-0013: a per-task grill must be archived into history like plan.json.
    task_grills = repo / ".factory" / "grills" / "tasks"
    task_grills.mkdir(parents=True, exist_ok=True)
    (task_grills / "ENG-1.1.json").write_text('{"gate": "task", "verdict": "pass"}\n')
    code, out = run(repo, "update_run.py", "--decomposition-status", "recorded")
    assert code == 0, out
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    # Archive: history bundle + plan moved + plan_file consistent (autoreview r8)
    history = repo / ".factory" / "history" / "ENG-1"
    for name in ("run.json", "decomposition.json", "verify.json", "tests.json"):
        assert (history / name).exists()
    assert (history / "reviews" / "quality.json").exists()
    completed = repo / "plans" / "completed" / "ENG-1-invoices.md"
    assert completed.exists()
    assert not list((repo / "plans" / "active").glob("ENG-1-*.md"))
    # the archived run.json carries the full task state...
    archived_state = json.loads((history / "run.json").read_text())
    assert archived_state["plan_file"] == "plans/completed/ENG-1-invoices.md"
    # ...while the working tree is CLEANED for conflict-free branch merges:
    # task-scoped artifacts removed, run.json reduced to project + last_shipped
    for name in ("decomposition.json", "verify.json", "tests.json"):
        assert not (repo / ".factory" / name).exists()
    assert not (repo / ".factory" / "reviews").exists()
    assert not (repo / ".factory" / "grills" / "plan.json").exists()
    # D-0013: task grills archived into history, then removed from the live tree.
    assert (history / "grills" / "tasks" / "ENG-1.1.json").exists()
    assert not (repo / ".factory" / "grills" / "tasks").exists()
    live = run_state(repo)
    assert live["phase"] == "shipped" and signed_off(repo)
    assert "client_signoff" not in live  # derived from harness.yaml, never stored
    assert "issue_key" not in live and "last_shipped" not in live
    assert "updated_at" not in live  # byte-stable across parallel branches
    # Idempotent rerun (autoreview r2)
    code, out = run(repo, "pr_ready.py")
    assert code == 0 and "shipped so far: ENG-1" in out


# ---------------------------------------------------------- sign-off gating

def test_plan_save_refused_before_signoff(repo, tmp_path):
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "sign-off" in out


def test_plan_save_refused_without_run_state(repo, tmp_path):
    (repo / ".factory" / "run.json").unlink()
    plan = tmp_path / "plan.md"
    plan.write_text("x\n")
    code, out = run(repo, "forge.py", "plan", "save", "--issue", "ENG-9", "--from", str(plan))
    assert code != 0 and "sign-off" in out  # autoreview r6


def test_decomposition_refused_before_signoff(repo):
    intake(repo)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code != 0 and "sign-off" in out


def test_decomposition_refused_before_approved_plan(repo):
    sign_off(repo)
    intake(repo)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code != 0 and "approved" in out  # autoreview r10


def test_pr_ready_refused_before_signoff(repo):
    intake(repo)
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "sign-off" in out


def test_update_run_phase_gated_before_signoff(repo):
    intake(repo)
    code, out = run(repo, "update_run.py", "--phase", "planning")
    assert code != 0 and "sign-off" in out


def test_intake_starts_discovery_before_signoff_and_planning_after(repo, tmp_path):
    intake(repo)
    assert run_state(repo)["phase"] == "discovery"
    sign_off(repo)
    intake(repo, "ENG-2", "Refunds")
    state = run_state(repo)
    assert state["phase"] == "planning" and signed_off(repo)


def test_signoff_is_pinned_and_cannot_be_repointed(repo, tmp_path):
    """The D-0032 bug: sign-off picked the highest-numbered client-signoff
    record, whatever task it belonged to, so a later unrelated record silently
    became the project's attestation — confirmed by the wrong human."""
    sign_off(repo)
    pinned = re.search(r'^signoff_record:\s*"([^"]*)"',
                       (repo / "harness.yaml").read_text(), re.MULTILINE).group(1)

    # A LATER, higher-numbered record for some other task shows up.
    later = repo / "docs" / "decisions" / "9999-client-signoff.md"
    later.write_text('---\nstatus: accepted\nconfirmed_by: "Someone Else"\n---\n\n# Other task\n')

    # Re-running refuses outright rather than re-pointing the attestation.
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "already signed off" in out, out
    still = re.search(r'^signoff_record:\s*"([^"]*)"',
                      (repo / "harness.yaml").read_text(), re.MULTILINE).group(1)
    assert still == pinned, "the pin moved to an unrelated record"

    # And unknown flags are rejected, not silently swallowed (--notes used to be).
    code, out = run(repo, "record_signoff.py", "--notes", "hi")
    assert code != 0, out


def test_signoff_record_must_be_a_real_signoff_record(repo, tmp_path):
    """--record pinned any file that merely carried `status: accepted` and a
    confirmed_by, including one outside docs/decisions (autoreview P1)."""
    seed_signoff_inputs(repo)  # sign-off now requires confirmed specs + roadmap
    # Written BEFORE the grill: creating it after would trip the (separate,
    # also correct) grill-staleness gate and prove nothing about --record.
    impostor = repo / "docs" / "decisions" / "0001-some-other-decision.md"
    impostor.write_text('---\nstatus: accepted\nconfirmed_by: "Nobody"\n---\n\n# Unrelated\n')
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "unrelated decision")
    code, out = record_grill(repo, "signoff")
    assert code == 0, out
    code, out = run(repo, "record_signoff.py", "--record", str(impostor.relative_to(repo)))
    assert code != 0 and "not a client sign-off record" in out, out

    outside = tmp_path / "elsewhere" / "0001-client-signoff.md"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_text('---\nstatus: accepted\nconfirmed_by: "Nobody"\n---\n')
    code, out = run(repo, "record_signoff.py", "--record", str(outside))
    assert code != 0 and "not a client sign-off record" in out, out
    assert not signed_off(repo)


def test_pin_insertion_preserves_a_yaml_prologue(repo):
    """Adding the key to a pre-pin manifest must land INSIDE the document:
    prepending before a `---` marker makes a two-document stream that consumers
    can no longer read as one mapping (r11)."""
    from importlib import import_module
    import sys
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    sys.modules.pop("factory_lib", None)
    factory_lib = import_module("factory_lib")

    # A symlink LOOP must read as an invalid pin, not a traceback: non-strict
    # resolve() raises RuntimeError for loops on Python 3.10-3.12 (CI's) and
    # OSError elsewhere (r11/r12).
    loop = repo / "docs" / "decisions" / "0001-loop-client-signoff.md"
    loop.symlink_to(loop)
    assert factory_lib.canonical_signoff_path(
        repo, "docs/decisions/0001-loop-client-signoff.md") == ""
    assert factory_lib.client_signoff(repo)[0] is False
    loop.unlink()

    doc = "%YAML 1.2\n---\nversion: 1\nprecedence:\n  - constitution\n"
    out = factory_lib.insert_signoff_pin(doc, "docs/decisions/0001-client-signoff.md")
    assert out.startswith("%YAML 1.2\n---\n"), out
    assert out.count("---") == 1, out
    assert out.splitlines()[2] == 'signoff_record: "docs/decisions/0001-client-signoff.md"'

    # A document-start marker carrying an inline comment is still a marker,
    # after a space OR a tab (both valid YAML separation).
    for marker in ("--- # main document", "---\t# main document"):
        out_t = factory_lib.insert_signoff_pin(
            marker + "\nversion: 1\n", "docs/decisions/0001-client-signoff.md")
        assert out_t.startswith(marker + "\n"), out_t
        assert out_t.splitlines()[1].startswith('signoff_record: "')

    commented_marker = "--- # main document\nversion: 1\n"
    out3 = factory_lib.insert_signoff_pin(commented_marker, "docs/decisions/0001-client-signoff.md")
    assert out3.startswith("--- # main document\n"), out3
    assert out3.splitlines()[1].startswith('signoff_record: "')

    # Replacing an existing key is still a plain line substitution.
    again = factory_lib.insert_signoff_pin(out, "docs/decisions/0002-client-signoff.md")
    assert again.count("signoff_record:") == 1
    assert "0002-client-signoff.md" in again

    # A leading comment block (this harness's own shape) is preserved too.
    commented = "# header\n\nversion: 1\n"
    out2 = factory_lib.insert_signoff_pin(commented, "docs/decisions/0001-client-signoff.md")
    assert out2.startswith('signoff_record: "'), out2

    sys.path.remove(str(repo / "factory" / "scripts"))
    sys.modules.pop("factory_lib", None)


def test_symlinked_manifest_is_refused(repo, tmp_path):
    """A symlinked harness.yaml would let the gate's 'committed' state live
    outside the repo, and write_text would follow the link (r6)."""
    seed_signoff_inputs(repo)  # sign-off now requires confirmed specs + roadmap
    # Everything sign-off needs must be READY, or the command refuses for an
    # unrelated reason and the control proves nothing.
    record = repo / "docs" / "decisions" / "0001-client-signoff.md"
    record.write_text('---\nstatus: accepted\nconfirmed_by: "PM"\n---\n')
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "signoff record")
    code, out = record_grill(repo, "signoff")
    assert code == 0, out

    real = tmp_path / "elsewhere.yaml"
    real.write_text((repo / "harness.yaml").read_text())
    (repo / "harness.yaml").unlink()
    (repo / "harness.yaml").symlink_to(real)

    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "symlink" in out, out
    assert 'signoff_record: ""' in real.read_text(), "wrote through the symlink"


def test_migration_ignores_a_mentioned_but_unset_key(repo):
    """The key must be detected as a real top-level assignment: a project-owned
    harness.yaml may mention it in a comment, and a substring test would then
    skip the migration and leave a legacy project silently unsigned (r6)."""
    from importlib import import_module
    import sys
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    sys.modules.pop("factory_lib", None)
    factory_lib = import_module("factory_lib")
    commented = "# signoff_record: docs/decisions/0001-client-signoff.md (example)\n"
    assert not factory_lib.SIGNOFF_KEY.search(commented)
    assert factory_lib.SIGNOFF_KEY.search('signoff_record: ""\n')

    # A bare `signoff_record:` is valid YAML for "no value". The reader must not
    # swallow the following top-level key as the pin (r7).
    manifest = repo / "harness.yaml"
    manifest.write_text("signoff_record:\nprecedence:\n  - constitution\n")
    assert factory_lib.signoff_pin(repo) == ""
    assert factory_lib.client_signoff(repo)[0] is False
    sys.path.remove(str(repo / "factory" / "scripts"))
    sys.modules.pop("factory_lib", None)


def test_upgrade_migration_canonicalizes_the_carried_pin(repo, tmp_path):
    """The migration reads run.json — gitignored, per-worktree, ungoverned. A
    value there can RESOLVE to a valid record while still being absolute
    (machine-specific) or carrying quotes/newlines that inject YAML into
    harness.yaml, so what gets persisted must be the canonical path (r4)."""
    from importlib import import_module
    import sys
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    for mod in ("factory_lib",):
        sys.modules.pop(mod, None)
    factory_lib = import_module("factory_lib")

    record = repo / "docs" / "decisions" / "0007-client-signoff.md"
    record.write_text('---\nstatus: accepted\nconfirmed_by: "PM"\n---\n')

    # An absolute path resolves fine but must never be persisted.
    assert factory_lib.canonical_signoff_path(repo, str(record)) == \
        "docs/decisions/0007-client-signoff.md"
    # A traversal that lands on the real record is normalised, not echoed back.
    sneaky = 'docs/decisions/x"\nprecedence: []\n#/../0007-client-signoff.md'
    assert factory_lib.canonical_signoff_path(repo, sneaky) in (
        "", "docs/decisions/0007-client-signoff.md")
    assert '"' not in factory_lib.canonical_signoff_path(repo, sneaky)
    # `$` also matches before a trailing newline, so a file named
    # "...client-signoff.md\n" would validate and then write a multi-line pin
    # that the reader truncates — success reported, every gate locked (r5).
    newline_named = repo / "docs" / "decisions" / "0008-client-signoff.md\n"
    try:
        newline_named.write_text('---\nstatus: accepted\nconfirmed_by: "PM"\n---\n')
    except OSError:  # filesystem refuses the name; the guard is then moot
        newline_named = None
    if newline_named is not None:
        assert factory_lib.canonical_signoff_path(
            repo, newline_named.relative_to(repo).as_posix()) == ""
        newline_named.unlink()

    sys.path.remove(str(repo / "factory" / "scripts"))
    sys.modules.pop("factory_lib", None)


def test_signoff_pin_cannot_escape_docs_decisions(repo, tmp_path):
    """The READER is authoritative: a correctly-named symlink pointing outside
    docs/decisions/ must not satisfy the gate, however it got pinned — glob
    discovery matches symlinks, and the upgrade migration carries a path out of
    gitignored run.json (autoreview r3)."""
    # Named VALIDLY on purpose: resolve() follows the link, so a badly-named
    # target would be caught by the name rule and prove nothing about
    # containment.
    outside = tmp_path / "0001-client-signoff.md"
    outside.write_text('---\nstatus: accepted\nconfirmed_by: "Nobody"\n---\n')
    link = repo / "docs" / "decisions" / "0001-escape-client-signoff.md"
    link.symlink_to(outside)

    # Pinned by hand, as a hostile or mistaken edit would.
    harness_yaml = repo / "harness.yaml"
    harness_yaml.write_text(
        re.sub(r'^signoff_record:.*$',
               'signoff_record: "docs/decisions/0001-escape-client-signoff.md"',
               harness_yaml.read_text(), count=1, flags=re.MULTILINE)
    )
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN_BODY)
    code, out = run(repo, "forge.py", "plan", "save", "--issue", "ENG-9", "--from", str(plan))
    # The invariant's OWN message: asserting a loose "sign-off" would also match
    # unrelated refusals and the control would pass with the check removed.
    assert code != 0 and "not a readable client sign-off record" in out, out

    # An ABSOLUTE pin resolves here but breaks in every other clone, so the
    # reader requires the pin to be canonical, not merely resolvable.
    real = repo / "docs" / "decisions" / "0009-client-signoff.md"
    real.write_text('---\nstatus: accepted\nconfirmed_by: "PM"\n---\n')
    harness_yaml.write_text(
        re.sub(r'^signoff_record:.*$', f'signoff_record: "{real}"',
               harness_yaml.read_text(), count=1, flags=re.MULTILINE)
    )
    code, out = run(repo, "forge.py", "plan", "save", "--issue", "ENG-9", "--from", str(plan))
    assert code != 0 and "not a readable client sign-off record" in out, out


def test_discovery_pins_the_canonical_path_not_a_symlink(repo):
    """A correctly named symlink beside its target passes the path check, but
    persisting the LINK's spelling writes a pin the reader rejects: success
    reported, every gate locked, repair refused because the pin is non-empty.
    The two also have to count as ONE record, not an ambiguous two."""
    seed_signoff_inputs(repo)
    real = repo / "docs" / "decisions" / "0001-client-signoff.md"
    real.write_text('---\nstatus: accepted\nconfirmed_by: "Client PM"\n---\n')
    link = repo / "docs" / "decisions" / "0002-alias-client-signoff.md"
    link.symlink_to(real)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "record plus alias")
    code, out = record_grill(repo, "signoff")
    assert code == 0, out

    code, out = run(repo, "record_signoff.py")
    assert code == 0, out  # one record, not "several ... use --record"
    pinned = re.search(r'^signoff_record:\s*"([^"]*)"',
                       (repo / "harness.yaml").read_text(), re.MULTILINE).group(1)
    assert pinned == "docs/decisions/0001-client-signoff.md", pinned
    assert signed_off(repo), "the pin the writer chose must satisfy the reader"


def test_signoff_pin_round_trips_or_is_refused(repo):
    """The writer must not accept a name the stdlib pin reader truncates: that
    combination reports success while leaving every gate locked, and the repair
    path then refuses because the pin is non-empty (autoreview r2)."""
    seed_signoff_inputs(repo)  # sign-off now requires confirmed specs + roadmap
    odd = repo / "docs" / "decisions" / "0001-acme co client-signoff.md"
    odd.write_text('---\nstatus: accepted\nconfirmed_by: "PM"\n---\n')
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "oddly named record")
    code, out = record_grill(repo, "signoff")
    assert code == 0, out

    code, out = run(repo, "record_signoff.py", "--record", str(odd.relative_to(repo)))
    assert code != 0, out
    assert not signed_off(repo)
    # And it is not silently chosen by auto-discovery either. This test
    # deliberately never calls sign_off(), so the fresh `forge init` fixture
    # holds no valid record and the odd one is the ONLY candidate.
    code, out = run(repo, "record_signoff.py")
    assert not signed_off(repo), out


def test_signoff_pin_is_added_to_a_manifest_that_predates_it(repo):
    """A project vendored before the key existed keeps its project-owned
    harness.yaml through upgrade, so the key is simply absent. Refusing there
    would make the gate unreachable in exactly those repos (autoreview P1)."""
    harness_yaml = repo / "harness.yaml"
    harness_yaml.write_text(
        re.sub(r'^signoff_record:.*$\n', '', harness_yaml.read_text(),
               count=1, flags=re.MULTILINE)
    )
    assert "signoff_record:" not in harness_yaml.read_text()
    sign_off(repo)
    assert signed_off(repo)


def test_signoff_survives_a_wiped_factory_dir(repo, tmp_path):
    """Every task runs in a fresh worktree where .factory/ is gitignored and
    absent. The gate must still hold there — that is why the pin is committed
    rather than recorded in run.json."""
    sign_off(repo)
    shutil.rmtree(repo / ".factory")
    code, out = run(repo, "forge.py", "next", "--repo", str(repo))
    assert code == 0, out
    assert signed_off(repo)
    # NEGATIVE CONTROL: with the pin cleared, the same repo is NOT signed off.
    (repo / "harness.yaml").write_text(
        re.sub(r'^signoff_record:.*$', 'signoff_record: ""',
               (repo / "harness.yaml").read_text(), count=1, flags=re.MULTILINE)
    )
    assert not signed_off(repo)
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN_BODY)
    code, out = run(repo, "forge.py", "plan", "save", "--issue", "ENG-9", "--from", str(plan))
    assert code != 0 and "sign-off" in out, out


def test_scaffold_does_not_inherit_the_harness_signoff(repo):
    """A new client repo has signed nothing off. Scaffolding must clear the
    harness's own pin, or every fresh project starts past its own gate."""
    assert not signed_off(repo)


def test_parse_sections_maps_headings_to_bodies():
    factory_lib = load_factory_lib(HARNESS)

    assert factory_lib.parse_sections(
        "# Brief\n\n## Summary\n\n A \n\n## Target Outcome\n \t\n"
    ) == {
        "Summary": "A",
        "Target Outcome": "",
    }

    # A brief authored on Windows is ordinary input. Multiline `$` sits before
    # the `\n` and cannot consume the `\r`, so an anchor without `\r?` misses
    # every heading and the gate refuses a document that is actually complete.
    assert factory_lib.parse_sections(
        "# Brief\r\n\r\n## Summary\r\n\r\n A \r\n\r\n## Target Outcome\r\n \t\r\n"
    ) == {
        "Summary": "A",
        "Target Outcome": "",
    }


def test_parse_sections_reads_examples_as_examples():
    """A heading inside an example illustrates a heading; it is not one.

    Every case here was broken by one of the four regex attempts that preceded
    factory_lib.example_ranges — each closed one way of over-counting and
    opened a new way of missing a real heading — so these are guards against
    reintroducing that class, not decoration.
    """
    factory_lib = load_factory_lib(HARNESS)

    # A fenced example cannot supply a section the author never wrote.
    assert factory_lib.parse_sections(
        "# Spec\n\n## Why\n\nreal\n\n```md\n## Behaviour\n\nfenced\n```\n"
    ) == {"Why": "real\n\n```md\n## Behaviour\n\nfenced\n```"}

    # ...and a section whose ONLY content is an example still has content.
    assert factory_lib.parse_sections(
        "## Acceptance criteria\n\n```gherkin\ngiven X, then Y\n```\n"
    )["Acceptance criteria"].startswith("```gherkin")

    # A closing fence exactly as long as its opener closes it, so the heading
    # after the block is document structure again.
    assert set(factory_lib.parse_sections(
        "```\n## Hidden\n```\n\n## Why\n\nreal\n"
    )) == {"Why"}

    # An info string containing a backtick opens nothing (CommonMark), so a
    # matcher that paired this line with a later fence swallowed real headings.
    assert set(factory_lib.parse_sections(
        "## Why\n\nuse ```json `x` ``` inline\n\n## Behaviour\n\nreal\n"
    )) == {"Why", "Behaviour"}

    # A comment marker inside an example must not pair with one outside it.
    assert set(factory_lib.parse_sections(
        "```\n<!--\n```\n\n## Why\n\nreal\n\n<!-- ## Hidden -->\n"
    )) == {"Why"}

    # A tilde fence is a fence; backticks inside it are content.
    assert set(factory_lib.parse_sections(
        "~~~\n```\n## Hidden\n~~~\n\n## Why\n\nreal\n"
    )) == {"Why"}

    # An unterminated construct masks NOTHING. A stray opener is a typo, and
    # reading the rest of the document as an example refuses a complete spec —
    # the failure this gate exists to remove. Over-counting only routes the
    # author to the grill that `spec confirm` requires anyway.
    assert set(factory_lib.parse_sections(
        "```\n\n## Why\n\nreal\n\n## Behaviour\n\nreal\n"
    )) == {"Why", "Behaviour"}

    # `<!--` is a comment opener at the start of a line, not wherever the
    # substring appears: in inline code or prose it is the subject, not syntax.
    assert set(factory_lib.parse_sections(
        "The marker is `<!--`\n\n## Why\n\nreal\n"
    )) == {"Why"}

    # A fence-looking line inside a comment must not change fence state, or a
    # commented-out example hides every real section after it — including when
    # a later fence would otherwise pair with the one inside the comment.
    assert set(factory_lib.parse_sections(
        "<!--\n```\n-->\n\n## Why\n\nreal\n"
    )) == {"Why"}
    assert set(factory_lib.parse_sections(
        "<!--\n```\n-->\n\n## Why\n\nreal\n\n```\n"
    )) == {"Why"}

    # ...and the mirror: a comment marker inside a fence is content, so the
    # heading after the fence closes is structure again.
    assert set(factory_lib.parse_sections(
        "```\n<!--\n```\n\n## Why\n\nreal\n"
    )) == {"Why"}

    # Only spaces and tabs may follow a closing fence. `strip()` also eats
    # NBSP, which would close a block the renderer leaves open and promote
    # the example's remaining headings to the document's own.
    assert set(factory_lib.parse_sections(
        "```\n## Hidden\n```\u00a0\n## Also hidden\n```\n\n## Why\n\nreal\n"
    )) == {"Why"}
    # A trailing ASCII space does close it, so the heading after is structure.
    assert set(factory_lib.parse_sections(
        "```\n## Hidden\n``` \n\n## Why\n\nreal\n"
    )) == {"Why"}

    # A fence opened inside a list item ends when the item does. Left open it
    # pairs with the next top-level fence and masks every heading between.
    assert set(factory_lib.parse_sections(
        "- example:\n  ```text\n  x\n## Why\n\nreal\n\n```text\nx\n```\n"
    )) == {"Why"}
    # ...but it still masks its own body, and a blank line is not an outdent.
    assert set(factory_lib.parse_sections(
        "- example:\n  ```\n\n  ## Hidden\n  ```\n\n## Why\n\nreal\n"
    )) == {"Why"}
    # Indentation alone is not list membership: a TOP-LEVEL fence may indent up
    # to three spaces, and closing that one early hands its headings over.
    assert factory_lib.parse_sections(
        "# S\n\n   ```md\n## Why\n\nw\n\n## Behaviour\n\nb\n   ```\n"
    ) == {}
    assert set(factory_lib.parse_sections(
        "- item\n\ntext\n\n  ```\n## Hidden\n  ```\n\n## Why\n\nreal\n"
    )) == {"Why"}

    # `<pre>` and friends hold their content verbatim to a closing tag, in any
    # case. A `<div>` does NOT: that block ends at the blank line, so the
    # heading after it is the document's own and masking to `</div>` would
    # refuse a complete spec.
    assert factory_lib.parse_sections(
        "# S\n\n<pre>\n## Why\n\nw\n\n## Behaviour\n\nb\n</pre>\n"
    ) == {}
    assert set(factory_lib.parse_sections(
        "# S\n\n<PRE>\n## Hidden\n</PRE>\n\n## Why\n\nreal\n"
    )) == {"Why"}
    assert set(factory_lib.parse_sections(
        "# S\n\n<div>\n\n## Why\n\nreal\n\n</div>\n"
    )) == {"Why"}
    # A container block with no blank line runs on, so those headings are its
    # content — but it ends at the first blank line, and after that the
    # document speaks for itself again.
    assert factory_lib.parse_sections(
        "# S\n\n<div>\n## Why\nw\n## Behaviour\nb\n## Acceptance criteria\n- a\n</div>\n"
    ) == {}
    assert set(factory_lib.parse_sections(
        "# S\n\n<div>\nx\n</div>\n\n## Why\n\nreal\n"
    )) == {"Why"}
    # ...and a tag named in prose opens nothing.
    assert set(factory_lib.parse_sections(
        "# S\n\nuse a <div> for layout\n\n## Why\n\nreal\n"
    )) == {"Why"}
    # The tag set is CommonMark's, not a hand-picked shortlist, so `<article>`
    # and `<ul>` behave exactly as `<div>` does.
    assert factory_lib.parse_sections(
        "# S\n\n<article>\n## Why\nw\n## Behaviour\nb\n## Acceptance criteria\n- a\n</article>\n"
    ) == {}
    assert set(factory_lib.parse_sections(
        "# S\n\n<ul>\n## Hidden\n</ul>\n\n## Why\n\nreal\n"
    )) == {"Why"}
    assert set(factory_lib.parse_sections(
        "# S\n\n<pre>\n\n## Why\n\nreal\n"
    )) == {"Why"}


def test_spec_confirm_refuses_headings_that_only_exist_in_an_example(repo):
    """The gate promises 'complete or refused'; an example is not completion."""
    spec = repo / "docs" / "specs" / "fenced.md"
    spec.parent.mkdir(parents=True, exist_ok=True)
    spec.write_text(
        "---\nslug: fenced\ntitle: Fenced\nstatus: draft\nsaved: 2026-08-04\n---\n\n"
        "# Fenced\n\n"
        "Here is the shape a spec takes:\n\n"
        "```md\n## Why\n\nbecause\n\n## Behaviour\n\nit does\n\n"
        "## Acceptance criteria\n\n- it works\n```\n"
    )
    code, out = run(repo, "forge.py", "spec", "confirm", "fenced")
    assert code != 0, out
    assert "## Why" in out and "## Behaviour" in out and "## Acceptance criteria" in out


def test_scaffolded_brief_carries_the_canonical_headings(repo):
    factory_lib = load_factory_lib(HARNESS)

    scaffolded = factory_lib.parse_sections(
        (repo / "docs" / "product" / "BRIEF.md").read_text()
    )
    live = factory_lib.parse_sections(
        (HARNESS / "docs" / "product" / "BRIEF.md").read_text()
    )
    plan_headings = re.findall(
        r"^- \*\*([^*]+)\*\* —",
        (HARNESS / "harness" / "nestjs-react" / "conventions" / "plans.md").read_text(),
        flags=re.MULTILINE,
    )

    assert tuple(scaffolded) == REQUIRED_BRIEF_HEADINGS
    assert tuple(live) == REQUIRED_BRIEF_HEADINGS
    assert tuple(plan_headings) == REQUIRED_BRIEF_HEADINGS
    sign_off(repo)
    assert signed_off(repo)


def test_signoff_refuses_a_brief_missing_a_required_heading(repo):
    brief = repo / "docs" / "product" / "BRIEF.md"
    brief.unlink()

    code, out = run(repo, "record_signoff.py")
    assert code != 0
    assert "at least one confirmed spec in docs/specs/" in out
    assert "plans/roadmap.json with at least one story" in out
    assert "docs/product/BRIEF.md is absent" in out
    assert ", ".join(REQUIRED_BRIEF_HEADINGS) in out

    missing = {"Users", "Constraints"}
    brief.write_text(
        "# Product Brief\n\n"
        + "\n".join(
            f"## {heading}\n\nComplete.\n"
            for heading in REQUIRED_BRIEF_HEADINGS
            if heading not in missing
        )
    )
    code, out = run(repo, "record_signoff.py")
    assert code != 0
    assert "brief required headings missing or empty: Users, Constraints" in out


def test_signoff_refuses_a_heading_with_an_empty_body(repo):
    seed_signoff_inputs(repo)
    empty = {"Users", "Constraints"}
    empty_body = " \t "
    (repo / "docs" / "product" / "BRIEF.md").write_text(
        "# Product Brief\n\n"
        + "\n".join(
            f"## {heading}\n\n{empty_body if heading in empty else 'Complete.'}\n"
            for heading in REQUIRED_BRIEF_HEADINGS
        )
    )

    code, out = run(repo, "record_signoff.py")
    assert code != 0
    assert "brief required headings missing or empty: Users, Constraints" in out


def test_record_signoff_requires_accepted_and_confirmed(repo):
    seed_signoff_inputs(repo)
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "grill" in out.lower()  # grill gate fires first
    record_grill(repo, "signoff")
    code, out = run(repo, "record_signoff.py")
    assert code != 0  # grilled, but no decision record yet
    run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "status" in out  # proposed, not accepted


def test_record_signoff_refuses_without_confirmed_specs_and_roadmap(repo):
    specs = repo / "docs" / "specs"
    specs.mkdir(parents=True, exist_ok=True)
    (specs / "draft.md").write_text(
        "---\nslug: draft\ntitle: Draft\nstatus: draft\n"
        "saved: 2026-07-24T00:00:00+00:00\n---\n\n# Draft\n"
    )
    code, out = run(repo, "record_signoff.py")
    assert code != 0
    assert "specs still draft or unconfirmed: docs/specs/draft.md" in out
    assert "plans/roadmap.json" in out


def test_spec_confirm_refuses_a_spec_missing_required_headings(repo, tmp_path):
    complete = {
        "title": "# Billing\n",
        "why": "## Why\n\nCustomers need invoices.\n",
        "behaviour": "## Behaviour\n\nInvoices can be downloaded.\n",
        "acceptance": "## Acceptance criteria\n\n- An invoice downloads.\n",
    }
    cases = [
        ("missing-title", "H1 title", {**complete, "title": ""}),
        ("empty-title", "H1 title", {**complete, "title": "#   \n"}),
        ("missing-why", "## Why", {**complete, "why": ""}),
        ("empty-why", "## Why", {**complete, "why": "## Why\n\n"}),
        ("missing-behaviour", "## Behaviour", {**complete, "behaviour": ""}),
        ("empty-behaviour", "## Behaviour",
         {**complete, "behaviour": "## Behaviour\n\n"}),
        ("missing-acceptance", "## Acceptance criteria",
         {**complete, "acceptance": ""}),
        ("empty-acceptance", "## Acceptance criteria",
         {**complete, "acceptance": "## Acceptance criteria\n\n"}),
    ]

    for slug, expected, parts in cases:
        draft = tmp_path / f"{slug}.md"
        draft.write_text("\n".join(parts.values()))
        code, out = run(repo, "forge.py", "spec", "save", slug,
                        "--from", str(draft))
        assert code == 0, out

        code, out = run(repo, "forge.py", "spec", "confirm", slug)
        assert code != 0
        assert expected in out
        assert "grill" not in out.lower()


def test_spec_check_never_refuses_a_complete_spec(repo):
    """Refusing a spec whose sections are plainly there is the failure this
    story exists to remove, so a document that carries an example before its
    sections must still pass. Each example below broke one of the four regex
    attempts that preceded factory_lib.example_ranges."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.specs import missing_required_content

    sections = "\n## Why\n\nw\n\n## Behaviour\n\nb\n\n## Acceptance criteria\n\n- a\n"
    for label, example in (
        ("closer longer than opener", "```\nex\n````\n"),
        ("closer indented three spaces", "```\nex\n   ```\n"),
        ("tilde fence", "~~~\nex\n~~~\n"),
        # A backtick fence's info string may not contain a backtick, so this is
        # only a legal opener with tildes — and the sections after it are real.
        ("backtick inside a tilde info string", "~~~a`b\nex\n~~~\n"),
        ("comment marker inside a fence", "```\n<!-- x\n```\n\n<!-- note -->\n"),
    ):
        document = f"---\nslug: x\n---\n\n# Billing\n\n{example}{sections}"
        assert missing_required_content(document) == [], label

    # `## Why ##` is the same heading as `## Why`. Refusing it would be the H1
    # rule contradicting the H2 rule inside one file.
    closed = ("\n## Why ##\n\nw\n\n## Behaviour ##\n\nb\n"
              "\n## Acceptance criteria ##\n\n- a\n")
    assert missing_required_content(
        f"---\nslug: x\n---\n\n# Billing\n{closed}") == []

    # An ATX closing run leaves no title behind, but a trailing hash that is
    # part of the name must survive — under LF and CRLF alike, since the
    # closing-run anchor sits before the line ending.
    for title, expected in (
        ("# #", ["H1 title"]),
        ("#   #", ["H1 title"]),
        ("# Billing #", []),
        ("# Sharp C#", []),
    ):
        document = f"---\nslug: x\n---\n\n{title}\n{sections}"
        assert missing_required_content(document) == expected, title
        assert missing_required_content(
            document.replace("\n", "\r\n")) == expected, f"{title} (CRLF)"


def test_spec_save_still_accepts_an_incomplete_draft(repo, tmp_path):
    draft = tmp_path / "notes.md"
    draft.write_text("Early notes without the required structure.\n")

    code, out = run(repo, "forge.py", "spec", "save", "early-notes",
                    "--from", str(draft))

    assert code == 0, out
    saved = repo / "docs" / "specs" / "early-notes.md"
    assert "status: draft" in saved.read_text()
    assert "Early notes without the required structure." in saved.read_text()


def test_spec_confirm_roadmap_derive_and_signoff_gate(repo, tmp_path):
    draft = tmp_path / "billing.md"
    draft.write_text(
        "# Billing\n\n"
        "## Why\n\nCustomers need invoices and payments.\n\n"
        "## Behaviour\n\nCustomers can manage invoices and payments.\n\n"
        "## Acceptance criteria\n\n- Billing actions are available.\n"
    )
    code, out = run(repo, "forge.py", "spec", "save", "billing",
                    "--from", str(draft))
    assert code == 0, out
    spec = repo / "docs" / "specs" / "billing.md"
    assert "status: draft" in spec.read_text()

    code, out = run(repo, "forge.py", "spec", "confirm", "billing")
    assert code != 0 and "grill" in out.lower()
    code, out = record_grill(repo, "spec", digest_of=spec)
    assert code == 0, out
    code, out = run(repo, "forge.py", "spec", "confirm", "billing")
    assert code == 0 and "confirmed" in out
    assert "status: confirmed" in spec.read_text()

    roadmap_input = tmp_path / "derived-roadmap.json"
    roadmap_input.write_text(json.dumps({
        "generated_by": "docs-decomposer",
        "epics": [ROADMAP_EPIC],
        "items": [authored_story("BILL-0", "Missing source")],
    }))
    code, out = run(repo, "forge.py", "roadmap", "derive",
                    "--input", str(roadmap_input))
    assert code != 0 and "'spec' is required" in out
    roadmap_input.write_text(json.dumps({
        "generated_by": "docs-decomposer",
        "epics": [ROADMAP_EPIC],
        "items": [{
            "key": "BILL-1", "title": "Invoices", "epic": "billing",
            "story": "As a user, I can create invoices.",
            "acceptance_criteria": ["Invoices can be created"], "skill": "backend",
            "spec": "docs/specs/billing.md", "depends_on": [],
        }],
    }))
    code, out = run(repo, "forge.py", "roadmap", "derive",
                    "--input", str(roadmap_input))
    assert code == 0 and "Derived roadmap" in out, out
    item = json.loads((repo / "plans" / "roadmap.json").read_text())["items"][0]
    assert item["spec"] == "docs/specs/billing.md"
    assert item["status"] == "pending" and item["order"] == 1

    git(repo, "add", "docs/specs/billing.md", "plans/roadmap.json")
    git(repo, "commit", "-q", "-m", "confirm billing contract")
    record_grill(repo, "signoff")
    run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-client-signoff.md"))
    record.write_text(record.read_text()
        .replace("status: proposed", "status: accepted")
        .replace('confirmed_by: ""', 'confirmed_by: "Client PM"'))
    code, out = run(repo, "record_signoff.py")
    assert code == 0 and "pinned to" in out, out
    # Sign-off is DERIVED from the committed harness.yaml pin, not a run.json flag.
    assert signed_off(repo)


# ------------------------------------------------------- plan approval gates

def test_update_run_approved_requires_plan_file(repo):
    sign_off(repo)
    intake(repo)
    code, out = run(repo, "update_run.py", "--plan-status", "approved")
    assert code != 0 and "plan save" in out


def test_hand_written_plan_cannot_approve_itself(repo):
    """plans/ is writable while locked, so file existence must not mean approval."""
    sign_off(repo)
    intake(repo)
    issue = run_state(repo)["issue_key"]
    forged = repo / "plans" / "active" / f"{issue}-forged.md"
    forged.parent.mkdir(parents=True, exist_ok=True)
    forged.write_text("---\nstatus: approved\n---\n\n## Surface Impact\n\nnone\n")
    # the plan file now exists; approval must still refuse
    code, out = run(repo, "update_run.py", "--plan-status", "approved")
    assert code != 0 and "plan save" in out
    assert run_state(repo).get("plan_status") != "approved"
    # ...and the lock is still armed for product writes
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" in out


def test_factory_state_is_never_hand_written(repo):
    """run.json carries plan_status — a hand edit would disarm the lock."""
    for mode in ("default", "plan"):
        code, out = hook(repo, {
            "tool_name": "Write", "permission_mode": mode,
            "tool_input": {"file_path": str(repo / ".factory" / "run.json")}})
        assert code == 0 and "deny" in out and "never hand-written" in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "echo {} > .factory/verify.json"}})
    assert "deny" in out and "never hand-written" in out
    # the session scratchpad is memory, not evidence
    code, out = hook(repo, {"tool_name": "Write", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / ".factory" / "scratchpad.md")}})
    assert "deny" not in out


def test_plan_mode_is_not_a_bash_side_door(repo):
    """Plan mode stops the Edit tools; it must not open a shell write path."""
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "plan",
                            "tool_input": {"command": "printf a > src/app.ts"}})
    assert code == 0 and "deny" in out


def test_pr_ready_requires_saved_plan(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    (repo / ".factory" / "run.json").write_text(
        json.dumps({**run_state(repo), "plan_status": "approved"})
    )
    write_passing_artifacts(repo)
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "plans/active" in out


# ------------------------------------------------------ pending-context gate

def test_plan_save_blocked_by_pending_ledgered_context(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    (repo / "docs" / "context" / "note.md").write_text("client email\n")
    run(repo, "forge.py", "context", "scan")
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "unharvested" in out  # autoreview r3


def test_plan_save_blocked_by_unscanned_drop(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    (repo / "docs" / "context" / "drop.md").write_text("raw\n")
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "unscanned" in out  # autoreview r4


def test_plan_save_blocked_when_harvested_file_changes(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ctx = repo / "docs" / "context" / "spec.md"
    ctx.write_text("v1\n")
    run(repo, "forge.py", "context", "scan")
    run(repo, "forge.py", "context", "mark", "spec.md", "--ignored", "--notes", "noise")
    ctx.write_text("v1\nv2 addendum\n")
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "unscanned" in out  # autoreview r4


def test_plan_save_passes_after_harvest(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    (repo / "docs" / "context" / "note.md").write_text("client email\n")
    run(repo, "forge.py", "context", "scan")
    run(repo, "forge.py", "context", "mark", "note.md", "--ignored", "--notes", "irrelevant")
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out


def test_next_counts_unscanned_context(repo):
    (repo / "docs" / "context" / "drop.md").write_text("raw\n")
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "Harvest 1 pending" in out  # autoreview r6


# ------------------------------------------------------------- context inbox

def test_scan_check_fails_on_drift_and_scan_registers(repo):
    (repo / "docs" / "context" / "a.md").write_text("x\n")
    code, out = run(repo, "forge.py", "context", "scan", "--check")
    assert code != 0  # drift detected, nothing written
    code, out = run(repo, "forge.py", "context", "scan")
    assert code == 0 and "pending: 1" in out
    code, out = run(repo, "forge.py", "context", "scan", "--check")
    assert code == 0


def test_subdirectory_readme_is_tracked(repo):
    sub = repo / "docs" / "context" / "client-call"
    sub.mkdir()
    (sub / "README.md").write_text("call notes\n")
    code, out = run(repo, "forge.py", "context", "scan")
    assert "client-call/README.md" in out  # autoreview r7


def test_mark_ignored_requires_notes(repo):
    (repo / "docs" / "context" / "a.md").write_text("x\n")
    run(repo, "forge.py", "context", "scan")
    code, out = run(repo, "forge.py", "context", "mark", "a.md", "--ignored")
    assert code != 0 and "--notes" in out  # autoreview r7


def test_mark_harvested_requires_real_in_repo_outputs(repo):
    (repo / "docs" / "context" / "a.md").write_text("x\n")
    run(repo, "forge.py", "context", "scan")
    code, out = run(repo, "forge.py", "context", "mark", "a.md", "--harvested")
    assert code != 0 and "--outputs" in out
    code, out = run(repo, "forge.py", "context", "mark", "a.md",
                    "--harvested", "--outputs", "docs/decisions/9999-phantom.md")
    assert code != 0 and "do not exist" in out
    for escaping in ("/etc/passwd", "../escape.md"):
        code, out = run(repo, "forge.py", "context", "mark", "a.md",
                        "--harvested", "--outputs", escaping)
        assert code != 0 and "inside the repo" in out  # autoreview r8


# ------------------------------------------------------------ intake safety

def test_intake_refuses_off_board_key(repo):
    code, out = run(repo, "intake.py", "--issue", "OFF-1", "--title", "Off board")

    assert code != 0
    assert "roadmap add --no-spec" in out


def test_intake_allows_on_board_key(repo):
    ensure_story(repo, "BOARD-1", "On board")

    code, out = run(repo, "intake.py", "--issue", "BOARD-1", "--title", "On board")

    assert code == 0, out
    assert roadmap_items(repo)["BOARD-1"]["status"] == "active"


def test_intake_preserves_signoff_and_refuses_to_clobber_evidence(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, _ = run(repo, "record_decomposition_from_json.py",
                  stdin=json.dumps(DECOMP))
    assert code == 0
    # Mid-task second intake must refuse (autoreview r3)
    code, out = intake(repo, "ENG-2", "Refunds")
    assert code != 0 and "unarchived" in out
    assert (repo / ".factory" / "decomposition.json").exists()
    # Deliberate abandonment works and preserves sign-off (intake fix, r1 of first review)
    code, out = intake(repo, "ENG-2", "Refunds", "--discard-active")
    assert code == 0, out
    state = run_state(repo)
    assert signed_off(repo) and state["phase"] == "planning"
    assert not (repo / ".factory" / "decomposition.json").exists()


def test_stale_task_state_reports_not_clears(repo):
    from intake import stale_task_state

    stale = [
        repo / ".factory" / "decomposition.json",
        repo / ".factory" / "verify.json",
        repo / ".factory" / "reviews" / "quality.json",
    ]
    for path in stale:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"evidence": true}\n')
    before = {path: path.read_bytes() for path in stale}

    reported = stale_task_state(repo)

    assert set(reported) == set(stale)
    assert {path: path.read_bytes() for path in stale} == before


def test_intake_after_ship_needs_no_discard(repo, tmp_path):
    """pr_ready writes phase 'shipped' after archiving; intake must read that
    as archived. Otherwise the next intake demands --discard-active, which
    deletes the very evidence pr_ready preserved."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, _ = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    assert code == 0
    state = run_state(repo)
    state["phase"] = "shipped"
    (repo / ".factory" / "run.json").write_text(json.dumps(state))
    code, out = intake(repo, "ENG-2", "Refunds")
    assert code == 0, out


def test_intake_guards_orphaned_approved_plan(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)  # plan approved, nothing else yet
    code, out = intake(repo, "ENG-2", "Refunds")
    assert code != 0 and "active plan" in out  # autoreview r9
    code, out = intake(repo, "ENG-2", "Refunds", "--discard-active")
    assert code == 0
    assert (repo / "plans" / "debt" / "ENG-1-invoices.md").exists()
    assert not list((repo / "plans" / "active").glob("ENG-1-*.md"))


def test_phase_implementing_requires_approved_saved_plan(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    code, out = run(repo, "update_run.py", "--phase", "implementing",
                    "--decomposition-status", "recorded")
    assert code != 0 and "approved" in out  # autoreview r9
    save_plan(repo, tmp_path)
    # Plan approved but decomposition artifact still missing (autoreview r11)
    code, out = run(repo, "update_run.py", "--phase", "implementing",
                    "--decomposition-status", "recorded")
    assert code != 0 and "decomposition" in out
    code, _ = run(repo, "record_decomposition_from_json.py",
                  stdin=json.dumps(DECOMP))
    assert code == 0
    code, out = run(repo, "update_run.py", "--phase", "implementing")
    assert code == 0, out


def test_update_run_enforces_artifact_phase_order(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    assert code == 0, out

    code, out = run(repo, "update_run.py", "--phase", "reviewing")
    assert code != 0 and "verify.json" in out
    (repo / ".factory" / "verify.json").write_text(json.dumps({"ok": True}))
    code, out = run(repo, "update_run.py", "--phase", "reviewing")
    assert code != 0 and "tests.json" in out
    (repo / ".factory" / "tests.json").write_text(json.dumps({"automated": {}}))
    code, out = run(repo, "update_run.py", "--phase", "reviewing")
    assert code == 0, out

    code, out = run(repo, "update_run.py", "--phase", "functional-check")
    assert code != 0 and "reviews" in out
    reviews = repo / ".factory" / "reviews"
    reviews.mkdir(exist_ok=True)
    for aspect in ("quality", "performance", "security"):
        (reviews / f"{aspect}.json").write_text(json.dumps({"score": 9}))
    code, out = run(repo, "update_run.py", "--phase", "functional-check")
    assert code == 0, out

    code, out = run(repo, "update_run.py", "--phase", "pr-ready")
    assert code != 0 and "pr_ready.py" in out


def test_decomposition_refused_without_run_state(repo):
    (repo / ".factory" / "run.json").unlink()
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code != 0 and "run.json" in out  # autoreview r11
    assert not (repo / ".factory" / "decomposition.json").exists()


def test_evidence_recorders_gated_on_preconditions(repo):
    # The whole writer family shares gate(): verify + test/review recorders
    # refuse before sign-off/plan/decomposition exist.
    intake(repo)
    for script, args, stdin in (
        ("verify.py", ("--print-only",), None),
        ("record_test_from_json.py", ("--kind", "automated"),
         json.dumps({"status": "passed"})),
        ("record_review_from_json.py", ("--aspect", "quality"),
         json.dumps({"score": 9})),
    ):
        code, out = run(repo, script, *args, stdin=stdin)
        assert code != 0 and "sign-off" in out, f"{script}: {out}"


# ----------------------------------------------------- provenance and upgrade

def ready_task(repo: Path, tmp_path: Path) -> None:
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")


def test_pr_ready_rejects_unstamped_evidence(repo, tmp_path):
    ready_task(repo, tmp_path)
    verify = repo / ".factory" / "verify.json"
    verify.write_text(json.dumps({"ok": True}))  # no commit stamp
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "provenance" in out


def test_pr_ready_rejects_stale_evidence_after_code_change(repo, tmp_path):
    ready_task(repo, tmp_path)
    (repo / "app.py").write_text("print('changed after evidence')\n")
    git(repo, "add", "app.py")
    git(repo, "commit", "-q", "-m", "code change after evidence")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "fresh evidence" in out
    # Re-recording at the new commit clears it
    write_passing_artifacts(repo)
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_pr_ready_accepts_decomposition_recorded_before_implementation(repo, tmp_path):
    # Found by the pilot simulation: decomposition is stamped at planning time,
    # code lands after, evidence is stamped at the implementation commit.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, _ = run(repo, "record_decomposition_from_json.py",
                  stdin=json.dumps(DECOMP))
    assert code == 0
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "plan + decomposition")
    (repo / "src.py").write_text("VALUE = 1\n")
    git(repo, "add", "src.py")
    git(repo, "commit", "-q", "-m", "implementation")
    write_passing_artifacts(repo)  # evidence stamped at the new HEAD
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_pr_ready_tolerates_evidence_only_commits(repo, tmp_path):
    ready_task(repo, tmp_path)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "record evidence")  # touches .factory/plans only
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_pr_ready_tolerates_harness_upgrade_commits(repo, tmp_path):
    # Found by the pilot simulation: a forge upgrade mid-task touches factory/
    # machinery — that is not product code and must not invalidate evidence.
    # A real upgrade also re-freezes the vendor manifest; simulate both halves.
    ready_task(repo, tmp_path)
    (repo / "factory" / "scripts" / "extra_helper.py").write_text("# upgraded\n")
    refresh_manifest(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "chore: forge upgrade")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_upgrade_survives_a_repo_without_harness_yaml(repo, tmp_path):
    """harness.yaml is PROJECT-owned, so an older scaffold may not have one —
    which is the normal state of the legacy repos this command exists to
    upgrade. Reading it unconditionally turned that into a traceback AFTER the
    writes, leaving the target half-upgraded."""
    (repo / "harness.yaml").unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "older scaffold: no harness.yaml")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    assert "Traceback" not in output
    assert "no harness.yaml in this repo" in output


def test_upgrade_replaces_machinery_preserves_project(repo, tmp_path):
    # Degrade machinery, add project-owned content + a proposed skill
    (repo / "factory" / "scripts" / "verify.py").unlink()
    proposed = repo / "factory" / "skills" / "proposed"
    proposed.mkdir(parents=True, exist_ok=True)
    (proposed / "keep-me.md").write_text("status: proposed\n")
    memory = repo / "docs" / "memory" / "MEMORY.md"
    memory.write_text("# Project Memory\n\nClient-specific fact.\n")
    run(repo, "forge.py", "decision", "new", "keep-decision", "--repo", str(repo))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "project state")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (repo / "factory" / "scripts" / "verify.py").exists()  # machinery restored
    assert (proposed / "keep-me.md").exists()  # evolution state preserved
    assert "Client-specific fact" in memory.read_text()  # project memory preserved
    assert list((repo / "docs" / "decisions").glob("*keep-decision.md"))  # project-owned untouched
    assert head(repo) in (repo / "constitution" / "VENDORED_FROM").read_text() or \
        "symphony-forge @" in (repo / "constitution" / "VENDORED_FROM").read_text()


def upgrade_into(repo: Path):
    return subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )


def test_upgrade_does_not_vendor_the_harness_source_marker(repo):
    # `forge upgrade` runs FROM the harness source, which carries the repo-kind
    # marker. It must never copy that marker into the upgraded client, or the
    # client would classify its vendored machinery as product and lock it.
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.repo_kind import is_harness_source_repo
    assert is_harness_source_repo(HARNESS), "harness source must carry the marker"
    assert not (repo / ".factory" / "harness-source.json").exists()  # baseline: client
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (repo / ".factory" / "harness-source.json").exists()
    assert not is_harness_source_repo(repo)


def test_upgrade_refuses_a_symlinked_destination_before_writing(repo, tmp_path):
    outside = tmp_path / "outside-config.toml"
    outside.write_text("do not replace\n")
    destination = repo / ".codex" / "config.toml"
    destination.unlink()
    destination.symlink_to(outside)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "symlinked upgrade destination")

    proc = upgrade_into(repo)

    assert proc.returncode != 0
    assert "refusing destination outside the target" in proc.stdout + proc.stderr
    assert destination.is_symlink()
    assert outside.read_text() == "do not replace\n"
    assert git(repo, "status", "--porcelain") == ""


def test_upgrade_refuses_a_symlinked_ancestor_and_leaves_the_target_clean(
    repo, tmp_path,
):
    outside = tmp_path / "outside-workflows"
    outside.mkdir()
    workflows = repo / ".github" / "workflows"
    shutil.rmtree(workflows)
    workflows.symlink_to(outside, target_is_directory=True)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "symlinked upgrade ancestor")

    proc = upgrade_into(repo)

    assert proc.returncode != 0
    assert "refusing destination outside the target" in proc.stdout + proc.stderr
    assert workflows.is_symlink()
    assert list(outside.iterdir()) == []
    assert git(repo, "status", "--porcelain") == ""


def strip_pin(repo: Path) -> None:
    """A project vendored before the pin key existed."""
    harness_yaml = repo / "harness.yaml"
    harness_yaml.write_text(
        re.sub(r'^signoff_record:.*$\n', '', harness_yaml.read_text(),
               count=1, flags=re.MULTILINE)
    )


def test_upgrade_migration_promotes_and_refuses_correctly(repo, tmp_path):
    """The migration must carry a legacy sign-off across, recover it from
    committed evidence when the gitignored run state is absent, and NEVER
    promote a project whose run state explicitly says unsigned (r8, r9)."""
    record = repo / "docs" / "decisions" / "0005-client-signoff.md"
    record.write_text('---\nstatus: accepted\nconfirmed_by: "Client PM"\n---\n')
    strip_pin(repo)
    # Explicitly UNSIGNED legacy state, with an accepted-looking record present.
    (repo / ".factory").mkdir(exist_ok=True)
    # The record path is present but the FLAG says unsigned, so only the flag
    # check can refuse — otherwise the control below proves nothing.
    (repo / ".factory" / "run.json").write_text(json.dumps({
        "client_signoff": False,
        "client_signoff_record": "docs/decisions/0005-client-signoff.md",
    }))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "legacy project, unsigned")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not signed_off(repo), "an explicitly unsigned project was promoted"

    # Run state simply GONE (fresh clone). An accepted record is NOT evidence
    # that sign-off happened — it can be committed before record_signoff.py ever
    # succeeds, and the required grill leaves no committed trace. The old scheme
    # also refused here (`if not state ... fail`), so nothing is lost.
    strip_pin(repo)
    (repo / ".factory" / "run.json").unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "no run state")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not signed_off(repo), "absent run state was treated as prior sign-off"
    assert "record_signoff.py" in proc.stdout + proc.stderr

    # An explicitly SIGNED legacy state is carried across, which is the one
    # case with real evidence.
    strip_pin(repo)
    (repo / ".factory").mkdir(exist_ok=True)
    (repo / ".factory" / "run.json").write_text(json.dumps({
        "client_signoff": True,
        "client_signoff_record": "docs/decisions/0005-client-signoff.md",
    }))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "legacy signed")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert signed_off(repo), "a genuinely signed legacy project was un-signed"
    assert "0005-client-signoff.md" in (repo / "harness.yaml").read_text()


def test_upgrade_refreshes_factory_workflows_and_keeps_project_ones(repo):
    # .github/workflows/ is mixed ownership: upgrade must refresh the harness
    # factory workflows without deleting the project's own (deployment/release).
    wf = repo / ".github" / "workflows"
    (wf / "deploy.yml").write_text("name: deploy to prod\n")
    (wf / "factory-scaffold.yml").write_text("name: stale factory\n")  # drift
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "project deploy workflow + drifted factory workflow")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # project-owned workflow survives (previously rmtree'd with the whole .github)
    assert (wf / "deploy.yml").read_text() == "name: deploy to prod\n"
    # harness factory workflow refreshed from the harness (drift overwritten)
    assert (wf / "factory-scaffold.yml").read_text() == \
        (HARNESS / ".github" / "workflows" / "factory-scaffold.yml").read_text()


def test_upgrade_refuses_dirty_target(repo):
    (repo / "dirty.txt").write_text("uncommitted\n")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert proc.returncode != 0 and "uncommitted" in proc.stdout + proc.stderr


def _make_legacy_upgrade_target(repo: Path) -> None:
    shutil.copytree(repo / "factory", repo / ".agents")
    shutil.rmtree(repo / "factory")


def _upgrade_target(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )


def test_upgrade_retires_the_legacy_agents_tree(repo):
    _make_legacy_upgrade_target(repo)
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "pre-rename harness layout")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (repo / ".agents").exists()
    assert (repo / "factory" / "scripts" / "forge.py").exists()
    assert (repo / "factory" / "schemas" / "decomposition.json").exists()


def test_upgrade_carries_legacy_skills_into_factory(repo):
    _make_legacy_upgrade_target(repo)
    legacy_skills = repo / ".agents" / "skills"
    (legacy_skills / "proposed" / "client-proposal.md").write_text("proposal\n")
    (legacy_skills / "rejected" / "client-rejection.md").write_text("rejection\n")
    custom = legacy_skills / "client-release-skill"
    custom.mkdir()
    (custom / "SKILL.md").write_text("client skill\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy skill evolution state")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (repo / "factory" / "skills" / "proposed" /
            "client-proposal.md").read_text() == "proposal\n"
    assert (repo / "factory" / "skills" / "rejected" /
            "client-rejection.md").read_text() == "rejection\n"
    assert (repo / "factory" / "skills" / "client-release-skill" /
            "SKILL.md").read_text() == "client skill\n"
    assert not (repo / ".agents").exists()


def test_upgrade_refuses_an_unrecognized_path_under_agents(repo):
    _make_legacy_upgrade_target(repo)
    orphan = repo / ".agents" / "client-private" / "keep.txt"
    orphan.parent.mkdir()
    orphan.write_text("must survive\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy tree with unrecognized content")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert ".agents/client-private/keep.txt" in proc.stdout + proc.stderr
    assert orphan.read_text() == "must survive\n"
    assert (repo / ".agents").exists()


def test_upgrade_retires_a_legacy_tree_carrying_pycache(repo):
    # Every repo that actually RAN the old machinery carries __pycache__ under
    # it, and vendoring never shipped build noise — so a .pyc has no factory/
    # counterpart by construction. Counting it would abort the upgrade on
    # exactly the repos this migration exists for.
    _make_legacy_upgrade_target(repo)
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy tree with compiled artifacts")
    # Written AFTER the commit: real repos gitignore bytecode, so the artifact
    # that must not abort the upgrade is the UNTRACKED one. A tracked .pyc is
    # committed content and is checked like anything else.
    cached = repo / ".agents" / "scripts" / "__pycache__" / "forge.cpython-313.pyc"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"\x00compiled\n")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (repo / ".agents").exists()


def test_upgrade_refuses_unrecognized_content_parked_under_a_cache_name(repo):
    # Only the bytecode itself is exempt from the counterpart check. Exempting
    # every path under a __pycache__ directory would let arbitrary content be
    # deleted by a name convention, which is the one thing retirement promises
    # not to do.
    _make_legacy_upgrade_target(repo)
    parked = repo / ".agents" / "scripts" / "__pycache__" / "notes.txt"
    parked.parent.mkdir(parents=True)
    parked.write_text("not bytecode\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "content parked under a cache name")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert "notes.txt" in proc.stdout + proc.stderr
    assert parked.read_text() == "not bytecode\n"


def test_upgrade_refuses_a_symlinked_legacy_skills_root(repo, tmp_path):
    # Not traversable without dereferencing, not mergeable into the real
    # factory/skills without a policy — and retiring .agents/ would delete the
    # link, silently dropping every client skill it stood for.
    external = tmp_path / "external-skills"
    (external / "vendor-skill").mkdir(parents=True)
    (external / "vendor-skill" / "SKILL.md").write_text("external\n")
    _make_legacy_upgrade_target(repo)
    shutil.rmtree(repo / ".agents" / "skills")
    (repo / ".agents" / "skills").symlink_to(external)
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy skills root as a symlink")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert ".agents/skills is not a directory" in proc.stdout + proc.stderr
    assert (repo / ".agents" / "skills").is_symlink()
    assert (external / "vendor-skill" / "SKILL.md").read_text() == "external\n"


def test_upgrade_refuses_a_tracked_pyc_with_no_counterpart(repo):
    # The .pyc exemption exists for build noise, which is untracked by
    # definition. A COMMITTED .pyc is client content, and exempting it by
    # suffix alone would delete it on nothing but its name.
    _make_legacy_upgrade_target(repo)
    committed = repo / ".agents" / "client" / "plugin.pyc"
    committed.parent.mkdir(parents=True)
    committed.write_bytes(b"\x00client bytecode\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "tracked client bytecode")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert ".agents/client/plugin.pyc" in proc.stdout + proc.stderr
    assert committed.read_bytes() == b"\x00client bytecode\n"


def test_upgrade_refuses_a_legacy_skills_root_that_is_a_file(repo):
    # The counterpart check exempts everything under skills/ because a real
    # directory there is shipped or preserved. A regular FILE at that path is
    # neither — it would be deleted with the tree, unchecked and unpreserved.
    _make_legacy_upgrade_target(repo)
    shutil.rmtree(repo / ".agents" / "skills")
    (repo / ".agents" / "skills").write_text("client notes, not a skills dir\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "skills root replaced by a file")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert ".agents/skills is not a directory" in proc.stdout + proc.stderr
    assert (repo / ".agents" / "skills").read_text() == "client notes, not a skills dir\n"


def test_upgrade_reports_a_migrated_client_skill_naming_the_old_tree(repo):
    # The carried skill lands at factory/skills/<name>, which is untracked
    # until the human stages the upgrade — so a report built only from
    # git ls-files would say "none" while this file still names .agents/.
    _make_legacy_upgrade_target(repo)
    custom = repo / ".agents" / "skills" / "client-ops-skill"
    custom.mkdir(parents=True)
    (custom / "SKILL.md").write_text("Run .agents/scripts/verify.py first.\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "client skill naming the old tree")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "factory/skills/client-ops-skill/SKILL.md" in proc.stdout


def test_upgrade_refuses_a_symlinked_legacy_root(repo, tmp_path):
    # Every later step reaches THROUGH the link: .agents/skills resolves past
    # it, so migration would copy an external directory into factory/skills.
    external = tmp_path / "outside"
    (external / "skills" / "vendor-skill").mkdir(parents=True)
    (external / "skills" / "vendor-skill" / "SKILL.md").write_text("external\n")
    _make_legacy_upgrade_target(repo)
    shutil.rmtree(repo / ".agents")
    (repo / ".agents").symlink_to(external)
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "machinery root as a symlink")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert ".agents is a symlink" in proc.stdout + proc.stderr
    assert not (repo / "factory" / "skills" / "vendor-skill").exists()
    assert (external / "skills" / "vendor-skill" / "SKILL.md").read_text() == "external\n"


def test_upgrade_preserves_a_dangling_client_skill_symlink(repo):
    # exists() is False for a dangling link, so the preservation check skipped
    # it and replacing factory/ deleted project-owned content.
    _make_legacy_upgrade_target(repo)
    (repo / "factory" / "skills").mkdir(parents=True)
    (repo / "factory" / "skills" / "client-linked").symlink_to("../../not-there")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "dangling client skill link")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (repo / "factory" / "skills" / "client-linked").is_symlink()


def test_upgrade_reports_a_client_skill_already_at_the_current_path(repo):
    # A client skill ALREADY under factory/skills/ is preserved, not replaced,
    # so it is project-owned — but it sits inside an UPGRADE_TREES entry and
    # the harness-owned filter would otherwise discard it and report "none".
    _make_legacy_upgrade_target(repo)
    current = repo / "factory" / "skills" / "client-current-skill"
    current.mkdir(parents=True)
    (current / "SKILL.md").write_text("See .agents/scripts/verify.py\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "client skill at the current path")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "factory/skills/client-current-skill/SKILL.md" in proc.stdout


def test_adapter_check_tolerates_os_artifacts(repo):
    # A structural gate must not depend on whether someone opened the folder
    # in Finder. These are gitignored everywhere and recreated by the desktop;
    # failing on them took check_dual_runtime — and verify.py with it — red in
    # a freshly upgraded client repo.
    for adapter in (".claude", ".codex"):
        (repo / adapter).mkdir(parents=True, exist_ok=True)
        (repo / adapter / ".DS_Store").write_bytes(b"\x00finder\n")
    proc = subprocess.run(
        [sys.executable, str(repo / "factory/scripts/check_dual_runtime.py")],
        cwd=repo, capture_output=True, text=True)
    assert ".DS_Store" not in proc.stdout + proc.stderr


def test_upgrade_does_not_vendor_os_noise(repo):
    # .DS_Store is gitignored in the HARNESS, so it is invisible there while
    # sitting on disk — and copytree walks the filesystem, not the index. A
    # real upgrade shipped one into the client, where .claude/.DS_Store fails
    # the thin-adapter linter.
    noise = HARNESS / ".claude" / ".DS_Store"
    created = not noise.exists()
    if created:
        noise.write_bytes(b"\x00finder\n")
    try:
        _make_legacy_upgrade_target(repo)
        git(repo, "add", "-A", "-f")
        git(repo, "commit", "-q", "-m", "pre-rename layout")

        proc = _upgrade_target(repo)

        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert not list(repo.rglob(".DS_Store"))
    finally:
        if created:
            noise.unlink()


def test_upgrade_report_ignores_names_that_merely_start_with_agents(repo):
    # Found on the real target: agentstats' own sources carry
    # `com.agentstats.push` and `day.agents`, and a bare-substring search
    # reported three source files as stale machinery references.
    _make_legacy_upgrade_target(repo)
    src = repo / "src" / "scheduler.ts"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text('const LABEL = "com.agentstats.push";\nreturn day.agents;\n')
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "sources with agents-prefixed identifiers")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "src/scheduler.ts" not in proc.stdout


def test_upgrade_reports_a_symlink_pointing_at_the_retired_root(repo):
    # `legacy-tools -> .agents` has no trailing slash and breaks just as
    # thoroughly as one naming a file inside it.
    _make_legacy_upgrade_target(repo)
    (repo / "legacy-tools").symlink_to(".agents")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "link pointing at the machinery root")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "legacy-tools" in proc.stdout


def test_upgrade_refusal_leaves_the_target_untouched(repo):
    # The refusal tells the human to delete the orphan and re-run. If the
    # abort happened after the trees were replaced, that re-run would be
    # rejected by the dirty-target gate — the repair would be unrunnable.
    _make_legacy_upgrade_target(repo)
    orphan = repo / ".agents" / "client-private" / "keep.txt"
    orphan.parent.mkdir()
    orphan.write_text("must survive\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy tree with unrecognized content")

    proc = _upgrade_target(repo)

    assert proc.returncode != 0
    assert not git(repo, "status", "--porcelain").strip(), \
        "a refused upgrade must leave the worktree clean so the repair can re-run"
    assert not (repo / "factory").exists()


def test_upgrade_preserves_a_legacy_skill_symlink_as_a_symlink(repo, tmp_path):
    # Dereferencing would copy the referent's bytes into the repo under the
    # link's name — and retirement then deletes the original, so an external
    # target would be silently absorbed.
    outside = tmp_path / "outside-the-repo.txt"
    outside.write_text("never belongs in the repo\n")
    _make_legacy_upgrade_target(repo)
    custom = repo / ".agents" / "skills" / "client-linked-skill"
    custom.mkdir(parents=True)
    (custom / "SKILL.md").write_text("client skill\n")
    (custom / "asset").symlink_to(outside)
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "legacy client skill carrying a symlink")

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    carried = repo / "factory" / "skills" / "client-linked-skill" / "asset"
    assert carried.is_symlink()
    assert not (repo / ".agents").exists()


def test_upgrade_reports_stale_agents_references(repo):
    _make_legacy_upgrade_target(repo)
    project_file = repo / "docs" / "context" / "legacy-path.md"
    project_file.write_text("Run .agents/scripts/verify.py after changes.\n")
    archived = repo / ".factory" / "history" / "OLD-1" / "notes.md"
    archived.parent.mkdir(parents=True)
    archived.write_text("Archived .agents/scripts/verify.py evidence.\n")
    git(repo, "add", "-A", "-f")
    git(repo, "commit", "-q", "-m", "tracked legacy references")
    dependency = repo / "node_modules" / "example" / "index.js"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("require('.agents/scripts/verify.py')\n")
    assert not git(repo, "ls-files", "node_modules")
    before = project_file.read_bytes()

    proc = _upgrade_target(repo)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "docs/context/legacy-path.md" in proc.stdout
    assert ".factory/history/OLD-1/notes.md" not in proc.stdout
    assert "node_modules/example/index.js" not in proc.stdout
    assert project_file.read_bytes() == before


# --------------------------------------------------------- misc deterministic

def test_decision_accept_and_plain_issue_keys(repo):
    seed_signoff_inputs(repo)
    record_grill(repo, "signoff")
    code, out = run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    assert code == 0
    code, out = run(repo, "forge.py", "decision", "accept", "client-signoff", "--by", "Client PM")
    assert code == 0 and "Accepted" in out
    code, out = run(repo, "record_signoff.py")
    assert code == 0, out
    # Linear-style keys are NOT mandatory (GitHub/Jira/plain all work)
    for key in ("42", "gh-42", "PROJ_9.1"):
        code, out = intake(repo, key, f"Task {key}", "--discard-active")
        assert code == 0, out
        assert run_state(repo)["issue_key"] == key


def test_decision_numbering_allocates_sequentially(repo):
    run(repo, "forge.py", "decision", "new", "first", "--repo", str(repo))
    run(repo, "forge.py", "decision", "new", "second", "--repo", str(repo))
    names = sorted(p.name for p in (repo / "docs" / "decisions").glob("00*.md"))
    assert names == ["0001-first.md", "0002-second.md"]


def test_plan_assume_requires_active_plan_then_appends(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    code, out = run(repo, "forge.py", "plan", "assume", "guessing")
    assert code != 0 and "no active plan" in out
    save_plan(repo, tmp_path)
    code, out = run(repo, "forge.py", "plan", "assume", "IDs are UUIDv7")
    assert code == 0, out
    plan = next((repo / "plans" / "active").glob("ENG-1-*.md")).read_text()
    assert "## Implementation Assumptions" in plan and "IDs are UUIDv7" in plan


def test_dual_runtime_linter_clean_on_scaffold_and_catches_phantom_ref(repo):
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out
    (repo / "plans" / "active").mkdir(parents=True, exist_ok=True)
    (repo / "plans" / "active" / "X-1-x.md").write_text(
        "see docs/decisions/0042-phantom.md\n"
    )
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "phantom" in out


# ------------------------------------------------------------------- roadmap

ROADMAP_EPIC = {"id": "billing", "title": "Billing", "objective": "money in",
                "source_refs": ["docs/product/BRIEF.md"]}


def authored_story(key: str, title: str, **over) -> dict:
    return {"key": key, "title": title, "epic": "billing",
            "story": f"As a user, I can use {title.lower()}.",
            "acceptance_criteria": [f"{title} works"], "skill": "backend",
            "depends_on": [], **over}


ROADMAP = {"generated_by": "human", "epics": [ROADMAP_EPIC], "items": [
    authored_story("ENG-1", "Invoices"),
    authored_story("ENG-2", "Payments"),
]}


def approve_epics(repo: Path, src: Path) -> None:
    """The PM->EM handoff gate: a digest-bound epics grill + accepted decision."""
    record_grill(repo, "epics", digest_of=src)
    if list((repo / "docs" / "decisions").glob("*epics-approved*.md")):
        return
    run(repo, "forge.py", "decision", "new", "epics-approved", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*epics-approved*.md"))
    record.write_text(
        record.read_text()
        .replace("status: proposed", "status: accepted")
        .replace('confirmed_by: ""', 'confirmed_by: "PM"')
    )


def import_roadmap(repo: Path, tmp_path: Path, payload=None) -> tuple[int, str]:
    if not signed_off(repo):
        sign_off(repo)  # roadmap mutations are post-sign-off
    src = tmp_path / "roadmap-input.json"
    src.write_text(json.dumps(payload if payload is not None else ROADMAP))
    approve_epics(repo, src)
    return run(repo, "forge.py", "roadmap", "import", "--input", str(src))


def roadmap_items(repo: Path) -> dict:
    data = json.loads((repo / "plans" / "roadmap.json").read_text())
    return {item["key"]: item for item in data["items"]}


def add_epic(repo: Path, epic=ROADMAP_EPIC) -> tuple[int, str]:
    source_args = [arg for ref in epic["source_refs"] for arg in ("--source-ref", ref)]
    return run(repo, "forge.py", "roadmap", "epic", "add", epic["id"],
               "--title", epic["title"], "--objective", epic["objective"],
               *source_args)


@pytest.mark.skipif(
    not FORGE_INIT_FIXTURE.is_dir(),
    reason="requires the FORGE-INIT-1 history fixture",
)
def test_shipped_roadmap_satisfies_the_story_contract():
    roadmap = json.loads((HARNESS / "plans" / "roadmap.json").read_text())
    epics = roadmap["epics"]
    assert epics

    epic_ids = set()
    for epic in epics:
        assert all(epic.get(field) for field in ("id", "title", "objective"))
        assert epic.get("source_refs")
        assert all((HARNESS / source_ref).is_file()
                   for source_ref in epic["source_refs"])
        epic_ids.add(epic["id"])

    assert all(item.get("epic") in epic_ids for item in roadmap["items"])


def test_epic_add_refuses_a_duplicate_id(repo):
    epic = {**ROADMAP_EPIC,
            "source_refs": ["docs/product/BRIEF.md", "docs/FACTORY.md"]}
    code, out = add_epic(repo, epic)
    assert code != 0 and "post-sign-off" in out, out

    sign_off(repo)
    code, out = add_epic(repo, epic)
    assert code == 0, out
    data = json.loads((repo / "plans" / "roadmap.json").read_text())
    assert data["epics"] == [epic]
    assert not list((repo / "docs" / "decisions").glob("*epics-approved*.md"))

    code, out = add_epic(repo, epic)
    assert code != 0 and "already" in out, out

    code, out = run(repo, "forge.py", "roadmap", "epic", "add", "--help")
    assert code == 0 and "does not require the epics-approved decision" in " ".join(
        out.split()), out


def test_set_epic_points_a_story_at_a_known_epic(repo):
    sign_off(repo)
    code, out = add_epic(repo)
    assert code == 0, out

    code, out = run(repo, "forge.py", "roadmap", "set-epic", "SIGNOFF-0",
                    "--epic", "billing")
    assert code == 0, out
    assert roadmap_items(repo)["SIGNOFF-0"]["epic"] == "billing"

    code, out = run(repo, "forge.py", "roadmap", "set-epic", "MISSING-1",
                    "--epic", "billing")
    assert code != 0 and "not on the roadmap" in out, out
    code, out = run(repo, "forge.py", "roadmap", "set-epic", "SIGNOFF-0",
                    "--epic", "missing")
    assert code != 0 and "not a known epic" in out, out


def test_roadmap_fill_sets_blank_field_on_pending(repo):
    seed_signoff_inputs(repo)
    ensure_story(repo, "ENG-9", "Reports")
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text())
    item = next(item for item in data["items"] if item["key"] == "ENG-9")
    item.pop("spec")
    data["epics"].append({"id": "billing"})
    path.write_text(json.dumps(data, indent=2) + "\n")
    args = (
        "roadmap", "fill", "ENG-9",
        "--story", "As a finance lead, I see monthly reports.",
        "--ac", "the report lists every invoice",
        "--skill", "backend", "--epic", "billing",
        "--spec", "docs/specs/base.md", "--depends-on", "SIGNOFF-0",
    )

    code, out = run(repo, "forge.py", *args)
    assert code == 0, out
    item = roadmap_items(repo)["ENG-9"]
    assert item["story"] == "As a finance lead, I see monthly reports."
    assert item["acceptance_criteria"] == ["the report lists every invoice"]
    assert item["skill"] == "backend"
    assert item["epic"] == "billing"
    assert item["spec"] == "docs/specs/base.md"
    assert item["depends_on"] == ["SIGNOFF-0"]
    events = [json.loads(line) for line in
              (repo / ".factory" / "events.jsonl").read_text().splitlines()]
    filled = [event for event in events if event["event"] == "roadmap-filled"]
    assert len(filled) == 1 and filled[0]["story"] == "ENG-9"

    roadmap_before = path.read_bytes()
    events_before = (repo / ".factory" / "events.jsonl").read_bytes()
    code, out = run(repo, "forge.py", *args)
    assert code == 0 and "already has the requested values" in out, out
    assert path.read_bytes() == roadmap_before
    assert (repo / ".factory" / "events.jsonl").read_bytes() == events_before


def test_roadmap_fill_refuses_nonblank_field(repo):
    ensure_story(repo, "ENG-9", "Reports")
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text())
    item = next(item for item in data["items"] if item["key"] == "ENG-9")
    item["story"] = "Existing story"
    path.write_text(json.dumps(data, indent=2) + "\n")
    before = path.read_bytes()

    code, out = run(repo, "forge.py", "roadmap", "fill", "ENG-9",
                    "--story", "Replacement story")
    assert code != 0 and "story" in out and "already non-blank" in out, out
    assert path.read_bytes() == before


def test_roadmap_fill_refuses_active_card(repo):
    ensure_story(repo, "ENG-9", "Reports")
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text())
    item = next(item for item in data["items"] if item["key"] == "ENG-9")
    item["status"] = "active"
    path.write_text(json.dumps(data, indent=2) + "\n")
    before = path.read_bytes()

    code, out = run(repo, "forge.py", "roadmap", "fill", "ENG-9",
                    "--story", "A story")
    assert code != 0 and "active" in out and "pending" in out, out
    assert path.read_bytes() == before


def test_roadmap_fill_refuses_done_card(repo):
    ensure_story(repo, "ENG-9", "Reports")
    path = repo / "plans" / "roadmap.json"
    data = json.loads(path.read_text())
    item = next(item for item in data["items"] if item["key"] == "ENG-9")
    item["status"] = "done"
    path.write_text(json.dumps(data, indent=2) + "\n")
    before = path.read_bytes()

    code, out = run(repo, "forge.py", "roadmap", "fill", "ENG-9",
                    "--story", "A story")
    assert code != 0 and "done" in out and "pending" in out, out
    assert path.read_bytes() == before


def test_roadmap_add_requires_a_known_epic(repo):
    sign_off(repo)
    code, out = add_epic(repo)
    assert code == 0, out
    story_flags = ("--story", "As a finance lead, I see monthly reports.",
                   "--ac", "the report lists every invoice", "--skill", "backend")

    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    *story_flags, "--spec", "docs/specs/base.md")
    assert code != 0 and "--epic" in out and "required" in out, out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    *story_flags, "--epic", "missing", "--spec", "docs/specs/base.md")
    assert code != 0 and "not a known epic" in out, out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    *story_flags, "--epic", "billing", "--spec", "docs/specs/base.md")
    assert code == 0 and roadmap_items(repo)["ENG-9"]["epic"] == "billing", out


def test_roadmap_add_no_spec_still_records_spec_debt(repo):
    sign_off(repo)
    code, out = add_epic(repo)
    assert code == 0, out
    reason = "client asked mid-sprint"
    code, out = run(
        repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
        "--story", "As a finance lead, I see monthly reports.",
        "--ac", "the report lists every invoice", "--skill", "backend",
        "--epic", "billing", "--no-spec", "--reason", reason,
    )
    assert code == 0, out
    item = roadmap_items(repo)["ENG-9"]
    assert item["origin"] == "adhoc"
    assert item["spec_debt_reason"] == reason


def test_roadmap_add_no_spec_without_ac_records_debt(repo):
    sign_off(repo)
    code, out = add_epic(repo)
    assert code == 0, out
    reason = "client asked mid-sprint"
    code, out = run(
        repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
        "--story", "As a finance lead, I see monthly reports.",
        "--skill", "backend", "--epic", "billing", "--no-spec",
        "--reason", reason,
    )
    assert code == 0, out
    item = roadmap_items(repo)["ENG-9"]
    assert item["origin"] == "adhoc"
    assert item["spec_debt_reason"] == reason
    assert "spec" not in item
    assert item["acceptance_criteria"] == []


def test_roadmap_add_spec_without_ac_fails(repo):
    sign_off(repo)
    code, out = add_epic(repo)
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
        "--story", "As a finance lead, I see monthly reports.",
        "--skill", "backend", "--epic", "billing",
        "--spec", "docs/specs/base.md",
    )
    assert code != 0 and "--ac is required" in out, out


def test_roadmap_authoring_refuses_an_incomplete_story(repo, tmp_path):
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC],
        "items": [{"key": "ENG-9", "title": "Reports"}],
    })
    assert code != 0
    for field in ("epic", "story", "acceptance_criteria", "skill", "depends_on"):
        assert field in out

    unknown = authored_story("ENG-9", "Reports", epic="missing")
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC], "items": [unknown],
    })
    assert code != 0 and "not a known epic" in out


def test_roadmap_authoring_requires_an_explicit_depends_on(repo, tmp_path):
    item = authored_story("ENG-9", "Reports")
    item.pop("depends_on")
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC], "items": [item],
    })
    assert code != 0 and "depends_on" in out

    item["depends_on"] = []
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC], "items": [item],
    })
    assert code == 0, out


def test_epic_contract_refuses_an_unresolvable_source_ref(repo, tmp_path):
    epic = {**ROADMAP_EPIC, "source_refs": ["docs/product/missing.md"]}
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [epic],
        "items": [authored_story("ENG-9", "Reports")],
    })
    assert code != 0 and "docs/product/missing.md" in out and "does not exist" in out


def test_derive_never_accepts_an_epic_it_is_about_to_delete(repo, tmp_path):
    """derive REPLACES the epic list, so validating a story against a stored
    epic would accept a parent the same call removes — saving a roadmap that
    violates the contract it just passed."""
    stored = {"generated_by": "human", "epics": [ROADMAP_EPIC], "items": []}
    (repo / "plans" / "roadmap.json").write_text(json.dumps(stored))

    payload = {
        "generated_by": "docs-decomposer",
        "items": [authored_story("ENG-9", "Reports", epic=ROADMAP_EPIC["id"])],
    }
    source = tmp_path / "derived.json"
    source.write_text(json.dumps(payload))
    code, out = run(repo, "forge.py", "roadmap", "derive", "--input", str(source))
    assert code != 0, out
    assert "not a known epic" in out

    saved = json.loads((repo / "plans" / "roadmap.json").read_text())
    named = {item.get("epic") for item in saved.get("items", [])}
    assert named <= {epic["id"] for epic in saved.get("epics", [])}


def test_malformed_epic_value_is_refused_not_crashed(repo, tmp_path):
    """Authoring input is untrusted JSON. An `epic` that arrives as a list must
    reach the type validator, not raise an unhashable-type traceback on the way."""
    item = authored_story("ENG-9", "Reports")
    item["epic"] = []
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC], "items": [item],
    })
    assert code != 0
    assert "Traceback" not in out and "unhashable" not in out, out
    assert "epic" in out


def test_add_ignores_a_stale_epic_the_new_story_does_not_name(repo, tmp_path):
    """One legacy epic elsewhere in the roadmap must not refuse an unrelated,
    perfectly good story — the same scoping import uses."""
    stale = {"id": "legacy", "title": "Legacy", "objective": "old",
             "source_refs": ["docs/architecture/gone.md"]}
    (repo / "docs" / "architecture").mkdir(parents=True, exist_ok=True)
    (repo / "docs" / "architecture" / "gone.md").write_text("# Gone\n")
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [ROADMAP_EPIC, stale],
        "items": [authored_story("ENG-1", "First")],
    })
    assert code == 0, out
    (repo / "docs" / "architecture" / "gone.md").unlink()

    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    "--story", "As a finance lead, I see monthly reports.",
                    "--ac", "the report lists every invoice",
                    "--epic", "billing", "--skill", "backend",
                    "--spec", "docs/specs/base.md")
    assert code == 0, out

    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-10", "Legacy work",
                    "--story", "As a maintainer, I finish the legacy work.",
                    "--ac", "it is done", "--epic", "legacy", "--skill", "backend",
                    "--spec", "docs/specs/base.md")
    assert code != 0 and "does not exist" in out, out


def test_story_contract_refuses_whitespace_only_fields(repo, tmp_path):
    """A field of spaces is a field nobody filled in. Type checks alone accept
    it, and the story then carries no usable narrative or criterion."""
    for field, blank in (("story", "   "), ("acceptance_criteria", ["  "])):
        item = authored_story("ENG-9", "Reports")
        item[field] = blank
        code, out = import_roadmap(repo, tmp_path, {
            "generated_by": "human", "epics": [ROADMAP_EPIC], "items": [item],
        })
        assert code != 0, f"{field}: {out}"
        assert field in out


def test_import_revalidates_a_stored_epic_a_new_story_leans_on(repo, tmp_path):
    """Import may name an epic it did not supply. That epic's source_refs may
    have been deleted since, so the ones incoming stories reference are
    re-checked — and only those, or an unrelated stale epic refuses the import."""
    # A source_ref outside the handover docs the grill watches, so deleting it
    # exercises the epic contract rather than the staleness gate.
    source = repo / "docs" / "architecture" / "billing.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("# Billing\n")
    epic = {**ROADMAP_EPIC, "source_refs": ["docs/architecture/billing.md"]}

    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [epic],
        "items": [authored_story("ENG-1", "First")],
    })
    assert code == 0, out

    source.unlink()

    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human",
        "items": [authored_story("ENG-2", "Second", epic=epic["id"])],
    })
    assert code != 0 and "does not exist" in out, out


def test_epic_source_refs_resolve_against_the_target_repo(repo, tmp_path):
    """--repo names the repository under management. Resolving source_refs
    against the tool's own checkout refuses references that exist in the target
    and accepts ones that do not."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    try:
        from forge_cli.roadmap import check_epic_contract
    finally:
        sys.path.pop(0)

    only_in_target = repo / "docs" / "product" / "target-only.md"
    only_in_target.parent.mkdir(parents=True, exist_ok=True)
    only_in_target.write_text("# Target only\n")
    epic = {**ROADMAP_EPIC, "source_refs": ["docs/product/target-only.md"]}

    check_epic_contract(epic, repo)  # resolves in the target: accepted

    with pytest.raises(SystemExit):
        check_epic_contract(epic, tmp_path)  # absent there: refused


def test_legacy_epicless_roadmap_still_loads_and_heals(repo):
    path = repo / "plans" / "roadmap.json"
    legacy = {"generated_by": "human", "items": [
        {"key": "LEG-1", "title": "Legacy story", "status": "pending", "order": 1},
    ]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(legacy))

    code, out = run(repo, "forge.py", "roadmap", "list")
    assert code == 0 and "LEG-1" in out, out
    code, out = run(repo, "intake.py", "--issue", "LEG-1", "--title", "Legacy story")
    assert code == 0 and roadmap_items(repo)["LEG-1"]["status"] == "active", out

    data = json.loads(path.read_text())
    data["items"].append({**data["items"][0], "status": "done"})
    path.write_text(json.dumps(data))
    code, out = run(repo, "forge.py", "roadmap", "heal")
    assert code == 0 and roadmap_items(repo)["LEG-1"]["status"] == "done", out


def test_roadmap_schema_notes_authoring_requirements():
    schema = json.loads((HARNESS / "factory" / "schemas" / "roadmap.json").read_text())
    note = schema["item_fields_note"]
    for route in ("roadmap derive", "roadmap import", "roadmap add"):
        assert route in note
    for field in ("epic", "story", "acceptance_criteria", "skill", "depends_on"):
        assert field in note


def test_roadmap_lifecycle(repo, tmp_path):
    code, out = import_roadmap(repo, tmp_path)
    assert code == 0 and "2 added" in out, out
    # forge next suggests the first pending item with the exact intake command
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "ENG-1" in out and "roadmap" in out.lower()
    # intake activates the matching item
    code, out = intake(repo)
    assert code == 0 and "marked active" in out
    assert roadmap_items(repo)["ENG-1"]["status"] == "active"
    # drive to pr-ready: item completed with a history link
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    items = roadmap_items(repo)
    assert items["ENG-1"]["status"] == "done"
    assert items["ENG-1"]["history"] == ".factory/history/ENG-1/"
    assert items["ENG-2"]["status"] == "pending"
    # next now suggests ENG-2 after the archived task
    code, out = run(repo, "intake.py", "--issue", "ENG-2", "--title", "Payments")
    assert code == 0
    assert roadmap_items(repo)["ENG-2"]["status"] == "active"


def test_roadmap_reimport_preserves_lifecycle_and_kept_items(repo, tmp_path):
    import_roadmap(repo, tmp_path)
    intake(repo)  # ENG-1 -> active
    # Refined roadmap: retitles ENG-1, drops ENG-2, adds ENG-3
    insights = {"id": "insights", "title": "Insights", "objective": "clear reports",
                "source_refs": ["docs/product/BRIEF.md"]}
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "human", "epics": [insights], "items": [
            authored_story("ENG-1", "Invoices v2"),
            authored_story("ENG-3", "Reports", epic="insights"),
        ]})
    assert code == 0 and "kept" in out, out
    items = roadmap_items(repo)
    assert items["ENG-1"]["status"] == "active"  # lifecycle survives re-import
    assert items["ENG-1"]["title"] == "Invoices v2"
    assert items["ENG-3"]["status"] == "pending"
    assert "ENG-2" in items  # absent from input, kept — removal is a PR edit


def test_roadmap_import_and_add_validation(repo, tmp_path):
    sign_off(repo)
    code, out = import_roadmap(repo, tmp_path, {"items": [{"key": "A", "title": "x"}]})
    assert code != 0 and "generated_by" in out  # schema: unattributed import refused
    code, out = import_roadmap(repo, tmp_path,
                               {"generated_by": "human", "items": [{"key": "A"}]})
    assert code != 0 and "title" in out
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "human", "items": [
        authored_story("A", "x"), authored_story("A", "y"),
    ], "epics": [ROADMAP_EPIC]})
    assert code != 0 and "duplicate" in out
    code, out = import_roadmap(repo, tmp_path)
    assert code == 0, out
    story_flags = ("--story", "As a finance lead, I see monthly reports.",
                   "--ac", "the report lists every invoice",
                   "--epic", "billing", "--skill", "backend")
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    *story_flags, "--spec", "docs/specs/base.md")
    assert code == 0, out
    assert roadmap_items(repo)["ENG-9"]["acceptance_criteria"] == [
        "the report lists every invoice"]
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports",
                    *story_flags, "--spec", "docs/specs/base.md")
    assert code != 0 and "already" in out
    # a story is not capturable without the narrative a reader needs later
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-10", "Exports",
                    "--spec", "docs/specs/base.md")
    assert code != 0 and "--story" in out
    # the ad-hoc hatch records WHY it has no spec, and refuses to stay silent
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-11", "Hotfix ask",
                    *story_flags, "--no-spec")
    assert code != 0 and "--reason" in out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-11", "Hotfix ask",
                    *story_flags, "--no-spec", "--reason", "client asked mid-sprint")
    assert code == 0 and roadmap_items(repo)["ENG-11"]["origin"] == "adhoc"
    # dependencies are validated as a graph, not accepted as free text
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-12", "Dash",
                    *story_flags, "--spec", "docs/specs/base.md",
                    "--depends-on", "GHOST-1")
    assert code != 0 and "GHOST-1" in out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-12", "Dash",
                    *story_flags, "--spec", "docs/specs/base.md",
                    "--depends-on", "ENG-12")
    assert code != 0 and "unknown story" in out  # self-reference: not on the roadmap yet


# ------------------------------------------------- determinism contract (schemas)

def test_recorders_refuse_nonconforming_payloads(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    # decomposition: missing required field
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({"generated_by": "docs-decomposer", "tasks": []}))
    assert code != 0 and "user_facing" in out
    # decomposition: unpinned generator, message routes to the harness PR
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({"generated_by": "ponytail",
                                      "user_facing": True, "tasks": []}))
    assert code != 0 and "not pinned" in out and "harness PR" in out
    # valid decomposition opens the downstream gates
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    assert code == 0, out
    # review: legacy 'blocking' alias no longer accepted as blocking_findings
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "autoreview", "score": 9,
                                      "summary": "ok", "blocking": []}))
    assert code != 0 and "blocking_findings" in out
    # review: wrong type
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "autoreview", "score": "9",
                                      "summary": "ok", "blocking_findings": []}))
    assert code != 0 and "'score' must be int" in out
    # review: unpinned generator (the old subagent name is retired)
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "quality-reviewer", "score": 9,
                                      "summary": "ok", "blocking_findings": []}))
    assert code != 0 and "not pinned" in out
    # happy path: recorded, attested, no legacy keys written
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "autoreview", "score": 9,
                                      "summary": "ok", "blocking_findings": [],
                                      "skills_used": ["review-animations"]}))
    assert code == 0, out
    recorded = json.loads((repo / ".factory" / "reviews" / "quality.json").read_text())
    assert recorded["generated_by"] == "autoreview" and "blocking" not in recorded
    # testing artifact via the recorder
    code, out = run(repo, "record_test_from_json.py", "--kind", "automated",
                    stdin=json.dumps({"generated_by": "implementer", "status": "passed",
                                      "summary": "unit suite", "blocking_findings": [],
                                      "commands_run": ["pytest"],
                                      "skills_used": ["emil-design-eng", "frontend-design"]}))
    assert code == 0, out


def test_linter_catches_schema_allowlist_divergence(repo):
    schema = repo / "factory" / "schemas" / "review.json"
    data = json.loads(schema.read_text())
    data["generated_by"].append("rogue-tool")
    schema.write_text(json.dumps(data))
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "rogue-tool" in out


def test_functional_check_conditional_on_user_facing(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    # user_facing: false — gate passes without a functional artifact
    write_passing_artifacts(repo)
    f = repo / ".factory"
    decomp = json.loads((f / "decomposition.json").read_text())
    decomp["user_facing"] = False
    (f / "decomposition.json").write_text(json.dumps(decomp))
    (delegation_ledger(repo).parent / "decomposition.json").write_text(
        json.dumps(decomp))
    tests = json.loads((f / "tests.json").read_text())
    del tests["functional"]
    (f / "tests.json").write_text(json.dumps(tests))
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_functional_check_required_when_user_facing(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    write_passing_artifacts(repo)  # user_facing: true via DECOMP
    f = repo / ".factory"
    tests = json.loads((f / "tests.json").read_text())
    del tests["functional"]
    (f / "tests.json").write_text(json.dumps(tests))
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "functional" in out


# --------------------------------------------------------------------- adopt

def existing_repo(tmp_path: Path) -> Path:
    """A pre-harness, agent-built repo: own code, own CLAUDE.md, own CI."""
    repo = tmp_path / "legacy"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "app.js").write_text("console.log('prototype')\n")
    (repo / "README.md").write_text("# Legacy prototype\n")
    (repo / "CLAUDE.md").write_text("# Legacy agent instructions\nAlways use tabs.\n")
    (repo / ".github" / "workflows").mkdir(parents=True)
    (repo / ".github" / "workflows" / "their-ci.yml").write_text("name: theirs\n")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "pre-harness state")
    return repo


def adopt(repo: Path) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "adopt", "--target", str(repo), "--name", "legacy"],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_adopt_vendors_harness_and_preserves_project(tmp_path):
    repo = existing_repo(tmp_path)
    code, out = adopt(repo)
    assert code == 0, out
    # machinery is in; project content untouched; their CI survived the merge
    assert (repo / "factory" / "scripts" / "forge.py").exists()
    assert (repo / "src" / "app.js").read_text() == "console.log('prototype')\n"
    # project README preserved, onboarding section appended (never rewritten)
    readme = (repo / "README.md").read_text()
    assert readme.startswith("# Legacy prototype\n")
    assert "Working in this repo — Symphony Forge" in readme
    assert (repo / ".github" / "workflows" / "their-ci.yml").exists()
    # harness factory workflow delivered alongside the preserved project one
    assert (repo / ".github" / "workflows" / "factory-scaffold.yml").exists()
    # old CLAUDE.md preserved for harvest; shim installed
    kept = repo / "docs" / "context" / "migrated-CLAUDE.md"
    assert kept.exists() and "tabs" in kept.read_text()
    assert "@AGENTS.md" in (repo / "CLAUDE.md").read_text()
    # sign-off gate armed, project-owned files created
    assert not signed_off(repo)  # an adopted repo inherits no sign-off
    assert (repo / "harness.yaml").exists()
    # the adopted repo passes the same checks as a scaffold
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out
    code, out = run(repo, "check_factory_scaffold.py", str(repo))
    assert code == 0, out
    # adopting twice routes to upgrade instead
    code, out = adopt(repo)
    assert code != 0 and "upgrade" in out


def test_adopt_does_not_vendor_the_harness_source_marker(tmp_path, monkeypatch):
    # A harness source carrying the repo-kind marker must not copy it into an
    # adopted client (the copytree ignores .factory, so add the marker back to
    # prove adopt itself excludes it).
    source = tmp_path / "source"
    shutil.copytree(
        HARNESS, source,
        ignore=shutil.ignore_patterns(".git", ".factory", "__pycache__", "*.pyc"),
    )
    marker = source / ".factory" / "harness-source.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text('{"role": "harness-source", "repo": "symphony-forge"}\n')
    from forge_cli import adopt as adopt_cli
    from forge_cli.repo_kind import is_harness_source_repo
    assert is_harness_source_repo(source)
    monkeypatch.setattr(adopt_cli, "repo_root", lambda: source)
    target = existing_repo(tmp_path)
    adopt_cli.cmd_adopt(argparse.Namespace(target=str(target), name="legacy"))
    assert not (target / ".factory" / "harness-source.json").exists()
    assert not is_harness_source_repo(target)


def test_adopt_vendors_only_the_harness_owned_skill_not_a_source_decoy(
    tmp_path: Path, monkeypatch,
):
    source = tmp_path / "source"
    shutil.copytree(
        HARNESS,
        source,
        ignore=shutil.ignore_patterns(".git", ".factory", "__pycache__", "*.pyc"),
    )
    (source / "DECOY.md").write_text("# Source-only canon\n")
    for runtime in (".claude", ".codex"):
        decoy = source / runtime / "skills" / "decoy" / "SKILL.md"
        decoy.parent.mkdir(parents=True)
        decoy.write_text("# Decoy\n\n<!-- canon: DECOY.md -->\n")

    from forge_cli import adopt as adopt_cli
    monkeypatch.setattr(adopt_cli, "repo_root", lambda: source)
    target = existing_repo(tmp_path)
    adopt_cli.cmd_adopt(argparse.Namespace(target=str(target), name="legacy"))

    assert {
        path.parent.name
        for path in (target / ".claude" / "skills").glob("*/SKILL.md")
    } == {"forge"}
    assert {
        path.parent.name
        for path in (target / ".codex" / "skills").glob("*/SKILL.md")
    } == {"forge"}
    code, out = run(target, "check_dual_runtime.py", str(target))
    assert code == 0, out


def test_readopt_does_not_rewrite_the_record_origin(tmp_path):
    repo = existing_repo(tmp_path)
    marker = repo / ".factory" / "record-origin.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(json.dumps({
        "date": "2025-01-02T03:04:05+00:00",
        "commit": head(repo),
        "preceding_commits": 7,
    }, indent=2) + "\n")
    original = marker.read_bytes()
    git(repo, "add", ".factory/record-origin.json")
    git(repo, "commit", "-q", "-m", "existing forge record boundary")

    code, out = adopt(repo)
    assert code == 0, out
    assert marker.read_bytes() == original


def test_adopt_refuses_dirty_tree(tmp_path):
    repo = existing_repo(tmp_path)
    (repo / "wip.txt").write_text("uncommitted\n")
    code, out = adopt(repo)
    assert code != 0 and "uncommitted" in out


def test_adopt_refuses_a_symlinked_destination_before_writing(tmp_path):
    repo = existing_repo(tmp_path)
    outside = tmp_path / "outside-forge"
    outside.write_text("do not replace\n")
    destination = repo / "forge"
    destination.symlink_to(outside)
    git(repo, "add", "forge")
    git(repo, "commit", "-q", "-m", "symlinked adopt destination")

    code, out = adopt(repo)

    assert code != 0
    assert "refusing destination outside the target" in out
    assert destination.is_symlink()
    assert outside.read_text() == "do not replace\n"
    assert git(repo, "status", "--porcelain") == ""


def test_adopt_refuses_a_symlinked_ancestor_and_leaves_the_target_clean(
    tmp_path,
):
    repo = existing_repo(tmp_path)
    outside = tmp_path / "outside-factory"
    outside.mkdir()
    (repo / "factory").symlink_to(outside, target_is_directory=True)
    git(repo, "add", "factory")
    git(repo, "commit", "-q", "-m", "symlinked adopt ancestor")

    code, out = adopt(repo)

    assert code != 0
    assert "refusing destination outside the target" in out
    assert (repo / "factory").is_symlink()
    assert list(outside.iterdir()) == []
    assert git(repo, "status", "--porcelain") == ""


# ------------------------------------------------------- project-local gstack

def test_scaffold_delivers_factory_workflows(repo):
    # forge init vendors the harness factory workflows (by allowlist, not by
    # copying the whole .github tree).
    wf = repo / ".github" / "workflows"
    assert (wf / "factory-scaffold.yml").exists()
    assert (wf / "gardener.yml").exists()
    assert (wf / "harness-health.yml").exists()


def test_scaffold_pins_gstack_into_the_repo(repo):
    envrc = repo / ".envrc"
    assert envrc.exists() and 'GSTACK_HOME="$PWD/.gstack"' in envrc.read_text()
    attrs = repo / ".gitattributes"
    # union, git's built-in: a scaffolded repo must not inherit a rule that
    # depends on a per-clone hook having run wherever the merge happens.
    assert attrs.exists() and "merge=union" in attrs.read_text()
    assert not jsonl_append_rules(attrs.read_text())
    # Marker-keyed gstack block: machine noise ignored, projects/ committable.
    assert subprocess.run(
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/sessions/probe"]).returncode == 0
    assert subprocess.run(
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/projects/probe"]).returncode != 0


def test_gstack_migrate_unions_personal_store(repo, tmp_path):
    # A personal ~/.gstack with history for this project (slug = dirname "app")
    personal = tmp_path / "home-gstack"
    store = personal / "projects" / "app"
    store.mkdir(parents=True)
    (store / "dev-main-design-1.md").write_text("# Approved design\n")
    (store / "learnings.jsonl").write_text('{"ts":"2026-07-01","note":"a"}\n')
    # Repo store already has one overlapping and one different learning line
    repo_store = repo / ".gstack" / "projects" / "app"
    repo_store.mkdir(parents=True)
    (repo_store / "learnings.jsonl").write_text('{"ts":"2026-07-02","note":"b"}\n')
    code, out = run(repo, "forge.py", "gstack", "migrate",
                    "--source", str(personal), "--repo", str(repo))
    assert code == 0, out
    assert (repo_store / "dev-main-design-1.md").read_text() == "# Approved design\n"
    lines = (repo_store / "learnings.jsonl").read_text().splitlines()
    assert '{"ts":"2026-07-01","note":"a"}' in lines
    assert '{"ts":"2026-07-02","note":"b"}' in lines  # union, no clobber
    # Second run is idempotent: nothing new to merge
    code, out = run(repo, "forge.py", "gstack", "migrate",
                    "--source", str(personal), "--repo", str(repo))
    assert code == 0 and "0 jsonl line(s) merged" in out and "0 file(s) copied" in out


def test_gstack_migrate_fails_clearly_without_store(repo, tmp_path):
    empty = tmp_path / "empty-gstack"
    empty.mkdir()
    code, out = run(repo, "forge.py", "gstack", "migrate",
                    "--source", str(empty), "--repo", str(repo))
    assert code != 0 and "no personal gstack store" in out


def test_upgrade_delivers_gstack_setup_to_older_scaffolds(repo):
    # Simulate a scaffold created before the project-local gstack change
    (repo / ".envrc").unlink()
    (repo / ".gitattributes").unlink()
    gitignore = repo / ".gitignore"
    # An older scaffold predates the gstack block entirely — marker included.
    gitignore.write_text(
        "\n".join(l for l in gitignore.read_text().splitlines() if "gstack" not in l) + "\n"
    )
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "old-style scaffold")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'GSTACK_HOME="$PWD/.gstack"' in (repo / ".envrc").read_text()
    assert "merge=union" in (repo / ".gitattributes").read_text()
    assert not jsonl_append_rules((repo / ".gitattributes").read_text())
    # The marker-keyed block: machine noise ignored, projects/ committable.
    assert subprocess.run(
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/sessions/probe"]).returncode == 0
    assert subprocess.run(
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/projects/probe"]).returncode != 0


def test_next_routes_design_skills_by_feature_type(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))  # user_facing: true
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "emil-design-eng" in out
    # backend task: no design skills suggested
    decomp_path = repo / ".factory" / "decomposition.json"
    data = json.loads(decomp_path.read_text())
    data["user_facing"] = False
    decomp_path.write_text(json.dumps(data))
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "emil-design-eng" not in out


# --------------------------------------------------------- roles and handoffs

def test_roadmap_import_gated_on_signoff_grill_then_pm_approval(repo, tmp_path):
    src = tmp_path / "rm.json"
    src.write_text(json.dumps(ROADMAP))
    code, out = run(repo, "forge.py", "roadmap", "import", "--input", str(src))
    assert code != 0 and "sign-off" in out  # post-sign-off activity
    sign_off(repo)
    code, out = run(repo, "forge.py", "roadmap", "import", "--input", str(src))
    assert code != 0 and "grill" in out.lower()  # then the grill gate
    # a grill bound to a DIFFERENT file must not open the gate
    other = tmp_path / "other.json"
    other.write_text("{}")
    record_grill(repo, "epics", digest_of=other)
    code, out = run(repo, "forge.py", "roadmap", "import", "--input", str(src))
    assert code != 0 and "THIS input" in out
    record_grill(repo, "epics", digest_of=src)
    code, out = run(repo, "forge.py", "roadmap", "import", "--input", str(src))
    assert code != 0 and "epics-approved" in out  # then the PM accept gate
    approve_epics(repo, src)
    code, out = run(repo, "forge.py", "roadmap", "import", "--input", str(src))
    assert code == 0, out


def test_epics_and_story_fields_recorded_and_grouped(repo, tmp_path):
    sign_off(repo)
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer",
        "epics": [ROADMAP_EPIC],
        "items": [{"key": "ENG-1", "title": "Invoices", "epic": "billing",
                   "story": "As an admin, I invoice clients",
                   "acceptance_criteria": ["PDF generated"], "skill": "backend",
                   "depends_on": []}],
    })
    assert code == 0 and "1 epic(s) recorded" in out, out
    data = json.loads((repo / "plans" / "roadmap.json").read_text())
    assert data["epics"][0]["objective"] == "money in"
    assert data["items"][0]["acceptance_criteria"] == ["PDF generated"]
    code, out = run(repo, "forge.py", "roadmap", "list")
    assert "# Billing" in out and "backend" in out
    # invalid skill refused
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer",
        "items": [{"key": "ENG-9", "title": "X", "skill": "devops"}],
    })
    assert code != 0 and "skill" in out


def test_team_roster_and_em_assignment(repo, tmp_path):
    import_roadmap(repo, tmp_path)  # helper signs off
    # roster validations
    code, out = run(repo, "forge.py", "team", "set", "alice", "--role", "dev")
    assert code != 0 and "--skills" in out
    code, out = run(repo, "forge.py", "team", "set", "alice", "--role", "dev",
                    "--skills", "frontend,devops")
    assert code != 0 and "devops" in out
    code, out = run(repo, "forge.py", "team", "set", "alice", "--role", "dev",
                    "--skills", "frontend")
    assert code == 0, out
    # assignment checked against the roster
    code, out = run(repo, "forge.py", "roadmap", "assign", "ENG-1", "--to", "mallory")
    assert code != 0 and "not on the team roster" in out
    code, out = run(repo, "forge.py", "roadmap", "assign", "ENG-1", "--to", "alice")
    assert code == 0, out
    items = roadmap_items(repo)
    assert items["ENG-1"]["assignee"] == "alice"
    # assignment survives a re-import (grooming state, like lifecycle)
    import_roadmap(repo, tmp_path)
    assert roadmap_items(repo)["ENG-1"]["assignee"] == "alice"
    # forge next shows the assignee and nags the EM about the unassigned rest
    sign_off(repo)
    code, out = run(repo, "forge.py", "next")
    assert "@alice" in out and "[EM]" in out and "unassigned" in out


def test_next_tags_steps_with_roles(repo):
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "[PM]" in out  # discovery is the PM's seat


# ------------------------------------------------------------ handover grills

def test_record_task_grill_writes_per_id_file(repo):
    task_id = "FORGE-BOARD-2.1"
    digest = "a" * 64
    payload = {"generated_by": "griller", "gate": "task", "task_id": task_id,
               "verdict": "pass",
               "gaps": [], "contradictions": [], "resolutions": []}

    code, out = run(repo, "record_grill_from_json.py", "--gate", "task",
                    "--task", task_id, "--task-digest", digest,
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads(
        (repo / ".factory" / "grills" / "tasks" / f"{task_id}.json").read_text()
    )
    assert recorded["verdict"] == "pass"
    assert recorded["gate"] == "task"
    assert recorded["task_id"] == task_id
    assert not (repo / ".factory" / "grills" / "task.json").exists()


def test_record_task_grill_binds_digest(repo):
    task_id = "FORGE-BOARD-2.1"
    task_digest = "0123456789abcdef" * 4
    payload = {"generated_by": "griller", "gate": "task", "verdict": "pass",
               "gaps": [], "contradictions": [], "resolutions": []}

    code, out = run(repo, "record_grill_from_json.py", "--gate", "task",
                    "--task", task_id, "--task-digest", task_digest,
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads(
        (repo / ".factory" / "grills" / "tasks" / f"{task_id}.json").read_text()
    )
    assert recorded["input_sha256"] == task_digest


def test_grill_recorder_refuses_pass_with_unresolved_findings(repo):
    seed_signoff_inputs(repo)
    code, out = record_grill(repo, "signoff",
                             gaps=["no data-retention answer"], resolutions=[])
    assert code != 0 and "unresolved" in out
    # blocked verdict with the same findings IS recordable (audit trail)
    code, out = record_grill(repo, "signoff", verdict="blocked",
                             gaps=["no data-retention answer"])
    assert code == 0, out
    # ...but a blocked grill never satisfies the gate
    run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-client-signoff.md"))
    record.write_text(record.read_text()
                      .replace("status: proposed", "status: accepted")
                      .replace('confirmed_by: ""', 'confirmed_by: "Client PM"'))
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "blocked" in out


def test_stale_grill_refused_after_handover_docs_change(repo):
    seed_signoff_inputs(repo)
    record_grill(repo, "signoff")
    # resolve-then-edit AFTER the grill: BRIEF changes, committed
    brief = repo / "docs" / "product" / "BRIEF.md"
    brief.write_text(brief.read_text() + "\n## Late scope addition\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "scope change after grill")
    run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-client-signoff.md"))
    record.write_text(record.read_text()
                      .replace("status: proposed", "status: accepted")
                      .replace('confirmed_by: ""', 'confirmed_by: "Client PM"'))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "signoff record")
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "STALE" in out
    # re-grill against the current docs -> gate passes
    # (the signoff record added after the grill is expected exhaust, ignored)
    code, out = record_grill(repo, "signoff")
    assert code == 0, out
    code, out = run(repo, "record_signoff.py")
    assert code == 0, out


# ------------------------------------------------ mandatory skill attestation

def test_user_facing_artifacts_must_attest_design_skills(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))  # user_facing
    # testing artifact without the mandatory design skills -> refused
    base = {"generated_by": "implementer", "status": "passed", "summary": "ok",
            "blocking_findings": [], "commands_run": ["pytest"]}
    code, out = run(repo, "record_test_from_json.py", "--kind", "automated",
                    stdin=json.dumps(base))
    assert code != 0 and "emil-design-eng" in out and "frontend-design" in out
    # partial attestation still refused
    code, out = run(repo, "record_test_from_json.py", "--kind", "automated",
                    stdin=json.dumps({**base, "skills_used": ["emil-design-eng"]}))
    assert code != 0 and "frontend-design" in out
    # full attestation passes
    code, out = run(repo, "record_test_from_json.py", "--kind", "automated",
                    stdin=json.dumps({**base, "skills_used":
                                      ["emil-design-eng", "frontend-design"]}))
    assert code == 0, out
    # review artifact must attest review-animations on user-facing tasks
    review = {"generated_by": "autoreview", "score": 9, "summary": "ok",
              "blocking_findings": []}
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review))
    assert code != 0 and "review-animations" in out
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({**review, "skills_used": ["review-animations"]}))
    assert code == 0, out
    # backend task: no design-skill requirement
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "user_facing": False}))
    assert code == 0, out
    code, out = run(repo, "record_test_from_json.py", "--kind", "automated",
                    stdin=json.dumps(base))
    assert code == 0, out


def test_linter_catches_unpinned_required_skill(repo):
    schema = repo / "factory" / "schemas" / "test-automated.json"
    data = json.loads(schema.read_text())
    data["required_skills"]["user_facing"].append("rogue-design-skill")
    schema.write_text(json.dumps(data))
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "rogue-design-skill" in out


# ------------------------------------------------------- assumptions ledger

def test_assumptions_ledger_gates_pr_ready(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "forge.py", "plan", "assume", "IDs are UUIDv7")
    assert code == 0 and "A-0001" in out, out
    ledger = (repo / "plans" / "assumptions.md").read_text()
    assert "| A-0001 |" in ledger and "| open |" in ledger and "ENG-1" in ledger
    # drive to the gate: refused while the assumption is unguided
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "A-0001" in out and "guidance" in out
    # guidance validations: notes mandatory, status constrained
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "confirmed", "--notes", "")
    assert code != 0 and "notes" in out
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "maybe", "--notes", "x")
    assert code != 0 and "status" in out
    # fix-needed still blocks the gate (guidance given, fix not done)
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "fix-needed", "--notes", "use UUIDv4, v7 lib unvetted")
    assert code == 0, out
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "A-0001" in out
    # confirmed clears it
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "confirmed", "--notes", "switched to UUIDv4; verified")
    assert code == 0, out
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    # list --open is the orchestrator's console
    run(repo, "forge.py", "plan", "assume", "second call")  # plan archived -> refused
    code, out = run(repo, "forge.py", "assumptions", "list", "--open")
    assert code == 0 and "A-0001" not in out


# --------------------------------------------------------------- repo hygiene

def test_secret_cruft_scan_repo_wide(repo):
    from forge_cli.sanitise import secret_cruft_findings

    source = repo / "src" / "credentials.py"
    source.parent.mkdir()
    source.write_text('API_KEY = "sk-' + ('x' * 24) + '"\n')
    git(repo, "add", "src/credentials.py")
    ds_store = repo / ".DS_Store"
    ds_store.write_bytes(b"finder noise\n")
    factory_junk = repo / ".factory" / "orphan.tmp.json"
    factory_junk.write_text("{}\n")
    before = {
        path: path.read_bytes() for path in (source, ds_store, factory_junk)
    }

    findings = secret_cruft_findings(repo)

    assert any(item.startswith("src/credentials.py: line 1: API secret key")
               for item in findings["secrets"])
    assert findings["untracked_droppings"] == [
        ".DS_Store", ".factory/orphan.tmp.json",
    ]
    assert {path: path.read_bytes() for path in before} == before


def test_sanitise_fixes_safe_reports_rest(repo, monkeypatch, capsys):
    from forge_cli import doctor, sanitise

    roadmap_path = repo / "plans" / "roadmap.json"
    ensure_story(repo, "SAN-1", "Sanitise")
    data = json.loads(roadmap_path.read_text())
    data["items"].append({**data["items"][0], "status": "done"})
    roadmap_path.write_text(json.dumps(data))

    tracked = repo / "src" / "__pycache__" / "app.cpython-312.pyc"
    tracked.parent.mkdir(parents=True)
    tracked.write_bytes(b"\x00bytecode")
    git(repo, "add", "-f", str(tracked))
    secret = repo / "src" / "credentials.py"
    secret.write_text('API_KEY = "sk-' + ("x" * 24) + '"\n')
    git(repo, "add", str(secret))
    dropping = repo / ".factory" / "orphan.tmp.json"
    dropping.write_text("{}\n")
    evidence = repo / ".factory" / "tests.json"
    evidence.write_text('{"evidence": true}\n')
    (repo / ".factory" / "quickfix.json").write_text(json.dumps({
        "id": "Q-0001-test", "reason": "unfinished cleanup",
    }))
    def failing_doctor(_args):
        print("forge doctor: required tool missing")
        raise SystemExit(1)

    monkeypatch.setattr(doctor, "cmd_doctor", failing_doctor)

    with pytest.raises(SystemExit) as exc:
        sanitise.cmd_sanitise(argparse.Namespace(repo=str(repo), check=False))

    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "[FIXED] [roadmap-drift]" in out
    assert "[FIXED] [tracked-cruft]" in out
    for reported in (
        "[board-done-story]", "[secret]", "[stale-task-state]", "[open-window]",
        "[untracked-cruft]", "[doctor]",
    ):
        assert reported in out
    assert len(json.loads(roadmap_path.read_text())["items"]) == 1
    assert tracked.exists()
    proc = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(tracked.relative_to(repo))],
        cwd=repo, capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert evidence.read_text() == '{"evidence": true}\n'
    code, help_out = run(repo, "forge.py", "sanitise", "--help")
    assert code == 0 and "--check" in help_out


def test_sanitise_check_is_read_only(repo, monkeypatch):
    from forge_cli import doctor, sanitise

    roadmap_path = repo / "plans" / "roadmap.json"
    ensure_story(repo, "SAN-1", "Sanitise")
    data = json.loads(roadmap_path.read_text())
    data["items"].append({**data["items"][0], "status": "done"})
    roadmap_path.write_text(json.dumps(data))
    tracked = repo / "factory" / "__pycache__" / "tool.cpython-312.pyc"
    tracked.parent.mkdir(parents=True)
    tracked.write_bytes(b"\x00bytecode")
    git(repo, "add", "-f", str(tracked))
    monkeypatch.setattr(
        doctor, "cmd_doctor", lambda _args: print("forge doctor: ready"),
    )
    before = {
        "roadmap": roadmap_path.read_bytes(),
        "cruft": tracked.read_bytes(),
        "status": git(repo, "status", "--porcelain=v1", "-uall"),
        "tracked": git(repo, "ls-files", "-z"),
    }

    with pytest.raises(SystemExit) as exc:
        sanitise.cmd_sanitise(argparse.Namespace(repo=str(repo), check=True))

    assert exc.value.code == 1
    assert roadmap_path.read_bytes() == before["roadmap"]
    assert tracked.read_bytes() == before["cruft"]
    assert git(repo, "status", "--porcelain=v1", "-uall") == before["status"]
    assert git(repo, "ls-files", "-z") == before["tracked"]


def test_sanitise_never_deletes_task_evidence(repo, monkeypatch):
    from forge_cli import doctor, sanitise

    evidence = [
        repo / ".factory" / "decomposition.json",
        repo / ".factory" / "tests.json",
        repo / ".factory" / "reviews" / "quality.json",
    ]
    for path in evidence:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"evidence": true}\n')
    before = {path: path.read_bytes() for path in evidence}
    monkeypatch.setattr(
        doctor, "cmd_doctor", lambda _args: print("forge doctor: ready"),
    )

    with pytest.raises(SystemExit) as exc:
        sanitise.cmd_sanitise(argparse.Namespace(repo=str(repo), check=False))

    assert exc.value.code == 1
    assert {path: path.read_bytes() for path in evidence} == before


def test_sanitise_check_writes_no_bytecode(repo):
    # Regression: the in-process tests above import forge_cli before running, so
    # they cannot see that a SUBPROCESS `forge sanitise --check` used to write
    # __pycache__/*.pyc during import and then report it as its own cruft. Run it
    # through forge.py and assert the tree gains no bytecode (read-only contract).
    ensure_story(repo, "SAN-1", "Sanitise")
    before = set(repo.rglob("*.pyc")) | set(repo.rglob("__pycache__"))
    before_status = git(repo, "status", "--porcelain=v1", "-uall")
    run(repo, "forge.py", "sanitise", "--check")
    after = set(repo.rglob("*.pyc")) | set(repo.rglob("__pycache__"))
    assert after == before, f"--check wrote bytecode: {sorted(after - before)}"
    assert git(repo, "status", "--porcelain=v1", "-uall") == before_status


def test_sanitise_survives_malformed_roadmap(repo, monkeypatch):
    from forge_cli import doctor, sanitise

    monkeypatch.setattr(doctor, "cmd_doctor", lambda _a: print("forge doctor: ready"))
    roadmap_path = repo / "plans" / "roadmap.json"
    for bad in ('{"items": null}', "[]", '{"items": {"a": 1}}', "{}"):
        roadmap_path.write_text(bad)
        # Malformed roadmap must be REPORTED, never crash sanitise with an
        # AttributeError/TypeError/KeyError. A clean SystemExit (issues) is fine.
        try:
            sanitise.cmd_sanitise(argparse.Namespace(repo=str(repo), check=True))
        except SystemExit:
            pass


def test_sanitise_never_prints_secret_value(repo, monkeypatch, capsys):
    from forge_cli import doctor, sanitise

    monkeypatch.setattr(doctor, "cmd_doctor", lambda _a: print("forge doctor: ready"))
    secret_value = "sk-" + "z" * 24
    (repo / "src").mkdir(exist_ok=True)
    leak = repo / "src" / "leak.py"
    leak.write_text(f'API_KEY = "{secret_value}"\n')
    git(repo, "add", str(leak))

    with pytest.raises(SystemExit):
        sanitise.cmd_sanitise(argparse.Namespace(repo=str(repo), check=True))

    out = capsys.readouterr().out
    assert "[secret]" in out and "src/leak.py" in out
    assert secret_value not in out  # label + line only, never the secret value


def test_doctor_github_slug_respects_repo_target(tmp_path):
    # Regression for --repo threading: the branch-protection slug lookup must read
    # the TARGET repo's origin remote, not the current working directory's.
    from forge_cli import doctor

    other = tmp_path / "client"
    other.mkdir()
    git(other, "init", "-q")
    git(other, "remote", "add", "origin", "https://github.com/acme/widget.git")
    assert doctor._github_slug(str(other)) == "acme/widget"


def test_context_scan_refuses_secrets_and_oversized_files(repo):
    inbox = repo / "docs" / "context"
    (inbox / "client-email.txt").write_text(
        'From: client\npassword = "hunter2secret"\nAKIAIOSFODNN7EXAMPLE\n')
    code, out = run(repo, "forge.py", "context", "scan")
    assert code != 0 and "REDACT" in out and "client-email.txt" in out
    # refused = unregistered = still blocks planning
    code, out = run(repo, "forge.py", "context", "list", "--pending")
    assert "client-email.txt" not in out  # not in ledger at all
    # redacted version scans clean
    (inbox / "client-email.txt").write_text("From: client\ncredentials redacted\n")
    code, out = run(repo, "forge.py", "context", "scan")
    assert code == 0, out
    # oversized dump refused
    (inbox / "huge-export.txt").write_text("x" * 6_000_000)
    code, out = run(repo, "forge.py", "context", "scan")
    assert code != 0 and "cap" in out


def test_repo_budget_watchdog(repo):
    code, out = run(repo, "check_repo_budget.py", str(repo))
    assert code == 0, out
    big = repo / "assets-dump.bin"
    big.write_bytes(b"\0" * 6_000_000)
    git(repo, "add", "-f", str(big))
    code, out = run(repo, "check_repo_budget.py", str(repo))
    assert code != 0 and "assets-dump.bin" in out


def test_decision_supersede_lifecycle(repo):
    def substantiate(slug):
        record = next((repo / "docs" / "decisions").glob(f"*-{slug}.md"))
        record.write_text(record.read_text()
            .replace("<!-- Why this decision was needed; the forces at play. -->",
                     "We needed to pick a queue technology for events.")
            .replace("<!-- What was decided, in one or two sentences. -->",
                     "Use Redis streams for the event bus.")
            .replace("<!-- What follows: tradeoffs accepted, doors closed, work implied. -->",
                     "No Kafka operational burden; revisit at 10k events/sec."))
    run(repo, "forge.py", "decision", "new", "event-bus", "--repo", str(repo))
    substantiate("event-bus")
    run(repo, "forge.py", "decision", "accept", "event-bus", "--by", "PM")
    code, out = run(repo, "forge.py", "decision", "new", "event-bus-v2",
                    "--supersedes", "event-bus", "--repo", str(repo))
    assert code == 0 and "stays active until" in out, out
    # The predecessor governs until the replacement is CONFIRMED: retiring it at
    # draft time would leave a window where neither record is active and plan
    # attestation would require neither.
    old = next((repo / "docs" / "decisions").glob("*-event-bus.md")).read_text()
    assert "status: accepted" in old, old
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out
    substantiate("event-bus-v2")
    code, out = run(repo, "forge.py", "decision", "accept", "event-bus-v2", "--by", "PM")
    assert code == 0 and "Superseded" in out, out
    old = next((repo / "docs" / "decisions").glob("*-event-bus.md")).read_text()
    assert "status: superseded" in old and "superseded_by:" in old
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out
    # the active corpus hides the superseded record
    code, out = run(repo, "forge.py", "decision", "list", "--active")
    assert "event-bus-v2" in out
    assert "] 0001-event-bus:" not in out
    # dangling lifecycle pointer is a violation
    old_path = next((repo / "docs" / "decisions").glob("*-event-bus.md"))
    old_path.write_text(old_path.read_text().replace(
        "superseded_by: 0002-event-bus-v2", "superseded_by: 0099-phantom"))
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "0099-phantom" in out


def test_accepted_decision_requires_substance(repo):
    run(repo, "forge.py", "decision", "new", "empty-call", "--repo", str(repo))
    run(repo, "forge.py", "decision", "accept", "empty-call", "--by", "PM")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "substance" in out or "boilerplate" in out


def test_prototype_import_ban(repo):
    src = repo / "src"
    src.mkdir(exist_ok=True)
    (src / "app.ts").write_text('import { helper } from "../prototype/utils";\n')
    git(repo, "add", "src/app.ts")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "prototype" in out
    (src / "app.ts").write_text('const p = Object.prototype.toString;\n')  # not a violation
    git(repo, "add", "src/app.ts")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out


def test_gstack_migrate_skips_caches_and_churn(repo, tmp_path):
    personal = tmp_path / "home-gstack"
    store = personal / "projects" / "app"
    (store / "brain-cache").mkdir(parents=True)
    (store / "brain-cache" / "salience.md").write_text("derived\n")
    (store / "timeline.jsonl").write_text('{"event":"noise"}\n')
    (store / "design.md").write_text("# keeper\n")
    code, out = run(repo, "forge.py", "gstack", "migrate",
                    "--source", str(personal), "--repo", str(repo))
    assert code == 0, out
    dest = repo / ".gstack" / "projects" / "app"
    assert (dest / "design.md").exists()
    assert not (dest / "brain-cache").exists()
    assert not (dest / "timeline.jsonl").exists()


def test_assumptions_archive_compacts_resolved_rows(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "forge.py", "plan", "assume", "first call")
    run(repo, "forge.py", "assumptions", "resolve", "A-0001",
        "--status", "confirmed", "--notes", "fine")
    # a resolved row from a DIFFERENT (finished) task archives; active stays
    intake(repo, "ENG-2", "Payments", "--discard-active")
    save_plan(repo, tmp_path)
    run(repo, "forge.py", "plan", "assume", "second call")
    code, out = run(repo, "forge.py", "assumptions", "archive")
    assert code == 0 and "Archived 1" in out, out
    ledger = (repo / "plans" / "assumptions.md").read_text()
    archive = (repo / "plans" / "assumptions-archive.md").read_text()
    assert "A-0001" in archive and "A-0001" not in ledger
    assert "A-0002" in ledger  # active task's row never moves


# ------------------------------------------------------------- planning lock

def hook(repo: Path, payload: dict) -> tuple[int, str]:
    return run(repo, "pre_tool_use.py", stdin=json.dumps(payload))


COMPANION = "node /x/codex-companion.mjs task --model gpt-5.6-sol"
COMPANION_WRITE = (COMPANION + " --write --prompt-file .factory/briefs/T1.md "
                   "'build the slice'")


def test_hook_denies_unbriefed_write_delegation(repo, tmp_path):
    """Every companion WRITE launch is routed to the canonical executor;
    read-only launches are the rescue exploration lane and pass."""
    start_stage(repo, tmp_path, DELEGATE_TASK, launch=False)
    for mode in ("default", "plan"):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": mode,
                                "tool_input": {"command": COMPANION_WRITE}})
        assert "deny" in out and "forge delegate <task-id>" in out, mode
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": COMPANION + " 'map it'"}})
    assert code == 0 and "deny" not in out


def test_hook_denies_write_delegation_hidden_by_quoting(repo, tmp_path):
    start_stage(repo, tmp_path, DELEGATE_TASK, launch=False)
    sneaky = (COMPANION.replace("task", "t''ask") +
              " --wri''te --prompt-file .factory/briefs/T1.md 'go'")
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": sneaky}})
    assert "deny" in out and "forge delegate <task-id>" in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": COMPANION + " --write 'unbalanced"}})
    assert "deny" in out and "forge delegate" in out


def test_hook_denies_unparseable_bash_instead_of_guessing(repo):
    command = (
        "X= node /x/co${X}dex-com${X}panion.mjs task --write <<'EOF'\n"
        "'\nEOF"
    )
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": command},
    })
    assert "deny" in out and "could not be safely parsed" in out


def test_hook_denies_any_unparseable_bash_write_flag(repo):
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "unknown-tool --write 'unbalanced"},
    })
    assert code == 0
    assert "deny" in out and "could not be safely parsed" in out


def test_hook_denies_variable_hidden_companion_in_unparseable_bash(repo):
    command = (
        "C=companion; node /x/codex-$C.mjs task --write <<'EOF'\n"
        "it's only heredoc text\nEOF"
    )
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": command},
    })
    assert code == 0
    assert "deny" in out and "could not be safely parsed" in out


def test_hook_allows_readonly_companion_mentions(repo):
    for command in (
        "rg codex-companion factory",
        "cat /tmp/codex-companion.mjs",
        "printf '%s\\n' codex-companion",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" not in out, command


def test_hook_allows_readonly_companion_task_launch(repo):
    for command in (
        COMPANION + " --effort xhigh 'explore the sender chain'",
        "node /x/codex-companion.mjs task-resume-candidate --json",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" not in out, command


def test_hook_routes_absolute_and_quoted_node_companion_invocations(repo):
    for command in (
        "/usr/local/bin/node /x/codex-companion.mjs task --write",
        '"/usr/local/bin/node" "/x/codex-companion.mjs" task --write',
        "'/x/codex-companion.mjs' task --write",
        "exec node /x/codex-companion.mjs task --write",
        "(node /x/codex-companion.mjs task --write)",
        "env MODE=x node /x/codex-companion.mjs task --write",
        "  node /x/codex-companion.mjs task --write",
        "MODE='two words' node /x/codex-companion.mjs task --write",
        'env MODE="two words" node /x/codex-companion.mjs task --write',
        "node --no-warnings /x/codex-companion.mjs task --write",
        "node --require preload.js /x/codex-companion.mjs task --write",
        "nohup node /x/codex-companion.mjs task --write",
        "node codex-companion.mjs task --write",
        "cd /x && node codex-companion.mjs task --write",
        "node /x/co'dex-companion'.mjs task --write",
        "node /x/codex-$'companion'.mjs task --write",
        "printf %s codex-companion `node /x/codex-companion.mjs task --write`",
        "printf %s codex-companion <(node /x/codex-companion.mjs task --write)",
        "printf %s codex-companion\nnode /x/codex-companion.mjs task --write",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" in out and "forge delegate" in out, command


def test_hook_does_not_block_unrelated_node_companion_helpers(repo):
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "node tools/companion-health-check.js --check"},
    })
    assert code == 0 and "deny" not in out


def test_hook_allows_briefed_write_delegation(repo, tmp_path):
    start_stage(repo, tmp_path, DELEGATE_TASK)
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": COMPANION_WRITE}})
    assert "deny" in out and "forge delegate" in out


def test_hook_requires_the_invocation_to_carry_the_brief(repo, tmp_path):
    """A recorded launch never authorizes a later direct shell invocation."""
    start_stage(repo, tmp_path, DELEGATE_TASK)
    for command in (COMPANION + " --write 'rewrite auth'",
                    COMPANION + " --write --prompt-file /tmp/mine.md 'rewrite auth'"):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert "deny" in out and "forge delegate" in out, command


def test_hook_denies_when_brief_edited(repo, tmp_path):
    """The record carries the brief's digest, so the brief that was authorized
    is the brief on disk — or the delegation is stale."""
    start_stage(repo, tmp_path, DELEGATE_TASK)
    brief = repo / ".factory" / "briefs" / "T1.md"
    brief.write_text(brief.read_text() + "\nAlso rewrite the auth layer.\n")
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": COMPANION_WRITE}})
    assert "deny" in out and "forge delegate" in out


def test_planning_lock_forces_plan_mode(repo, tmp_path):
    sign_off(repo)
    intake(repo)  # planning phase, no approved plan
    # product-code edit in normal mode -> denied, routed to plan mode
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert code == 0 and "deny" in out and "PLAN MODE" in out
    # planning-phase writes stay open: the plan itself, decisions, docs
    # (.factory/ is NOT among them — recorded state is never hand-written)
    for ok_path in ("plans/draft.md", "docs/decisions/0009-x.md", "docs/notes.md"):
        code, out = hook(repo, {"tool_name": "Write", "permission_mode": "default",
                                "tool_input": {"file_path": str(repo / ok_path)}})
        assert "deny" not in out, ok_path
    # plan mode itself is never blocked by the lock
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "plan",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" not in out
    # raw codex exec is off-contract in ANY phase — route to /codex:rescue
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "codex exec 'implement the thing'"}})
    assert "deny" in out and "codex:rescue" in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command":
                                           "codex exec --profile explore -s read-only 'map it'"}})
    assert "deny" in out and "codex:rescue" in out
    # Companion denial keys on WRITE INTENT, not on the companion itself: the
    # codex-exec denial points at /codex:rescue, which runs the companion, so
    # denying every invocation made exploration impossible from the
    # orchestrator (0341332). A read-only rescue run passes; a write launch
    # stays delegate-owned.
    companion = "node /x/codex-companion.mjs task --model gpt-5.6-terra 'map the module'"
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion}})
    assert "deny" not in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write"}})
    assert "deny" in out and "forge delegate" in out
    # there is NO escape hatch — env-var prefixes don't open a side door
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command":
                                           "FACTORY_DEGRADED=1 codex exec -s read-only 'map it'"}})
    assert "deny" in out and "codex:rescue" in out
    # an approved plan is not yet an implementation licence: work is bounded by
    # tasks, so a product write before the decomposition belongs to no task
    save_plan(repo, tmp_path)
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" in out and "no decomposition" in out
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    # plan + decomposition lifts the lock entirely
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" not in out
    # ...but a WRITE delegation still needs a started, briefed stage: the plan
    # authorizes the work, the brief is what the executor is actually given
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write"}})
    assert "deny" in out and "forge delegate" in out
    run(repo, "forge.py", "stage", "start", "T1")
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write "
                                           "--prompt-file .factory/briefs/T1.md"}})
    assert "deny" in out and "forge delegate" in out
    # ...but raw codex exec stays off-contract even after approval
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "codex exec 'build it'"}})
    assert "deny" in out and "codex:rescue" in out


def test_planning_lock_is_always_armed_and_guards_bash_writes(repo):
    product = repo / "src" / "app.ts"
    payload = {"tool_name": "Edit", "permission_mode": "default",
               "tool_input": {"file_path": str(product)}}
    code, out = hook(repo, payload)
    assert code == 0 and "deny" in out
    assert "enter plan mode (shift+tab)" in out
    assert './forge quickfix start \\"<reason>\\"' in out

    code, out = hook(repo, {**payload, "permission_mode": "plan"})
    assert code == 0 and "deny" not in out
    code, out = hook(repo, {"tool_name": "Write", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "docs" / "notes.md")}})
    assert code == 0 and "deny" not in out

    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "cat > src/app.ts"}})
    assert code == 0 and "deny" in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "cat > docs/notes.md"}})
    assert code == 0 and "deny" not in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "echo hi > /tmp/forge-hook-test"}})
    assert code == 0 and "deny" not in out


def test_bash_write_guard_classifies_only_real_product_writes(repo):
    """The guard must not tax ordinary shell work it cannot classify."""
    def decision(command):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0
        return "deny" in out

    # writes the hook CAN see landing in product code
    assert decision("printf a > ./src/app.ts")
    assert decision("echo x >> src/app.ts")
    assert decision("echo x >src/app.ts")
    assert decision("sed -i '' s/a/b/ src/app.ts")
    assert decision("cp README.md src/copy.ts")

    # a redirect character inside a quoted argument is text, not a write
    assert not decision("git commit -m 'x > y'")
    assert not decision('git commit -m "moved a -> b"')
    # unexpanded shell expansions are unclassifiable, not product (0013)
    assert not decision('echo x > "$SCRATCH/probe.md"')
    assert not decision("echo x > $HOME/notes.md")
    assert not decision("echo x > $(mktemp)")
    # stderr duplication is not a file write
    assert not decision("make build 2>&1")
    # a heredoc body with an apostrophe must not blind the guard
    assert decision("cat > src/app.ts <<'EOF'\nit's fine\nEOF")
    assert not decision("echo it's fine")
    assert not decision(
        'git add f && git commit -q -m "fix: quoted \'a > b\' and \\$HOME/x"')

    # heredoc BODIES are data, not commands: prose that mentions a tool or a
    # redirect character is not an invocation (the command line still is).
    prose = ("git commit -F - <<'MSG'\n"
             "fix: real writes still deny\n"
             "moved src/a.ts > src/b.ts by hand, ran sed -i on src/c.ts\n"
             "MSG")
    assert not decision(prose)
    # ...and a tool named only in passing, outside command position, is prose
    assert not decision("echo 'use sed -i src/app.ts to patch it'")
    assert decision("sed -i '' s/a/b/ src/app.ts")
    # env-var prefixes do not hide the command
    assert decision("LC_ALL=C sed -i '' s/a/b/ src/app.ts")
    # allowlisted surfaces stay open
    assert not decision("echo x > factory/board/x.html")
    assert not decision("echo x > plans/roadmap.json")


def mark_harness_source(repo: Path) -> None:
    marker = repo / ".factory" / "harness-source.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text('{"role": "harness-source", "repo": "symphony-forge"}\n')


def test_harness_repo_locks_machinery_writes_without_a_plan(repo, tmp_path):
    mark_harness_source(repo)
    machinery = repo / "factory" / "scripts" / "pre_tool_use.py"
    for tool_name in ("Edit", "Write"):
        code, out = hook(repo, {
            "tool_name": tool_name,
            "permission_mode": "default",
            "tool_input": {"file_path": str(machinery)},
        })
        assert code == 0 and "deny" in out and "PLAN MODE" in out
    for rel in (
        "constitution/09-agent-conduct.md",
        "harness/nestjs-react/SCAFFOLD_PROMPT.md",
        ".claude/settings.json",
        ".codex/config.toml",
    ):
        code, out = hook(repo, {
            "tool_name": "Write",
            "permission_mode": "default",
            "tool_input": {"file_path": str(repo / rel)},
        })
        assert code == 0 and "deny" in out and "PLAN MODE" in out, rel
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "printf x > factory/scripts/pre_tool_use.py"},
    })
    assert code == 0 and "deny" in out and "PLAN MODE" in out

    # The repo-kind marker itself is product-locked: while the lock is armed it
    # can be neither rewritten nor DELETED, so flipping source->client takes the
    # same ceremony as any machinery change. (An earlier draft put the marker in
    # the freely-writable allowlist, where a silent `rm` would unlock everything.)
    marker_rel = ".factory/harness-source.json"
    code, out = hook(repo, {
        "tool_name": "Write",
        "permission_mode": "default",
        "tool_input": {"file_path": str(repo / marker_rel)},
    })
    assert code == 0 and "deny" in out and "repo-kind marker" in out
    for command in (f"rm {marker_rel}", f"git rm {marker_rel}",
                    f"git -C . rm {marker_rel}", f"git -c x=y rm {marker_rel}",
                    f"git mv {marker_rel} factory/scripts/moved.py"):
        code, out = hook(repo, {
            "tool_name": "Bash",
            "permission_mode": "default",
            "tool_input": {"command": command},
        })
        assert code == 0 and "deny" in out and "repo-kind marker" in out, command

    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code == 0, out
    # With the plan approved and decomposition recorded, machinery writes AND
    # the marker's own edit/delete are permitted — ceremony-gated, not frozen.
    for payload in (
        {"tool_name": "Edit", "permission_mode": "default",
         "tool_input": {"file_path": str(machinery)}},
        {"tool_name": "Bash", "permission_mode": "default",
         "tool_input": {"command": "printf x > factory/scripts/pre_tool_use.py"}},
        {"tool_name": "Write", "permission_mode": "default",
         "tool_input": {"file_path": str(repo / marker_rel)}},
        {"tool_name": "Bash", "permission_mode": "default",
         "tool_input": {"command": f"rm {marker_rel}"}},
    ):
        code, out = hook(repo, payload)
        assert code == 0 and "deny" not in out, out


def test_client_repo_leaves_vendored_machinery_writable(repo):
    assert not (repo / ".factory" / "harness-source.json").exists()
    machinery = repo / "factory" / "scripts" / "pre_tool_use.py"
    for payload in (
        {"tool_name": "Edit", "permission_mode": "default",
         "tool_input": {"file_path": str(machinery)}},
        {"tool_name": "Write", "permission_mode": "default",
         "tool_input": {"file_path": str(machinery)}},
        {"tool_name": "Bash", "permission_mode": "default",
         "tool_input": {"command": "printf x > factory/scripts/pre_tool_use.py"}},
    ):
        code, out = hook(repo, payload)
        assert code == 0 and "deny" not in out, out


def test_harness_quickfix_claims_machinery_files_against_budget(repo):
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "quickfix", "start", "repair machinery")
    assert code == 0, out

    expected = [f"factory/scripts/repair-{number}.py" for number in range(1, 6)]
    for rel in expected:
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / rel)},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "factory/scripts/repair-6.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out

    code, out = run(repo, "forge.py", "quickfix", "done")
    assert code == 0 and "5 file(s)" in out, out
    events = [json.loads(path.read_text())
              for path in (repo / "plans" / "quickfixes").glob("*.json")]
    done = [event for event in events if event.get("event") == "done"]
    assert len(done) == 1
    assert done[0]["files"] == expected


def test_harness_quickfix_cannot_delete_the_repo_kind_marker(repo):
    # The attack: open a quickfix, rm the marker as the first claimed file to
    # flip the repo to client-mode, then flood machinery past the 5-file budget.
    # The marker is plan-only, so the window can never touch it.
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "quickfix", "start", "sneaky")
    assert code == 0, out
    # Direct deletion of the marker, and deletion of an ANCESTOR that contains
    # it (`rm -r .factory`, `git rm .factory`) — all refused. (`rm -rf` is caught
    # even earlier by the blanket rm-rf policy; use `rm -r` to exercise this path.)
    # Common drift vectors — direct deletion of the marker and of the ancestor
    # .factory that contains it — are refused. (cwd games, git -C, indirect
    # pathspecs, and arbitrary code are the documented 0013 residual; the PIN
    # test below is what makes the budget robust against ALL of them.)
    for command in ("rm .factory/harness-source.json",
                    "git rm .factory/harness-source.json",
                    "mv .factory/harness-source.json plans/decoy.json",
                    "rm -r .factory", "git rm .factory"):
        code, out = hook(repo, {
            "tool_name": "Bash", "permission_mode": "default",
            "tool_input": {"command": command},
        })
        assert code == 0 and "deny" in out, command
        assert "repo-kind marker" in out or "recorded state" in out, command
    code, out = hook(repo, {
        "tool_name": "Write", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / ".factory" / "harness-source.json")},
    })
    assert code == 0 and "deny" in out and "repo-kind marker" in out
    # Classification held: machinery is still product, still claimed against budget.
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "factory" / "scripts" / "x.py")},
    })
    assert code == 0 and "deny" not in out, out


def test_quickfix_pins_repo_kind_so_marker_deletion_cannot_escape_budget(repo):
    # The structural guarantee (decision 0030): a quickfix pins the repo kind at
    # start, so even if the marker is removed mid-window by an UNCAUGHT vector,
    # classification stays 'harness' and machinery keeps being claimed against
    # the budget. Without the pin, the deletion would flip the repo to client and
    # let unlimited machinery writes bypass the 5-file budget.
    from forge_cli.repo_kind import is_harness_source_repo
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "quickfix", "start", "pinned")
    assert code == 0, out
    (repo / ".factory" / "harness-source.json").unlink()  # marker gone (any vector)
    assert not is_harness_source_repo(repo)  # live classification would say client
    for number in range(1, 6):  # ...but the window still claims machinery
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / "factory" / "scripts" / f"m{number}.py")},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {  # 6th exceeds the pinned budget — still product
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "factory" / "scripts" / "m6.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out
    # And the pin cannot be laundered away by closing the window: a harness-pinned
    # window whose marker went missing refuses to close until it is restored.
    code, out = run(repo, "forge.py", "quickfix", "done")
    assert code != 0 and "missing" in out, out
    (repo / ".factory" / "harness-source.json").write_text('{"role": "harness-source"}\n')
    code, out = run(repo, "forge.py", "quickfix", "done")
    assert code == 0, out


def test_harness_quickfix_allows_benign_root_destination(repo):
    # The ancestor-marker guard must fire only on marker DELETION, not on a
    # benign create-into-root destination like `cp/mv <src> .` (whose parsed
    # target is the repo root). Those are ordinary product writes, budget-claimed.
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "quickfix", "start", "benign")
    assert code == 0, out
    for command in ("cp /tmp/tool .", "mv /tmp/tool ."):
        code, out = hook(repo, {
            "tool_name": "Bash", "permission_mode": "default",
            "tool_input": {"command": command},
        })
        assert code == 0 and "repo-kind marker" not in out, command


def test_harness_quickfix_refuses_opaque_machinery_deletes(repo):
    # The 5-file budget is only honest if each claimed slot is a bounded file. A
    # recursive/globbed/brace-expanded DELETE of machinery would spend one slot on
    # an unbounded set, so a quickfix refuses it; explicit single-file ops stay
    # allowed, and — critically — read-OUT copies (product source, external dest)
    # are NOT blocked (they modify nothing in the repo).
    mark_harness_source(repo)
    (repo / "factory" / "scripts").mkdir(parents=True, exist_ok=True)
    code, out = run(repo, "forge.py", "quickfix", "start", "opaque")
    assert code == 0, out
    for command in ("rm -r factory/scripts",
                    "rm factory/scripts/*.py",
                    "rm factory/scripts/f{1..6}.py",       # brace expansion
                    "git rm -r factory/scripts",
                    "cp -R /tmp/tree factory/scripts/new",  # recursive copy INTO machinery
                    "cp /tmp/x/*.py factory/scripts/"):     # glob source INTO machinery
        code, out = hook(repo, {
            "tool_name": "Bash", "permission_mode": "default",
            "tool_input": {"command": command},
        })
        assert code == 0 and "deny" in out, command
    for command in ("rm factory/scripts/one.py",              # explicit single file
                    "sed -i 's/foo.*/bar/' factory/scripts/x.py",  # sed regex, not a glob
                    "cp -R factory/scripts /tmp/backup",      # read-OUT: nothing written in-repo
                    "cp factory/scripts/*.py /tmp/backup"):   # read-OUT glob source
        code, out = hook(repo, {
            "tool_name": "Bash", "permission_mode": "default",
            "tool_input": {"command": command},
        })
        assert code == 0 and "deny" not in out, command


def test_harness_quickfix_counts_each_file_copied_into_a_machinery_dir(repo):
    # `cp <src> factory/scripts/` creates factory/scripts/<basename>; six such
    # copies must spend six budget slots (resolved per created file), not one for
    # the shared directory — so the sixth is refused.
    mark_harness_source(repo)
    (repo / "factory" / "scripts").mkdir(parents=True, exist_ok=True)
    code, out = run(repo, "forge.py", "quickfix", "start", "copies")
    assert code == 0, out
    for number in range(1, 6):
        code, out = hook(repo, {
            "tool_name": "Bash", "permission_mode": "default",
            "tool_input": {"command": f"cp /tmp/a{number} factory/scripts/"},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {
        "tool_name": "Bash", "permission_mode": "default",
        "tool_input": {"command": "cp /tmp/a6 factory/scripts/"},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out


def test_scaffolded_client_has_no_harness_source_marker(tmp_path, monkeypatch):
    # Exercise a REAL vendoring path: a harness source that carries the marker
    # must not copy it into a client via `forge init`, or the client would
    # classify its vendored machinery as product and lock it during planning.
    import argparse
    from forge_cli import scaffold
    from forge_cli.repo_kind import is_harness_source_repo
    source = _copy_harness_source(tmp_path)
    marker = source / ".factory" / "harness-source.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text('{"role": "harness-source", "repo": "symphony-forge"}\n')
    assert is_harness_source_repo(source)

    monkeypatch.setattr(scaffold, "repo_root", lambda: source)
    target = tmp_path / "client-app"
    scaffold.cmd_init(argparse.Namespace(
        name="client-app", target=str(target), force=False, stack="nestjs-react",
    ))
    assert not (target / ".factory" / "harness-source.json").exists()
    assert not is_harness_source_repo(target)


def test_harness_repo_keeps_docs_and_planning_surfaces_writable(repo):
    mark_harness_source(repo)
    for rel in (
        "docs/notes.md",
        "plans/draft.md",
        ".factory/scratchpad.md",
        "prototype/probe.md",
        ".github/workflows/probe.yml",
        ".gstack/projects/probe.md",
        "AGENTS.md",
        "CLAUDE.md",
        "WORKFLOW.md",
        "harness.yaml",
        "README.md",
        ".gitignore",
        ".gitattributes",
        ".envrc",
    ):
        code, out = hook(repo, {
            "tool_name": "Write", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / rel)},
        })
        assert code == 0 and "deny" not in out, rel

    code, out = hook(repo, {
        "tool_name": "Write", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / ".factory" / "run.json")},
    })
    assert code == 0 and "deny" in out and "never hand-written" in out


def test_quickfix_lifecycle_tracks_files_and_enforces_budget(repo):
    code, out = run(repo, "forge.py", "quickfix", "start", "repair parser")
    assert code == 0 and "Q-" in out, out
    active_path = repo / ".factory" / "quickfix.json"
    active = json.loads(active_path.read_text())
    assert active["reason"] == "repair parser"
    assert active["max_files"] == 5 and active["files"] == []

    companion = "node /x/codex-companion.mjs task --write 'repair parser'"
    code, out = hook(repo, {
        "tool_name": "Bash", "permission_mode": "default",
        "tool_input": {"command": companion},
    })
    assert code == 0 and "deny" in out and "forge delegate" in out
    assert json.loads(active_path.read_text())["files"] == []

    for number in range(1, 6):
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / "src" / f"file-{number}.py")},
        })
        assert code == 0 and "deny" not in out, out
    # Repeating a file is free; only distinct product paths consume budget.
    code, out = hook(repo, {
        "tool_name": "Bash", "permission_mode": "default",
        "tool_input": {"command": "touch src/file-5.py"},
    })
    assert code == 0 and "deny" not in out
    assert len(json.loads(active_path.read_text())["files"]) == 5

    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "file-6.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out
    assert len(json.loads(active_path.read_text())["files"]) == 5

    code, out = run(repo, "forge.py", "quickfix", "list")
    assert code == 0 and "repair parser" in out and "5/5" in out
    code, out = run(repo, "forge.py", "quickfix", "done")
    assert code == 0 and "5 file(s)" in out, out
    assert not active_path.exists()
    # One record per file now (decision 0022). Each record carries its own
    # timestamps, so the ledger is a SET of records rather than a sequence —
    # asserting a line order would re-import the assumption 0022 removed, and
    # start/done can land inside the same second anyway.
    events = {json.loads(p.read_text())["event"]: json.loads(p.read_text())
              for p in (repo / "plans" / "quickfixes").glob("*.json")}
    assert set(events) == {"open", "done"}
    assert events["open"]["started_at"] <= events["done"]["completed_at"]
    events = [events["open"], events["done"]]
    assert events[-1]["files"] == [f"src/file-{number}.py" for number in range(1, 6)]

    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "again.py")},
    })
    assert code == 0 and "deny" in out


def test_quickfix_records_files_inside_an_active_story(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    assert code == 0, out
    code, out = run(repo, "forge.py", "quickfix", "start", "repair active story")
    assert code == 0, out

    active_path = repo / ".factory" / "quickfix.json"
    for number in range(1, 7):
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / "src" / f"story-{number}.py")},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "story-6.py")},
    })
    assert code == 0 and "deny" not in out, out
    assert json.loads(active_path.read_text())["files"] == [
        f"src/story-{number}.py" for number in range(1, 7)
    ]


def test_quickfix_budget_still_refuses_over_limit_when_unplanned(repo):
    code, out = run(repo, "forge.py", "quickfix", "start", "bounded repair")
    assert code == 0, out
    active_path = repo / ".factory" / "quickfix.json"

    for number in range(1, 6):
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / "src" / f"bounded-{number}.py")},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "bounded-6.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out
    assert json.loads(active_path.read_text())["files"] == [
        f"src/bounded-{number}.py" for number in range(1, 6)
    ]


def test_quickfix_recording_authorizes_nothing(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "forge.py", "quickfix", "start", "zero-budget probe")
    assert code == 0, out

    active_path = repo / ".factory" / "quickfix.json"
    active = json.loads(active_path.read_text())
    active["max_files"] = 0
    active_path.write_text(json.dumps(active, indent=2) + "\n")

    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "recorded.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out
    assert json.loads(active_path.read_text())["files"] == []


def open_lite(repo: Path) -> dict:
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--by", "Ada", "--reason", "ship a bounded change")
    assert code == 0, out
    return json.loads((repo / ".factory" / "quickfix.json").read_text())


def write_lite_reviews(repo: Path, *, blocker: str | None = None,
                       commit: str | None = None) -> None:
    reviews = repo / ".factory" / "reviews"
    reviews.mkdir(exist_ok=True)
    for aspect in ("quality", "performance", "security"):
        (reviews / f"{aspect}.json").write_text(json.dumps({
            "generated_by": "autoreview",
            "score": 9,
            "summary": "clean",
            "blocking_findings": [blocker] if blocker and aspect == "quality" else [],
            "skills_used": ["review-animations"],
            "commit": commit or head(repo),
        }))


def test_mode_lite_opens_window_with_profile_and_base_sha(repo):
    base_sha = head(repo)
    active = open_lite(repo)
    assert active["profile"] == "lite"
    assert active["base_sha"] == base_sha
    assert active["by"] == "Ada"
    assert active["reason"] == "ship a bounded change"

    (repo / "src").mkdir()
    (repo / "src" / "lite.py").write_text("enabled = True\n")
    git(repo, "add", "src/lite.py")
    git(repo, "commit", "-q", "-m", "bounded lite fix")
    write_lite_reviews(repo)
    code, out = run(repo, "forge.py", "mode", "done")
    assert code == 0 and "1 file(s)" in out, out
    done = [json.loads(path.read_text())
            for path in (repo / "plans" / "quickfixes").glob("*.json")
            if json.loads(path.read_text()).get("event") == "done"]
    assert len(done) == 1
    assert done[0]["profile"] == "lite"
    assert done[0]["base_sha"] == base_sha
    assert done[0]["by"] == "Ada"
    assert done[0]["files"] == ["src/lite.py"]
    assert sorted(done[0]["reviews"]) == ["performance", "quality", "security"]
    assert not (repo / ".factory" / "reviews").exists()

    code, out = run(repo, "forge.py", "mode", "full")
    assert code != 0 and "invalid choice" in out


def test_mode_abandon_closes_crashed_window(repo):
    active = open_lite(repo)
    (repo / "src").mkdir()
    crashed_change = repo / "src" / "crashed.py"
    crashed_change.write_text("unfinished = True\n")
    partial_reviews = repo / ".factory" / "reviews"
    partial_reviews.mkdir(exist_ok=True)
    (partial_reviews / "quality.json").write_text("{}\n")

    code, out = run(repo, "forge.py", "mode", "done")
    assert code != 0 and "commit the fix first" in out, out

    code, out = run(
        repo, "forge.py", "mode", "abandon", "--reason", "worker crashed",
    )
    assert code == 0 and active["id"] in out and "worker crashed" in out, out
    assert not (repo / ".factory" / "quickfix.json").exists()
    assert crashed_change.read_text() == "unfinished = True\n"
    assert (partial_reviews / "quality.json").exists()

    abandoned = [
        json.loads(path.read_text())
        for path in (repo / "plans" / "quickfixes").glob("*.json")
        if json.loads(path.read_text()).get("event") == "abandoned"
    ]
    assert len(abandoned) == 1
    assert abandoned[0]["id"] == active["id"]
    assert abandoned[0]["profile"] == "lite"
    assert abandoned[0]["reason"] == "worker crashed"
    assert abandoned[0]["opened_reason"] == "ship a bounded change"

    code, out = run(repo, "forge.py", "mode", "list")
    assert code == 0 and "[abandoned lite]" in out and "worker crashed" in out, out

    code, out = run(
        repo, "forge.py", "mode", "abandon", "--reason", "already closed",
    )
    assert code != 0 and "no mode window is open" in out, out


def test_mode_done_refuses_dirty_product_tree(repo):
    open_lite(repo)
    (repo / "src").mkdir()
    (repo / "src" / "dirty.py").write_text("dirty = True\n")

    code, out = run(repo, "forge.py", "mode", "done")

    assert code != 0 and "commit the fix first" in out, out
    assert (repo / ".factory" / "quickfix.json").exists()


def test_mode_done_refuses_over_budget_committed_diff(repo):
    open_lite(repo)
    (repo / "src").mkdir()
    for number in range(5):
        (repo / "src" / f"fix_{number}.py").write_text(f"value = {number}\n")
    git(repo, "add", "src")
    git(repo, "commit", "-q", "-m", "maximum-size lite fix")
    write_lite_reviews(repo)

    code, out = run(repo, "forge.py", "mode", "done")

    assert code == 0 and "5 file(s)" in out, out

    open_lite(repo)
    for number in range(6):
        (repo / "src" / f"extra_{number}.py").write_text(f"value = {number}\n")
    git(repo, "add", "src")
    git(repo, "commit", "-q", "-m", "oversized lite fix")

    code, out = run(repo, "forge.py", "mode", "done")

    assert code != 0 and "touches 6 product files" in out and "bound is 5" in out, out
    assert (repo / ".factory" / "quickfix.json").exists()


def test_mode_done_requires_clean_reviews_at_head(repo):
    active = open_lite(repo)
    (repo / "src").mkdir()
    (repo / "src" / "reviewed.py").write_text("reviewed = True\n")
    git(repo, "add", "src/reviewed.py")
    git(repo, "commit", "-q", "-m", "reviewed lite fix")

    code, out = run(repo, "forge.py", "mode", "done")
    assert code != 0 and ".factory/reviews/quality.json" in out, out

    write_lite_reviews(repo, commit=active["base_sha"])
    code, out = run(repo, "forge.py", "mode", "done")
    assert code != 0 and "must be stamped at HEAD" in out, out

    write_lite_reviews(repo, blocker="fix this")
    code, out = run(repo, "forge.py", "mode", "done")
    assert code != 0 and "quality review must have no blockers" in out, out
    assert (repo / ".factory" / "reviews").exists()

    write_lite_reviews(repo)
    code, out = run(repo, "forge.py", "mode", "done")
    assert code == 0, out
    done = [json.loads(path.read_text())
            for path in (repo / "plans" / "quickfixes").glob("*.json")
            if json.loads(path.read_text()).get("event") == "done"][-1]
    assert done["files"] == ["src/reviewed.py"]
    assert all(not review["blocking_findings"] for review in done["reviews"].values())
    assert not (repo / ".factory" / "reviews").exists()


def test_record_review_accepts_open_lite_window_post_ship(repo):
    sign_off(repo)
    shipped_state = run_state(repo)
    shipped_state["phase"] = "shipped"
    (repo / ".factory" / "run.json").write_text(json.dumps(shipped_state))
    open_lite(repo)

    code, out = run(
        repo, "record_review_from_json.py", "--aspect", "quality",
        stdin=json.dumps(review_payload()),
    )

    assert code == 0, out
    recorded = json.loads((repo / ".factory" / "reviews" / "quality.json").read_text())
    assert recorded["commit"] == head(repo)
    assert run_state(repo) == shipped_state


def test_lite_window_does_not_unlock_verify_or_test_recording(repo):
    sign_off(repo)
    open_lite(repo)

    verify_code, verify_out = run(repo, "verify.py", "--print-only")
    test_code, test_out = run(
        repo, "record_test_from_json.py", "--kind", "automated",
        stdin=json.dumps({"generated_by": "implementer", "status": "passed"}),
    )

    assert verify_code != 0 and "approved, saved plan" in verify_out, verify_out
    assert test_code != 0 and "approved, saved plan" in test_out, test_out
    assert not (repo / ".factory" / "verify.json").exists()
    assert not (repo / ".factory" / "tests.json").exists()


def test_forge_fix_refuses_without_lite_window(repo):
    code, out = run(repo, "forge.py", "fix", "repair the parser")
    assert code != 0 and "open lite window" in out.lower(), out


def test_forge_fix_records_terra_high_write_delegation(repo, tmp_path):
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--by", "Ada", "--reason", "bounded delivery")
    assert code == 0, out
    window = json.loads((repo / ".factory" / "quickfix.json").read_text())
    before = head(repo)
    companion_env = fake_companion_env(tmp_path)
    companion_cache = (Path(companion_env["HOME"]) / ".claude" / "plugins" /
                       "cache" / "openai-codex" / "codex")
    companion = next(companion_cache.glob("*/scripts/codex-companion.mjs"))
    companion.write_text(
        "import fs from 'node:fs';\n"
        "fs.mkdirSync('src', {recursive:true});\n"
        "fs.writeFileSync('src/fixed.py', 'fixed = true\\n');\n"
        "process.stdout.write(JSON.stringify({ok:true}));\n"
    )

    code, out = run(
        repo, "forge.py", "fix", "repair the parser",
        env=companion_env,
    )
    assert code == 0, out
    assert head(repo) == before

    rows = [json.loads(line) for line in
            delegation_ledger(repo).read_text().splitlines() if line.strip()]
    entry = rows[-1]
    assert entry["launch_status"] == "succeeded"
    assert entry["task"] == window["id"]
    assert entry["model"] == "gpt-5.6-terra"
    assert entry["effort"] == "high"
    assert entry["write"] is True
    assert entry["mode"] == "lite"
    active = json.loads((repo / ".factory" / "quickfix.json").read_text())
    assert active["files"] == ["src/fixed.py"]

    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from factory_lib import validate_payload
        validate_payload(repo, "delegation", entry)
    finally:
        sys.path.pop(0)


def test_modes_lite_pins_parse_and_dual_runtime_green(repo):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.delegate import mode_run_config
        assert mode_run_config(repo, "lite") == ("gpt-5.6-terra", "high", 5)
    finally:
        sys.path.pop(0)

    code, out = run(repo, "check_dual_runtime.py")
    assert code == 0, out


def test_lite_window_authorizes_product_write(repo):
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--by", "Ada", "--reason", "bounded delivery")
    assert code == 0, out

    code, out = hook(repo, {
        "tool_name": "Edit",
        "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "lite.py")},
    })
    assert code == 0 and "deny" not in out, out


def test_mode_list_shows_open_lite_window(repo):
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--by", "Ada", "--reason", "finish the slice")
    assert code == 0, out

    code, out = run(repo, "forge.py", "mode", "list")
    assert code == 0
    assert "[OPEN LITE]" in out and "finish the slice" in out

    code, out = run(repo, "forge.py", "next", "--repo", str(repo))
    assert code == 0
    assert "OPEN LITE WINDOW" in out
    assert "one review is required" in out and "./forge mode done" in out

    code, out = run(repo, "session_start.py", stdin="{}")
    assert code == 0, out
    context = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "OPEN LITE WINDOW" in context
    assert "one review is required" in context and "./forge mode done" in context


def test_docs_describe_three_planning_lock_exits():
    decision = (
        HARNESS / "docs" / "decisions" /
        "0013-always-armed-planning-lock.md"
    ).read_text().lower()
    entry_contract = (
        HARNESS / "docs" / "memory" / "factory-entry-contract.md"
    ).read_text().lower()
    workflow = (HARNESS / "WORKFLOW.md").read_text().lower()
    model_tiers = (
        HARNESS / "docs" / "decisions" /
        "0003-model-tiers-terra-explore-sol-implement.md"
    ).read_text().lower()

    for contract in (decision, entry_contract, workflow):
        assert "three" in contract
        assert "approved plan" in contract
        assert "quickfix" in contract
        assert "lite" in contract
        assert "forge mode lite" in contract
    assert "0031" in model_tiers
    assert "lite" in model_tiers and "terra" in model_tiers


# The stage's verify command selects this exact required test by keyword.
test_docs_describe_three_planning_lock_exits.docs_third_exit = True


def test_forge_skill_maps_lite_mode_phrase():
    skill = (HARNESS / ".claude" / "skills" / "forge" / "SKILL.md").read_text()

    assert '"use lite mode"' in skill
    assert "./forge mode lite" in skill
    assert "<!-- canon: factory/skills/forge.md -->" in skill


# The stage's verify command selects this exact required test by keyword.
test_forge_skill_maps_lite_mode_phrase.forge_skill_lite = True


def test_quickfix_profile_behavior_unchanged(repo):
    code, out = run(repo, "forge.py", "quickfix", "start", "repair parser")
    assert code == 0 and "Quickfix" in out and "0/5 files" in out, out
    active_path = repo / ".factory" / "quickfix.json"
    active = json.loads(active_path.read_text())
    assert active["profile"] == "quickfix"

    # Old active windows without a profile still behave as quickfixes.
    active.pop("profile")
    active_path.write_text(json.dumps(active, indent=2) + "\n")
    code, out = run(repo, "forge.py", "quickfix", "list")
    assert code == 0 and "[OPEN]" in out and "repair parser" in out
    code, out = run(repo, "forge.py", "quickfix", "done")
    assert code == 0 and "Quickfix" in out, out


# ---------------------------------------------------------------- plan grill

def test_plan_save_refuses_approved_without_a_matching_marker(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "approval-plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")

    assert code != 0
    assert "awaiting-approval" in out
    assert "review it in plan mode" in out
    assert "forge plan approve" in out
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    assert "status: awaiting-approval" in active.read_text()
    assert run_state(repo)["plan_status"] == "awaiting-approval"
    code, out = run(repo, "update_run.py", "--phase", "implementing")
    assert code != 0 and "requires an approved, saved plan" in out


def test_plan_approve_requires_a_human_by_and_binds_the_body_digest(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "approval-plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out

    code, out = run(repo, "forge.py", "plan", "approve")
    assert code != 0 and "--by" in out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "  ")
    assert code != 0 and "human approver" in out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out

    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    persisted_body = active.read_text().split("---\n", 2)[2]
    marker = json.loads((repo / ".factory" / "plan-approval.json").read_text())
    assert marker["plan_sha256"] == hashlib.sha256(persisted_body.encode()).hexdigest()
    assert marker["approver"] == "Client PM"
    assert marker["issue"] == "ENG-1" and marker["story"] == "ENG-1"
    assert marker["at"]
    assert git(repo, "check-ignore", ".factory/plan-approval.json") == (
        ".factory/plan-approval.json"
    )
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code == 0, out
    assert run_state(repo)["plan_status"] == "approved"

    # The marker cannot be replayed in a DIFFERENT context: a marker whose
    # body digest matches but whose story is another one does NOT approve —
    # the human reviewed this plan for THIS story, not that one.
    marker_path = repo / ".factory" / "plan-approval.json"
    tampered = {**marker, "story": "ENG-2"}
    marker_path.write_text(json.dumps(tampered))
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out
    assert run_state(repo)["plan_status"] == "awaiting-approval"


def test_plan_save_refuses_an_edited_plan_riding_a_stale_marker(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "approval-plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    approved_digest = json.loads(
        (repo / ".factory" / "plan-approval.json").read_text()
    )["plan_sha256"]

    plan.write_text(plan_draft(repo, body=PLAN_BODY + "\nEdited after approval.\n"))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")

    assert code != 0 and "awaiting-approval" in out
    assert run_state(repo)["plan_status"] == "awaiting-approval"
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    edited_body = active.read_text().split("---\n", 2)[2]
    assert hashlib.sha256(edited_body.encode()).hexdigest() != approved_digest


def test_an_approval_marker_authorizes_only_one_save(repo, tmp_path):
    # The marker is consumed on the approved save; replaying it (e.g. after a
    # later awaiting-approval reset of the same body) must require a fresh approve.
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "once-plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code == 0 and run_state(repo)["plan_status"] == "approved", out
    assert not (repo / ".factory" / "plan-approval.json").exists()

    # Same body, marker gone -> save refuses, no silent re-approval.
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out
    assert run_state(repo)["plan_status"] == "awaiting-approval"


def test_existing_plan_save_gates_still_run_unchanged(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "gate-plan.md"
    plan.write_text(plan_draft(repo))

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "grill" in out.lower() and "awaiting-approval" not in out

    plan.write_text(plan_draft(repo, decisions=[]))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "missing active decisions" in out
    assert "awaiting-approval" not in out

    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "signal", "raise", "--kind", "contradiction",
                    "--by", "implementer", "-m", "plan contradicts a decision")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "open contradiction" in out.lower()
    assert "awaiting-approval" not in out
    signal_id = json.loads(
        (repo / ".factory" / "signals.jsonl").read_text().splitlines()[0]
    )["id"]
    run(repo, "forge.py", "signal", "resolve", signal_id, "--notes", "resolved")

    body_without_surface = "\n\n".join(
        f"## {section}\nComplete."
        for section in PLAN_SECTIONS if section != "Surface Impact"
    )
    plan.write_text(plan_draft(repo, body=body_without_surface))
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "Surface Impact" in out
    assert "awaiting-approval" not in out

def test_plan_save_requires_a_fresh_same_issue_grill(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    # ungrilled plan -> refused
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "grill" in out.lower()
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(plan_draft(repo))
    # blocked grill never satisfies the gate
    record_grill(repo, "plan", verdict="blocked", digest_of=plan_file,
                 gaps=["criteria 2 unaddressed"])
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "blocked" in out
    # a grill of a DIFFERENT draft never approves this one
    other = tmp_path / "other-plan.md"
    other.write_text("something else\n")
    record_grill(repo, "plan", digest_of=other)
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "THIS input" in out
    # passing grill bound to THIS draft reaches the human approval gate
    code, out = record_grill(repo, "plan", digest_of=plan_file)
    assert code == 0, out
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "awaiting-approval" in out, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    code, out = save_plan_raw(repo, tmp_path)
    assert code == 0, out
    # next task cannot ride the previous task's grill: intake clears it
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    run(repo, "pr_ready.py")
    intake(repo, "ENG-2", "Payments")
    assert not (repo / ".factory" / "grills" / "plan.json").exists()
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "grill" in out.lower()


def test_plan_grill_recorder_stamps_the_active_issue(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    draft = tmp_path / "d.md"
    draft.write_text("x\n")
    code, out = record_grill(repo, "plan", issue="ENG-9", digest_of=draft)  # wrong task
    assert code != 0 and "does not match" in out
    code, out = record_grill(repo, "plan")  # digest is mandatory for plan gate
    assert code != 0 and "input-digest" in out
    code, out = record_grill(repo, "plan", digest_of=draft)
    assert code == 0, out
    data = json.loads((repo / ".factory" / "grills" / "plan.json").read_text())
    assert data["issue"] == "ENG-1"


def test_plan_save_requires_decision_coverage_and_no_open_contradiction(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    draft = tmp_path / "decision-plan.md"

    draft.write_text(PLAN_BODY)
    record_grill(repo, "plan", digest_of=draft)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "decisions_reviewed" in out

    draft.write_text(plan_draft(repo, decisions=[]))
    record_grill(repo, "plan", digest_of=draft)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "missing active decisions" in out

    draft.write_text(plan_draft(repo, decisions=[*active_decision_ids(repo), "9999-phantom"]))
    record_grill(repo, "plan", digest_of=draft)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "unknown or inactive" in out

    draft.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=draft)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "NOPE-1")
    assert code != 0 and "not in plans/roadmap.json" in out
    run(repo, "forge.py", "signal", "raise", "--kind", "contradiction",
        "--by", "implementer", "-m", "draft conflicts with an active decision")
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "open contradiction" in out.lower()
    signal_id = json.loads(
        (repo / ".factory" / "signals.jsonl").read_text().splitlines()[0]
    )["id"]
    run(repo, "forge.py", "signal", "resolve", signal_id,
        "--notes", "plan updated to follow the decision")
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(draft),
                    "--story", "ENG-1")
    assert code == 0, out
    saved = next((repo / "plans" / "active").glob("ENG-1-*.md")).read_text()
    assert "story: ENG-1" in saved
    for decision in active_decision_ids(repo):
        assert f"  - {decision}" in saved

    (repo / ".factory" / "stages.json").write_text(json.dumps({
        "issue": "ENG-1",
        "stages": [{"id": "T1", "status": "done"}, {"id": "T2", "status": "pending"}],
    }))
    code, out = run(repo, "forge.py", "plan", "list")
    assert code == 0 and "ENG-1" in out and "1/2" in out


def test_trailer_check_targets_the_acceptance_commit(repo):
    # Proposed draft committed WITHOUT a trailer — that must not warn.
    run(repo, "forge.py", "decision", "new", "queue-choice", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-queue-choice.md"))
    record.write_text(record.read_text()
        .replace("<!-- Why this decision was needed; the forces at play. -->", "Events need a transport.")
        .replace("<!-- What was decided, in one or two sentences. -->", "Use Redis streams for events.")
        .replace("<!-- What follows: tradeoffs accepted, doors closed, work implied. -->", "No Kafka ops burden."))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "draft decision")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0 and "Confirmed-by" not in out
    # Acceptance committed WITHOUT the trailer -> warning names that commit.
    run(repo, "forge.py", "decision", "accept", "queue-choice", "--by", "PM")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "accept queue-choice")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0 and "accepting" in out and "Confirmed-by" in out
    # Same acceptance WITH the trailer -> quiet.
    git(repo, "commit", "-q", "--amend", "-m", "accept queue-choice", "--trailer", "Confirmed-by: PM")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0 and "Confirmed-by" not in out


# ---------------------------------------------------------- Gate A: PR ticket

def pr_ticket_base(repo: Path, *keys: str) -> str:
    for key in keys:
        ensure_story(repo, key)
    roadmap = repo / "plans" / "roadmap.json"
    if not roadmap.exists():
        roadmap.parent.mkdir(parents=True, exist_ok=True)
        roadmap.write_text(json.dumps({
            "generated_by": "docs-decomposer", "epics": [], "items": [],
        }, indent=2) + "\n")
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-q", "-m", "seed PR tickets")
    return head(repo)


def complete_story(repo: Path, key: str) -> None:
    roadmap = repo / "plans" / "roadmap.json"
    data = json.loads(roadmap.read_text())
    next(item for item in data["items"] if item["key"] == key)["status"] = "done"
    roadmap.write_text(json.dumps(data, indent=2) + "\n")
    history = repo / ".factory" / "history" / key
    history.mkdir(parents=True)
    (history / "outcome.json").write_text('{"status": "recorded"}\n')


def check_pr_ticket(repo: Path, base: str, branch: str, body: str = ""):
    return run(
        repo, "check_pr_ticket.py", "--base", base,
        "--head-branch", branch, "--pr-body", body,
    )


def test_check_pr_ticket_passes_story(repo):
    key = "BOARD-101"
    base = pr_ticket_base(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "complete story")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code == 0 and f"story {key}" in out, out


def test_check_pr_ticket_passes_base_absent_story(repo):
    key = "BOARD-107"
    base = pr_ticket_base(repo)
    ensure_story(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "add and complete story")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code == 0 and f"story {key}" in out, out


def test_check_pr_ticket_fails_no_ticket(repo):
    key = "BOARD-102"
    base = pr_ticket_base(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "complete unlinked story")

    code, out = check_pr_ticket(repo, base, "chore/unlinked")

    assert code != 0 and "no ticket was found" in out, out


def test_check_pr_ticket_fails_missing_done_flip(repo):
    key = "BOARD-103"
    base = pr_ticket_base(repo, key)
    history = repo / ".factory" / "history" / key
    history.mkdir(parents=True)
    (history / "outcome.json").write_text('{"status": "recorded"}\n')
    git(repo, "add", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "history without completion")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code != 0 and "no completed work record" in out, out


def test_check_pr_ticket_fails_missing_history(repo):
    key = "BOARD-106"
    base = pr_ticket_base(repo, key)
    roadmap = repo / "plans" / "roadmap.json"
    data = json.loads(roadmap.read_text())
    next(item for item in data["items"] if item["key"] == key)["status"] = "done"
    roadmap.write_text(json.dumps(data, indent=2) + "\n")
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-q", "-m", "completion without history")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code != 0 and "no completed work record" in out, out


def test_check_pr_ticket_window_passes(repo):
    window_id = "Q-0042-abcd"
    base = pr_ticket_base(repo)
    ledger = repo / "plans" / "quickfixes"
    ledger.mkdir(exist_ok=True)
    (ledger / "window-done.json").write_text(json.dumps({
        "event": "done", "id": window_id, "files": ["src/fix.py"],
    }) + "\n")
    git(repo, "add", "plans/quickfixes/window-done.json")
    git(repo, "commit", "-q", "-m", "complete work window")

    code, out = check_pr_ticket(
        repo, base, "fix/bounded-change", f"Summary\n\nTicket: {window_id}\n",
    )

    assert code == 0 and f"window {window_id}" in out, out


def test_check_pr_ticket_two_declared_records_pass(repo):
    # A review-driven PR can complete two work records; declaring BOTH passes.
    first, second = "BOARD-104", "BOARD-105"
    base = pr_ticket_base(repo, first, second)
    complete_story(repo, first)
    complete_story(repo, second)
    git(repo, "add", "plans/roadmap.json", ".factory/history")
    git(repo, "commit", "-q", "-m", "complete two stories")

    code, out = check_pr_ticket(
        repo, base, f"feat/{first}-gate-a", f"Ticket: {second}\n",
    )

    assert code == 0, out
    assert f"story {first}" in out and f"story {second}" in out, out


def test_check_pr_ticket_fails_when_a_completed_record_is_undeclared(repo):
    # Two records complete, only one declared -> fail. Closes the declare-1-of-N
    # loophole: every completed record must be named, not just one.
    first, second = "BOARD-108", "BOARD-109"
    base = pr_ticket_base(repo, first, second)
    complete_story(repo, first)
    complete_story(repo, second)
    git(repo, "add", "plans/roadmap.json", ".factory/history")
    git(repo, "commit", "-q", "-m", "complete two stories")

    code, out = check_pr_ticket(repo, base, f"feat/{first}-gate-a")  # only first declared

    assert code != 0, out
    assert "must be declared" in out and second in out, out


# -------------------------------------------------- Gate B: board completeness

def board_story(repo: Path, key: str, **over) -> None:
    ensure_story(repo, key)
    roadmap = repo / "plans" / "roadmap.json"
    data = json.loads(roadmap.read_text())
    item = next(item for item in data["items"] if item["key"] == key)
    item.update({"status": "done", "outcome": "Shipped outcome."}, **over)
    roadmap.write_text(json.dumps(data, indent=2) + "\n")


def add_pr_link(repo: Path, key: str, reference: str = "acme/widgets#42") -> None:
    events = repo / ".factory" / "events.jsonl"
    events.parent.mkdir(exist_ok=True)
    with events.open("a") as ledger:
        ledger.write(json.dumps({
            "event": "pr-linked",
            "generated_by": "orchestrator",
            "at": "2026-08-07T00:00:00+00:00",
            "story": key,
            "detail": reference,
        }) + "\n")


def add_story_history(repo: Path, key: str) -> None:
    history = repo / ".factory" / "history" / key
    history.mkdir(parents=True, exist_ok=True)


def test_check_board_complete_passes(repo):
    key = "BOARD-201"
    board_story(repo, key)
    add_pr_link(repo, key)
    add_story_history(repo, key)

    code, out = run(repo, "check_board_complete.py")

    assert code == 0 and "Board completeness check OK" in out, out


def test_check_board_complete_fails_missing_link(repo):
    key = "BOARD-202"
    board_story(repo, key)
    add_story_history(repo, key)
    code, out = run(repo, "check_board_complete.py")
    assert code != 0 and "missing pr-linked event" in out, out


def test_check_board_complete_fails_missing_outcome(repo):
    key = "BOARD-202"
    board_story(repo, key, outcome="")
    add_pr_link(repo, key)
    add_story_history(repo, key)
    code, out = run(repo, "check_board_complete.py")
    assert code != 0 and "missing outcome" in out, out


def test_check_board_complete_fails_missing_history(repo):
    key = "BOARD-202"
    board_story(repo, key)
    add_pr_link(repo, key)
    code, out = run(repo, "check_board_complete.py")
    assert code != 0 and "missing .factory/history/BOARD-202/ directory" in out, out


def test_check_board_complete_predates_ok(repo):
    key = "BOARD-203"
    board_story(repo, key, outcome="", predates_outcome_contract=True)

    code, out = run(repo, "check_board_complete.py")
    assert code != 0 and f"missing .factory/history/{key}/ directory" in out, out

    add_story_history(repo, key)

    code, out = run(repo, "check_board_complete.py")

    assert code == 0 and "Board completeness check OK" in out, out


def test_gate_b_workflows_link_the_branch_and_check_main():
    link = (HARNESS / ".github" / "workflows" / "pr-link.yml").read_text()
    invariant = (HARNESS / ".github" / "workflows" / "board-invariant.yml").read_text()

    assert "pull_request:" in link
    assert "already_linked" in link
    assert 'git push origin "HEAD:$HEAD_BRANCH"' in link
    assert "branches: [main]" in invariant
    assert "python3 factory/scripts/check_board_complete.py" in invariant


def test_project_audit_reports_gaps(repo):
    done_key = "BOARD-204"
    pending_key = "BOARD-205"
    board_story(repo, done_key, outcome="")
    ensure_story(repo, pending_key)
    roadmap = repo / "plans" / "roadmap.json"
    data = json.loads(roadmap.read_text())
    pending = next(item for item in data["items"] if item["key"] == pending_key)
    pending.pop("spec")
    roadmap.write_text(json.dumps(data, indent=2) + "\n")
    (repo / "factory" / "prompts" / "planner.md").write_text("drift\n")

    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))

    assert code != 0, out
    assert f"[done-story] {done_key}: missing pr-linked event" in out
    assert f"[done-story] {done_key}: missing outcome" in out
    assert f"[done-story] {done_key}: missing .factory/history/{done_key}/ directory" in out
    assert (f"[pending-story] {pending_key}: missing required fields: "
            "epic, story, acceptance_criteria, skill, depends_on, spec") in out
    assert "[vendor-drift] edited: factory/prompts/planner.md" in out


def test_project_audit_clean_repo_exits_zero(repo):
    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))

    assert code == 0, out
    assert "Project audit OK: no project-state gaps." in out


def _backfill_done_story(repo: Path, key: str, records: list[dict], **over):
    board_story(repo, key, **over)
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-q", "-m", f"legacy done story {key}")
    from forge_cli.project import backfill_project
    return backfill_project(repo, gh=lambda _base: records)


def _merged_pr(number: int, title: str, branch: str) -> dict:
    return {
        "number": number,
        "title": title,
        "url": f"https://github.com/acme/widgets/pull/{number}",
        "headRefName": branch,
    }


def _backfill_events(repo: Path) -> list[dict]:
    path = repo / ".factory" / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_project_backfill_unique_match_still_links(repo):
    key = "BOARD-210"
    pr = _merged_pr(42, f"{key} ship the board", f"feat/{key}-ship-board")

    counts = _backfill_done_story(repo, key, [pr])

    events = _backfill_events(repo)
    links = [event for event in events
             if event.get("event") == "pr-linked" and event.get("story") == key]
    assert counts["linked"] == 1
    assert [event["detail"] for event in links] == [pr["url"]]


def test_project_backfill_matches_pr_by_body(repo):
    # D-0014: a PR whose title/branch don't match but whose BODY names the key.
    key = "BOARD-212"
    pr = {
        "number": 24,
        "title": "chore: archive completed work",
        "url": "https://github.com/acme/widgets/pull/24",
        "headRefName": "chore/cleanup",
        "body": f"Archives the completed {key} story.",
    }
    counts = _backfill_done_story(repo, key, [pr])
    links = [e for e in _backfill_events(repo)
             if e.get("event") == "pr-linked" and e.get("story") == key]
    assert counts["linked"] == 1
    assert [e["detail"] for e in links] == [pr["url"]]


def test_project_backfill_body_match_respects_word_boundary(repo):
    # BOARD-21 must NOT match a body that only names BOARD-210.
    key = "BOARD-21"
    pr = {
        "number": 25,
        "title": "chore: cleanup",
        "url": "https://github.com/acme/widgets/pull/25",
        "headRefName": "chore/x",
        "body": "Relates to BOARD-210 only.",
    }
    counts = _backfill_done_story(repo, key, [pr])
    assert counts["linked"] == 0


def test_project_backfill_body_mentions_are_ambiguous_not_guessed(repo, capsys):
    # D-0014's body match is best-effort: two PRs that both MENTION the key (an
    # implementer and, say, a revert) collapse to ambiguous and link neither, so
    # a non-owning mention cannot silently become the story's shipping provenance.
    key = "BOARD-213"
    prs = [
        {"number": 30, "title": "chore: work", "headRefName": "chore/a",
         "url": "https://github.com/acme/widgets/pull/30", "body": f"Implements {key}."},
        {"number": 31, "title": "chore: revert", "headRefName": "chore/b",
         "url": "https://github.com/acme/widgets/pull/31", "body": f"Reverts {key}."},
    ]
    counts = _backfill_done_story(repo, key, prs)
    out = capsys.readouterr().out
    assert counts["linked"] == 0 and counts["ambiguous"] == 1
    assert "ambiguous" in out
    assert [e for e in _backfill_events(repo)
            if e.get("event") == "pr-linked" and e.get("story") == key] == []


def test_project_backfill_zero_match_does_not_predate(repo, capsys):
    key = "BOARD-211"

    counts = _backfill_done_story(repo, key, [])

    out = capsys.readouterr().out
    item = roadmap_items(repo)[key]
    assert counts["unresolved"] == 1
    assert f"SKIP {key}: unresolved provenance" in out
    assert "predates_outcome_contract" not in item
    assert not any(
        event.get("event") == "pr-linked" and event.get("story") == key
        for event in _backfill_events(repo)
    )


def test_project_backfill_zero_match_stays_red(repo):
    key = "BOARD-216"
    add_story_history(repo, key)

    _backfill_done_story(repo, key, [])

    code, out = run(repo, "check_board_complete.py")
    assert code != 0, out
    assert f"{key}: missing pr-linked event" in out


def test_project_mark_predates_is_human_confirmed(repo):
    key = "BOARD-217"
    reason = "Shipped before durable outcome and PR-link records existed"
    board_story(repo, key, outcome="")

    code, out = run(
        repo, "forge.py", "project", "mark-predates", key,
        "--reason", reason, "--repo", str(repo),
    )

    assert code == 0, out
    assert roadmap_items(repo)[key]["predates_outcome_contract"] is True
    confirmations = [
        event for event in _backfill_events(repo)
        if event.get("event") == "project-mark-predates"
        and event.get("story") == key
    ]
    assert len(confirmations) == 1
    assert confirmations[0]["generated_by"] == "human"
    assert confirmations[0]["detail"] == reason


def test_project_backfill_reports_ambiguous_without_guessing(repo, capsys):
    key = "BOARD-212"
    records = [
        _merged_pr(51, f"{key} first candidate", "feat/other-work"),
        _merged_pr(52, "Unrelated title", f"fix/{key}-second-candidate"),
    ]

    counts = _backfill_done_story(repo, key, records)

    out = capsys.readouterr().out
    assert counts["ambiguous"] == 1
    assert f"SKIP {key}: ambiguous" in out
    assert records[0]["url"] in out and records[1]["url"] in out
    assert not any(
        event.get("event") == "pr-linked" and event.get("story") == key
        for event in _backfill_events(repo)
    )


def test_project_backfill_reconstructs_card_from_evidence_only(repo):
    evidenced = "BOARD-213"
    evidence_less = "BOARD-214"
    for key in (evidenced, evidence_less):
        board_story(repo, key)
    roadmap = repo / "plans" / "roadmap.json"
    data = json.loads(roadmap.read_text())
    data["items"] = [
        item for item in data["items"]
        if item.get("key") not in {evidenced, evidence_less}
    ]
    data["items"].extend([
        {"key": evidenced, "status": "done"},
        {"key": evidence_less, "status": "done"},
    ])
    roadmap.write_text(json.dumps(data, indent=2) + "\n")

    plan = repo / "plans" / "completed" / f"{evidenced}-legacy.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        f"---\nissue: {evidenced}\ntitle: Recovered board title\n"
        f"story: {evidenced}\n---\n\n# Legacy plan\n"
    )
    history = repo / ".factory" / "history" / evidenced
    history.mkdir(parents=True, exist_ok=True)
    decomposition = history / "decomposition.json"
    decomposition.write_text(json.dumps({
        "story": evidenced,
        "epic": "recovered-epic",
        "acceptance_criteria": ["Recovered criterion"],
    }))
    git(repo, "add", "plans/roadmap.json", "plans/completed")
    git(repo, "add", "-f", ".factory/history")
    git(repo, "commit", "-q", "-m", "committed legacy evidence")

    # Working-tree claims are not evidence and must not be copied.
    plan.write_text(plan.read_text().replace("Recovered board title", "Invented title"))
    decomposition.write_text(json.dumps({"epic": "invented-epic", "skill": "frontend"}))
    from forge_cli.project import backfill_project
    records = [
        _merged_pr(61, f"{evidenced} shipped", "feat/unrelated"),
        _merged_pr(62, f"{evidence_less} shipped", "fix/unrelated"),
    ]
    backfill_project(repo, gh=lambda _base: records)

    items = roadmap_items(repo)
    assert items[evidenced]["title"] == "Recovered board title"
    assert items[evidenced]["epic"] == "recovered-epic"
    assert items[evidenced]["acceptance_criteria"] == ["Recovered criterion"]
    assert "skill" not in items[evidenced]
    assert "backfill_evidence_missing" not in items[evidenced]
    assert items[evidence_less]["backfill_evidence_missing"] is True
    for field in ("title", "epic", "story", "acceptance_criteria", "skill", "spec"):
        assert field not in items[evidence_less]


def test_project_backfill_is_idempotent(repo):
    key = "BOARD-215"
    board_story(repo, key)
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-q", "-m", "legacy done story")
    pr = _merged_pr(71, f"{key} shipped", f"feat/{key}-ship")
    calls = 0

    def gh_fixture(_base):
        nonlocal calls
        calls += 1
        return [pr]

    from forge_cli.project import backfill_project
    first = backfill_project(repo, gh=gh_fixture)
    before = {
        "roadmap": (repo / "plans" / "roadmap.json").read_bytes(),
        "events": (repo / ".factory" / "events.jsonl").read_bytes(),
    }
    second = backfill_project(repo, gh=gh_fixture)

    assert first["linked"] == 1
    assert second == {"linked": 0, "unresolved": 0, "ambiguous": 0,
                      "reconstructed": 0}
    assert calls == 1
    assert (repo / "plans" / "roadmap.json").read_bytes() == before["roadmap"]
    assert (repo / ".factory" / "events.jsonl").read_bytes() == before["events"]


def test_harness_health_runs_project_audit_without_backfill():
    workflow = (HARNESS / ".github" / "workflows" / "harness-health.yml").read_text()

    assert "python3 factory/scripts/forge.py project audit" in workflow
    assert "project_rc" in workflow
    assert "project backfill" not in workflow


def test_harness_health_has_no_daily_cron():
    workflow = (HARNESS / ".github" / "workflows" / "harness-health.yml").read_text()

    assert "schedule:" not in workflow
    assert "cron:" not in workflow
    assert "workflow_dispatch:" in workflow
    assert "push:" in workflow
    assert "branches: [main]" in workflow
    assert "if: steps.staleness.outputs.behind == '1'" in workflow


# ------------------------------------------------------------ parallelization

def test_roadmap_parallel_frontier(repo, tmp_path):
    code, out = import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer", "epics": [ROADMAP_EPIC], "items": [
            authored_story("P-1", "Auth API"),
            authored_story("P-2", "Notes UI", skill="frontend"),
            authored_story("P-3", "Profile page", skill="frontend",
                           depends_on=["P-1"]),
        ]})
    assert code == 0, out
    # dangling and self edges are refused at import
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        authored_story("P-4", "X", depends_on=["P-99"])]})
    assert code != 0 and "P-99" in out
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        authored_story("P-5", "Y", depends_on=["P-5"])]})
    assert code != 0 and "itself" in out
    # frontier: P-1 and P-2 run in parallel worktrees; P-3 blocked on P-1
    code, out = run(repo, "forge.py", "roadmap", "parallel")
    assert code == 0, out
    assert "2 stories are independent" in out and "git worktree add" in out
    assert "P-1" in out and "P-2" in out and "BLOCKED P-3" in out and "waiting on: P-1" in out
    # forge next surfaces the fan-out to the EM
    code, out = run(repo, "forge.py", "next")
    assert "PARALLELIZE" in out and "roadmap parallel" in out
    # completing P-1 unblocks P-3
    from_json = (repo / "plans" / "roadmap.json")
    import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        authored_story("P-1", "Auth API")]})  # no-op merge keeps status
    data = json.loads(from_json.read_text())
    for item in data["items"]:
        if item["key"] == "P-1":
            item["status"] = "done"
    from_json.write_text(json.dumps(data))
    code, out = run(repo, "forge.py", "roadmap", "parallel")
    assert "BLOCKED" not in out and "P-3" in out


# ----------------------------------------------------------- roadmap healing

def test_roadmap_heal_unions_duplicates_done_wins(repo, tmp_path):
    import_roadmap(repo, tmp_path)
    # simulate a bad hand-merge: duplicate keys with diverged statuses
    p = repo / "plans" / "roadmap.json"
    data = json.loads(p.read_text())
    dupe_active = {**data["items"][0], "status": "active"}
    dupe_done = {**data["items"][0], "status": "done",
                 "history": ".factory/history/ENG-1/"}
    data["items"] = [dupe_active, data["items"][1], dupe_done]
    p.write_text(json.dumps(data))
    code, out = run(repo, "forge.py", "roadmap", "heal")
    assert code == 0 and "1 duplicate(s) unioned" in out, out
    items = roadmap_items(repo)
    assert items["ENG-1"]["status"] == "done"  # further-along wins
    assert items["ENG-1"]["history"] == ".factory/history/ENG-1/"
    assert len(json.loads(p.read_text())["items"]) == 2
    # unparseable outside a merge -> clear failure, no silent guess
    p.write_text("{ <<<<<<< garbage")
    code, out = run(repo, "forge.py", "roadmap", "heal")
    assert code != 0 and "restore" in out


# ------------------------------------------------- the record of what shipped

def test_outcome_is_required_to_ship_and_survives_in_the_record(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    (repo / ".factory" / "outcome.json").unlink()
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    # a bare pr_ready stays a readiness CHECK: it names the gap, it does not
    # demand an argument before it will answer
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "outcome" in out
    # the paragraph must read like one: a command line or an essay is not it
    code, out = run(repo, "forge.py", "outcome", "set", "fixed it")
    assert code != 0 and "at least" in out
    code, out = run(repo, "forge.py", "outcome", "set", "word " * 300)
    assert code != 0 and "max" in out
    text = ("Invoices now load for every account and can be filtered by date, "
            "so support no longer has to run the export by hand.")
    code, out = run(repo, "forge.py", "outcome", "set", text)
    assert code == 0, out
    code, out = run(repo, "pr_ready.py")
    assert code == 0 and "PR_READY" in out, out
    # what shipped is answerable from the durable record, not from a session
    assert roadmap_items(repo)["ENG-1"]["outcome"] == text
    history = repo / ".factory" / "history" / "ENG-1"
    assert json.loads((history / "outcome.json").read_text())["outcome"] == text
    assert not (repo / ".factory" / "outcome.json").exists()
    # the shipped stub stays byte-stable for parallel merges
    assert "outcome" not in json.loads(
        (repo / ".factory" / "run.json").read_text())


def test_story_timeline_is_recorded_and_archived_with_its_story(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    events = [json.loads(line) for line in
              (repo / ".factory" / "events.jsonl").read_text().splitlines()]
    kinds = [e["event"] for e in events]
    assert "intake" in kinds and "plan-approved" in kinds and "decomposed" in kinds
    # every line says WHO: a timeline in an agent-built repo that cannot
    # attribute a transition answers nothing six weeks later
    assert all(e.get("generated_by") for e in events), events
    assert all(e["story"] == "ENG-1" for e in events if "story" in e)
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    archived = [json.loads(line) for line in
                (repo / ".factory" / "history" / "ENG-1" / "events.jsonl")
                .read_text().splitlines()]
    assert "shipped" in [e["event"] for e in archived]
    # The archive is a COPY: the live ledger is append-only and keeps every
    # line. Removing lines from a union-merged file does not survive a parallel
    # branch that still holds them — the removal grows back on merge, so it was
    # never a removal at all.
    live = [json.loads(line) for line in
            (repo / ".factory" / "events.jsonl").read_text().splitlines()]
    assert [e for e in live if e.get("story") == "ENG-1"], live
    assert "client-signoff" in [e["event"] for e in live]


def test_ship_archives_the_plan_grill_not_the_project_grills(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    assert (repo / ".factory" / "grills" / "plan.json").exists()
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    history = repo / ".factory" / "history" / "ENG-1"
    # the interrogation record of THIS story survives the ship
    assert json.loads((history / "grills" / "plan.json").read_text())["issue"] == "ENG-1"
    # project-level grills are not this story's evidence
    assert not (history / "grills" / "signoff.json").exists()


def test_tagged_process_scan_skips_unreadable_environments(tmp_path):
    """The /proc scan must SKIP a process whose environ it cannot read, not
    abort the gate.

    Linux refuses /proc/<pid>/environ for a zombie (ptrace_may_access fails on
    an exited task) and for any process we do not own. Our own short-lived
    proof children become zombies routinely, so raising there took down every
    stage-done and delegate gate on Linux — while macOS, which has no /proc,
    never ran the branch at all and stayed green. proc_root is injectable so
    this case is reachable from either platform.
    """
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.delegate import _tagged_processes

    token = "gate-test-token"
    fake_proc = tmp_path / "proc"
    fake_proc.mkdir()

    # Unreadable environ, exactly as Linux reports for a zombie or a process
    # belonging to somebody else.
    unreadable = fake_proc / "424242"
    unreadable.mkdir()
    (unreadable / "environ").write_bytes(b"")
    (unreadable / "environ").chmod(0o000)

    # A readable, genuinely live process carrying the marker: this one must
    # still be found, so the skip above cannot be hiding real work.
    mine = fake_proc / str(os.getpid())
    mine.mkdir()
    (mine / "environ").write_bytes(
        b"PATH=/usr/bin\0FORGE_PROCESS_TOKEN=" + token.encode() + b"\0")

    table = {424242: (1, "start-a"), os.getpid(): (1, "start-b")}
    found = _tagged_processes(token, current=table, proc_root=fake_proc)

    assert os.getpid() in found, "a readable tagged process must still be found"
    assert 424242 not in found

    (unreadable / "environ").chmod(0o600)  # let tmp_path clean up


def test_frontier_is_ranked_by_what_it_unblocks(repo, tmp_path):
    """The frontier answers "what CAN I start"; without leverage it reads the
    same for a story that frees three others and one that frees none."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.roadmap import epic_gating, leverage
    items = [
        {"key": "A", "title": "a", "epic": "core", "status": "done"},
        {"key": "B", "title": "b", "epic": "core", "status": "pending",
         "depends_on": ["A"]},
        {"key": "C", "title": "c", "epic": "comms", "status": "pending",
         "depends_on": ["B"]},
        {"key": "D", "title": "d", "epic": "comms", "status": "pending",
         "depends_on": ["C"]},
        {"key": "E", "title": "e", "epic": "core", "status": "pending"},
    ]
    unblocks = leverage(items)
    assert unblocks["B"] == 2 and unblocks["C"] == 1 and unblocks["E"] == 0
    assert unblocks["A"] == 3          # transitive: B, then C, then D
    # Work already shipped is not counted as unblocked, and the walk stops
    # there: once B is done, C is free regardless of A.
    shipped_b = [{**i, "status": "done"} if i["key"] == "B" else i for i in items]
    assert leverage(shipped_b)["A"] == 0
    rows = dict((epic, (left, waits)) for epic, left, waits in epic_gating(items))
    assert rows["comms"] == (2, ["core"])   # derived, not declared
    assert rows["core"] == (2, [])
    # and the CLI ranks by it rather than by roadmap order
    import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer", "epics": [ROADMAP_EPIC], "items": [
            authored_story("ENG-1", "frees nothing"),
            authored_story("ENG-2", "frees one"),
            authored_story("ENG-3", "waits", depends_on=["ENG-2"]),
        ]})
    code, out = run(repo, "forge.py", "roadmap", "parallel")
    assert code == 0, out
    assert out.index("ENG-2") < out.index("ENG-1"), out
    assert "unblocks 1" in out and "unblocks nothing further" in out


def test_board_binds_evidence_to_the_story_that_owns_it(repo, tmp_path):
    """Live .factory/ belongs to whatever story is ACTIVE. Handing it to any
    other story shows one story's proof under another's name."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import story_detail
    sign_off(repo)
    ensure_story(repo, "ENG-2", "Another story")
    intake(repo)                                   # ENG-1 is the active run
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    assert story_detail(repo, "ENG-1")["evidence"]["decomposition"], "active story"
    other = story_detail(repo, "ENG-2")["evidence"]
    assert not other["decomposition"], "an unplanned story showed the active run's proof"
    assert not other["verify"]
    # the board is a viewer: no route may mutate anything
    board = (HARNESS / "factory" / "scripts" / "forge_cli" / "board.py").read_text()
    assert "do_POST" not in board and "do_PUT" not in board and "do_DELETE" not in board


def test_api_state_carries_project_identity_from_the_shared_parser(repo):
    from forge_cli.board import aggregate_state

    brief = repo / "docs" / "product" / "BRIEF.md"
    brief.write_text(
        "# Deliberately different document title\n\n"
        + "\n".join(
            f"## {heading}\n\nCaptured {heading}.\n"
            for heading in REQUIRED_BRIEF_HEADINGS
        )
    )

    # forge init --name AUTHORED this; the directory is "app". The authored
    # name wins, or a project initialized as "Acme Billing" into ~/acme-billing
    # reads as its slug on the board.
    run_state = repo / ".factory" / "run.json"
    run_state.write_text(json.dumps(
        {**json.loads(run_state.read_text()), "project": "Acme Billing"}))
    assert aggregate_state(repo)["project"]["name"] == "Acme Billing"
    # Falls back to the directory only when nothing authored a name.
    run_state.write_text(json.dumps(
        {**json.loads(run_state.read_text()), "project": ""}))

    project = aggregate_state(repo)["project"]
    assert project == {
        "name": "app",
        "sections": {
            heading: f"Captured {heading}."
            for heading in REQUIRED_BRIEF_HEADINGS
        },
        "missing_sections": [],
    }

    brief.write_text("# Incomplete\n\n## Summary\n\nCaptured.\n")
    incomplete = aggregate_state(repo)["project"]
    assert incomplete["sections"] == {"Summary": "Captured."}
    assert incomplete["missing_sections"] == list(REQUIRED_BRIEF_HEADINGS[1:])

    brief.unlink()
    missing = aggregate_state(repo)["project"]
    assert missing["sections"] == {}
    assert missing["missing_sections"] == list(REQUIRED_BRIEF_HEADINGS)


def test_board_reports_the_record_boundary(repo):
    from forge_cli.board import aggregate_state

    state = aggregate_state(repo)
    assert state["record_origin"] == json.loads(
        (repo / ".factory" / "record-origin.json").read_text()
    )
    assert state["record_origin"]["preceding_commits"] == 0

    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    boundary = (
        "record begins here; ${esc(recordOrigin.preceding_commits)} "
        "commits precede it"
    )
    assert boundary in page
    # A real count renders the number; a null (shallow) count renders the
    # boundary without one; no marker renders nothing.
    assert "Number.isInteger(recordOrigin.preceding_commits)" in page
    assert '`<p class="record-boundary">record begins here</p>`' in page

    (repo / ".factory" / "record-origin.json").unlink()
    assert aggregate_state(repo)["record_origin"] is None


def test_bundled_example_authors_its_project_name():
    """The example AUTHORS its name like any scaffolded repo, rather than the
    board inferring one from the brief's H1 — a brief's H1 is a document
    title (the scaffold ships '# Product Brief'), which is why
    test_api_state_carries_project_identity_from_the_shared_parser
    deliberately titles its brief differently from the project. Without an
    authored name the example rendered as 'example', its directory."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import project_identity

    example = HARNESS / "factory" / "board" / "example"
    assert json.loads(
        (example / ".factory" / "run.json").read_text())["project"] == "Workshop Dispatch"
    assert project_identity(example)["name"] == "Workshop Dispatch"
    # A relative path must still name the project, not render it blank.
    assert project_identity(Path(".")).get("name")


def test_brief_required_headings_have_a_single_owner():
    import record_signoff
    from forge_cli import board, doctor

    assert board.REQUIRED_BRIEF_HEADINGS is record_signoff.REQUIRED_BRIEF_HEADINGS
    assert doctor.REQUIRED_BRIEF_HEADINGS is record_signoff.REQUIRED_BRIEF_HEADINGS
    assert not hasattr(doctor, "BRIEF_REQUIRED_HEADINGS")

    sources = [
        (HARNESS / "factory" / "scripts" / "record_signoff.py").read_text(),
        (HARNESS / "factory" / "scripts" / "forge_cli" / "doctor.py").read_text(),
        (HARNESS / "factory" / "scripts" / "forge_cli" / "board.py").read_text(),
    ]
    assert sum(source.count("REQUIRED_BRIEF_HEADINGS = (") for source in sources) == 1
    assert sum(source.count('"Summary"') for source in sources) == 1


def test_api_state_derives_epic_relationships_and_reverse_unblocks(repo):
    from forge_cli.board import aggregate_state

    reporting = {
        "id": "reporting", "title": "Reporting", "objective": "see trends",
        "source_refs": ["docs/product/BRIEF.md"],
    }
    analytics = {
        "id": "analytics", "title": "Analytics", "objective": "explain trends",
        "source_refs": ["docs/product/BRIEF.md"],
    }
    roadmap = {
        "generated_by": "human",
        "epics": [ROADMAP_EPIC, reporting, analytics],
        "items": [
            authored_story("BILL-1", "Paid invoices", status="done"),
            authored_story("BILL-2", "Open invoices", status="pending"),
            authored_story("REP-1", "Aging report", epic="reporting",
                           status="pending", depends_on=["BILL-2"]),
            authored_story("REP-2", "Revenue report", epic="reporting",
                           status="pending", depends_on=["BILL-1"]),
            authored_story("ANA-1", "Trend analysis", epic="analytics",
                           status="pending", depends_on=["BILL-1"]),
        ],
    }
    (repo / "plans" / "roadmap.json").write_text(json.dumps(roadmap))

    state = aggregate_state(repo)
    stories = {story["key"]: story for story in state["stories"]}
    assert stories["BILL-1"]["unblocks"] == ["REP-2", "ANA-1"]
    assert stories["BILL-2"]["unblocks"] == ["REP-1"]
    assert stories["REP-1"]["unblocks"] == []
    assert stories["REP-2"]["unblocks"] == []
    assert stories["ANA-1"]["unblocks"] == []
    assert stories["REP-1"]["blocked_by"] == ["BILL-2"]
    assert stories["REP-2"]["blocked_by"] == []

    epics = {epic["id"]: epic for epic in state["epics"]}
    assert epics["billing"]["stories"] == ["BILL-1", "BILL-2"]
    assert epics["billing"]["progress"] == {"done": 1, "total": 2}
    assert epics["reporting"]["stories"] == ["REP-1", "REP-2"]
    assert epics["reporting"]["progress"] == {"done": 0, "total": 2}
    assert epics["analytics"]["stories"] == ["ANA-1"]
    assert epics["analytics"]["progress"] == {"done": 0, "total": 1}
    assert epics["reporting"]["blocked_by"] == ["billing"]
    assert epics["reporting"]["unblocks"] == []
    assert epics["analytics"]["blocked_by"] == ["billing"]
    assert epics["analytics"]["unblocks"] == []
    assert epics["billing"]["blocked_by"] == []
    assert epics["billing"]["unblocks"] == ["reporting", "analytics"]


def test_api_story_detail_carries_project_and_resolved_epic(repo):
    from forge_cli.board import aggregate_state, story_detail

    (repo / "plans" / "roadmap.json").write_text(json.dumps({
        "generated_by": "human",
        "epics": [ROADMAP_EPIC],
        "items": [authored_story("ENG-1", "Invoices", status="pending")],
    }))

    state = aggregate_state(repo)
    detail = story_detail(repo, "ENG-1")
    assert detail is not None
    assert detail["project"] == state["project"]
    assert detail["epic"] == state["epics"][0]
    assert detail["epic"]["id"] == detail["story"]["epic"] == "billing"
    assert state["stories"][0]["epic"] == "billing"
    assert not isinstance(state["stories"][0]["epic"], dict)


def test_board_default_view_is_the_overview():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()

    assert '<body data-view="overview">' in page
    assert 'data-board-view="overview" aria-selected="true"' in page
    assert 'data-board-view="lifecycle" aria-selected="false"' in page
    assert page.index('data-board-view="overview"') < page.index(
        'data-board-view="lifecycle"')
    assert 'id="overview-view"' in page
    assert 'id="lifecycle-view" hidden' in page
    assert 'document.body.dataset.view = view' in page
    assert '$("overview-view").hidden = view !== "overview"' in page
    assert '$("lifecycle-view").hidden = view !== "lifecycle"' in page
    # Both tabs stay in the tab order. A roving tabIndex without an
    # ArrowLeft/ArrowRight handler stranded keyboard-only users in whichever
    # view they picked first — with two tabs, keeping both focusable is the
    # smaller fix than implementing the full tablist key protocol.
    assert "tabIndex" not in page

    # Adding a default view must not replace any part of the lifecycle render.
    render = page[page.index("function render(state)"):
                  page.index("async function poll()")]
    for existing_affordance in (
            "renderRunline(state)", "renderProgress(state)",
            "renderBanner(state)", "renderNext(state)", "renderColhead()",
            "patchLanes(state)"):
        assert existing_affordance in render


def test_overview_answers_the_four_questions():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    overview = page[page.index("function renderOverview(state)"):
                    page.index("/* ═══ overlays", page.index(
                        "function renderOverview(state)"))]

    questions = [
        "What is this project?",
        "What can start now?",
        "What does each epic deliver?",
        "Where does each story sit?",
    ]
    assert all(question in page for question in questions)
    assert overview.index(questions[0]) < overview.index(questions[1])
    assert overview.index(questions[1]) < overview.index(questions[2])
    assert overview.index(questions[2]) < overview.index(questions[3])

    assert "state.project" in overview and "state.root" not in overview
    assert "state.frontier" in overview
    assert "frontier.length" in overview
    assert "state.epics" in overview and "epic.objective" in overview
    assert "epic.stories" in overview
    assert "story.blocked_by" in overview
    assert "story.unblocks" in overview
    assert "depends_on" not in overview
    assert "ageDays(" not in overview and "Date(" not in overview
    assert not re.search(r"\b(?:wave|layer)\s*\d", overview, re.IGNORECASE)
    # The board polls, so a rebuild lands mid-interaction: it must restore both
    # keyboard focus and the drawer's focus-return `opener`, or a live update
    # silently steals a keyboard user's place.
    assert "document.activeElement" in overview
    assert "refocus.focus()" in overview
    assert "opener = reopener" in overview
    # A frontier story renders in BOTH sections, so identity is (slot, key):
    # rebinding on key alone would jump focus to the other section.
    assert "data-overview-slot" in page
    assert 'node.dataset.overviewSlot' in overview


def test_epic_story_and_task_are_explicitly_labelled():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()

    make_lane = page[page.index("function makeLane("):
                     page.index("function rollCount(")]
    overview = page[page.index("function renderOverview(state)"):
                    page.index("function showBoardView(")]
    make_card = page[page.index("function makeCard("):
                     page.index("function makeLane(")]
    task_block = page[page.index("function taskBlock("):
                      page.index("function findingList(")]
    proof_block = page[page.index("function proofBlock("):
                       page.index("const RAW_SOURCE")]

    assert 'kindLabel("EPIC")' in make_lane
    assert 'kindLabel("EPIC")' in overview
    assert 'kindLabel("STORY")' in make_card
    assert 'kindLabel("STORY")' in overview
    assert 'kindLabel("TASK")' in task_block
    assert 'kindLabel("TASK")' in proof_block


def test_drawer_opens_with_a_project_epic_story_breadcrumb():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    breadcrumb = page[page.index("function drawerBreadcrumb("):
                      page.index("function drawerBody(")]
    drawer_body = page[page.index("function drawerBody("):
                       page.index("function tabBar(")]
    open_drawer = page[page.index("async function openDrawer("):
                       page.index("/* ═══ library")]

    assert "detail.project" in breadcrumb
    assert "detail.epic" in breadcrumb
    assert "detail.story" in breadcrumb
    assert 'label: "Project"' in breadcrumb
    assert 'label: "Epic"' in breadcrumb
    assert 'label: "Story"' in breadcrumb
    assert "epicName ?" in breadcrumb  # absent/unknown epic omits the segment
    assert "drawerBreadcrumb(detail)" in drawer_body
    assert "fetch(" not in breadcrumb
    assert open_drawer.count("fetch(") == 1
    assert "/api/story/" in open_drawer


def test_blocked_reads_as_blocked_on_every_surface():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    progress = page[page.index("function renderProgress(state)"):
                    page.index("function renderBanner(state)")]
    card_mark = page[page.index("function cardMark(story"):
                     page.index("/* ═══ since you last looked")]
    cards = page[page.index("function patchLanes(state)"):
                 page.index("/* ═══ overview")]
    drawer_body = page[page.index("function drawerBody("):
                       page.index("function tabBar(")]

    assert "sum.blocked + sum.waiting" not in progress
    assert '["blocked", sum.blocked]' in progress
    assert '["waiting", sum.waiting]' in progress
    assert 'sum.blocked, "blocked"' in progress
    assert 'sum.waiting, "waiting"' in progress

    assert 'story.state === "blocked"' in card_mark
    assert "blocked by" in card_mark
    assert 'story.state === "waiting"' in card_mark
    assert 'return "· waiting"' in card_mark
    assert "STATE_WORD[story.state]" in cards  # card ARIA label
    assert "STATE_WORD[s.state]" in drawer_body
    assert "blocked by" in drawer_body
    assert "waiting on" not in drawer_body

    # The overview is a fifth state-reporting surface; keep it consistent too.
    overview = page[page.index("function renderOverview(state)"):
                    page.index("function showBoardView(")]
    assert "STATE_WORD[story.state]" in overview


def test_board_page_stays_self_contained():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()

    assert len(re.findall(r"<style(?:\s|>)", page)) == 1
    assert len(re.findall(r"<script(?:\s|>)", page)) == 1
    assert not re.search(r"<(?:script|img|iframe)[^>]+\bsrc\s*=", page,
                         re.IGNORECASE)
    assert not re.search(r"<link[^>]+\bhref\s*=", page, re.IGNORECASE)
    assert not re.search(r"@import\s+|url\(\s*['\"]?https?://", page,
                         re.IGNORECASE)


def test_bundled_example_passes_the_production_validators():
    from factory_lib import load_json
    from forge_cli.roadmap import (
        check_dag,
        check_epic_contract,
        check_epics,
        check_item,
        check_story_contract,
    )
    from forge_cli.specs import (
        missing_required_content,
        resolve_spec_reference,
        spec_records,
    )
    from record_signoff import workflow_input_problems

    example = HARNESS / "factory" / "board" / "example"
    roadmap = load_json(example / "plans" / "roadmap.json", default={})

    # These are the production gates used by record_signoff and roadmap
    # authoring. Tightening any capture contract must refuse this source too.
    assert workflow_input_problems(example) == []
    records = spec_records(example)
    assert len(records) == 1 and all(
        record["status"] == "confirmed"
        and missing_required_content(record["_path"].read_text()) == []
        for record in records
    )
    check_epics(roadmap["epics"])
    for epic in roadmap["epics"]:
        check_epic_contract(epic, example)
    known_epics = {epic["id"] for epic in roadmap["epics"]}
    for position, story in enumerate(roadmap["items"], 1):
        check_item(story, position)
        check_story_contract(story, known_epics)
        resolve_spec_reference(example, story["spec"], confirmed=True)
    check_dag(roadmap["items"])


def test_bundled_example_exercises_frontier_and_blocked():
    from forge_cli.board import aggregate_state

    example = HARNESS / "factory" / "board" / "example"
    state = aggregate_state(example)
    stories = {story["key"]: story for story in state["stories"]}

    assert len(state["frontier"]) >= 2
    assert all(stories[key]["ready_to_plan"] for key in state["frontier"])
    blocked = [story for story in stories.values() if story["state"] == "blocked"]
    assert blocked and all(story["blocked_by"] for story in blocked)
    assert all(dependency in stories for story in blocked
               for dependency in story["blocked_by"])
    assert len(state["epics"]) == 2
    assert all(epic["stories"] for epic in state["epics"])


def test_board_shows_task_grill_status():
    from forge_cli.board import story_detail

    example = HARNESS / "factory" / "board" / "example"
    detail = story_detail(example, "RETURN-1")
    assert detail is not None
    assert detail["tasks"][0]["proof"]["grill"]["verdict"] == "pass"

    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    dossier = page[page.index("function taskDossier(t)"):
                   page.index("function findingList(")]
    assert "proof.grill" in dossier
    assert "<b>Grill</b>" in dossier


def test_board_shows_done_story_pr_link():
    from forge_cli.board import aggregate_state, story_detail

    example = HARNESS / "factory" / "board" / "example"
    state = aggregate_state(example)
    story = next(item for item in state["stories"] if item["key"] == "RETURN-1")
    assert story["state"] == "shipped"
    assert story["pr_link"] == "https://github.com/example/workshop-dispatch/pull/12"
    assert story_detail(example, "RETURN-1")["story"]["pr_link"] == story["pr_link"]

    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    drawer_body = page[page.index("function drawerBody()"):
                       page.index("function tabBar()")]
    assert 's.state === "shipped"' in drawer_body
    assert "prReference(s)" in drawer_body


def test_board_content_survives_all_three_widths():
    from forge_cli.board import aggregate_state

    example = HARNESS / "factory" / "board" / "example"
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    stylesheet = re.search(r"<style>(.*?)</style>", page, re.DOTALL).group(1)
    breakpoints = sorted(
        {int(value) for value in re.findall(
            r"@media\s*\(max-width:\s*(\d+)px\)", stylesheet)},
        reverse=True,
    )
    assert len(breakpoints) == 2
    tablet_max, mobile_max = breakpoints

    widths = {"desktop": 1280, "tablet": 768, "mobile": 390}
    assert widths["desktop"] > tablet_max
    assert mobile_max < widths["tablet"] <= tablet_max
    assert widths["mobile"] <= mobile_max

    state = aggregate_state(example)
    assert state["frontier"]
    assert all(epic["stories"] for epic in state["epics"])
    assert any(story["blocked_by"] for story in state["stories"])
    for question in (
        "What is this project?",
        "What can start now?",
        "What does each epic deliver?",
        "Where does each story sit?",
    ):
        assert question in page
    assert '<section id="overview-view" role="tabpanel"' in page

    def matching_css(width: int) -> str:
        """Base rules plus max-width media rules active at this width."""
        chunks = []
        cursor = 0
        while True:
            start = stylesheet.find("@media", cursor)
            if start < 0:
                chunks.append(stylesheet[cursor:])
                return "".join(chunks)
            chunks.append(stylesheet[cursor:start])
            brace = stylesheet.find("{", start)
            depth = 1
            end = brace + 1
            while depth:
                depth += (stylesheet[end] == "{") - (stylesheet[end] == "}")
                end += 1
            condition = stylesheet[start:brace]
            maximum = re.search(r"max-width:\s*(\d+)px", condition)
            if maximum and width <= int(maximum.group(1)):
                chunks.append(stylesheet[brace + 1:end - 1])
            cursor = end

    content_selectors = {
        "main", ".wrap", "#overview-view", "#overview", ".overview",
        ".overview-question", ".overview-answer", ".project-sections",
        ".project-name", ".project-section", ".frontier-count",
        ".overview-list", ".overview-list li", ".overview-story",
        ".epic-deliveries", ".epic-delivery", ".epic-stories",
        ".story-position", ".dependency-facts",
    }
    clipping_properties = {
        "overflow", "overflow-x", "overflow-y", "clip", "clip-path",
    }
    zero_size_properties = {"height", "max-height", "block-size", "max-block-size"}

    for width in widths.values():
        declarations = []
        for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", matching_css(width)):
            if not content_selectors.intersection(
                    selector.strip() for selector in selectors.split(",")):
                continue
            declarations.extend(
                (name.strip(), value.strip().lower())
                for name, _, value in (
                    declaration.partition(":") for declaration in body.split(";"))
                if name.strip() and value.strip()
            )
        assert not any(
            (name == "display" and value == "none")
            or (name == "visibility" and value in {"hidden", "collapse"})
            or (name == "content-visibility" and value == "hidden")
            or (name in clipping_properties and value in {"hidden", "clip"})
            or (name in zero_size_properties and re.fullmatch(r"0(?:[a-z%]+)?", value))
            for name, value in declarations
        )

    # The page deliberately clips horizontal body overflow. These shrink rules
    # are what keep Overview content inside that boundary instead of merely
    # hiding an accidental overflow at narrower bands.
    compact = re.sub(r"\s+", " ", stylesheet)
    assert re.search(r"\.overview-answer\s*\{[^}]*min-width:\s*0", compact)
    assert re.search(
        r"\.overview-question\s*\{[^}]*grid-template-columns:[^;}]*minmax\(0,",
        compact,
    )
    mobile_css = matching_css(widths["mobile"])
    for selector in (".overview-question", ".project-sections", ".story-position"):
        assert re.search(
            rf"{re.escape(selector)}\s*\{{[^}}]*grid-template-columns:\s*1fr",
            mobile_css,
        )


def test_recorder_holds_the_task_narrative_contract(repo, tmp_path):
    """objective and acceptance_criteria were prompt convention, so a task
    could reach the board as an id and a title."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    bare = {**DECOMP, "tasks": [{"id": "T1", "title": "core slice"}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(bare))
    assert code != 0 and "objective" in out
    dumped = {**DECOMP, "tasks": [{**DECOMP["tasks"][0], "objective": "x " * 400}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(dumped))
    assert code != 0 and "max 500" in out, out
    no_ac = {**DECOMP, "tasks": [{**DECOMP["tasks"][0], "acceptance_criteria": []}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(no_ac))
    assert code != 0 and "acceptance_criteria" in out
    # and re-recording after a scope change keeps what is already built
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    assert code == 0, out
    run(repo, "forge.py", "stage", "start", "T1")
    launch_fake(repo, tmp_path, "T1")
    write_in_scope(repo, "src/core.py")  # stage done measures the diff
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    grown = {**DECOMP, "tasks": [DECOMP["tasks"][0],
                                 {"id": "T2", "title": "second", "objective": "more",
                                  "acceptance_criteria": ["works"]}]}
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(grown))
    stages = {s["id"]: s for s in
              json.loads((repo / ".factory" / "stages.json").read_text())["stages"]}
    assert stages["T1"]["status"] == "done" and stages["T1"].get("completed_at")
    assert stages["T2"]["status"] == "pending"


def test_board_renders_plan_tables_and_hides_author_comments(repo):
    """Every plan carries a Surface Impact TABLE — the one section that is a
    hard gate — and template comments addressed to the dev, not the reader."""
    page = (repo / "factory" / "board" / "index.html").read_text()
    # tables: header + divider, emitted as a real table inside a scroll wrapper
    assert "<thead>" in page and 'class="tablewrap"' in page
    assert ".tablewrap { overflow-x: auto" in page
    # comments are stripped BEFORE escaping — the other order makes them
    # visible text, which is the bug this guards
    strip = page.index("replace(/<!--[\\s\\S]*?-->/g")
    assert strip < page.index("split(/\\r?\\n/)")
    assert "esc(String(src ?? \"\").replace(/<!--" in page


def test_board_task_rows_carry_their_own_plan_spec_and_proof(repo, tmp_path):
    """A task row that shows only an id and a title cannot answer what the
    task was for or what proves it ran."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import plan_section, story_detail
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    detail = story_detail(repo, "ENG-1")
    task = detail["tasks"][0]
    assert task["objective"] and task["acceptance_criteria"]
    assert task["proof"]["required_tests"] == [] or "proof" in task
    assert task["proof"]["verify_ok"] is True
    # the excerpt is the task's OWN line, never the whole decomposition block
    body = ("## Task Decomposition\n\n"
            "1. **T1 — core slice**: build the first slice end to end.\n"
            "2. **T2 — second**: something else entirely.\n")
    assert plan_section(body, "T1") == "build the first slice end to end."
    assert "something else" not in plan_section(body, "T1")
    # a plan that merely restates the objective adds nothing and is dropped
    assert plan_section(body, "T9") == ""


def test_board_task_dossiers_survive_object_form_required_tests():
    """required_tests entries are {id, path, command} OBJECTS (the recorded
    decomposition schema), not bare strings. Coverage matched on the whole dict
    (`t in str(recorded)`), which raised TypeError and crashed the story drawer
    (HTTP 000) for EVERY done story, so their content never rendered. Coverage
    must key on the test id; a legacy bare-string entry still works."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import task_dossiers
    detail = {
        "plan_body": "",
        "spec": {"path": "docs/specs/x.md"},
        "evidence": {
            "decomposition": {"tasks": [{
                "id": "T1", "title": "slice", "objective": "build it",
                "acceptance_criteria": ["works"],
                "required_tests": [
                    {"id": "test_alpha", "path": "t.py", "command": "pytest {path}::{id}"},
                    {"id": "test_beta", "path": "t.py", "command": "pytest {path}::{id}"},
                    "test_legacy_string",
                ],
            }]},
            "stages": {"stages": [{"id": "T1", "status": "done"}]},
            "tests": {"automated": {
                "tests_added_or_updated": ["test_alpha runs green", "test_legacy_string"]}},
            "verify": {"ok": True},
            "reviews": {},
        },
    }
    dossiers = task_dossiers(detail)  # must not raise
    assert len(dossiers) == 1
    covered = dossiers[0]["proof"]["covered_tests"]
    covered_ids = {t["id"] if isinstance(t, dict) else t for t in covered}
    # matched by id — alpha and the legacy string are recorded; beta is not
    assert covered_ids == {"test_alpha", "test_legacy_string"}, covered_ids


def test_adhoc_capture_is_visible_debt_not_a_build_bypass(repo, tmp_path):
    """The client emails a new ask mid-sprint. It must be capturable — an
    ask that cannot be recorded gets built off the books — without becoming a
    way around decision 0014."""
    sign_off(repo)
    code, out = import_roadmap(repo, tmp_path)
    assert code == 0, out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-7", "Urgent export",
                    "--story", "As a finance lead, I export invoices to CSV.",
                    "--ac", "the export downloads", "--epic", "billing",
                    "--skill", "backend", "--no-spec",
                    "--reason", "client asked mid-sprint, spec to follow")
    assert code == 0, out
    item = roadmap_items(repo)["ENG-7"]
    assert item["origin"] == "adhoc" and "spec" not in item
    intake(repo, "ENG-7", "Urgent export")
    # building it is refused while the debt stands, and the refusal says how
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "link-spec" in out and "0014" in out, out
    spec = tmp_path / "export.md"
    spec.write_text(
        "# Export\n\n"
        "## Why\n\nFinance leads need invoice data outside the app.\n\n"
        "## Behaviour\n\nFinance leads can export invoices to CSV.\n\n"
        "## Acceptance criteria\n\n- The export downloads.\n"
    )
    run(repo, "forge.py", "spec", "save", "export", "--from", str(spec))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "docs: export spec draft")
    record_grill(repo, "spec", digest_of=repo / "docs" / "specs" / "export.md")
    code, out = run(repo, "forge.py", "spec", "confirm", "export")
    assert code == 0, out
    code, out = run(repo, "forge.py", "roadmap", "link-spec", "ENG-7",
                    "--spec", "docs/specs/export.md")
    assert code == 0 and "debt cleared" in out, out
    assert "spec_debt_reason" not in roadmap_items(repo)["ENG-7"]
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out


def test_event_ledger_merges_instead_of_conflicting(repo):
    """Two stories shipping from parallel worktrees both append here. Without
    the union driver the timeline is exactly the file that conflicts."""
    attrs = (repo / ".gitattributes").read_text()
    # built-in union: a custom driver is registered per clone by a hook that
    # may not have run, and this file must never conflict
    assert ".factory/*.jsonl merge=union" in attrs
    ledger = repo / ".factory" / "events.jsonl"
    ledger.parent.mkdir(exist_ok=True)
    ledger.write_text('{"event": "intake", "generated_by": "orchestrator"}\n')
    git(repo, "add", "-f", ".factory/events.jsonl", ".gitattributes")
    git(repo, "commit", "-q", "-m", "base ledger")
    base = head(repo)
    git(repo, "checkout", "-q", "-b", "story-a")
    ledger.write_text(ledger.read_text() + '{"event": "stage-done", "story": "A"}\n')
    git(repo, "add", "-f", ".factory/events.jsonl")
    git(repo, "commit", "-q", "-m", "story A")
    git(repo, "checkout", "-q", base)
    git(repo, "checkout", "-q", "-b", "story-b")
    ledger.write_text('{"event": "intake", "generated_by": "orchestrator"}\n'
                      '{"event": "stage-done", "story": "B"}\n')
    git(repo, "add", "-f", ".factory/events.jsonl")
    git(repo, "commit", "-q", "-m", "story B")
    git(repo, "merge", "--no-edit", "story-a")  # asserts a clean merge
    merged = ledger.read_text()
    assert '"story": "A"' in merged and '"story": "B"' in merged, merged
    assert "<<<<<<<" not in merged

    # …and a union-merged file cannot also be PRUNED: whatever one branch
    # removes, a parallel branch that still holds those lines restores on
    # merge. That is why ship copies a story's timeline into its archive
    # rather than moving it out of the live ledger.
    shared = head(repo)                      # both branches below have A and B
    git(repo, "checkout", "-q", "-b", "pruner")
    ledger.write_text('{"event": "intake", "generated_by": "orchestrator"}\n')
    git(repo, "add", "-f", ".factory/events.jsonl")
    git(repo, "commit", "-q", "-m", "prune the shipped story's lines")
    assert '"story": "A"' not in ledger.read_text()
    git(repo, "checkout", "-q", shared)
    git(repo, "checkout", "-q", "-b", "keeper")
    ledger.write_text(ledger.read_text() + '{"event": "stage-done", "story": "C"}\n')
    git(repo, "add", "-f", ".factory/events.jsonl")
    git(repo, "commit", "-q", "-m", "story C appends")
    git(repo, "checkout", "-q", "pruner")
    git(repo, "merge", "--no-edit", "keeper")
    assert '"story": "A"' in ledger.read_text(), (
        "the pruned lines did NOT come back — if this ever fails, pruning has "
        "become safe and pr_ready could move rather than copy the timeline")


def test_forge_history_filters_by_story_type_and_date(repo):
    ledger = repo / ".factory" / "events.jsonl"
    ledger.parent.mkdir(exist_ok=True)
    events = [
        {"event": "intake", "at": "2026-07-01T09:00:00+00:00",
         "story": "ENG-1", "detail": "first"},
        {"event": "future-emitter-event", "at": "2026-07-02T10:00:00+00:00",
         "story": "ENG-1", "detail": "second"},
        {"event": "future-emitter-event", "at": "2026-07-03T11:00:00+00:00",
         "story": "ENG-2", "detail": "third"},
        {"event": "stage-done", "at": "2026-07-04T12:00:00+00:00",
         "detail": "unattributed"},
        {"event": "legacy-event", "story": "ENG-1", "detail": "undated"},
    ]
    ledger.write_text("".join(json.dumps(event) + "\n" for event in events))

    code, out = run(repo, "forge.py", "history", "--story", "ENG-1")
    assert code == 0, out
    assert "first" in out and "second" in out and "undated" in out
    assert "third" not in out and "unattributed" not in out

    code, out = run(repo, "forge.py", "history", "--event", "future-emitter-event")
    assert code == 0, out
    assert "second" in out and "third" in out
    assert "first" not in out and "unattributed" not in out

    code, out = run(repo, "forge.py", "history", "--since", "2026-07-03")
    assert code == 0, out
    assert "third" in out and "unattributed" in out
    assert "first" not in out and "second" not in out

    code, out = run(repo, "forge.py", "history", "--until", "2026-07-02")
    assert code == 0, out
    assert "first" in out and "second" in out
    assert "third" not in out and "unattributed" not in out and "undated" not in out

    code, out = run(
        repo, "forge.py", "history", "--story", "ENG-1",
        "--event", "future-emitter-event", "--since", "2026-07-02",
        "--until", "2026-07-02",
    )
    assert code == 0, out
    assert "second" in out
    assert "first" not in out and "third" not in out


def test_forge_history_names_unattributed_events(repo):
    ledger = repo / ".factory" / "events.jsonl"
    ledger.parent.mkdir(exist_ok=True)
    events = [
        {"event": "intake", "at": "2026-07-01T09:00:00+00:00",
         "story": "ENG-1", "detail": "attributed"},
        {"event": "spec-confirmed", "at": "2026-07-01T10:00:00+00:00",
         "detail": "missing story"},
    ]
    ledger.write_text("".join(json.dumps(event) + "\n" for event in events))

    code, out = run(repo, "forge.py", "history")
    assert code == 0, out
    assert "Story: ENG-1" in out and "attributed" in out
    assert "Unattributed events (no story)" in out and "missing story" in out


def test_forge_history_is_read_only(repo):
    ledger = repo / ".factory" / "events.jsonl"
    ledger.parent.mkdir(exist_ok=True)
    ledger.write_text(
        '{"event": "intake", "at": "2026-07-01T09:00:00+00:00", '
        '"story": "ENG-1"}\n'
    )

    def factory_snapshot():
        return {
            path.relative_to(repo): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in (repo / ".factory").rglob("*") if path.is_file()
        }

    before = factory_snapshot()
    code, out = run(repo, "forge.py", "history")
    assert code == 0, out
    assert factory_snapshot() == before


def test_pr_link_event_survives_a_clone_with_no_remote(repo, tmp_path):
    before = (repo / ".factory" / "run.json").read_bytes()
    reference = "https://github.com/acme/widgets/pull/42"
    code, out = run(repo, "forge.py", "pr-link", "ENG-1", reference)
    assert code == 0, out
    assert (repo / ".factory" / "run.json").read_bytes() == before
    linked = json.loads(
        (repo / ".factory" / "events.jsonl").read_text().splitlines()[-1])
    assert linked["event"] == "pr-linked"
    assert linked["story"] == "ENG-1"
    assert linked["detail"] == reference

    git(repo, "add", "-f", ".factory/events.jsonl")
    git(repo, "commit", "-q", "-m", "link shipped PR")
    clone = tmp_path / "clone"
    git(repo.parent, "clone", "-q", str(repo), str(clone))
    git(clone, "remote", "remove", "origin")
    assert git(clone, "remote") == ""

    code, out = run(clone, "forge.py", "history", "--story", "ENG-1")
    assert code == 0, out
    assert "pr-linked" in out and reference in out


def test_forge_history_shows_the_pr_link(repo):
    reference = "acme/widgets#42"
    code, out = run(repo, "forge.py", "pr-link", "ENG-1", reference)
    assert code == 0, out

    code, out = run(repo, "forge.py", "history", "--story", "ENG-1")
    assert code == 0, out
    assert "Story: ENG-1" in out
    assert "pr-linked" in out and reference in out


def test_decisions_name_the_stories_they_govern(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    run(repo, "forge.py", "decision", "new", "queue-choice", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-queue-choice.md"))
    assert "stories: [ENG-1]" in record.read_text()
    # one decision commonly governs several stories — the link is a list
    code, out = run(repo, "forge.py", "decision", "link", "queue-choice",
                    "--story", "ENG-2")
    assert code == 0 and "ENG-1, ENG-2" in out
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.decisions import decision_records
    governed = next(r for r in decision_records(repo) if "queue-choice" in r["id"])
    assert governed["stories"] == ["ENG-1", "ENG-2"]
    assert governed["title"]  # the board renders this; it was empty before
    # A record that predates the field is NOT a violation — failing an existing
    # corpus for a field it could not have had is how a gate gets ignored.
    legacy = repo / "docs" / "decisions" / "0099-predates-the-field.md"
    legacy.write_text('---\nstatus: proposed\nconfirmed_by: ""\n'
                      "date: 2026-07-27\n---\n\n# Predates the field\n")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert "stories" not in out, out
    # A malformed one IS: that record is lying about what it governs.
    legacy.write_text('---\nstatus: proposed\nconfirmed_by: ""\n'
                      "date: 2026-07-27\nstories: ENG-1\n---\n\n# Malformed\n")
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code != 0 and "stories" in out and "flow list" in out


# ------------------------------------------------------- signal event channel

def test_signal_events_block_ship_until_resolved(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    # guardrails on the raise itself
    code, out = run(repo, "forge.py", "signal", "raise", "--kind", "vibes",
                    "--by", "implementer", "-m", "x")
    assert code != 0 and "kind" in out
    code, out = run(repo, "forge.py", "signal", "raise", "--kind", "confusion",
                    "--by", "ponytail", "-m", "x")
    assert code != 0 and "not pinned" in out
    # worker raises a contradiction mid-implementation and pauses
    code, out = run(repo, "forge.py", "signal", "raise", "--kind", "contradiction",
                    "--by", "implementer", "-m",
                    "plan says soft-delete; decision 0001 says hard-delete")
    assert code == 0 and "S-0001" in out and "PAUSE" in out
    import re as _re
    sig_id = _re.search(r"S-0001-[0-9a-f]{4}", out).group(0)
    # the orchestrator sees it everywhere, and the ship gate refuses
    code, out = run(repo, "forge.py", "next")
    assert "OPEN worker signal" in out and "S-0001" in out
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "S-0001" in out
    # resolution needs substance, then unblocks
    code, out = run(repo, "forge.py", "signal", "resolve", sig_id, "--notes", " ")
    assert code != 0 and "notes" in out
    code, out = run(repo, "forge.py", "signal", "resolve", sig_id,
                    "--notes", "decision 0001 wins: hard-delete; plan revised")
    assert code == 0 and "resume" in out
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    # channel archived with the task, working copy cleaned
    assert (repo / ".factory" / "history" / "ENG-1" / "signals.jsonl").exists()
    assert not (repo / ".factory" / "signals.jsonl").exists()


def test_open_quickfix_blocks_ship_until_closed(repo, tmp_path):
    """An open window is the lock still disarmed — and an unwritten ledger row."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")

    code, out = run(repo, "forge.py", "quickfix", "start", "tweak the copy")
    assert code == 0
    quickfix_id = re.search(r"Q-\d{4}-[0-9a-f]{4}", out).group(0)

    code, out = run(repo, "pr_ready.py")
    assert code != 0 and quickfix_id in out and "quickfix done" in out

    code, _ = run(repo, "forge.py", "quickfix", "done")
    assert code == 0
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_quickfix_ids_survive_concurrent_worktrees(repo):
    """Same-sequence windows from parallel worktrees must not share an id."""
    _, first = run(repo, "forge.py", "quickfix", "start", "fix a")
    run(repo, "forge.py", "quickfix", "done")
    # a second worktree that has not seen the first ledger row computes the
    # same sequence number; the suffix is what keeps the ids distinct
    for record in (repo / "plans" / "quickfixes").glob("*.json"):
        record.unlink()
    _, second = run(repo, "forge.py", "quickfix", "start", "fix b")
    first_id = re.search(r"Q-0001-[0-9a-f]{4}", first).group(0)
    second_id = re.search(r"Q-0001-[0-9a-f]{4}", second).group(0)
    assert first_id != second_id


def test_codex_exec_ban_matches_invocations_not_prose(repo):
    def bash(cmd):
        return hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                           "tool_input": {"command": cmd}})
    # invocations: denied in every position
    for cmd in ('codex exec "build it"',
                'FACTORY_DEGRADED=1 codex exec -s read-only "x"',
                'cd /tmp && codex exec "x"',
                'echo hi | codex exec "x"',
                'OUT=$(codex exec "x")'):
        code, out = bash(cmd)
        assert "deny" in out, cmd
    # prose mentioning the phrase (heredocs, greps, docs): allowed
    for cmd in ('cat > docs/notes.md << EOF\nthe hook denies raw codex exec always\nEOF',
                'grep -rn "codex exec" docs/ || true'):
        code, out = bash(cmd)
        assert "deny" not in out, cmd


# --------------------------------------------------- review-hardening guards

def test_review_hardening_guards(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    # empty task graph refused; malformed task refused
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": []}))
    assert code != 0 and "at least one leaf task" in out
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [{"id": 7}]}))
    assert code != 0 and "string 'id'" in out
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    # out-of-scale review score refused at record time
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "autoreview", "score": 999,
                                      "summary": "x", "blocking_findings": [],
                                      "skills_used": ["review-animations"]}))
    assert code != 0 and "0..10" in out
    # non-object payload refused, not crashed
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps([1, 2, 3]))
    assert code != 0 and "JSON object" in out and "Traceback" not in out
    # planning-lock path traversal + flags-between invocation bypass
    intake(repo, "ENG-2", "Refunds", "--discard-active")
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path":
                                           str(repo / "plans" / ".." / "src" / "x.ts")}})
    assert "deny" in out and "PLAN MODE" in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "codex --profile explore exec 'x'"}})
    assert "deny" in out and "codex:rescue" in out


def test_roadmap_dependency_and_lifecycle_guards(repo, tmp_path):
    import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer", "epics": [ROADMAP_EPIC], "items": [
            authored_story("G-1", "API"),
            authored_story("G-2", "UI", depends_on=["G-1"]),
        ]})
    # cycles refused at import
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        authored_story("C-1", "a", depends_on=["C-2"]),
        authored_story("C-2", "b", depends_on=["C-1"]),
    ]})
    assert code != 0 and "cycle" in out
    # intake ENFORCES depends_on, not just displays it
    code, out = intake(repo, "G-2", "UI")
    assert code != 0 and "BLOCKED" in out and "G-1" in out
    # a done story is not silently reopened by re-intake
    code, out = intake(repo, "G-1", "API")
    assert code == 0
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    run(repo, "pr_ready.py")
    code, out = intake(repo, "G-1", "API")
    assert code == 0 and "already done" in out
    assert roadmap_items(repo)["G-1"]["status"] == "done"
    # ...and shipping G-1 unblocked G-2
    code, out = intake(repo, "G-2", "UI")
    assert code == 0


def test_promoted_assumption_requires_decision_record(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "forge.py", "plan", "assume", "cache TTL is 60s")
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "promoted", "--notes", "durable choice")
    assert code != 0 and "--decision" in out
    run(repo, "forge.py", "decision", "new", "cache-ttl", "--repo", str(repo))
    code, out = run(repo, "forge.py", "assumptions", "resolve", "A-0001",
                    "--status", "promoted", "--notes", "durable choice",
                    "--decision", "cache-ttl")
    assert code == 0 and "cache-ttl" in out


# ------------------------------------------- self-sustainability loops (0005-0007)

def review_payload(**over):
    return {"generated_by": "autoreview", "score": 9, "summary": "ok",
            "blocking_findings": [], "skills_used": ["review-animations"], **over}


def test_structured_findings_recorded_and_malformed_refused(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    # a structured finding missing its category is refused, not stringified
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload(
                        blocking_findings=[{"summary": "no category"}])))
    assert code != 0 and "category" in out
    # a well-formed structured finding survives as an object
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload(non_blocking_findings=[
                        {"category": "validation-gap", "area": "api",
                         "summary": "missing bounds check"}])))
    assert code == 0, out
    recorded = json.loads((repo / ".factory" / "reviews" / "quality.json").read_text())
    assert recorded["non_blocking_findings"][0]["category"] == "validation-gap"


def test_recurring_finding_class_surfaces_everywhere(repo, tmp_path):
    # two shipped tasks + the active one all hit the same class -> RECURRING
    for issue in ("ENG-7", "ENG-8"):
        d = repo / ".factory" / "history" / issue / "reviews"
        d.mkdir(parents=True)
        (d / "quality.json").write_text(json.dumps({"blocking_findings": [
            {"category": "validation-gap", "area": "api", "summary": "s"}]}))
    (repo / ".factory" / "reviews").mkdir(exist_ok=True)
    (repo / ".factory" / "reviews" / "quality.json").write_text(json.dumps(
        {"blocking_findings": [{"category": "validation-gap", "area": "api",
                                "summary": "again"}]}))
    code, out = run(repo, "forge.py", "findings", "patterns")
    assert code == 0 and "RECURRING x3" in out and "design signal" in out
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "RECURRING" in out
    # distinct classes below the threshold stay a healthy tail
    (repo / ".factory" / "reviews" / "quality.json").unlink()
    code, out = run(repo, "forge.py", "findings", "patterns")
    assert "RECURRING" not in out and "watch" in out


def test_lesson_ledger_validation_dedup_and_relevance(repo):
    add = ["forge.py", "lesson", "add", "--topic", "orm-n-plus-one",
           "--lesson", "Batch child fetches in list endpoints",
           "--source", "abc1234", "--applies-to", "src/api/**",
           "--severity", "high", "--by", "implementer"]
    code, out = run(repo, *add)
    assert code == 0, out
    # dedup on lesson text
    code, out = run(repo, *add)
    assert code != 0 and "already ledgered" in out
    # unpinned generator refused by the schema
    code, out = run(repo, "forge.py", "lesson", "add", "--topic", "t",
                    "--lesson", "x", "--source", "s", "--applies-to", "src/**",
                    "--severity", "low", "--by", "ponytail")
    assert code != 0 and "not pinned" in out
    # bad severity refused
    code, out = run(repo, "forge.py", "lesson", "add", "--topic", "t",
                    "--lesson", "y", "--source", "s", "--applies-to", "src/**",
                    "--severity", "urgent", "--by", "human")
    assert code != 0 and "severity" in out
    # relevance is glob-scoped
    code, out = run(repo, "forge.py", "lesson", "relevant",
                    "--files", "src/api/users.ts")
    assert code == 0 and "orm-n-plus-one" in out
    code, out = run(repo, "forge.py", "lesson", "relevant", "--files", "docs/x.md")
    assert code == 0 and "orm-n-plus-one" not in out
    # a merge-artifact line fails loudly instead of dropping knowledge
    # A legacy .jsonl is still read (decision 0022 migrates nothing), and a
    # malformed line in one must still fail loudly rather than drop knowledge.
    path = repo / "plans" / "lessons.jsonl"
    path.write_text("<<<<<<< HEAD\n")
    code, out = run(repo, "forge.py", "lesson", "list")
    assert code != 0 and "merge artifact" in out


def test_stage_loop_orders_execution_and_gates_pr_ready(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    decomp = {**DECOMP, "tasks": [
        {"id": "T1", "title": "api", "write_scope": ["src/api/"],
         "objective": "Serve invoices over the api.", "acceptance_criteria": ["200 ok"]},
        {"id": "T2", "title": "ui", "write_scope": ["src/ui/"],
         "objective": "Render the invoice list.", "acceptance_criteria": ["rows show"]},
    ]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(decomp))
    assert code == 0 and "stages.json" in out
    # Order is strict inside one story worktree.
    code, out = run(repo, "forge.py", "stage", "start", "T2")
    assert code != 0 and "T1" in out
    code, out = run(repo, "forge.py", "stage", "start", "T2", "--parallel")
    assert code != 0 and "task stages are sequential" in out
    # done requires the stage to have actually started
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "not active" in out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    launch_fake(repo, tmp_path, "T1")
    write_in_scope(repo, "src/api/invoices.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    # pr_ready refuses while a stage is open
    stages_before_artifacts = json.loads(
        (repo / ".factory" / "stages.json").read_text())
    write_passing_artifacts(repo)
    # write_passing_artifacts stamps the single-task DECOMP; T2's contract has
    # to survive, or stage done has nothing to measure it against
    (repo / ".factory" / "decomposition.json").write_text(
        json.dumps({**decomp, "commit": head(repo)}))
    (repo / ".factory" / "stages.json").write_text(json.dumps(stages_before_artifacts))
    (delegation_ledger(repo).parent / "stages.json").write_text(
        json.dumps(stages_before_artifacts))
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "stage completion" in out and "T2" in out
    # The next task starts only after its predecessor is done.
    code, out = run(repo, "forge.py", "stage", "start", "T2")
    assert code == 0, out
    launch_fake(repo, tmp_path, "T2")
    write_in_scope(repo, "src/ui/list.py")
    code, out = run(repo, "forge.py", "stage", "done", "T2")
    assert code == 0, out
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    assert not (repo / ".factory" / "stages.json").exists()
    assert (repo / ".factory" / "history" / "ENG-1" / "stages.json").exists()


def fake_companion_home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    script = home / ".claude/plugins/cache/openai-codex/codex/1.0.0/scripts/codex-companion.mjs"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        "process.stdout.write(JSON.stringify({ok:true, argv:process.argv.slice(2)}));\n"
    )
    metadata = home / ".claude/plugins/installed_plugins.json"
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text(json.dumps({
        "version": 2,
        "plugins": {
            "codex@openai-codex": [{
                "scope": "user",
                "installPath": str(script.parents[1]),
                "version": "1.0.0",
            }],
        },
    }))
    return home


def fake_companion_env(tmp_path: Path) -> dict[str, str]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    fake_ps = fake_bin / "ps"
    fake_ps.write_text(
        "#!/bin/sh\n"
        "if [ \"$2\" = \"lstart=\" ]; then\n"
        "  echo 'Thu Aug 7 00:00:00 2026'\n"
        "fi\n"
    )
    fake_ps.chmod(0o755)
    return {
        "HOME": str(fake_companion_home(tmp_path)),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }


def launch_fake(repo: Path, tmp_path: Path, stage_id: str) -> None:
    # The write delegation gate (decision 0032) refuses without a fresh per-task
    # grill; record one bound to the recorded contract before launching.
    from factory_lib import load_json, protected_decomposition_state_path
    decomp = load_json(protected_decomposition_state_path(repo), default={})
    task = next(t for t in decomp.get("tasks", []) if t.get("id") == stage_id)
    record_task_grill(repo, task)
    code, out = run(repo, "forge.py", "delegate", stage_id,
                    env=fake_companion_env(tmp_path))
    assert code == 0, out


def delegation_ledger(repo: Path) -> Path:
    git_dir = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return Path(git_dir) / "forge" / "delegations.jsonl"


def delegation_lock(repo: Path, task_id: str) -> Path:
    return delegation_ledger(repo).parent / "locks" / "task" / f"{task_id}.lock"


def start_stage(repo: Path, tmp_path: Path, task: dict, stage_id: str = "T1",
                *, launch: bool = True) -> None:
    """Signed off, planned, decomposed, and the stage started — the state every
    stage-done measurement test needs before it can measure anything."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code == 0, out
    code, out = record_task_grill(repo, task)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", stage_id)
    assert code == 0, out
    if launch:
        launch_fake(repo, tmp_path, stage_id)


def write_in_scope(repo: Path, rel: str, text: str = "print('work')\n") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


STAGE_TASK = {"id": "T1", "title": "core slice", "write_scope": ["src/"],
              "objective": "Build the core slice so the feature works end to end.",
              "acceptance_criteria": ["the slice runs green"]}


def test_stage_done_refuses_empty_diff(repo, tmp_path):
    """The silent-stall signature: a delegation that wrote nothing. Workflow
    paths churn on every forge command, so they must not count as work."""
    start_stage(repo, tmp_path, STAGE_TASK)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "EMPTY diff" in out
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_refuses_out_of_scope_change(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, "billing/ledger.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "write_scope" in out and "billing/ledger.py" in out


def test_stage_done_sees_deleted_initial_untracked_path(repo, tmp_path):
    outside = repo / "outside.tmp"
    outside.write_text("keep me\n")
    start_stage(repo, tmp_path, STAGE_TASK)
    outside.unlink()
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "outside.tmp" in out and "write_scope" in out


def test_stage_done_sees_initial_untracked_path_staged_without_byte_change(
        repo, tmp_path):
    outside = repo / "outside.tmp"
    outside.write_text("same bytes\n")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "add", "outside.tmp")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "outside.tmp" in out and "write_scope" in out


def test_stage_done_does_not_credit_unchanged_initial_dirt(repo, tmp_path):
    write_in_scope(repo, "src/preexisting.py", "same bytes\n")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "add", "src/preexisting.py")
    git(repo, "commit", "-qm", "commit pre-stage dirt unchanged")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "EMPTY diff" in out


def test_stage_done_does_not_credit_replacement_directory_chmod(
        repo, tmp_path):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    git(repo, "add", "src/pkg/module.py")
    start_stage(repo, tmp_path, STAGE_TASK)
    os.chmod(repo / "src/pkg", 0o700)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "EMPTY diff" in out


def test_stage_done_refuses_split_index_and_worktree_content(repo, tmp_path):
    write_in_scope(repo, "src/core.py", "old\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "tracked core")
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py", "staged but untested\n")
    git(repo, "add", "src/core.py")
    write_in_scope(repo, "src/core.py", "old\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_stage_done_refuses_staged_delete_recreated_as_untracked(repo, tmp_path):
    write_in_scope(repo, "src/core.py", "tracked\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "track core")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "rm", "src/core.py")
    write_in_scope(repo, "src/core.py", "recreated but untracked\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_stage_done_refuses_ignored_recreation_of_staged_delete(repo, tmp_path):
    write_in_scope(repo, "src/core.py", "tracked\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "track core")
    (repo / ".gitignore").write_text("src/core.py\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "ignore generated core")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "rm", "src/core.py")
    write_in_scope(repo, "src/core.py", "ignored recreation\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_stage_done_refuses_ignored_recreation_of_rename_source(
        repo, tmp_path):
    write_in_scope(repo, "src/source.py", "tracked\n")
    git(repo, "add", "src/source.py")
    git(repo, "commit", "-qm", "track source")
    (repo / ".gitignore").write_text("src/source.py\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "ignore generated source")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "mv", "src/source.py", "src/renamed.py")
    write_in_scope(repo, "src/source.py", "ignored recreation\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_split_index_allows_case_only_rename(repo):
    write_in_scope(repo, "src/lower.py", "tracked\n")
    git(repo, "add", "src/lower.py")
    git(repo, "commit", "-qm", "track lowercase path")
    git(repo, "mv", "src/lower.py", "src/Lower.py")
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import split_index_paths
        split = split_index_paths(repo)
    finally:
        sys.path.pop(0)
    assert split == []


def test_stage_done_allows_staged_file_to_directory_replacement(repo, tmp_path):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    git(repo, "add", "src/pkg/module.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_refuses_ignored_extra_in_file_to_directory_replacement(
        repo, tmp_path):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    (repo / ".gitignore").write_text("src/pkg/generated.py\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "ignore generated package file")
    start_stage(repo, tmp_path, STAGE_TASK)
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    write_in_scope(repo, "src/pkg/generated.py", "ignored extra\n")
    git(repo, "add", "src/pkg/module.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_split_index_fails_closed_when_replacement_walk_errors(
        repo, monkeypatch):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    git(repo, "add", "src/pkg/module.py")
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.stages as stages

        def unreadable_walk(_root, *, followlinks, onerror):
            assert followlinks is False
            onerror(PermissionError("unreadable subtree"))
            return iter(())

        monkeypatch.setattr(stages.os, "walk", unreadable_walk)
        split = stages.split_index_paths(repo)
    finally:
        sys.path.pop(0)
    assert split == ["src/pkg"]


def test_split_index_refuses_extra_empty_replacement_directory(repo):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    (repo / "src" / "pkg" / "empty-cache").mkdir()
    git(repo, "add", "src/pkg/module.py")
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import split_index_paths
        split = split_index_paths(repo)
    finally:
        sys.path.pop(0)
    assert split == ["src/pkg"]


def test_stage_done_rechecks_replacement_directory_after_proof(
        repo, tmp_path):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    (repo / ".gitignore").write_text("src/pkg/generated.py\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "ignore generated package file")
    command = (
        "python3 -c \"from pathlib import Path; "
        "Path('src/pkg/generated.py').write_text('ignored proof output')\""
    )
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    git(repo, "rm", "src/pkg")
    write_in_scope(repo, "src/pkg/module.py", "replacement module\n")
    git(repo, "add", "src/pkg/module.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "staged content that differs from the tested worktree" in out


def test_split_index_treats_checked_out_gitlink_as_directory_leaf(repo):
    write_in_scope(repo, "src/pkg", "old file\n")
    git(repo, "add", "src/pkg")
    git(repo, "commit", "-qm", "track package file")
    git(repo, "rm", "src/pkg")
    git(
        repo, "update-index", "--add", "--cacheinfo",
        "160000", head(repo), "src/pkg/sub",
    )
    checkout = repo / "src" / "pkg" / "sub"
    checkout.mkdir(parents=True)
    (checkout / ".git").write_text("gitdir: elsewhere\n")
    (checkout / "checked-out.txt").write_text("submodule content\n")
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import split_index_paths
        split = split_index_paths(repo)
    finally:
        sys.path.pop(0)
    assert split == []


def test_stage_measurement_refuses_an_unreadable_dirty_path(
        repo, monkeypatch, capsys):
    write_in_scope(repo, "src/unreadable.py")
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.stages as stages
        original = stages._digest
        monkeypatch.setattr(
            stages, "_digest",
            lambda base, rel, gitlinks=None: None
            if rel == "src/unreadable.py"
            else original(base, rel, gitlinks),
        )
        with pytest.raises(SystemExit):
            stages.dirty_digests(repo)
        assert "unreadable content" in capsys.readouterr().out
    finally:
        sys.path.pop(0)


def test_stage_done_snapshots_checked_out_gitlinks(repo, tmp_path):
    dependency = tmp_path / "dependency"
    dependency.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=dependency, check=True)
    (dependency / "dep.txt").write_text("dependency\n")
    subprocess.run(["git", *GIT_ID, "add", "dep.txt"],
                   cwd=dependency, check=True)
    subprocess.run(["git", *GIT_ID, "commit", "-qm", "dependency"],
                   cwd=dependency, check=True)
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q",
        str(dependency), "vendor/dependency")
    git(repo, "commit", "-qam", "add dependency gitlink")
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_measures_a_changed_gitlink(repo, tmp_path):
    dependency = tmp_path / "dependency"
    dependency.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=dependency, check=True)
    (dependency / "dep.txt").write_text("dependency\n")
    subprocess.run(["git", *GIT_ID, "add", "dep.txt"],
                   cwd=dependency, check=True)
    subprocess.run(["git", *GIT_ID, "commit", "-qm", "dependency"],
                   cwd=dependency, check=True)
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q",
        str(dependency), "vendor/dependency")
    git(repo, "commit", "-qam", "add dependency gitlink")
    start_stage(repo, tmp_path, STAGE_TASK)
    checkout = repo / "vendor" / "dependency"
    (checkout / "dep.txt").write_text("advanced\n")
    subprocess.run(["git", *GIT_ID, "add", "dep.txt"],
                   cwd=checkout, check=True)
    subprocess.run(["git", *GIT_ID, "commit", "-qm", "advance dependency"],
                   cwd=checkout, check=True)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0
    assert "vendor/dependency" in out and "write_scope" in out
    assert "unreadable" not in out


def test_gitlink_index_parser_preserves_unusual_path_characters(repo):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import _gitlink_entries
        rel = "vendor/ leading\tand\ntrailing "
        parsed = _gitlink_entries(f"160000 {'a' * 40} 0\t{rel}\0")
    finally:
        sys.path.pop(0)
    assert parsed == {rel: f"160000 {'a' * 40} 0"}


def test_product_snapshot_reads_gitlink_index_once(repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.stages as stages
        original = stages._git
        calls = []

        def counted(base, *args):
            calls.append(args)
            return original(base, *args)

        monkeypatch.setattr(stages, "_git", counted)
        stages.product_tree_snapshot(repo)
    finally:
        sys.path.pop(0)
    assert sum(
        args[:3] == ("ls-files", "--stage", "-z") for args in calls
    ) == 1
    assert not any(
        args[:2] == ("ls-files", "--stage") and "-z" not in args
        for args in calls
    )


def test_stage_done_checks_both_sides_of_a_committed_rename(repo, tmp_path):
    write_in_scope(repo, "outside.py")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "tracked outside file")
    start_stage(repo, tmp_path, STAGE_TASK)
    (repo / "src").mkdir(exist_ok=True)
    git(repo, "mv", "outside.py", "src/outside.py")
    git(repo, "commit", "-qam", "move into declared scope")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "outside.py" in out and "write_scope" in out


def test_stage_done_refuses_missing_required_test(repo, tmp_path):
    name = "test_core" + "_slice_runs_green"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": name, "path": path,
        "command": "python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and name in out
    write_in_scope(repo, "src/test_core.py", f"def {name}():\n    pass\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_requires_exact_junit_testcase_identity(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest {path} -q -k {id} "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, path, "def test_slice_extra():\n    pass\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "not present in the fresh JUnit report" in out


def test_stage_done_runs_environment_prefixed_required_test(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "PYTHONPATH=src python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, path, "def test_slice():\n    pass\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out


def test_stage_done_binds_required_test_to_declared_path(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest src/test_other.py --ignore={path} "
                   "-q -k {id} -o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, path, "def test_not_selected():\n    pass\n")
    write_in_scope(repo, "src/test_other.py", "def test_slice():\n    pass\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "not attributed" in out and path in out


def test_stage_done_refuses_required_test_product_mutation(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(
        repo,
        path,
        "from pathlib import Path\n\n"
        "def test_slice():\n"
        "    Path('src/generated.py').write_text('changed = True\\n')\n",
    )
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "proof commands changed the product tree" in out


def test_stage_done_refuses_proof_mutation_of_protected_authority(
        repo, tmp_path):
    command = (
        "python3 -c \"from pathlib import Path; "
        "p=Path('.git/forge/stages.json'); p.write_text('{}')\""
    )
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "changed protected Forge authority" in out


def test_stage_done_detects_required_test_mode_mutation(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(
        repo, path,
        "import os\n\n"
        "def test_slice():\n"
        "    os.chmod('src/core.py', 0o755)\n",
    )
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "proof commands changed the product tree" in out


def test_stage_done_detects_required_test_index_flag_mutation(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    write_in_scope(
        repo, path,
        "import subprocess\n\n"
        "def test_slice():\n"
        "    subprocess.run(['git', 'update-index', '--assume-unchanged', "
        "'src/core.py'], check=True)\n",
    )
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "proof commands changed the product tree" in out


def test_stage_done_reaps_required_test_descendants(repo, tmp_path):
    test_id = "test_slice"
    path = "src/test_core.py"
    task = {**STAGE_TASK, "required_tests": [{
        "id": test_id, "path": path,
        "command": "python3 -m pytest {path}::{id} -q "
                   "-o junit_family=legacy --junitxml={report}",
    }]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    write_in_scope(
        repo, path,
        "import subprocess, sys\n\n"
        "def test_slice():\n"
        "    subprocess.Popen([sys.executable, '-c', "
        # 5s, not 0.5s. Reaping has to win this race, and a 0.2s margin makes
        # the test a coin flip under CI load: it failed inside a loaded
        # 25-minute suite run and passed three times standalone. The wider
        # delay tests the same thing — the descendant is killed before it can
        # write — with room for a slow machine, and the wait below still
        # outlasts the delay so an unreaped process WOULD be caught.
        "\"import time; from pathlib import Path; time.sleep(5); "
        "Path('src/late.py').write_text('late')\"], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, "
        "start_new_session=True)\n",
    )
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    threading.Event().wait(6)
    assert not (repo / "src" / "late.py").exists()


def test_stage_done_refuses_failing_verify_command(repo, tmp_path):
    task = {**STAGE_TASK, "verify_commands": ["exit 3"]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "exit 3" in out


def test_stage_done_remeasures_after_verify_command(repo, tmp_path):
    command = ("python3 -c \"from pathlib import Path; "
               "p=Path('billing/generated.py'); p.parent.mkdir(exist_ok=True); "
               "p.write_text('generated = True\\\\n')\"")
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "proof commands changed the product tree" in out


def test_stage_done_reaps_verify_command_descendants(repo, tmp_path):
    command = (
        "python3 -c \"import subprocess,sys; "
        "subprocess.Popen([sys.executable,'-c',"
        "'import time; from pathlib import Path; time.sleep(5); "
        "Path(\\\"src/late-verify.py\\\").write_text(\\\"late\\\")'],"
        "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,"
        "start_new_session=True)\""
    )
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    threading.Event().wait(0.2)
    assert not (repo / "src" / "late-verify.py").exists()


@pytest.mark.parametrize("termination_signal", [signal.SIGTERM, signal.SIGINT])
def test_stage_done_termination_signal_reaps_active_proof(
        repo, tmp_path, termination_signal):
    command = (
        "python3 -c \"import os,signal,time; from pathlib import Path; "
        "Path('.factory/proof-child.pid').write_text(str(os.getpid())); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(30)\""
    )
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    proc = subprocess.Popen(
        [sys.executable, str(repo / "factory/scripts/forge.py"),
         "stage", "done", "T1"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    marker = repo / ".factory" / "proof-child.pid"
    for _ in range(100):
        if marker.is_file():
            break
        threading.Event().wait(0.05)
    assert marker.is_file()
    child_pid = int(marker.read_text())
    proc.send_signal(termination_signal)
    proc.communicate(timeout=12)
    assert proc.returncode != 0
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)


def test_process_identity_matches_the_process_table_on_single_digit_days(
        repo, monkeypatch):
    # `ps -o lstart=` pads the day of month to width two ("Aug  4"), while
    # _process_table rebuilds identity with " ".join(fields) and collapses it.
    # Every identity comparison in the module pits one form against the other,
    # so an unnormalized probe matches nothing on days 1-9 — no observed
    # process is recognized as live, none is signalled, and proof trees
    # survive. It passed on 2026-07-30 and failed on 2026-08-04 for that
    # reason alone. Assert the two forms agree for a live process.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        def fake_ps(args, **_kwargs):
            if args[1:3] == ["-o", "lstart="]:
                return subprocess.CompletedProcess(
                    args, 0, stdout="Mon Aug  4 10:11:12 2026\n", stderr="")
            return subprocess.CompletedProcess(
                args, 0,
                stdout="101 1 Mon Aug 4 10:11:12 2026\n", stderr="")

        monkeypatch.setattr(delegate.subprocess, "run", fake_ps)
        probed = delegate._process_start_identity(101)
        tabled = delegate._process_table().get(101)
        assert probed is not None and tabled is not None
        assert probed == tabled[1], (
            f"identity forms disagree: probe={probed!r} table={tabled[1]!r}")
        assert "  " not in probed
    finally:
        sys.path.remove(str(repo / "factory" / "scripts"))
        sys.modules.pop("forge_cli.delegate", None)


@pytest.mark.parametrize("proof_kind", ["verify-command", "required-test"])
def test_proof_reaps_spawn_when_process_identity_probe_fails(
        repo, monkeypatch, proof_kind):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        import forge_cli.stages as stages

        class FakeProcess:
            pid = 424242

            def __init__(self):
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                assert timeout == 5
                self.returncode = -signal.SIGTERM
                return self.returncode

        fake_process = FakeProcess()
        cleaned = []
        signals = []
        monkeypatch.setattr(stages.subprocess, "Popen",
                            lambda *_args, **_kwargs: fake_process)
        monkeypatch.setattr(delegate, "_process_table", lambda: {})
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda _pid: (_ for _ in ()).throw(OSError("ps unavailable")))
        monkeypatch.setattr(
            delegate.os, "killpg",
            lambda pgid, signum: signals.append((pgid, signum)))
        monkeypatch.setattr(
            delegate, "_terminate_observed_process_tree",
            lambda proc, *_args: cleaned.append(proc.pid) or True)
        with pytest.raises(SystemExit):
            if proof_kind == "verify-command":
                stages._run_verify_commands(
                    repo, "T1", {"verify_commands": ["true"]})
            else:
                write_in_scope(
                    repo, "src/test_core.py",
                    "def test_core():\n    pass\n")
                stages._run_required_tests(repo, "T1", {
                    "required_tests": [{
                        "id": "test_core",
                        "path": "src/test_core.py",
                        "command": "python3 -m pytest {path}::{id} "
                                   "--junitxml={report}",
                    }],
                })
    finally:
        sys.path.pop(0)
    assert cleaned == [fake_process.pid]
    assert signals == [(fake_process.pid, signal.SIGTERM)]


def test_stage_done_reloads_launch_after_proof_commands(repo, tmp_path):
    command = ("python3 -c \"from pathlib import Path; "
               "p=Path('.factory/briefs/T1.md'); "
               "p.write_text(p.read_text() + 'changed')\"")
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_stage_tasks_are_sequential_and_parallel_flag_is_refused(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    decomp = {**DECOMP, "tasks": [
        {**STAGE_TASK, "id": "T1", "write_scope": ["src/api/"]},
        {**STAGE_TASK, "id": "T2", "write_scope": ["src/ui/"]},
    ]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(decomp))
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T2", "--parallel")
    assert code != 0
    assert "task stages are sequential" in out
    assert "dependency-ready stories" in out


def test_stage_done_ledgers_a_contract_rewritten_mid_stage(repo, tmp_path):
    """A contract that moved mid-stage is evidence, not a refusal (0023).

    Refusing forced a re-baseline, and re-baselining after the work destroyed
    the delta being measured — which stranded a stage whose work was complete,
    reviewed and committed. The widened scope is recorded for review instead,
    and the diff is still measured against the ref the stage started from, so
    the boundary still binds.
    """
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "billing/ledger.py")
    widened = {**DECOMP, "tasks": [{**STAGE_TASK, "write_scope": ["src/", "billing/"]}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(widened))
    assert code == 0, out
    code, out = record_task_grill(repo, widened["tasks"][0])
    assert code == 0, out
    # A changed contract is a changed brief, so decision 0018 still wants a
    # launch bound to it. Ledgering the change removes the re-baseline, not
    # the delegation binding.
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    write_in_scope(repo, "billing/ledger.py", "changed = True\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    assert "contract changed" in out

    stage = next(s for s in json.loads(
        (repo / ".factory" / "stages.json").read_text())["stages"]
        if s["id"] == "T1")
    assert stage["contract_changed"]["from"] != stage["contract_changed"]["to"]
    events = (repo / ".factory" / "events.jsonl").read_text()
    assert "stage-contract-changed" in events


def test_decomposition_refuses_to_remove_an_active_task(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    replacement = {
        **DECOMP,
        "tasks": [{**STAGE_TASK, "id": "T2", "title": "replacement"}],
    }
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps(replacement),
    )
    assert code != 0
    assert "active stage cannot be removed or renamed" in out


def test_decomposition_refuses_to_rewrite_a_completed_task_contract(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    changed = {
        **DECOMP,
        "tasks": [{
            **STAGE_TASK,
            "acceptance_criteria": ["A different contract after completion"],
        }],
    }
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(changed))
    assert code != 0 and "completed stage's contract" in out


def test_decomposition_backfills_unchanged_legacy_completed_contract(
        repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    protected_stages = delegation_ledger(repo).parent / "stages.json"
    stages = json.loads(protected_stages.read_text())
    stages["stages"][0].pop("task_sha256")
    protected_stages.write_text(json.dumps(stages))
    grown = {
        **DECOMP,
        "tasks": [
            STAGE_TASK,
            {
                "id": "T2",
                "title": "follow-up",
                "objective": "Add the next bounded slice.",
                "acceptance_criteria": ["the follow-up is recorded"],
            },
        ],
    }
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(grown))
    assert code == 0, out
    recorded = json.loads(protected_stages.read_text())
    completed = recorded["stages"][0]
    assert completed["status"] == "done"
    assert completed["task_sha256"]


def test_completed_contract_check_uses_protected_stage_digest(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    changed_task = {
        **STAGE_TASK,
        "acceptance_criteria": ["worker rewrote the prior contract"],
    }
    decomposition = repo / ".factory" / "decomposition.json"
    forged_prior = json.loads(decomposition.read_text())
    forged_prior["tasks"] = [changed_task]
    decomposition.write_text(json.dumps(forged_prior))
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [changed_task]}))
    assert code != 0 and "completed stage's contract" in out


def test_stage_start_refuses_to_rebaseline_an_unchanged_active_contract(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "billing/ledger.py")
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "already active" in out and "erase" in out


def test_stage_done_ignores_paths_a_merge_brought_in(repo, tmp_path):
    """A merge is something the branch received, not something the stage did.

    Measuring a plain range diff attributes every file upstream touched to the
    open stage, so `stage done` refuses a scope violation the worker never
    committed — and no baseline can separate the two once the merge is in the
    window. That stranded PH-2.2 with its work complete and reviewed.
    """
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "the stage's own work")

    # An upstream branch that touches a path this task does not own.
    git(repo, "checkout", "-q", "-b", "upstream", "HEAD~1")
    (repo / "unrelated.py").write_text("upstream = True\n")
    git(repo, "add", "unrelated.py")
    git(repo, "commit", "-qm", "upstream work outside this task")
    git(repo, "checkout", "-q", "-")
    git(repo, "merge", "--no-edit", "-q", "upstream")

    assert (repo / "unrelated.py").exists()
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    assert "unrelated.py" not in out


def test_stage_start_never_moves_the_baseline(repo, tmp_path):
    """The baseline is written once, as a ref, and is not something to move.

    Re-baselining used to be the sanctioned repair for a wrong scope. Doing it
    after the work set the baseline to the finished state, so `stage done`
    measured nothing and refused as an EMPTY diff — with no way back, because
    restarting again is what caused it.
    """
    start_stage(repo, tmp_path, STAGE_TASK)
    baseline = git(repo, "rev-parse", "refs/forge/stage/T1")
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "the stage's work")

    widened = {**STAGE_TASK,
               "write_scope": [*STAGE_TASK["write_scope"], "src/extra.py"]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [widened]}))
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "not something to move" in out

    # ...and the ref still points where it did, so the work stays measurable.
    assert git(repo, "rev-parse", "refs/forge/stage/T1") == baseline
    code, out = record_task_grill(repo, widened)
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    write_in_scope(repo, "src/core.py", "more = True\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_verify_refuses_to_guess_a_toolchain(repo, tmp_path):
    """An unset command used to default to pnpm, so a Python project recorded a
    red verify against a package.json it does not have — and a project whose
    pnpm scripts are no-ops would have recorded green having tested nothing."""
    start_stage(repo, tmp_path, STAGE_TASK)  # verify runs past the workflow gate
    # Explicit empties, not deletions: run() merges over os.environ, so a
    # developer with these exported would otherwise not exercise the refusal.
    blank = {"FACTORY_STRUCTURAL_CMD": "", "FACTORY_TYPECHECK_CMD": "",
             "FACTORY_TEST_CMD": ""}
    code, out = run(repo, "verify.py", env=blank)
    assert code != 0
    assert "not configured" in out
    for variable in ("FACTORY_STRUCTURAL_CMD", "FACTORY_TYPECHECK_CMD",
                     "FACTORY_TEST_CMD"):
        assert variable in out
    assert "pnpm" not in out.split("e.g.")[0]


def test_jsonl_ledgers_merge_with_a_builtin_driver(repo):
    """A merge driver this repo depends on must be one git already ships.

    The custom jsonl-append driver hangs — it forks and never runs its payload,
    so a merge blocks forever instead of failing, which is indistinguishable
    from an unresolvable conflict. It was registered per clone by a hook that
    may not have run, and no test exercised it.
    """
    attributes = (HARNESS / ".gitattributes").read_text()
    assert not jsonl_append_rules(attributes)
    for pattern in ("plans/lessons.jsonl", "plans/quickfixes.jsonl",
                    ".factory/*.jsonl"):
        line = next(l for l in attributes.splitlines() if l.startswith(pattern))
        assert line.endswith("merge=union"), line


def test_stage_done_refuses_a_task_with_no_boundary(repo, tmp_path):
    start_stage(repo, tmp_path, {k: v for k, v in STAGE_TASK.items()
                                 if k != "write_scope"})
    write_in_scope(repo, "anywhere.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no write_scope" in out


def test_stage_done_sees_later_edits_to_an_initially_dirty_file(repo, tmp_path):
    """Subtracting a NAME would hide every later edit to that file, so a worker
    could keep changing an out-of-scope dirty file invisibly. The stage records
    CONTENT: "still as I found it" differs from "I changed it too"."""
    write_in_scope(repo, "billing/ledger.py", "before = 1\n")
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    write_in_scope(repo, "billing/ledger.py", "after = 2\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "billing/ledger.py" in out
    # left exactly as the stage found it, it is not this stage's work
    write_in_scope(repo, "billing/ledger.py", "before = 1\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_scope_checks_initial_dirt_once_it_is_committed(repo, tmp_path):
    write_in_scope(repo, "billing/ledger.py", "before = 1\n")
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "stage work plus unrelated dirt")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "billing/ledger.py" in out and "write_scope" in out


def test_stage_done_incomplete_leaves_stage_open(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1",
                    "--incomplete", "the retry path is unwritten")
    assert code == 0, out
    stages = json.loads((repo / ".factory" / "stages.json").read_text())["stages"]
    assert stages[0]["status"] == "active"
    assert stages[0]["incomplete"] == "the retry path is unwritten"
    events = (repo / ".factory" / "events.jsonl").read_text()
    assert "stage-incomplete" in events and "retry path" in events
    # and it clears once the stage really closes
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    stages = json.loads((repo / ".factory" / "stages.json").read_text())["stages"]
    assert stages[0]["status"] == "done" and "incomplete" not in stages[0]


def test_stage_start_refuses_a_decomposition_whose_plan_moved(repo, tmp_path):
    """The realistic staleness is the plan being edited AFTER the task graph
    was recorded — the decomposition was current when written, so no
    record-time check can see it. Catch it before work starts."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}))
    assert code == 0, out
    plan = next((repo / "plans" / "active").glob("*.md"))
    plan.write_text(plan.read_text() + "\n<!-- edited after decomposition -->\n")
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0, out
    assert "has changed since this decomposition was recorded" in out

    # Absence must refuse too: a stamped decomposition claims a binding, so
    # failing to VERIFY it is not permission to proceed.
    plan.unlink()
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0, out
    assert "missing" in out and "cannot be verified" in out


def test_no_prompt_authors_build_waves(repo):
    """Waves were a SECOND hand-written ordering of work whose real order is
    the array index and the depends_on edges (decision 0021). Two sources of
    truth for one fact, and the authored one could not be recomputed when
    anything moved. The writer and its only reader die together — a field
    nothing writes with a script still reading it, or the reverse, is an
    orphan by construction."""
    for prompt in ("decomposer.md", "griller.md"):
        body = (HARNESS / "factory" / "prompts" / prompt).read_text()
        assert "build_waves" not in body, prompt
    assert not (HARNESS / "factory" / "scripts" / "render_linear_task_graph.py").exists()
    assert "render_linear_task_graph" not in (HARNESS / "docs" / "FACTORY.md").read_text()
    # Nothing else may reference the deleted renderer either — a scaffold check
    # that still REQUIRES it turns the deletion into a failing gate.
    scaffold = (HARNESS / "factory" / "scripts" / "check_factory_scaffold.py").read_text()
    assert "render_linear_task_graph" not in scaffold


def test_decomposition_refuses_a_malformed_epic(repo, tmp_path):
    """Absent or null is legacy "no epic"; false/0/{}/[] is a broken roadmap.

    `or ""` erased the difference, so provenance recorded "no epic" for a
    roadmap that was actually malformed — the same shape as the dependencies
    bug in this file, three lines away.
    """
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    roadmap = repo / "plans" / "roadmap.json"
    import copy
    original = json.loads(roadmap.read_text())
    for malformed in (False, 0, {}, []):
        data = copy.deepcopy(original)
        for item in data["items"]:
            item["epic"] = malformed
        roadmap.write_text(json.dumps(data))
        code, out = run(repo, "record_decomposition_from_json.py",
                        stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}))
        assert code != 0, f"{malformed!r} accepted: {out}"
        assert "epic" in out


def test_decomposition_refuses_a_falsy_non_list_dependencies(repo, tmp_path):
    """`or []` let false, 0, "" and {} pass a list check, then persisted the
    malformed value into the recorded artifact."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    for malformed in (False, 0, "", {}):
        payload = {**DECOMP, "tasks": [{**STAGE_TASK, "dependencies": malformed}]}
        code, out = run(repo, "record_decomposition_from_json.py",
                        stdin=json.dumps(payload))
        assert code != 0, f"{malformed!r} was accepted: {out}"
        assert "dependencies" in out


def test_decomposition_refuses_prose_verify_commands(repo, tmp_path):
    """`stage done` executes these, so an entry that cannot run is a gate that
    can never pass — which is what "package test script" always was."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    prose = {**DECOMP, "tasks": [{**STAGE_TASK,
                                  "verify_commands": ["package test script"]}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(prose))
    assert code != 0 and "T1" in out and "package test script" in out
    runnable = {**DECOMP, "tasks": [{**STAGE_TASK, "verify_commands": ["true"]}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(runnable))
    assert code == 0, out
    # legitimate shell is not prose: env prefixes, flags, pipes, builtins
    for command in ["FOO=1 git status", "git log --oneline | head -1", "test -d src"]:
        payload = {**DECOMP, "tasks": [{**STAGE_TASK, "verify_commands": [command]}]}
        code, out = run(repo, "record_decomposition_from_json.py",
                        stdin=json.dumps(payload))
        assert code == 0, f"{command}: {out}"


def test_decomposition_provenance_overrides_agent_supplied_fields(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    roadmap = json.loads((repo / "plans" / "roadmap.json").read_text())
    story = next(item for item in roadmap["items"] if item["key"] == "ENG-1")
    story["epic"] = "billing"
    (repo / "plans" / "roadmap.json").write_text(json.dumps(roadmap, indent=2) + "\n")
    state = run_state(repo)
    plan = repo / state["plan_file"]
    payload = {
        **DECOMP,
        "project": "agent-project",
        "story": "AGENT-9",
        "epic": "agent-epic",
        "plan_file": "plans/active/agent.md",
        "plan_sha256": hashlib.sha256(plan.read_bytes()).hexdigest(),
    }

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads((repo / ".factory" / "decomposition.json").read_text())
    assert {key: recorded[key] for key in (
        "project", "story", "epic", "plan_file", "plan_sha256",
    )} == {
        "project": "app",
        "story": "ENG-1",
        "epic": "billing",
        "plan_file": state["plan_file"],
        "plan_sha256": hashlib.sha256(plan.read_bytes()).hexdigest(),
    }


def test_decomposition_refuses_a_stale_plan_digest(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    payload = {**DECOMP, "plan_sha256": "0" * 64}

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(payload))

    assert code != 0
    assert "plan_sha256" in out and "active plan" in out


def test_decomposition_accepts_empty_required_tests(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    task = {**STAGE_TASK, "verify_commands": ["true"], "required_tests": []}

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))

    assert code == 0, out
    recorded = json.loads((repo / ".factory" / "decomposition.json").read_text())
    assert recorded["tasks"][0]["required_tests"] == []


def test_decomposition_refuses_a_dependency_on_a_later_task(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**STAGE_TASK, "dependencies": ["T2"]}
    second = {**STAGE_TASK, "id": "T2", "dependencies": []}

    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first, second]}))

    assert code != 0
    assert "T1" in out and "T2" in out and "earlier" in out


def test_decomposition_refuses_when_roadmap_story_is_missing(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    roadmap = json.loads((repo / "plans" / "roadmap.json").read_text())
    roadmap["items"] = [
        item for item in roadmap["items"] if item.get("key") != "ENG-1"
    ]
    (repo / "plans" / "roadmap.json").write_text(json.dumps(roadmap, indent=2) + "\n")

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))

    assert code != 0
    assert "ENG-1" in out and "roadmap" in out


@pytest.mark.skipif(
    not FORGE_INIT_FIXTURE.is_dir(),
    reason="requires the FORGE-INIT-1 history fixture",
)
def test_historical_decomposition_artifacts_still_parse():
    schema = json.loads((HARNESS / "factory" / "schemas" / "decomposition.json").read_text())
    assert "build_waves" in schema["optional"]
    carried = 0
    factory_lib = load_factory_lib(HARNESS)
    for issue in ("FORGE-INIT-1", "FORGE-DELEG-1", "PH-1"):
        artifact = HARNESS / ".factory" / "history" / issue / "decomposition.json"
        assert artifact.is_file()
        payload = json.loads(artifact.read_text())
        carried += "build_waves" in payload
        assert "plan_sha256" not in payload
        factory_lib.validate_payload(HARNESS, "decomposition", payload)
    assert carried, "no historical artifact carries build_waves — this test proves nothing"


def test_doctor_reports_prose_verify_commands(repo, tmp_path):
    """Prose predates the record-time refusal, so an already-recorded
    decomposition can still carry one. Report it before it becomes a stage
    that cannot close."""
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import prose_verify_commands, unrunnable_reason
    finally:
        sys.path.pop(0)
    assert unrunnable_reason("package test script")
    assert unrunnable_reason("python3 -m pytest") is None
    (repo / ".factory" / "decomposition.json").write_text(json.dumps(
        {**DECOMP, "tasks": [{**STAGE_TASK, "verify_commands": ["package test script"]}]}))
    found = prose_verify_commands(repo)
    assert len(found) == 1 and "package test script" in found[0] and "T1" in found[0]


def test_decomposition_refuses_string_required_tests(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    task = {**STAGE_TASK, "required_tests": ["test_slice"]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "opaque test names" in out


def test_decomposition_refuses_malformed_required_test_objects(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    task = {**STAGE_TASK, "required_tests": [
        {"id": "test_slice", "path": "../escape.py", "command": "true"},
    ]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "repo-relative" in out


def test_decomposition_refuses_required_test_command_without_path_or_id(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    task = {**STAGE_TASK, "required_tests": [{
        "id": "test_slice", "path": "tests/test_slice.py", "command": "true",
    }]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "{report}" in out
    task["required_tests"][0]["command"] = \
        "true # tests/test_slice.py test_slice"
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "shell-free runner invocation" in out
    task["required_tests"][0]["command"] = \
        "python3 -m pytest tests/test_slice.py::test_slice -q"
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "{report}" in out
    task["required_tests"][0]["command"] = \
        "python3 -m pytest --file={path} --test={id} " \
        "--junitxml={report}"
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code == 0, out
    task["required_tests"][0]["command"] = \
        "python3 -m pytest --file={path} --test=test_slice " \
        "--junitxml={report}"
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "{id}" in out
    task["required_tests"][0]["command"] = \
        "sh -c 'python3 -m pytest {path}::{id}; true' --junitxml={report}"
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))
    assert code != 0 and "shell/env wrapper" in out


def test_doctor_reports_legacy_string_required_tests(repo):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import legacy_required_tests
    finally:
        sys.path.pop(0)
    (repo / ".factory" / "decomposition.json").write_text(json.dumps(
        {**DECOMP, "tasks": [{**STAGE_TASK, "required_tests": ["test_slice"]}]}))
    assert legacy_required_tests(repo) == ["T1: 'test_slice'"]


def test_doctor_reports_legacy_capture_without_blocking(repo, capsys):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import report_legacy_capture_gaps
    finally:
        sys.path.pop(0)

    brief = repo / "docs" / "product" / "BRIEF.md"
    brief.write_text("\n".join(
        f"## {heading}\n\n{'' if heading in {'Users', 'Constraints'} else 'Captured.'}"
        for heading in REQUIRED_BRIEF_HEADINGS
    ))
    specs = repo / "docs" / "specs"
    specs.joinpath("base.md").write_text(
        "---\nstatus: confirmed\n---\n\n# Base\n\n"
        "## Behaviour\n\nCaptured.\n\n"
        "## Acceptance criteria\n\n- Captured.\n"
    )
    specs.joinpath("legacy-two.md").write_text(
        "---\nstatus: confirmed\n---\n\n# Two\n\n"
        "## Why\n\nCaptured.\n\n## Behaviour\n\nCaptured.\n"
    )
    specs.joinpath("draft.md").write_text(
        "---\nstatus: draft\n---\n\n# Draft\n"
    )

    report_legacy_capture_gaps(repo)
    out = capsys.readouterr().out
    assert "[opt ] capture/brief docs/product/BRIEF.md: Users, Constraints" in out
    assert "[opt ] capture/spec  docs/specs/base.md: ## Why" in out
    assert ("[opt ] capture/spec  docs/specs/legacy-two.md: "
            "## Acceptance criteria") in out
    assert "draft.md" not in out

    # A brief that does not exist is the most incomplete a brief can be, and a
    # project with no brief is exactly the one that needs to be told.
    brief.unlink()
    report_legacy_capture_gaps(repo)
    out = capsys.readouterr().out
    assert all(f"{heading}" in out for heading in REQUIRED_BRIEF_HEADINGS)
    assert out.startswith("[opt ] capture/brief docs/product/BRIEF.md:")

    brief.write_text("\n".join(
        f"## {heading}\n\nCaptured." for heading in REQUIRED_BRIEF_HEADINGS
    ))
    complete_spec = (
        "---\nstatus: confirmed\n---\n\n# Complete\n\n"
        "## Why\n\nCaptured.\n\n## Behaviour\n\nCaptured.\n\n"
        "## Acceptance criteria\n\n- Captured.\n"
    )
    specs.joinpath("base.md").write_text(complete_spec)
    specs.joinpath("legacy-two.md").write_text(complete_spec)

    report_legacy_capture_gaps(repo)
    assert capsys.readouterr().out == ""


def test_doctor_survives_a_malformed_roadmap(repo):
    """doctor is what someone runs when the project is ALREADY broken.

    A roadmap that is null, a list, or holds a non-object item must produce a
    report — a traceback here takes doctor's other checks down with it, at
    exactly the moment they are the ones being asked for.
    """
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import legacy_roadmap_gaps
    finally:
        sys.path.pop(0)

    path = repo / "plans" / "roadmap.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    for shape in ("null", "[]", '{"items": "nope"}', '{"items": [1, 2]}',
                  '{"items": [{"key": "A"}]}'):
        path.write_text(shape)
        gaps = legacy_roadmap_gaps(repo)  # must not raise
        assert isinstance(gaps, list), shape


def test_doctor_reports_an_epicless_roadmap_without_blocking(repo, capsys):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import report_legacy_roadmap_gaps
    finally:
        sys.path.pop(0)

    roadmap = repo / "plans" / "roadmap.json"
    roadmap.write_text(json.dumps({
        "generated_by": "human",
        "items": [
            {"key": "LEG-1", "title": "Legacy story"},
            {"key": "MOD-1", "title": "Modern story", "epic": "modern"},
        ],
    }))

    assert report_legacy_roadmap_gaps(repo) is None
    out = capsys.readouterr().out
    assert "[opt ] roadmap/epics plans/roadmap.json: no epics declared" in out
    assert "[opt ] roadmap/story LEG-1: no epic declared" in out
    assert "MOD-1" not in out


def test_doctor_reports_an_unmarked_outcomeless_done_item(repo, capsys):
    from forge_cli.doctor import report_legacy_roadmap_gaps
    from forge_cli.roadmap import load_roadmap

    roadmap = repo / "plans" / "roadmap.json"
    roadmap.write_text(json.dumps({
        "generated_by": "human",
        "epics": [ROADMAP_EPIC],
        "items": [
            {"key": "GAP-1", "title": "Silent gap", "status": "done",
             "epic": "billing"},
            {"key": "OLD-1", "title": "Marked history", "status": "done",
             "epic": "billing", "predates_outcome_contract": True},
            {"key": "DONE-1", "title": "Recorded outcome", "status": "done",
             "epic": "billing", "outcome": "Customers can pay invoices."},
        ],
    }))

    assert len(load_roadmap(repo)["items"]) == 3
    assert report_legacy_roadmap_gaps(repo) is None
    out = capsys.readouterr().out
    assert "[opt ] roadmap/outcome GAP-1: done without an outcome" in out
    assert "OLD-1" not in out
    assert "DONE-1" not in out


@pytest.mark.skipif(
    not FORGE_INIT_FIXTURE.is_dir(),
    reason="requires the FORGE-INIT-1 history fixture",
)
def test_precontract_stories_are_marked_without_synthesized_outcomes():
    roadmap = json.loads((HARNESS / "plans" / "roadmap.json").read_text())
    items = {item["key"]: item for item in roadmap["items"]}

    for key in ("FORGE-INIT-1", "harness-v2-wedge"):
        item = items[key]
        assert item["status"] == "done"
        assert item["epic"] == "symphony-forge"
        assert item["predates_outcome_contract"] is True
        assert "outcome" not in item


DELEGATE_TASK = {**STAGE_TASK, "required_tests": [{
                     "id": "test_slice",
                     "path": "factory/tests/test_gates.py",
                     "command": "python3 -m pytest {path} "
                                "-q -k {id} -o junit_family=legacy "
                                "--junitxml={report}",
                 }],
                 "reviewer_focus": "the retry path",
                 "verify_commands": ["true"]}


def test_delegate_brief_carries_criteria_and_scope(repo, tmp_path):
    """The executor is told not to inspect the repo, so everything it needs
    has to travel with the brief — including what already exists in scope."""
    start_stage(repo, tmp_path, DELEGATE_TASK)
    write_in_scope(repo, "src/existing_helper.py")
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    brief = (repo / ".factory" / "diagnostic-briefs" / "T1.md").read_text()
    assert "the slice runs green" in brief          # acceptance criteria
    assert "src/" in brief                          # write scope
    assert "src/existing_helper.py" in brief        # existing modules
    assert "test_slice" in brief                    # required tests
    assert "the retry path" in brief                # reviewer focus
    assert "Implementer contract" in brief          # the prompt, inlined
    assert "Then return." in brief
    assert "orchestrator owns local autoreview" in brief
    assert "Do not run" in brief and "forge stage done" in brief
    assert "--prompt-file .factory/diagnostic-briefs/T1.md" in out


def test_delegate_derives_write_from_stage_state(repo, tmp_path):
    """Write permission stopped being a per-request opinion: three layers
    disagreed on the default and a read-only sandbox can neither write nor ask."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [DELEGATE_TASK]}))
    assert code == 0, out
    # stage not started -> read only
    home = str(fake_companion_home(tmp_path))
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "--write" not in out and "Write access: NO" in out
    code, out = record_task_grill(repo, DELEGATE_TASK)
    assert code == 0, out
    run(repo, "forge.py", "stage", "start", "T1")
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "--write" in out
    # ...and --read-only is the explicit exception
    code, out = run(repo, "forge.py", "delegate", "T1", "--read-only", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "--write" not in out


@delegate_task_grill_test
def test_delegate_refuses_without_task_grill(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    grill = repo / ".factory" / "grills" / "tasks" / "T1.json"
    grill.unlink()
    command = (
        "python3 factory/scripts/record_grill_from_json.py --gate task "
        f"--task T1 --task-digest {task_digest(STAGE_TASK)}"
    )

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0 and "Task grill required" in out and command in out
    assert not delegation_ledger(repo).exists()

    code, out = record_task_grill(repo, STAGE_TASK, verdict="blocked")
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0 and "verdict is 'blocked'" in out and command in out
    assert not delegation_ledger(repo).exists()


@delegate_task_grill_test
def test_delegate_refuses_stale_task_grill(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    payload = {"generated_by": "griller", "gate": "task", "verdict": "pass",
               "gaps": [], "contradictions": [], "resolutions": []}
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        "--task-digest", "0" * 64, stdin=json.dumps(payload),
    )
    assert code == 0, out

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0 and "STALE" in out
    assert "record_grill_from_json.py --gate task --task T1 --task-digest" in out
    assert task_digest(STAGE_TASK) in out
    assert not delegation_ledger(repo).exists()


@delegate_task_grill_test
def test_delegate_passes_with_fresh_task_grill(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))

    assert code == 0, out
    entries = [
        json.loads(line)
        for line in delegation_ledger(repo).read_text().splitlines()
    ]
    assert entries[-1]["launch_status"] == "succeeded"
    assert entries[-1]["task_sha256"] == task_digest(STAGE_TASK)


@delegate_task_grill_test
def test_delegate_readonly_unaffected_by_task_grill(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    (repo / ".factory" / "grills" / "tasks" / "T1.json").unlink()

    code, out = run(repo, "forge.py", "delegate", "T1", "--read-only",
                    env=fake_companion_env(tmp_path))

    assert code == 0, out
    entries = [
        json.loads(line)
        for line in delegation_ledger(repo).read_text().splitlines()
    ]
    assert entries[-1]["launch_status"] == "succeeded"
    assert entries[-1]["write"] is False


def test_delegate_records_ledger_entry(repo, tmp_path):
    start_stage(repo, tmp_path, DELEGATE_TASK, launch=False)
    home_path = fake_companion_home(tmp_path)
    unlisted = home_path / ".claude/plugins/cache/openai-codex/codex/9.9.9/scripts/codex-companion.mjs"
    unlisted.parent.mkdir(parents=True)
    unlisted.write_text("process.exit(9);\n")
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out
    lines = [json.loads(x) for x in
             delegation_ledger(repo).read_text().splitlines() if x.strip()]
    assert len(lines) == 3
    assert lines[0]["launch_status"] == "starting"
    assert "pid" not in lines[0]
    assert lines[1]["launch_status"] == "running" and lines[1]["pid"] > 0
    entry = lines[-1]
    assert entry["task"] == "T1" and entry["write"] is True
    assert entry["generated_by"] == "orchestrator" and entry["model"]
    assert entry["launch_status"] == "succeeded"
    assert entry["launch_id"] == lines[0]["launch_id"] == lines[1]["launch_id"]
    assert "/1.0.0/scripts/codex-companion.mjs" in entry["companion_path"]
    assert entry["stage_started_at"] and entry["task_sha256"] and entry["argv_sha256"]
    assert entry["argv"][1] == entry["companion_path"]
    assert entry["argv"][-1] == "--write"
    assert entry["argv_sha256"] == hashlib.sha256(json.dumps(
        entry["argv"], separators=(",", ":")).encode()).hexdigest()
    assert entry["process_token"] == f"delegation-{entry['launch_id']}"
    digest = hashlib.sha256(
        (repo / ".factory" / "briefs" / "T1.md").read_bytes()).hexdigest()
    assert entry["brief_sha256"] == digest
    # an unknown task id is refused, and never reaches the filesystem
    code, out = run(repo, "forge.py", "delegate", "../escape")
    assert code != 0 and "not a task" in out


def test_delegate_print_only_records_no_successful_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    home = str(fake_companion_home(tmp_path))
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "not launched" in out
    assert not (repo / ".factory" / "delegations.jsonl").exists()
    assert not delegation_ledger(repo).exists()
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


@pytest.mark.parametrize("tamper", ["missing", "digest", "read-only"])
def test_stage_done_rejects_unbound_launch_argv(repo, tmp_path, tamper):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    entry = json.loads(ledger.read_text().splitlines()[-1])
    if tamper == "missing":
        entry.pop("argv")
    elif tamper == "digest":
        entry["argv_sha256"] = "0" * 64
    else:
        entry["argv"][-1] = "--read-only"
        entry["argv_sha256"] = hashlib.sha256(json.dumps(
            entry["argv"], separators=(",", ":")).encode()).hexdigest()
    with ledger.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_stage_done_rejects_incomplete_success_lifecycle(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    entry = json.loads(ledger.read_text().splitlines()[-1])
    entry["launch_id"] = "terminal-only"
    with ledger.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_stage_done_fails_closed_on_malformed_launch_authority(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    with delegation_ledger(repo).open("a") as fh:
        fh.write('{"launch_status":\n')
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "delegation authority is malformed" in out


def test_running_write_launch_invalidates_older_success(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    lines = [json.loads(line) for line in ledger.read_text().splitlines()]
    running = {**lines[-1], "at": "2999-01-01T00:00:00+00:00",
               "launch_status": "running"}
    running.pop("exit_code", None)
    with ledger.open("a") as fh:
        fh.write(json.dumps(running) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_workspace_mirror_cannot_forge_authoritative_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    authority = delegation_ledger(repo)
    prior = json.loads(authority.read_text().splitlines()[-1])
    running = {
        **prior,
        "launch_id": "real-running-writer",
        "launch_status": "running",
        "pid": os.getpid(),
    }
    running.pop("exit_code", None)
    with authority.open("a") as fh:
        fh.write(json.dumps(running) + "\n")
    forged = {
        **running,
        "launch_id": "forged-workspace-success",
        "launch_status": "succeeded",
        "exit_code": 0,
    }
    mirror = repo / ".factory" / "delegations.jsonl"
    with mirror.open("a") as fh:
        fh.write(json.dumps(forged) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_workspace_stage_mirror_cannot_forge_completion(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    mirror = repo / ".factory" / "stages.json"
    forged = json.loads(mirror.read_text())
    forged["stages"][0]["status"] = "done"
    mirror.write_text(json.dumps(forged))
    code, out = run(repo, "forge.py", "stage", "list")
    assert code == 0 and "[>]" in out and "T1" in out


def test_workspace_decomposition_mirror_cannot_forge_task_contract(
        repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}))
    assert code == 0, out
    mirror = repo / ".factory" / "decomposition.json"
    forged = json.loads(mirror.read_text())
    forged["tasks"][0]["write_scope"] = ["billing/"]
    mirror.write_text(json.dumps(forged))
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    brief = (repo / ".factory" / "diagnostic-briefs" / "T1.md").read_text()
    assert "src/" in brief and "billing/" not in brief


def test_git_environment_cannot_redirect_protected_authority(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    fake = tmp_path / "fake-git"
    subprocess.run(["git", "init", "-q", str(fake)], check=True)
    fake_authority = fake / ".git" / "forge"
    fake_authority.mkdir(parents=True)
    (fake_authority / "stages.json").write_text(json.dumps({
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "forged", "status": "done"}],
    }))
    code, out = run(repo, "forge.py", "stage", "list",
                    env={"GIT_DIR": str(fake / ".git")})
    assert code == 0 and "[>]" in out and "forged" not in out


def test_missing_protected_stage_state_never_falls_back_to_workspace(
        repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import authoritative_stages_path
        authoritative_stages_path(repo).unlink()
    finally:
        sys.path.pop(0)
    mirror = repo / ".factory" / "stages.json"
    forged = json.loads(mirror.read_text())
    forged["stages"][0]["status"] = "done"
    mirror.write_text(json.dumps(forged))
    code, out = run(repo, "forge.py", "stage", "list")
    assert code == 0 and "No stage tracker" in out


def test_stage_migrate_requires_confirmation_and_adopts_legacy_state(
        repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}))
    assert code == 0, out
    protected = delegation_ledger(repo).parent
    shutil.rmtree(protected)
    base = head(repo)
    code, out = run(repo, "forge.py", "stage", "migrate", "--base", base)
    assert code != 0 and "--confirm-workspace-state" in out
    code, out = run(
        repo, "forge.py", "stage", "migrate", "--base", base,
        "--confirm-workspace-state")
    assert code == 0, out
    assert (protected / "decomposition.json").is_file()
    assert (protected / "stages.json").is_file()
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out


@pytest.mark.parametrize("protected_name", ["decomposition.json", "stages.json"])
def test_stage_migrate_refuses_partial_protected_authority(
        repo, tmp_path, protected_name):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}))
    assert code == 0, out
    protected = delegation_ledger(repo).parent
    source = (repo / ".factory" / protected_name).read_bytes()
    shutil.rmtree(protected)
    protected.mkdir(parents=True)
    (protected / protected_name).write_bytes(source)
    code, out = run(
        repo, "forge.py", "stage", "migrate", "--base", head(repo),
        "--confirm-workspace-state")
    assert code != 0
    assert "partial protected" in out


def prepare_legacy_stage_migration(repo, tmp_path, tasks=None):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    tasks = tasks or [STAGE_TASK]
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": tasks}))
    assert code == 0, out
    protected = delegation_ledger(repo).parent
    shutil.rmtree(protected)
    return protected


def test_stage_migrate_requires_a_base(repo, tmp_path):
    prepare_legacy_stage_migration(repo, tmp_path)
    code, out = run(
        repo, "forge.py", "stage", "migrate", "--confirm-workspace-state")
    assert code != 0 and "--base" in out

    code, out = run(
        repo, "forge.py", "stage", "migrate", "--base", "not-a-commit",
        "--confirm-workspace-state")
    assert code != 0 and "does not resolve to a commit" in out


def test_stage_migrate_refuses_a_base_that_is_not_an_ancestor(repo, tmp_path):
    prepare_legacy_stage_migration(repo, tmp_path)
    tree = git(repo, "rev-parse", "HEAD^{tree}")
    unrelated = git(repo, "commit-tree", tree, "-m", "unrelated root")
    code, out = run(
        repo, "forge.py", "stage", "migrate", "--base", unrelated,
        "--confirm-workspace-state")
    assert code != 0 and "not an ancestor of HEAD" in out


def test_stage_migrate_records_the_base_on_adopted_stages(repo, tmp_path):
    tasks = [
        {**STAGE_TASK, "id": "T1"},
        {**STAGE_TASK, "id": "T2"},
        {**STAGE_TASK, "id": "T3"},
    ]
    protected = prepare_legacy_stage_migration(repo, tmp_path, tasks)
    stages_path = repo / ".factory" / "stages.json"
    stages = json.loads(stages_path.read_text())
    stages["stages"][0]["status"] = "done"
    stages["stages"][1]["status"] = "active"
    stages_path.write_text(json.dumps(stages))
    base = head(repo)

    code, out = run(
        repo, "forge.py", "stage", "migrate", "--base", base[:12],
        "--confirm-workspace-state")
    assert code == 0, out
    adopted = json.loads((protected / "stages.json").read_text())["stages"]
    for stage in adopted[:2]:
        assert stage["base_sha"] == base
        assert stage["task_sha256"]
    assert "base_sha" not in adopted[2]
    assert "task_sha256" not in adopted[2]


@pytest.mark.parametrize(
    ("extra", "brief_dir"),
    [
        (("--print-only",), "diagnostic-briefs"),
        ((), "briefs"),
    ],
)
def test_delegate_brief_symlink_is_refused(
        repo, tmp_path, extra, brief_dir):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    victim = repo / "victim.txt"
    victim.write_text("do not touch\n")
    brief = repo / ".factory" / brief_dir / "T1.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.symlink_to(victim)
    code, out = run(
        repo, "forge.py", "delegate", "T1", *extra,
        env={"HOME": str(fake_companion_home(tmp_path))},
    )
    assert code != 0 and "cannot safely write" in out
    assert victim.read_text() == "do not touch\n"


def test_delegate_mirror_symlink_is_ignored(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    victim = repo / "victim.txt"
    victim.write_text("do not touch\n")
    mirror = repo / ".factory" / "delegations.jsonl"
    mirror.symlink_to(victim)
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    assert victim.read_text() == "do not touch\n"
    assert delegation_ledger(repo).is_file()


def test_overlapping_write_launch_stays_invalid_until_all_are_terminal(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    lines = [json.loads(line) for line in ledger.read_text().splitlines()]
    prior = lines[-1]
    first_start = {
        **prior, "launch_id": "overlap-a", "launch_status": "starting"}
    second_start = {
        **prior, "launch_id": "overlap-b", "launch_status": "starting"}
    first_start.pop("exit_code", None)
    second_start.pop("exit_code", None)
    first = {**first_start, "launch_status": "running"}
    second = {**second_start, "launch_status": "running"}
    with ledger.open("a") as fh:
        fh.write(json.dumps(first_start) + "\n")
        fh.write(json.dumps(first) + "\n")
        fh.write(json.dumps(second_start) + "\n")
        fh.write(json.dumps(second) + "\n")
        fh.write(json.dumps({**second, "launch_status": "succeeded",
                             "exit_code": 0}) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out
    with ledger.open("a") as fh:
        fh.write(json.dumps({**first, "launch_status": "succeeded",
                             "exit_code": 0}) + "\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_running_launch_with_old_brief_still_blocks_stage_close(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    prior = json.loads(ledger.read_text().splitlines()[-1])
    old_running = {
        **prior,
        "launch_id": "old-brief-writer",
        "launch_status": "running",
        "pid": os.getpid(),
    }
    old_running.pop("exit_code", None)
    brief = repo / ".factory" / "briefs" / "T1.md"
    brief.write_text(brief.read_text() + "\nnew module appeared\n")
    new_digest = hashlib.sha256(brief.read_bytes()).hexdigest()
    new_running = {
        **prior,
        "launch_id": "new-brief-writer",
        "brief_sha256": new_digest,
        "launch_status": "running",
    }
    new_running.pop("exit_code", None)
    with ledger.open("a") as fh:
        fh.write(json.dumps(old_running) + "\n")
        fh.write(json.dumps(new_running) + "\n")
        fh.write(json.dumps({
            **new_running, "launch_status": "succeeded", "exit_code": 0,
        }) + "\n")
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_delegate_retry_reconciles_interrupted_running_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    ledger = delegation_ledger(repo)
    prior = json.loads(ledger.read_text().splitlines()[-1])
    stale = {
        **prior,
        "launch_id": "interrupted-writer",
        "launch_status": "running",
        "pid": 2_147_483_647,
    }
    stale.pop("exit_code", None)
    with ledger.open("a") as fh:
        fh.write(json.dumps(stale) + "\n")
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    entries = [json.loads(line) for line in ledger.read_text().splitlines()]
    reconciled = [entry for entry in entries
                  if entry.get("launch_id") == "interrupted-writer"]
    assert reconciled[-1]["launch_status"] == "failed"
    assert entries[-1]["launch_status"] == "succeeded"


def test_starting_launch_reaps_tagged_process_before_retry(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        launch_id = "interrupted-start"
        entry = {
            "task": "T1",
            "write": True,
            "launch_id": launch_id,
            "process_token": f"delegation-{launch_id}",
            "launch_status": "starting",
        }
        recorded = []
        stopped = []
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes",
            lambda marker_value: stopped.append(marker_value) or True)
        monkeypatch.setattr(
            delegate, "append_delegation",
            lambda _base, record: recorded.append(record))
        delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert stopped == [entry["process_token"]]
    assert recorded[-1]["launch_status"] == "failed"


def test_running_launch_stays_nonterminal_when_tagged_process_survives(
        repo, monkeypatch, capsys):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        launch_id = "cleanup-failed"
        entry = {
            "task": "T1",
            "write": True,
            "launch_id": launch_id,
            "process_token": f"delegation-{launch_id}",
            "launch_status": "running",
            "pid": 123,
            "pgid": 123,
        }
        recorded = []
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: False)
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes",
            lambda _marker_value: False)
        monkeypatch.setattr(
            delegate, "append_delegation",
            lambda _base, record: recorded.append(record))
        with pytest.raises(SystemExit):
            delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert recorded == []
    assert "second writer will not start" in capsys.readouterr().out


def test_process_signal_revalidates_each_pid_identity(repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        killed = []
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda pid: "replacement" if pid == 101 else "live")
        monkeypatch.setattr(delegate, "_process_is_zombie", lambda _pid: False)
        monkeypatch.setattr(
            delegate.os, "kill",
            lambda pid, signum: killed.append((pid, signum)))
        signalled = delegate._signal_identified_processes({
            101: "original",
            102: "live",
        })
    finally:
        sys.path.pop(0)
    assert signalled == {102: "live"}
    assert killed == [(102, signal.SIGTERM)]


def test_process_signal_revalidates_identity_after_zombie_probe(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        state = {"identity": "original"}
        killed = []
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda _pid: state["identity"])

        def probe_zombie(_pid):
            state["identity"] = "replacement"
            return False

        monkeypatch.setattr(delegate, "_process_is_zombie", probe_zombie)
        monkeypatch.setattr(
            delegate.os, "kill",
            lambda pid, signum: killed.append((pid, signum)))
        signalled = delegate._signal_identified_processes({
            101: "original",
        })
    finally:
        sys.path.pop(0)
    assert signalled == {}
    assert killed == []


def test_process_group_signal_requires_live_leader_identity(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        signals = []
        monkeypatch.setattr(delegate, "_process_is_zombie", lambda _pid: False)
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda pid: "leader" if pid == 101 else None)
        monkeypatch.setattr(
            delegate.os, "killpg",
            lambda pgid, signum: signals.append((pgid, signum)))
        assert delegate._signal_verified_process_group(101, "leader") is True
        assert delegate._signal_verified_process_group(102, "old") is False
    finally:
        sys.path.pop(0)
    assert signals == [(101, signal.SIGTERM)]


def test_process_table_failure_is_not_treated_as_an_empty_table(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        class FailedPs:
            returncode = 1
            stdout = ""

        monkeypatch.setattr(
            delegate.subprocess, "run",
            lambda *_args, **_kwargs: FailedPs())
        with pytest.raises(delegate.ProcessDiscoveryError):
            delegate._process_table()
    finally:
        sys.path.pop(0)


def test_tagged_process_scan_is_limited_to_same_user_processes(
        repo, tmp_path, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        real_path = Path
        proc_root = tmp_path / "proc"
        for pid in ("101", "202"):
            (proc_root / pid).mkdir(parents=True)
        (proc_root / "101" / "environ").write_bytes(b"OTHER=value\0")
        (proc_root / "202" / "environ").write_bytes(
            b"FORGE_PROCESS_TOKEN=owned\0")
        monkeypatch.setattr(
            delegate, "Path",
            lambda value: proc_root if value == "/proc" else real_path(value))
        monkeypatch.setattr(
            delegate, "_process_table", lambda: {101: (1, "same-user")})
        found = delegate._tagged_processes("owned")
    finally:
        sys.path.pop(0)
    assert found == {}


def test_tagged_process_scan_skips_permission_denied_candidates(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        real_path = Path

        class Candidate:
            def __init__(self, name):
                self.name = name

            def __truediv__(self, _name):
                return self

            def read_bytes(self):
                if self.name == "101":
                    raise PermissionError("hidden process environment")
                return b"FORGE_PROCESS_" + b"TOKEN=owned\0"

        class ProcRoot:
            def is_dir(self):
                return True

            def __truediv__(self, pid):
                return Candidate(str(pid))

        monkeypatch.setattr(
            delegate, "Path",
            lambda value: ProcRoot() if value == "/proc" else real_path(value))
        monkeypatch.setattr(
            delegate, "_process_table",
            lambda: {101: (1, "hidden"), 202: (1, "readable")})
        monkeypatch.setattr(
            delegate, "_process_start_identity", lambda pid: f"identity-{pid}")
        found = delegate._tagged_processes("owned")
    finally:
        sys.path.pop(0)
    assert found == {202: "identity-202"}


def test_live_process_identity_probe_failure_is_not_treated_as_exit(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        monkeypatch.setattr(
            delegate, "_process_start_identity", lambda _pid: None)
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: True)
        with pytest.raises(delegate.ProcessDiscoveryError):
            delegate._live_identified_processes({101: "identity"})
    finally:
        sys.path.pop(0)


def test_process_cleanup_fails_when_discovery_is_unavailable(
        repo):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        def unavailable():
            raise delegate.ProcessDiscoveryError("ps unavailable")

        stopped = delegate._terminate_processes_until_quiet(
            {}, unavailable)
    finally:
        sys.path.pop(0)
    assert stopped is False


def test_process_cleanup_reaps_known_process_when_discovery_fails(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        clock = {"now": 0.0}
        live = {101: "parent"}
        signals = []

        def unavailable():
            raise delegate.ProcessDiscoveryError("ps unavailable")

        def signal_processes(processes, signum=signal.SIGTERM):
            signals.extend((pid, signum) for pid in processes)
            if signum == signal.SIGKILL:
                live.clear()
            return dict(processes)

        monkeypatch.setattr(
            delegate, "_live_identified_processes",
            lambda known: {
                pid: identity for pid, identity in known.items()
                if live.get(pid) == identity
            })
        monkeypatch.setattr(
            delegate, "_signal_identified_processes", signal_processes)
        monkeypatch.setattr(
            delegate.time, "monotonic", lambda: clock["now"])
        monkeypatch.setattr(
            delegate.time, "sleep",
            lambda _seconds: clock.__setitem__("now", clock["now"] + 1))
        stopped = delegate._terminate_processes_until_quiet(
            {101: "parent"}, unavailable)
    finally:
        sys.path.pop(0)
    assert stopped is False
    assert signals == [(101, signal.SIGTERM), (101, signal.SIGKILL)]


def test_immediate_cleanup_signals_owned_group_before_discovery(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        events = []

        class FakeProcess:
            pid = 101

            def poll(self):
                return None

        def unavailable():
            events.append("discover")
            raise delegate.ProcessDiscoveryError("ps unavailable")

        monkeypatch.setattr(delegate, "_process_table", unavailable)
        monkeypatch.setattr(
            delegate, "_signal_verified_process_group",
            lambda _pid, _identity: events.append("signal") or True)
        monkeypatch.setattr(
            delegate, "_reap_observed_process_tree",
            lambda *_args, **_kwargs: events.append("reap") or False)
        stopped = delegate._terminate_observed_process_tree(
            FakeProcess(), "", {}, "leader")
    finally:
        sys.path.pop(0)
    assert stopped is False
    assert events == ["signal", "discover", "reap"]


def test_process_cleanup_discovers_children_spawned_during_termination(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        clock = {"now": 0.0}
        live = {101: "parent"}
        spawned = {"child": False}
        signals = []

        def discover():
            if clock["now"] >= 1 and not spawned["child"]:
                live.pop(101)
                live[102] = "child"
                spawned["child"] = True
            return dict(live)

        def identified(known):
            return {
                pid: identity for pid, identity in known.items()
                if live.get(pid) == identity
            }

        def signal_processes(processes, signum=signal.SIGTERM):
            signals.extend(
                (pid, identity, signum)
                for pid, identity in processes.items()
            )
            for pid in processes:
                if pid == 102 or signum == signal.SIGKILL:
                    live.pop(pid, None)
            return dict(processes)

        monkeypatch.setattr(delegate, "_live_identified_processes", identified)
        monkeypatch.setattr(
            delegate, "_signal_identified_processes", signal_processes)
        monkeypatch.setattr(
            delegate.time, "monotonic", lambda: clock["now"])
        monkeypatch.setattr(
            delegate.time, "sleep",
            lambda _seconds: clock.__setitem__("now", clock["now"] + 1))
        stopped = delegate._terminate_processes_until_quiet(
            {}, discover)
    finally:
        sys.path.pop(0)
    assert stopped is True
    assert spawned["child"] is True
    assert (101, "parent", signal.SIGTERM) in signals
    assert (102, "child", signal.SIGTERM) in signals


def test_wait_reuses_process_table_snapshot_for_tag_discovery(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        class FakeProcess:
            pid = 123

            def __init__(self):
                self.polls = 0

            def poll(self):
                self.polls += 1
                return None if self.polls == 1 else 0

        snapshots = [
            {123: (1, "leader")},
            {},
        ]
        seen = []

        def process_table():
            return snapshots.pop(0)

        def tagged(_marker_value, _baseline, current):
            seen.append(current)
            return {}

        monkeypatch.setattr(delegate, "_process_table", process_table)
        monkeypatch.setattr(delegate, "_tagged_processes", tagged)
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes",
            lambda *_args, **_kwargs: True)
        stopped = delegate._wait_and_reap(
            FakeProcess(), "marker", {}, "leader")
    finally:
        sys.path.pop(0)
    assert stopped is True
    assert seen == [
        {123: (1, "leader")},
        {},
    ]
    assert snapshots == []


def test_delegate_reaps_spawn_when_running_registration_fails(
        repo, tmp_path, monkeypatch):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        class FakeProcess:
            pid = 424242
            returncode = None

        fake_process = FakeProcess()
        lifecycle = []
        real_popen = subprocess.Popen

        def append(_base, record):
            status = record["launch_status"]
            lifecycle.append(f"append:{status}")
            if status == "running":
                raise OSError("protected ledger unavailable")

        def reap(proc, _marker_value, _baseline, _foreground_identity):
            lifecycle.append("reap")
            proc.returncode = 130
            return True

        monkeypatch.setattr(delegate, "append_delegation", append)
        monkeypatch.setattr(
            delegate, "companion_script", lambda: tmp_path / "companion.mjs")
        monkeypatch.setattr(delegate.shutil, "which", lambda _name: "/usr/bin/true")
        def spawn(args, *spawn_args, **spawn_kwargs):
            if args and args[0] == "/usr/bin/true":
                return fake_process
            return real_popen(args, *spawn_args, **spawn_kwargs)

        monkeypatch.setattr(delegate.subprocess, "Popen", spawn)
        monkeypatch.setattr(delegate, "_process_table", lambda: {})
        monkeypatch.setattr(
            delegate, "_process_start_identity", lambda _pid: "identity")
        monkeypatch.setattr(
            delegate, "_terminate_observed_process_tree", reap)
        monkeypatch.setattr(
            delegate, "_process_group_alive", lambda _pgid: False)
        args = argparse.Namespace(
            repo=str(repo),
            id="T1",
            read_only=False,
            background=False,
            print_only=False,
        )
        with pytest.raises(SystemExit):
            delegate.cmd_delegate(args)
    finally:
        sys.path.pop(0)
    assert lifecycle == [
        "append:starting",
        "append:running",
        "reap",
        "append:failed",
    ]


def test_stale_launch_reconciliation_refuses_unverified_process_group(
        repo, monkeypatch, capsys):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        entry = {
            "task": "T1", "write": True, "launch_id": "old",
            "launch_status": "running", "pid": 123, "pgid": 456,
        }
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: False)
        monkeypatch.setattr(delegate, "_process_group_alive", lambda _pgid: True)
        with pytest.raises(SystemExit):
            delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert "will not signal an unverified reused group" in capsys.readouterr().out


def test_stale_launch_reconciliation_does_not_signal_a_reused_pid(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        entry = {
            "task": "T1", "write": True, "launch_id": "old",
            "launch_status": "running", "pid": 123, "pgid": 123,
            "pid_started": "Mon Jul 27 10:00:00 2026",
        }
        recorded = []
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: True)
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda _pid: "Tue Jul 28 10:00:00 2026",
        )
        monkeypatch.setattr(
            delegate, "append_delegation",
            lambda _base, record: recorded.append(record),
        )
        delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert recorded[-1]["launch_status"] == "failed"


def test_delegate_ignores_stale_lock_contents_when_no_process_holds_it(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    lock = delegation_lock(repo, "T1")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("")
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    assert lock.exists()


def test_stage_close_exclusion_blocks_a_new_delegate(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.delegate import delegation_exclusion
        with delegation_exclusion(repo, "T1", kind="stage-close"):
            code, out = run(repo, "forge.py", "delegate", "T1",
                            env={"HOME": str(fake_companion_home(tmp_path))})
            start_code, start_out = run(repo, "forge.py", "stage", "start", "T1")
    finally:
        sys.path.pop(0)
    assert code != 0 and "active protected lock" in out
    assert start_code != 0 and "active protected lock" in start_out


def test_protected_lock_path_rejects_unsafe_task_id(repo):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.delegate import delegation_lock_path
        with pytest.raises(SystemExit):
            delegation_lock_path(repo, "../../../package")
    finally:
        sys.path.pop(0)


@pytest.mark.parametrize("wrapper_signal", [
    signal.SIGINT,
    signal.SIGTERM,
    signal.SIGHUP,
    signal.SIGQUIT,
])
def test_termination_signals_reap_companion_before_lock_release(
        repo, tmp_path, wrapper_signal):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    home = fake_companion_home(tmp_path)
    companion = next(home.glob(
        ".claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs"))
    companion.write_text(
        ("process.on('SIGTERM', () => {});\n"
         if wrapper_signal == signal.SIGTERM else "")
        + "setInterval(() => {}, 1000);\n"
    )
    proc = subprocess.Popen(
        [sys.executable, str(repo / "factory/scripts/forge.py"),
         "delegate", "T1"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "HOME": str(home)},
    )
    lock = delegation_lock(repo, "T1")
    latest = {}
    for _ in range(100):
        if lock.exists() and delegation_ledger(repo).exists():
            latest = json.loads(
                delegation_ledger(repo).read_text().splitlines()[-1])
            if latest.get("launch_status") == "running":
                break
        threading.Event().wait(0.05)
    assert lock.exists() and latest["launch_status"] == "running"
    proc.send_signal(wrapper_signal)
    proc.communicate(timeout=10)
    assert proc.returncode != 0
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.delegate import _lock_is_held
        assert not _lock_is_held(lock)
    finally:
        sys.path.pop(0)
    terminal = json.loads(delegation_ledger(repo).read_text().splitlines()[-1])
    assert terminal["launch_status"] == "failed"


def test_read_only_diagnostic_does_not_revoke_write_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    home = str(fake_companion_home(tmp_path))
    code, out = run(repo, "forge.py", "delegate", "T1", "--read-only",
                    env={"HOME": home})
    assert code == 0, out
    write_in_scope(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_delegate_missing_companion_guides_doctor_fix(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(tmp_path / "empty-home")})
    assert code != 0 and "doctor --fix" in out


def test_delegate_refuses_background_write_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    code, out = run(repo, "forge.py", "delegate", "T1", "--background",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code != 0 and "background write delegation" in out
    assert not (repo / ".factory" / "delegations.jsonl").exists()
    assert not delegation_ledger(repo).exists()


def test_codex_status_reports_write_flag_and_stall(repo, tmp_path):
    """The registry already recorded everything needed to see a stalled run —
    status, phase, the write flag, timestamps. Nothing read it."""
    start_stage(repo, tmp_path, STAGE_TASK)
    jobs = tmp_path / "state" / "proj-abc" / "jobs"
    jobs.mkdir(parents=True)
    (jobs / "task-1.json").write_text(json.dumps({
        "id": "task-1", "workspaceRoot": str(repo), "status": "running",
        "phase": "thinking", "write": False, "startedAt": "2020-01-01T00:00:00Z",
        "logFile": "/tmp/task-1.log"}))
    (jobs / "task-2.json").write_text(json.dumps({
        "id": "task-2", "workspaceRoot": "/somewhere/else", "status": "running",
        "write": True, "startedAt": "2020-01-01T00:00:00Z"}))
    code, out = run(repo, "forge.py", "codex", "status",
                    "--state-root", str(tmp_path / "state"))
    assert code == 0, out                       # advisory: never fails a gate
    assert "task-1" in out and "task-2" not in out   # this repo's jobs only
    assert "write=no" in out and "STALLED?" in out and "READ-ONLY" in out
    # a missing registry degrades to a clear unknown, still exit 0
    code, out = run(repo, "forge.py", "codex", "status",
                    "--state-root", str(tmp_path / "nope"))
    assert code == 0 and "unknown" in out


def test_codex_status_uses_inactivity_instead_of_total_runtime(repo, tmp_path):
    jobs = tmp_path / "state" / "proj-abc" / "jobs"
    jobs.mkdir(parents=True)
    (jobs / "task-1.json").write_text(json.dumps({
        "id": "task-1", "workspaceRoot": str(repo), "status": "running",
        "phase": "implementing", "write": True,
        "startedAt": "2020-01-01T00:00:00Z",
    }))
    project = jobs.parent
    project.joinpath("state.json").write_text(json.dumps({"jobs": [{
        "id": "task-1", "updatedAt": "2999-01-01T00:00:00Z",
    }]}))
    code, out = run(repo, "forge.py", "codex", "status",
                    "--state-root", str(tmp_path / "state"))
    assert code == 0 and "task-1" in out and "STALLED?" not in out
    project.joinpath("state.json").write_text(json.dumps({"jobs": [{
        "id": "task-1", "updatedAt": "2020-01-01T00:01:00Z",
    }]}))
    code, out = run(repo, "forge.py", "codex", "status",
                    "--state-root", str(tmp_path / "state"))
    assert code == 0 and "STALLED?" in out and "no progress" in out
    project.joinpath("state.json").write_text(json.dumps({"jobs": [{
        "id": "task-1", "updatedAt": {"malformed": True},
    }]}))
    code, out = run(repo, "forge.py", "codex", "status",
                    "--state-root", str(tmp_path / "state"))
    assert code == 0 and "task-1" in out


def test_doctor_flags_skill_missing_for_codex_runtime(repo, tmp_path):
    """The harness refuses a user-facing artifact whose skills_used omits
    emil-design-eng, while the runtime asked to attest it cannot load it."""
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.doctor import skills_missing_per_runtime
    finally:
        sys.path.pop(0)
    home = tmp_path / "home"
    for rel in (".claude/skills/emil-design-eng", ".claude/skills/frontend-design",
                ".codex/skills/frontend-design"):
        (home / rel).mkdir(parents=True)
        (home / rel / "SKILL.md").write_text("rules\n")
    # a directory with no SKILL.md is not a loadable skill
    (home / ".codex" / "skills" / "emil-design-eng").mkdir(parents=True)
    missing = skills_missing_per_runtime(repo, home=home)
    assert ("codex", "emil-design-eng") in missing
    assert ("claude", "emil-design-eng") not in missing
    assert not [m for m in missing if m[1] == "frontend-design"]
    assert ("codex", "review-animations") in missing
    assert ("claude", "review-animations") not in missing
    advisory = skills_missing_per_runtime(repo, home=home, advisory=True)
    for skill in ("apple-design", "animation-vocabulary"):
        assert ("claude", skill) in advisory
        assert ("codex", skill) in advisory


def test_next_names_delegation_step(repo, tmp_path):
    """Part of why the harness got skipped is that the delegation step was
    never printed anywhere — so "what should I have done" had no answer to
    point at."""
    start_stage(repo, tmp_path, STAGE_TASK)
    code, out = run(repo, "forge.py", "next")
    assert code == 0, out
    assert "forge delegate T1" in out and "forge codex status" in out
    run(repo, "forge.py", "stage", "done", "T1", "--incomplete", "retry path missing")
    code, out = run(repo, "forge.py", "next")
    assert "INCOMPLETE" in out and "retry path missing" in out


def test_plan_save_refuses_a_plan_missing_any_required_section(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "plan.md"

    for missing in PLAN_SECTIONS:
        body = "\n\n".join(
            f"## {section}\nComplete."
            for section in PLAN_SECTIONS if section != missing
        )
        plan.write_text(plan_draft(repo, body=body))
        record_grill(repo, "plan", digest_of=plan)
        code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
        assert code != 0 and missing in out, (missing, out)


def test_plan_save_names_every_missing_section(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "plan.md"
    present = {"Problem", "Technical Approach", "Decisions", "Verify Plan"}
    body = "\n\n".join(
        f"## {section}\n" + (" \t" if section == "Scope / Non-goals" else "Complete.")
        for section in PLAN_SECTIONS
        if section in present or section == "Scope / Non-goals"
    )
    plan.write_text(plan_draft(repo, body=body))
    record_grill(repo, "plan", digest_of=plan)

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))

    missing = [section for section in PLAN_SECTIONS if section not in present]
    assert code != 0
    assert all(section in out for section in missing), out
    assert all(section not in out for section in present), out


def test_archived_plans_are_not_held_to_a_later_contract(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    archived = repo / "plans" / "completed" / "FORGE-INIT-1-init.md"
    archived.parent.mkdir(parents=True, exist_ok=True)
    historical = "---\nissue: FORGE-INIT-1\nstatus: shipped\n---\n\n## Decisions\nNone.\n"
    archived.write_text(historical)

    code, out = save_plan(repo, tmp_path)

    assert code == 0, out
    assert archived.read_text() == historical


def test_plan_ledgers_are_not_plans(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ledgers = {
        repo / "plans" / "README.md": "# Plans\n",
        repo / "plans" / "assumptions.md": "# Assumptions\n",
        repo / "plans" / "deferrals.md": "# Deferrals\n",
    }
    for path, content in ledgers.items():
        path.write_text(content)

    code, out = save_plan(repo, tmp_path)

    assert code == 0, out
    assert all(path.read_text() == content for path, content in ledgers.items())


def test_refactor_ratchet_blocks_growing_refactors(repo, tmp_path):
    import_roadmap(repo, tmp_path, {
        "generated_by": "docs-decomposer", "epics": [ROADMAP_EPIC], "items": [
            authored_story("REF-1", "Shrink the api layer", kind="refactor"),
        ]})
    # invalid kind refused at grooming time
    code, out = run(repo, "forge.py", "roadmap", "add", "X-1", "t", "--kind", "cleanup",
                    "--story", "As a dev, I keep the api small.", "--ac", "smaller",
                    "--epic", "billing")
    assert code != 0 and "kind" in out
    git(repo, "checkout", "-q", "-b", "feat/REF-1-shrink")
    intake(repo, "REF-1", "Shrink the api layer")
    save_plan(repo, tmp_path)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "grew.ts").write_text("line\n" * 40)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "feat(REF-1): work")
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "refactor ratchet" in out and "+40" in out
    # deleting more than it adds passes the ratchet
    (repo / "src" / "grew.ts").unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "refactor(REF-1): actually shrink")
    write_passing_artifacts(repo)
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_deferral_ledger_add_list_resolve_strict(repo):
    code, out = run(repo, "forge.py", "defer", "add", "profile GC",
                    "--why", "entangled with scheduler", "--trigger", "")
    assert code != 0 and "--trigger" in out
    code, out = run(repo, "forge.py", "defer", "add", "profile GC",
                    "--why", "entangled with scheduler",
                    "--trigger", "storage pressure on fleet")
    assert code == 0 and "D-0001" in out
    code, out = run(repo, "forge.py", "next")
    assert "deferred item(s)" in out
    code, out = run(repo, "forge.py", "defer", "resolve", "D-0001",
                    "--notes", "back on the roadmap as GC-1")
    assert code == 0
    code, out = run(repo, "forge.py", "defer", "list", "--open")
    assert code == 0 and "D-0001" not in out
    # malformed row fails loudly
    path = repo / "plans" / "deferrals.md"
    path.write_text(path.read_text() + "| D-0002 | broken row |\n")
    code, out = run(repo, "forge.py", "defer", "list")
    assert code != 0 and "malformed" in out


def test_precompact_scratchpad_snapshots_facts_and_findings(repo, tmp_path):
    # empty project: hook must not crash, snapshot says uninitialized
    code, out = run(repo, "pre_compact.py", stdin=json.dumps({"trigger": "auto"}))
    assert code == 0, out
    pad = repo / ".factory" / "scratchpad.md"
    assert "Active task" in pad.read_text()
    # live task with signals, assumptions, stages, and a recurring class
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    run(repo, "forge.py", "stage", "start", "T1")
    run(repo, "forge.py", "plan", "assume", "cache TTL is 60s")
    run(repo, "forge.py", "signal", "raise", "--kind", "blocked",
        "--by", "implementer", "-m", "migrations dir is missing")
    hist = repo / ".factory" / "history"
    for issue in ("ENG-7", "ENG-8", "ENG-9"):
        d = hist / issue / "reviews"
        d.mkdir(parents=True)
        (d / "quality.json").write_text(json.dumps({"blocking_findings": [
            {"category": "validation-gap", "area": "api", "summary": "s"}]}))
    code, out = run(repo, "pre_compact.py", stdin=json.dumps({"trigger": "manual"}))
    assert code == 0, out
    text = pad.read_text()
    assert "ENG-1" in text and "0/1 done" in text
    assert "migrations dir is missing" in text        # open signal survives
    assert "cache TTL is 60s" in text                 # unguided assumption survives
    assert "RECURRING x3: validation-gap" in text     # findings survive
    assert "forge next" in text                       # re-derivation pointer
    # the post-compaction session start surfaces the scratchpad
    code, out = run(repo, "session_start.py", stdin=json.dumps({"source": "compact"}))
    assert code == 0 and "scratchpad" in out.lower()
    # agent working notes survive snapshot rewrites; facts refresh around them
    code, out = run(repo, "forge.py", "note", "suspect the retry loop double-fires")
    assert code == 0, out
    import re as _re
    sig_id = _re.search(r"S-0001-[0-9a-f]{4}",
                        (repo / ".factory" / "signals.jsonl").read_text()).group(0)
    run(repo, "forge.py", "signal", "resolve", sig_id,
        "--notes", "created the migrations dir")
    code, out = run(repo, "pre_compact.py", stdin=json.dumps({"trigger": "auto"}))
    assert code == 0, out
    text = pad.read_text()
    assert "suspect the retry loop double-fires" in text  # note preserved
    assert "migrations dir is missing" not in text        # resolved fact refreshed away
    # a shipped task wipes the pad — session noise never crosses tasks
    run(repo, "forge.py", "stage", "done", "T1")
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    run(repo, "forge.py", "assumptions", "resolve", "A-0001",
        "--status", "confirmed", "--notes", "60s confirmed with EM")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    assert not pad.exists()


def test_upgrade_preserves_client_claude_and_codex_surfaces(repo, tmp_path):
    # the client grows its OWN Claude Code surfaces after adoption
    (repo / ".claude" / "skills" / "own-client-skill").mkdir(parents=True, exist_ok=True)
    (repo / ".claude" / "skills" / "own-client-skill" / "SKILL.md").write_text("client skill")
    (repo / ".claude" / "skills" / "own-client-skill" / "mocking.md").write_text("ref file")
    (repo / ".claude" / "agents").mkdir(exist_ok=True)
    (repo / ".claude" / "agents" / "own-gatekeeper.md").write_text("client agent")
    (repo / ".claude" / "launch.json").write_text("{}")
    (repo / ".codex" / "agents" / "client-custom.toml").write_text("client toml")
    (repo / "factory" / "skills" / "own-agents-skill").mkdir(parents=True, exist_ok=True)
    (repo / "factory" / "skills" / "own-agents-skill" / "SKILL.md").write_text("client agents skill")
    # ...and locally drifts a harness-owned file (must be refreshed)
    (repo / ".claude" / "skills" / "forge" / "SKILL.md").write_text("stale local edit")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "client surfaces + drift")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # client-owned surfaces survive
    assert (repo / ".claude" / "skills" / "own-client-skill" / "mocking.md").read_text() == "ref file"
    assert (repo / ".claude" / "agents" / "own-gatekeeper.md").read_text() == "client agent"
    assert (repo / ".claude" / "launch.json").exists()
    assert (repo / ".codex" / "agents" / "client-custom.toml").read_text() == "client toml"
    # harness-owned paths are refreshed, not left drifted
    assert "stale local edit" not in (repo / ".claude" / "skills" / "forge" / "SKILL.md").read_text()
    assert (repo / ".claude" / "settings.json").exists()
    # client-installed factory/skills survive; harness-shipped ones refresh
    assert (repo / "factory" / "skills" / "own-agents-skill" / "SKILL.md").read_text() == "client agents skill"
    assert (repo / "factory" / "skills" / "forge.md").exists()
    # vendoring never ships build noise
    assert not list((repo / "factory").rglob("__pycache__"))
    assert not list((repo / "factory").rglob("*.pyc"))


def test_repo_budget_refuses_tracked_build_noise(repo):
    pyc = repo / "factory" / "scripts" / "__pycache__"
    pyc.mkdir(parents=True)
    (pyc / "factory_lib.cpython-312.pyc").write_bytes(b"\x00")
    git(repo, "add", "-f", "-A")
    git(repo, "commit", "-q", "-m", "sneak bytecode past gitignore")
    code, out = run(repo, "check_repo_budget.py", str(repo))
    assert code != 0 and "build/tool noise" in out and "git rm --cached" in out


def test_machine_readiness_checked_every_session(repo, tmp_path):
    import os
    bare_home = tmp_path / "bare-home"
    bare_home.mkdir()
    env = {**os.environ, "HOME": str(bare_home)}
    # fast doctor: pure existence checks, nonzero on missing required tools
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "forge.py"),
         "doctor", "--fast"], cwd=repo, env=env, capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0
    assert "codex-plugin-cc" in out and "autoreview" in out and "--fix" in out
    # the session hook banners it on EVERY session in a fresh clone
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / "session_start.py")],
        cwd=repo, env=env, capture_output=True, text=True, input="{}")
    assert proc.returncode == 0 and "MACHINE NOT READY" in proc.stdout


def test_session_start_injects_project_memory_plan_and_quickfix(repo, tmp_path):
    memory = repo / "docs" / "memory" / "MEMORY.md"
    assert memory.exists()
    memory.write_text("# Project Memory\n\nThe billing cutoff is 17:00 UTC.\n")
    sign_off(repo)
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    code, out = run(repo, "forge.py", "quickfix", "start", "adjust cutoff")
    assert code == 0, out
    code, out = run(repo, "session_start.py", stdin="{}")
    assert code == 0, out
    context = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "PROJECT MEMORY" in context
    assert "billing cutoff is 17:00 UTC" in context
    assert "plans/active/ENG-1-invoices.md" in context
    assert "Story: ENG-1" in context
    assert "OPEN QUICKFIX" in context and "adjust cutoff" in context


def test_board_serves_live_lifecycle_state(repo, tmp_path):
    sign_off(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    (repo / ".factory" / "stages.json").write_text(json.dumps({
        "issue": "ENG-1",
        "stages": [{"id": "T1", "status": "done"}, {"id": "T2", "status": "pending"}],
    }))
    run(repo, "forge.py", "signal", "raise", "--kind", "blocked",
        "--by", "implementer", "-m", "waiting for fixture")
    run(repo, "forge.py", "quickfix", "start", "board fixture")

    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import make_server
    server = make_server(repo, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        state = json.loads(urllib.request.urlopen(
            f"{base_url}/api/state", timeout=5).read())
        story = next(item for item in state["stories"] if item["key"] == "ENG-1")
        assert state["frontier"] == []
        assert story["plan"]["location"] == "active"
        assert story["lifecycle"]["spec"] == "confirmed"
        assert story["lifecycle"]["stages"] == {"done": 1, "total": 2}
        assert state["signals"] and state["quickfix"]["reason"] == "board fixture"

        roadmap = json.loads((repo / "plans" / "roadmap.json").read_text())
        next(item for item in roadmap["items"] if item["key"] == "ENG-1")["status"] = "done"
        (repo / "plans" / "roadmap.json").write_text(json.dumps(roadmap))
        refreshed = json.loads(urllib.request.urlopen(
            f"{base_url}/api/state", timeout=5).read())
        refreshed_story = next(
            item for item in refreshed["stories"] if item["key"] == "ENG-1")
        assert refreshed_story["lifecycle"]["shipped"] is True

        # project rollup: every story lands in exactly one state, and the
        # things a human must act on are counted apart from graph blockage
        summary = refreshed["summary"]
        assert summary["stories"]["total"] == sum(
            summary["stories"][state] for state in
            ("shipped", "building", "ready", "waiting", "blocked"))
        assert summary["stories"]["shipped"] == sum(
            1 for item in refreshed["stories"] if item["state"] == "shipped")
        # every story is counted under exactly one epic bucket
        assert sum(e["total"] for e in summary["epics"]) == summary["stories"]["total"]
        assert summary["attention"]["contradictions"] == [
            s["id"] for s in refreshed["signals"] if s["kind"] == "contradiction"]
        # the deterministic next actions and live decision corpus travel too
        assert refreshed["next"]["phase"] and isinstance(refreshed["next"]["steps"], list)
        assert all(d["status"] == "accepted" for d in refreshed["decisions"])

        # per-story artifacts load lazily, keyed off the roadmap not a path
        detail = json.loads(urllib.request.urlopen(
            f"{base_url}/api/story/ENG-1", timeout=5).read())
        assert detail["key"] == "ENG-1" and "## Surface Impact" in detail["plan_body"]
        assert {c["label"] for c in detail["readiness"]} >= {"plan saved"}
        try:
            urllib.request.urlopen(f"{base_url}/api/story/nope", timeout=5)
            raise AssertionError("unknown story must 404")
        except urllib.error.HTTPError as exc:
            assert exc.code == 404

        # quickfix history: the ledger carries CLOSED windows only, so the
        # window opened above is still in `quickfix` and absent from it until
        # `quickfix done` files it.
        assert refreshed["quickfix"]["id"] not in {
            event["id"] for event in refreshed["quickfix_ledger"]}
        run(repo, "forge.py", "quickfix", "done")
        closed = json.loads(urllib.request.urlopen(
            f"{base_url}/api/state", timeout=5).read())
        assert closed["quickfix"] is None
        assert refreshed["quickfix"]["id"] in {
            event["id"] for event in closed["quickfix_ledger"]}

        page = urllib.request.urlopen(base_url, timeout=5).read().decode()
        # Structural anchors, not prose: the page polls /api/state and mounts
        # the regions the aggregator feeds.
        assert "setInterval" in page and "/api/state" in page
        assert 'id="lanes"' in page and 'id="drawer"' in page
        assert 'id="library"' in page
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_adopt_normalizes_case_variant_contract_files(repo, tmp_path):
    target = tmp_path / "legacy"
    target.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=target, check=True)
    (target / "agents.md").write_text("# old lowercase rules\nproject standards here\n")
    (target / "README.md").write_text("app\n")
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "pre-harness")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "adopt", "--target", str(target), "--name", "legacy"],
        cwd=HARNESS, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # canonical CAPS name on disk (readdir, not open-by-name: case-insensitive
    # filesystems would lie to an exists() check)
    names = {p.name for p in target.iterdir()}
    assert "AGENTS.md" in names and "agents.md" not in names
    # the old rules are preserved for rehoming, and the output demands it
    assert (target / "docs" / "context" / "migrated-AGENTS.md").read_text().startswith("# old lowercase rules")
    assert "REHOME" in proc.stdout and "not disposal" in proc.stdout.replace("is not", "not")


# -------------------------------------------------- loop-health audit (0008)

def shipped_reviews(repo: Path, task: str, findings: list) -> None:
    d = repo / ".factory" / "history" / task / "reviews"
    d.mkdir(parents=True, exist_ok=True)
    (d / "quality.json").write_text(json.dumps(
        {"score": 9, "blocking_findings": [], "non_blocking_findings": findings}))


def test_audit_flags_ignored_escalation_until_routed(repo):
    # A class goes RECURRING at T-03; T-04 ships past it with no consolidation.
    finding = {"category": "validation-gap", "area": "api", "summary": "s"}
    for task in ("T-01", "T-02", "T-03"):
        shipped_reviews(repo, task, [finding])
    (repo / ".factory" / "history" / "T-04").mkdir()
    code, out = run(repo, "forge.py", "audit")
    assert code == 0 and "IGNORED ESCALATION" in out and "T-03" in out, out
    # Routing it — a decision naming the class — clears the audit.
    (repo / "docs" / "decisions" / "0100-validation-invariant.md").write_text(
        "---\nstatus: proposed\nconfirmed_by: \"\"\ndate: 2026-07-22\n---\n"
        "# API validation invariant\n\nConsolidates the validation-gap class.\n")
    code, out = run(repo, "forge.py", "audit")
    assert code == 0 and "IGNORED ESCALATION" not in out, out


def test_audit_flags_stale_deferral_and_next_surfaces_count(repo):
    code, out = run(repo, "forge.py", "defer", "add", "bulk export",
                    "--why", "cycle-sized", "--trigger", "second tenant")
    assert code == 0, out
    code, out = run(repo, "forge.py", "audit")
    assert "STALE DEFERRAL" not in out  # fresh deferral is healthy
    ledger = repo / "plans" / "deferrals.md"
    row = next(line for line in ledger.read_text().splitlines() if line.startswith("| D-"))
    ledger.write_text(ledger.read_text().replace(row.split(" | ")[1], "2020-01-01"))
    code, out = run(repo, "forge.py", "audit")
    assert code == 0 and "STALE DEFERRAL" in out and "D-0001" in out, out
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "loop-health audit" in out, out


def test_audit_flags_decayed_lesson_globs(repo):
    for topic, lesson, glob in (
        ("dead-glob", "Renamed away long ago", "src/legacy-api/**"),
        ("live-glob", "Contract file rules", "AGENTS.md"),
    ):
        code, out = run(repo, "forge.py", "lesson", "add", "--topic", topic,
                        "--lesson", lesson, "--source", "abc1234",
                        "--applies-to", glob, "--severity", "low", "--by", "implementer")
        assert code == 0, out
    code, out = run(repo, "forge.py", "audit")
    assert code == 0 and "DECAYED LESSON" in out and "dead-glob" in out, out
    assert "live-glob" not in out


def test_audit_flags_review_drift_on_latest_task_only(repo):
    # Early task predates structured findings — tolerated. Latest one is judged.
    shipped_reviews(repo, "T-01", ["legacy string finding"])
    code, out = run(repo, "forge.py", "audit")
    assert "REVIEW DRIFT" in out and "T-01" in out, out
    shipped_reviews(repo, "T-02", [{"category": "perf", "area": "db", "summary": "s"}])
    code, out = run(repo, "forge.py", "audit")
    assert "REVIEW DRIFT" not in out, out


# ----------------------------------------------- frozen-gate integrity (0009)

def test_scaffold_freezes_gate_surface_and_check_verifies(repo):
    manifest = repo / "constitution" / "VENDOR_MANIFEST.json"
    assert manifest.exists()  # forge init armed it from birth
    files = json.loads(manifest.read_text())["files"]
    assert "factory/scripts/verify.py" in files and "forge" in files
    assert not any("__pycache__" in f or f.endswith(".pyc") for f in files)
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out
    # edited gate file -> drift
    verify = repo / "factory" / "scripts" / "verify.py"
    verify.write_text(verify.read_text() + "# weakened\n")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "edited: factory/scripts/verify.py" in out and "upstream" in out, out
    # unexpected file in the gate surface -> drift too
    git(repo, "checkout", "--", "factory/scripts/verify.py")
    (repo / "factory" / "prompts" / "rogue.md").write_text("softer review\n")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "unexpected: factory/prompts/rogue.md" in out, out
    # no manifest -> unarmed, advisory only
    (repo / "factory" / "prompts" / "rogue.md").unlink()
    manifest.unlink()
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "unarmed" in out, out


def test_pr_ready_refuses_drifted_gate_surface(repo, tmp_path):
    ready_task(repo, tmp_path)
    prompt = repo / "factory" / "prompts" / "reviewer.md"
    prompt.write_text(prompt.read_text() + "\nScore generously.\n")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "vendor integrity" in out and "reviewer.md" in out, out
    # the SessionStart hook warns about the same drift at session start
    code, out = run(repo, "session_start.py", stdin="{}")
    assert code == 0 and "GATE SURFACE DRIFTED" in out, out
    git(repo, "checkout", "--", "factory/prompts/reviewer.md")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_adopt_and_upgrade_refreeze_the_manifest(repo, tmp_path):
    # adopt arms a migrated repo
    legacy = existing_repo(tmp_path)
    code, out = adopt(legacy)
    assert code == 0, out
    assert (legacy / "constitution" / "VENDOR_MANIFEST.json").exists()
    code, out = run(legacy, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out
    # a drifted client repo comes back clean after re-vendoring
    verify = repo / "factory" / "scripts" / "verify.py"
    verify.write_text(verify.read_text() + "# local patch\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "drift")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out


# --------------------------------------------------- README onboarding section

def test_onboarding_section_created_at_init_and_never_duplicated(repo):
    # forge init writes the prompt-first onboarding README from birth
    readme = repo / "README.md"
    assert readme.exists()
    assert "Working in this repo — Symphony Forge" in readme.read_text()
    assert '"what now?"' in readme.read_text()
    # a project that rewrote its README keeps its content; upgrade appends once
    readme.write_text("# app\n\nProject-specific orientation.\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "project readme")
    for i in range(2):  # idempotent: a second upgrade must not duplicate
        proc = subprocess.run(
            [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
             "upgrade", "--target", str(repo)],
            cwd=HARNESS, capture_output=True, text=True)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"upgrade {i}", "--allow-empty")
    text = readme.read_text()
    assert text.startswith("# app\n")
    assert text.count("Working in this repo — Symphony Forge") == 1


def _init(target: Path, *extra: str):
    return subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "app", "--target", str(target), *extra],
        capture_output=True, text=True,
    )


def _copy_harness_source(tmp_path: Path) -> Path:
    # Copy ONLY the harness-owned surface init/adopt read, never the whole repo:
    # in a vendored client CI, HARNESS is the CLIENT root, so a wholesale copy
    # would duplicate the client's deps/build trees and choke on client symlinks.
    from forge_cli.scaffold import (
        COPY_CLAUDE, COPY_CODEX, COPY_FILES, COPY_WORKFLOWS, DOC_CONTRACTS,
        INIT_COPY_TREES, PROJECT_STARTERS,
    )
    source = tmp_path / "source"
    source.mkdir()
    ignore = shutil.ignore_patterns(".git", ".factory", "__pycache__", "*.pyc")
    rels = {
        *INIT_COPY_TREES,
        *(f".claude/{name}" for name in COPY_CLAUDE),
        *(f".codex/{name}" for name in COPY_CODEX),
        *COPY_WORKFLOWS, *COPY_FILES,
        *(src for src, _ in DOC_CONTRACTS), *PROJECT_STARTERS,
        "AGENTS.md",
    }
    for rel in sorted(rels):
        src = HARNESS / rel
        if not src.exists():
            continue
        dst = source / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    return source


def test_init_into_nonempty_noncolliding_target(tmp_path: Path):
    # A new repo with a commit of its own docs must not trip the guard
    target = tmp_path / "app"
    spec = target / "docs" / "notes" / "spec.md"
    spec.parent.mkdir(parents=True)
    spec.write_text("# pre-existing spec\n")
    custom = target / ".codex" / "custom.toml"
    custom.parent.mkdir(parents=True)
    custom.write_text("local = true\n")  # non-gate .codex content is legal
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    proc = _init(target)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert spec.read_text() == "# pre-existing spec\n"
    assert custom.read_text() == "local = true\n"


def test_init_vendors_only_the_harness_owned_skill_not_a_source_decoy(
    tmp_path: Path, monkeypatch,
):
    source = _copy_harness_source(tmp_path)
    (source / "DECOY.md").write_text("# Source-only canon\n")
    for runtime in (".claude", ".codex"):
        decoy = source / runtime / "skills" / "decoy" / "SKILL.md"
        decoy.parent.mkdir(parents=True)
        decoy.write_text("# Decoy\n\n<!-- canon: DECOY.md -->\n")

    from forge_cli import scaffold
    monkeypatch.setattr(scaffold, "repo_root", lambda: source)
    target = tmp_path / "app"
    scaffold.cmd_init(argparse.Namespace(
        name="app", target=str(target), force=False, stack="nestjs-react",
    ))

    assert {
        str(path.relative_to(target / ".claude"))
        for path in (target / ".claude").rglob("*") if path.is_file()
    } == {"CLAUDE.md", "settings.json", "skills/forge/SKILL.md"}
    assert {
        path.parent.name
        for path in (target / ".codex" / "skills").glob("*/SKILL.md")
    } == {"forge"}
    code, out = run(target, "check_dual_runtime.py", str(target))
    assert code == 0, out


def test_vendored_scaffold_check_is_clean_in_a_client_repo_with_its_own_skill(
    tmp_path: Path, monkeypatch,
):
    source = _copy_harness_source(tmp_path)
    canon = source / "skills" / "client-skill" / "SKILL.md"
    canon.parent.mkdir(parents=True)
    canon.write_text("# Client skill canon\n")
    client_skill = source / ".claude" / "skills" / "client-skill" / "SKILL.md"
    client_skill.parent.mkdir(parents=True)
    client_skill.write_text(
        "# Client skill\n\n<!-- canon: skills/client-skill/SKILL.md -->\n"
    )

    from forge_cli import scaffold
    monkeypatch.setattr(scaffold, "repo_root", lambda: source)
    target = tmp_path / "app"
    scaffold.cmd_init(argparse.Namespace(
        name="app", target=str(target), force=False, stack="nestjs-react",
    ))

    assert not (target / ".claude" / "skills" / "client-skill").exists()
    code, out = run(target, "check_dual_runtime.py", str(target))
    assert code == 0, out

    # The scaffold is clean because init EXCLUDED the client skill — not because
    # the checker is toothless. A legitimate client skill (runtime + its canon
    # target both present) is accepted...
    owned = target / ".claude" / "skills" / "client-skill" / "SKILL.md"
    owned.parent.mkdir(parents=True)
    owned.write_text("# Client skill\n\n<!-- canon: skills/client-skill/SKILL.md -->\n")
    owned_canon = target / "skills" / "client-skill" / "SKILL.md"
    owned_canon.parent.mkdir(parents=True)
    owned_canon.write_text("# Client skill canon\n")
    code, out = run(target, "check_dual_runtime.py", str(target))
    assert code == 0, out

    # ...while the reported failure — the client skill dragged in WITHOUT its
    # root canon target (init's old wholesale copy) — is caught. So the clean
    # result above proves init's filtering, and the checker really gates it.
    owned_canon.unlink()
    code, out = run(target, "check_dual_runtime.py", str(target))
    assert code != 0 and "client-skill" in out


def test_fixture_bound_tests_skip_in_a_fixture_free_client_scaffold(
    tmp_path: Path, monkeypatch,
):
    # The client-CI guarantee is a PYTEST guarantee, not only a dual-runtime one:
    # the FORGE-INIT-1-bound tests must SKIP (never fail) in a repo without that
    # fixture. Scaffold a fixture-free target and run just those tests from its
    # own vendored suite, proving the skip guards fire where the fixture is absent.
    from forge_cli import scaffold
    monkeypatch.setattr(scaffold, "repo_root", lambda: _copy_harness_source(tmp_path))
    target = tmp_path / "app"
    scaffold.cmd_init(argparse.Namespace(
        name="app", target=str(target), force=False, stack="nestjs-react",
    ))
    assert not (target / ".factory" / "history" / "FORGE-INIT-1").exists()

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "factory/tests/test_gates.py",
         "-p", "no:cacheprovider", "-q", "-k",
         "historical_decomposition_artifacts_still_parse or "
         "precontract_stories_are_marked_without_synthesized_outcomes or "
         "shipped_roadmap_satisfies_the_story_contract"],
        cwd=target, capture_output=True, text=True,
        env={**os.environ, "PYTEST_ADDOPTS": "-o tmp_path_retention_policy=none"},
    )
    out = result.stdout + result.stderr
    assert result.returncode == 0, out       # no failures — a fail means the skip broke
    assert "skipped" in out, out             # the fixture-bound tests actually skipped


def test_init_adopt_upgrade_agree_on_the_harness_owned_skill_set():
    # Derive each command's skill set from its CONFIGURED paths, never from the
    # repo's actual skill directories — the whole point of this story is that a
    # client repo carries its own extra skills, so enumerating the tree here
    # would make this very test fail in the client CI it is meant to protect.
    from forge_cli.adopt import ADOPT_SKILL_TREES
    from forge_cli.scaffold import HARNESS_OWNED_SKILLS, INIT_COPY_TREES
    from forge_cli.upgrade import (
        CLAUDE_HARNESS_OWNED,
        CODEX_HARNESS_OWNED_SKILLS,
    )

    adopt_skills = {Path(path).name for path in ADOPT_SKILL_TREES}
    upgrade_claude_skills = {
        Path(path).name
        for path in CLAUDE_HARNESS_OWNED
        if path.startswith("skills/")
    }
    upgrade_codex_skills = {Path(path).name for path in CODEX_HARNESS_OWNED_SKILLS}
    init_skills = {
        runtime: {
            Path(tree).name
            for tree in INIT_COPY_TREES
            if tree.startswith(f"{runtime}/skills/")
        }
        for runtime in (".claude", ".codex")
    }
    assert (
        adopt_skills
        == upgrade_claude_skills
        == upgrade_codex_skills
        == set(HARNESS_OWNED_SKILLS)
    )
    assert init_skills == {
        ".claude": set(HARNESS_OWNED_SKILLS),
        ".codex": set(HARNESS_OWNED_SKILLS),
    }


def test_init_writes_a_record_origin_marker_with_preceding_count(tmp_path: Path):
    target = tmp_path / "app"
    note = target / "docs" / "notes" / "origin.md"
    note.parent.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    note.write_text("first\n")
    git(target, "add", "docs/notes/origin.md")
    git(target, "commit", "-q", "-m", "first pre-forge commit")
    note.write_text("second\n")
    git(target, "add", "docs/notes/origin.md")
    git(target, "commit", "-q", "-m", "second pre-forge commit")
    before = head(target)

    proc = _init(target)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    marker = json.loads((target / ".factory" / "record-origin.json").read_text())
    assert set(marker) == {"date", "commit", "preceding_commits"}
    assert marker["date"]
    assert marker["commit"] == before
    assert marker["preceding_commits"] == 2


def test_record_origin_records_unknown_count_for_a_shallow_clone(tmp_path: Path):
    """A shallow clone counts only its local commits. An honest boundary must
    not persist a truncated number it will claim forever — it records null, and
    the board (which gates the count on Number.isInteger) omits it."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.scaffold import ensure_record_origin

    source = tmp_path / "source"
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    for n in range(3):
        (source / "f.txt").write_text(f"{n}\n")
        git(source, "add", "f.txt")
        git(source, "commit", "-q", "-m", f"commit {n}")

    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth", "1",
                    f"file://{source}", str(shallow)], check=True)
    (shallow / ".factory").mkdir()

    assert ensure_record_origin(shallow) is True
    marker = json.loads((shallow / ".factory" / "record-origin.json").read_text())
    assert marker["preceding_commits"] is None  # unknown, not the truncated 1
    assert marker["commit"] and marker["date"]

    # The board still shows the boundary for a null count — just no number.
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    assert '`<p class="record-boundary">record begins here</p>`' in page


def test_init_refuses_colliding_target(tmp_path: Path):
    target = tmp_path / "app"
    target.mkdir()
    (target / "WORKFLOW.md").write_text("mine\n")
    proc = _init(target)
    assert proc.returncode == 1
    assert "WORKFLOW.md" in proc.stdout + proc.stderr
    assert (target / "WORKFLOW.md").read_text() == "mine\n"


def test_init_refuses_symlink_and_blocking_ancestor(tmp_path: Path):
    # symlinked destination component: copy would escape the target
    target = tmp_path / "sym"
    target.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (target / "docs").symlink_to(outside)
    proc = _init(target)
    assert proc.returncode == 1
    assert "docs" in proc.stdout + proc.stderr
    assert not any(outside.iterdir())
    # regular file where init needs a directory: no leaf exists, still refused
    target2 = tmp_path / "blk"
    target2.mkdir()
    (target2 / ".codex").write_text("not a dir\n")
    proc = _init(target2)
    assert proc.returncode == 1
    assert ".codex" in proc.stdout + proc.stderr
    assert (target2 / ".codex").read_text() == "not a dir\n"


def test_init_refuses_a_symlinked_destination_before_writing(tmp_path: Path):
    target = tmp_path / "app"
    codex = target / ".codex"
    codex.mkdir(parents=True)
    outside = tmp_path / "outside.toml"
    outside.write_text("do not replace\n")
    destination = codex / "config.toml"
    destination.symlink_to(outside)

    proc = _init(target, "--force")

    assert proc.returncode == 1
    assert "refusing destination outside the target" in proc.stdout + proc.stderr
    assert destination.is_symlink()
    assert outside.read_text() == "do not replace\n"
    assert sorted(str(path.relative_to(target)) for path in target.rglob("*")) == [
        ".codex",
        ".codex/config.toml",
    ]


def test_init_refuses_a_symlinked_ancestor_and_leaves_the_target_clean(
    tmp_path: Path,
):
    target = tmp_path / "app"
    target.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (target / "docs").symlink_to(outside, target_is_directory=True)

    proc = _init(target, "--force")

    assert proc.returncode == 1
    assert "refusing destination outside the target" in proc.stdout + proc.stderr
    assert (target / "docs").is_symlink()
    assert list(outside.iterdir()) == []
    assert [path.name for path in target.iterdir()] == ["docs"]


def test_init_refuses_symlinked_readme(tmp_path: Path):
    # README is append-only so a regular one is legal, but a symlink would
    # write outside the target
    target = tmp_path / "app"
    target.mkdir()
    outside = tmp_path / "elsewhere.md"
    outside.write_text("external\n")
    (target / "README.md").symlink_to(outside)
    proc = _init(target)
    assert proc.returncode == 1
    assert "README.md" in proc.stdout + proc.stderr
    assert outside.read_text() == "external\n"


def test_init_refuses_blocking_ensured_dir(tmp_path: Path):
    # .factory/reviews is mkdir-only; a regular file there must be a collision
    target = tmp_path / "app"
    (target / ".factory").mkdir(parents=True)
    (target / ".factory" / "reviews").write_text("not a dir\n")
    proc = _init(target)
    assert proc.returncode == 1
    assert ".factory/reviews" in proc.stdout + proc.stderr


def test_init_refuses_rogue_file_in_owned_tree(tmp_path: Path):
    # a pre-existing file under factory/ would be blessed into the vendor
    # manifest as trusted — must be refused even though it collides with nothing
    target = tmp_path / "app"
    (target / "factory" / "scripts").mkdir(parents=True)
    (target / "factory" / "scripts" / "rogue.py").write_text("print('hi')\n")
    proc = _init(target)
    assert proc.returncode == 1
    assert "factory/scripts/rogue.py" in proc.stdout + proc.stderr


def test_init_refuses_directory_at_append_path(tmp_path: Path):
    # README.md is append-only for regular files; a directory there would
    # crash init midway
    target = tmp_path / "app"
    (target / "README.md").mkdir(parents=True)
    proc = _init(target)
    assert proc.returncode == 1
    assert "README.md" in proc.stdout + proc.stderr


def test_upgrade_untracks_ephemeral_factory_paths(repo):
    """0025: a legacy client tracks briefs and the delegation mirror. Upgrade
    must untrack all three paths (staged, --cached) while leaving the files on
    disk — a running task keeps reading its brief — and must be idempotent."""
    briefs = repo / ".factory" / "briefs"
    briefs.mkdir(parents=True, exist_ok=True)
    (briefs / "T-1.md").write_text("brief body\n")
    diag = repo / ".factory" / "diagnostic-briefs"
    diag.mkdir(exist_ok=True)
    (diag / "T-1.md").write_text("diag body\n")
    (repo / ".factory" / "delegations.jsonl").write_text("{}\n")
    # -f: current scaffolds already ignore these; a legacy repo tracked them.
    git(repo, "add", "-f", "-A")
    git(repo, "commit", "-q", "-m", "legacy repo tracking ephemera")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    tracked = subprocess.run(
        ["git", "-C", str(repo), "ls-files", ".factory"],
        capture_output=True, text=True).stdout
    assert ".factory/briefs/T-1.md" not in tracked
    assert ".factory/diagnostic-briefs/T-1.md" not in tracked
    assert ".factory/delegations.jsonl" not in tracked
    assert (briefs / "T-1.md").exists()  # on disk, just untracked
    assert ".factory/briefs/" in (repo / ".gitignore").read_text()
    assert "untracked" in proc.stdout
    # Second run: nothing left to untrack, still succeeds. Plain add -A now
    # skips the ignored ephemera — only the upgrade's own writes get committed.
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "carry the staged untracking")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # Legacy .gitignore WITHOUT the marker: hand-written partial rules and a
    # negation must not suppress the append (no rule detection — the marker is
    # the only key). The block lands at the end, where it beats the negation.
    gitignore = repo / ".gitignore"
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.upgrade import EPHEMERAL_MARKER
    gitignore.write_text("".join(
        line for line in gitignore.read_text().splitlines(keepends=True)
        if line.strip() != EPHEMERAL_MARKER)
        .replace(".factory/diagnostic-briefs/\n", "")
        + "!.factory/delegations.jsonl\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "legacy hand-written rules, no marker")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert EPHEMERAL_MARKER in gitignore.read_text()
    for probe in (".factory/briefs/probe", ".factory/diagnostic-briefs/probe",
                  ".factory/delegations.jsonl"):
        assert subprocess.run(
            ["git", "-C", str(repo), "check-ignore", "-q", "--", probe],
        ).returncode == 0, f"{probe} not effectively ignored after upgrade"
    # Opt-out under the marker: the client re-includes a path by NEGATING it
    # after the block. The positive rule line still exists inside the marker
    # block above, so a file-wide line set would wrongly untrack it — only the
    # marker-owned tail governs, last mention wins. The opted-back-in path
    # stays tracked (untracking it would delete teammates' copies on pull).
    opted = gitignore.read_text() + "!.factory/diagnostic-briefs\n"
    gitignore.write_text(opted)
    (diag / "T-2.md").write_text("opted back in\n")
    git(repo, "add", "-A")  # plain add tracks it — the negation wins
    git(repo, "commit", "-q", "-m", "client opts a path back in, under the marker")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert gitignore.read_text() == opted  # untouched — opt-out respected
    tracked = subprocess.run(
        ["git", "-C", str(repo), "ls-files", ".factory"],
        capture_output=True, text=True).stdout
    assert ".factory/diagnostic-briefs/T-2.md" in tracked


def test_upgrade_repairs_blanket_gstack_ignore(repo):
    """The legacy blanket `.gstack/` rule hid the committed projects/ store
    (WORKFLOW.md), and a directory exclude cannot be re-included — upgrade must
    remove the blanket line, then the corrected block takes effect."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.upgrade import GSTACK_MARKER
    gitignore = repo / ".gitignore"
    gitignore.write_text("".join(
        line for line in gitignore.read_text().splitlines(keepends=True)
        if line.strip() != GSTACK_MARKER) + ".gstack/\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "legacy blanket gstack ignore")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    lines = {line.strip() for line in gitignore.read_text().splitlines()}
    assert ".gstack/" not in lines  # blanket rule gone
    assert GSTACK_MARKER in lines
    assert subprocess.run(  # projects/ is committable again
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/projects/probe"]).returncode != 0
    assert subprocess.run(  # session noise still ignored
        ["git", "-C", str(repo), "check-ignore", "-q", "--",
         ".gstack/sessions/probe"]).returncode == 0
    # No .gitignore at all: upgrade creates it with BOTH blocks.
    gitignore.unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "client with no .gitignore")
    proc = upgrade_into(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    from forge_cli.upgrade import EPHEMERAL_MARKER
    created = gitignore.read_text()
    assert GSTACK_MARKER in created
    assert EPHEMERAL_MARKER in created


def test_upgrade_refuses_unreadable_run_json_before_writing(repo):
    """A malformed run.json used to crash the sign-off carry AFTER machinery
    replacement, leaving a half-upgraded target. Refuse before writing."""
    (repo / ".factory").mkdir(exist_ok=True)
    (repo / ".factory" / "run.json").write_text("[not json")
    sentinel = repo / "factory" / "scripts" / "verify.py"
    sentinel.unlink()  # any write phase would restore this
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "legacy repo with corrupt run state")
    proc = upgrade_into(repo)
    assert proc.returncode != 0
    assert "run.json" in proc.stdout + proc.stderr
    assert not sentinel.exists()  # refused BEFORE writing anything
    # Parseable but not an object refuses the same way.
    (repo / ".factory" / "run.json").write_text("[]\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "run state is a list")
    proc = upgrade_into(repo)
    assert proc.returncode != 0
    assert "run.json" in proc.stdout + proc.stderr
    assert not sentinel.exists()
    # A DIRECTORY at the path refuses the same way (preflight runs before the
    # dirty check, so no commit is needed to reach it).
    (repo / ".factory" / "run.json").unlink()
    (repo / ".factory" / "run.json").mkdir()
    proc = upgrade_into(repo)
    assert proc.returncode != 0
    assert "run.json" in proc.stdout + proc.stderr
    assert not sentinel.exists()


def test_doctor_merge_check_helpers(repo, monkeypatch):
    """Slug parsing covers the three GitHub remote forms and rejects others;
    the protection check answers None (not a failing row) when unanswerable."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli import doctor
    monkeypatch.chdir(repo)
    git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git")
    assert doctor._github_slug() == "acme/widgets"
    git(repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git")
    assert doctor._github_slug() == "acme/widgets"
    git(repo, "remote", "set-url", "origin", "https://gitlab.com/acme/widgets.git")
    assert doctor._github_slug() == ""
    # No gh on PATH -> unanswerable -> None, never a red advisory row.
    monkeypatch.setattr(doctor.shutil, "which", lambda _: None)
    assert doctor._merge_check_status(fix=False) is None


def test_project_name_survives_the_run_state_lifecycle(tmp_path):
    """The Overview's project name comes from run.json, which intake and
    pr_ready REWRITE. Injecting the field in a test proves nothing about
    whether the lifecycle keeps it — a rewrite that dropped `project` would
    silently regress every client board to its clone-directory slug."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.board import project_identity

    target = tmp_path / "acme-billing"
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "Acme Billing", "--target", str(target)],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # The authored name, not the directory it was created in.
    assert project_identity(target)["name"] == "Acme Billing"

    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "scaffold")
    sign_off(target)
    intake(target)
    assert project_identity(target)["name"] == "Acme Billing", \
        "intake rewrote run.json and dropped the authored project name"

    run_state = json.loads((target / ".factory" / "run.json").read_text())
    assert run_state.get("issue_key"), "intake did not actually write run state"

    # And through SHIP: pr_ready reduces run.json to a stable object
    # (pr_ready.py:334) — that projection must keep `project`, or every
    # shipped repo's board would fall back to its directory slug.
    shipped = {k: run_state[k] for k in ("project",) if k in run_state}
    shipped["phase"] = "shipped"
    (target / ".factory" / "run.json").write_text(json.dumps(shipped))
    assert project_identity(target)["name"] == "Acme Billing", \
        "the shipped run-state shape dropped the authored project name"


def test_record_origin_skips_a_repo_with_an_existing_forge_record(tmp_path: Path):
    """Re-adopting a pre-marker Forge repo must NOT stamp a boundary at HEAD:
    the existing committed events ARE the record, so counting them as
    'preceding' would falsely claim the record begins after work the board can
    already show. The honest act is to leave the origin unclaimed."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.scaffold import ensure_record_origin

    target = tmp_path / "prior-forge"
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    (target / "x.txt").write_text("work\n")
    git(target, "add", "x.txt")
    git(target, "commit", "-q", "-m", "pre-existing forge work")
    (target / ".factory").mkdir()
    (target / ".factory" / "events.jsonl").write_text(
        '{"event": "shipped", "at": "2026-01-01T00:00:00+00:00", "story": "OLD-1"}\n')

    assert ensure_record_origin(target) is False
    assert not (target / ".factory" / "record-origin.json").exists()


def test_record_origin_refuses_a_symlinked_factory_ancestor(tmp_path: Path):
    """A symlinked .factory would land the marker outside the target — the
    repository-escape class. Preflight must refuse before any write."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    from forge_cli.scaffold import check_record_origin_writable

    target = tmp_path / "app"
    target.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (target / ".factory").symlink_to(outside)
    with pytest.raises(SystemExit):
        check_record_origin_writable(target)

    dangling_target = tmp_path / "dangling-app"
    dangling_target.mkdir()
    (dangling_target / ".factory").symlink_to(tmp_path / "missing-outside")
    with pytest.raises(SystemExit):
        check_record_origin_writable(dangling_target)


def test_no_raw_write_primitive_outside_the_boundary_helper():
    """Keep init, adopt, and upgrade closed against future raw write sites."""
    modules = {
        "scaffold.py": HARNESS / "factory" / "scripts" / "forge_cli" / "scaffold.py",
        "adopt.py": HARNESS / "factory" / "scripts" / "forge_cli" / "adopt.py",
        "upgrade.py": HARNESS / "factory" / "scripts" / "forge_cli" / "upgrade.py",
    }
    assert set(modules) == {"scaffold.py", "adopt.py", "upgrade.py"}

    # helper "strength": file > any > none. A destination is routed when the
    # helper wrapping it is at least as strong as the primitive requires.
    # shutil.copy*/move treat a directory dst as a CONTAINER (write dst/<name>),
    # so they need the file-specific guard; the plain containment guard is not
    # enough. Everything else is satisfied by either guard.
    STRENGTH = {None: 0, "any": 1, "file": 2}

    def call_name(call: ast.Call, aliases: dict | None = None) -> str:
        aliases = aliases or {}
        func = call.func
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            return f"{aliases.get(func.value.id, func.value.id)}.{func.attr}"
        if isinstance(func, ast.Attribute):
            return f"Path.{func.attr}"
        return ""

    def helper_kind(call: ast.Call, aliases: dict | None = None) -> str | None:
        name = call_name(call, aliases)
        if name == "assert_target_file_destination":
            return "file"
        if name == "assert_target_destination":
            return "any"
        return None

    # from shutil/os import <primitive> would call the mutation as a bare name
    # the qualified-name classifier below never sees, so forbid those imports.
    FORBIDDEN_IMPORTS = {
        "shutil": {"copy", "copy2", "copyfile", "copytree", "move", "rmtree"},
        "os": {"mkdir", "makedirs", "remove", "unlink", "rmdir", "rename",
               "replace", "symlink", "link"},
    }

    def arg_at(call: ast.Call, index: int, *names: str) -> ast.AST | None:
        """The positional arg at `index`, else a keyword arg named in `names`.
        Resolves both forms so a keyword call cannot slip past the classifier."""
        if len(call.args) > index and not isinstance(call.args[index], ast.Starred):
            return call.args[index]
        for kw in call.keywords:
            if kw.arg in names:
                return kw.value
        return None

    def write_destination(call: ast.Call, aliases: dict | None = None
                          ) -> tuple[str, list[tuple[ast.AST, str]]] | None:
        """Return (primitive, [(mutated-path-node, required helper kind), ...]).

        A call can mutate more than one path: rename/replace/move also remove
        the SOURCE, so both sides must be inside the boundary.
        """
        name = call_name(call, aliases)

        def one(dest: ast.AST | None, kind: str):
            return (name, [(dest, kind)]) if dest is not None else None

        # File copies with container/symlink-follow semantics: dest needs "file".
        if name in {"shutil.copy", "shutil.copy2", "shutil.copyfile"}:
            return one(arg_at(call, 1, "dst"), "file")
        if name == "shutil.move":  # writes dest (container) AND removes source
            paths = [(p, k) for p, k in ((arg_at(call, 0, "src"), "any"),
                                         (arg_at(call, 1, "dst"), "file")) if p]
            return (name, paths) if paths else None
        # copytree's root is a directory destination; its per-file copies are
        # validated by _preflight_copytree, so the root only needs containment.
        if name == "shutil.copytree":
            return one(arg_at(call, 1, "dst"), "any")
        if name == "shutil.rmtree":
            return one(arg_at(call, 0, "path"), "any")
        if name in {"os.mkdir", "os.makedirs", "os.remove", "os.unlink",
                    "os.rmdir"}:
            return one(arg_at(call, 0, "path", "name"), "any")
        if name in {"os.symlink", "os.link"}:  # the created link path is arg 1
            return one(arg_at(call, 1, "dst"), "any")
        if name in {"os.rename", "os.replace"}:  # source (arg 0) AND dest (arg 1)
            paths = [(p, "any") for p in (arg_at(call, 0, "src"),
                                          arg_at(call, 1, "dst")) if p]
            return (name, paths) if paths else None
        if name in {"Path.write_text", "Path.write_bytes", "Path.mkdir",
                    "Path.touch", "Path.unlink", "Path.rmdir",
                    "Path.symlink_to", "Path.hardlink_to"}:
            return name, [(call.func.value, "any")]
        # Path.rename(dst)/replace(dst): both the source (func.value, removed)
        # and the created dst (arg 0) are mutated. Path.replace needs exactly one
        # argument to tell it from str.replace(old, new[, count]) (two or more).
        if name == "Path.rename" or (name == "Path.replace"
                                     and len(call.args) + len(call.keywords) == 1):
            paths = [(call.func.value, "any")]
            target = arg_at(call, 0, "target")
            if target is not None:
                paths.append((target, "any"))
            return name, paths
        if name in {"open", "Path.open"}:
            mode = arg_at(call, 1 if name == "open" else 0, "mode")
            if not (isinstance(mode, ast.Constant) and isinstance(mode.value, str)
                    and any(flag in mode.value for flag in "wax+")):
                return None
            dest = call.func.value if name == "Path.open" else arg_at(call, 0, "file")
            return one(dest, "any")
        return None

    violations: list[str] = []
    for module_name, path in modules.items():
        source = path.read_text()
        tree = ast.parse(source)
        # `import shutil as sh` -> resolve sh.copy2 to shutil.copy2; a
        # `from shutil import copy2` is forbidden outright (it would call the
        # primitive as a bare name the classifier never matches).
        aliases: dict[str, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname:
                        aliases[alias.asname] = alias.name
            elif isinstance(node, ast.ImportFrom) and node.module in FORBIDDEN_IMPORTS:
                for alias in node.names:
                    if alias.name in FORBIDDEN_IMPORTS[node.module]:
                        violations.append(
                            f"{module_name}:{node.lineno}: `from {node.module} "
                            f"import {alias.name}` bypasses the scan — call it "
                            f"qualified as {node.module}.{alias.name}")
        parents: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                parents[child] = node

        def owner(node: ast.AST) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
            while node in parents:
                node = parents[node]
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    return node
            return None

        # function -> {name -> [(lineno, helper kind or None)]}
        assignments: dict[ast.AST, dict[str, list[tuple[int, str | None]]]] = {}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            value = node.value
            kind = helper_kind(value, aliases) if isinstance(value, ast.Call) else None
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            function = owner(node)
            if function is None:
                continue
            for target_node in targets:
                if isinstance(target_node, ast.Name):
                    assignments.setdefault(function, {}).setdefault(
                        target_node.id, []).append((node.lineno, kind))

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            mutation = write_destination(node, aliases)
            if mutation is None:
                continue
            primitive, destinations = mutation
            function = owner(node)
            function_name = function.name if function else "<module>"
            # copytree's leaf safety comes from guarded_copytree's per-entry
            # preflight, which a root wrapper alone does not prove — so every
            # copytree MUST live inside guarded_copytree and nowhere else.
            if primitive == "shutil.copytree" and function_name != "guarded_copytree":
                violations.append(
                    f"{module_name}:{node.lineno} {function_name}: shutil.copytree "
                    "must route through guarded_copytree (its root wrapper alone "
                    "does not validate the copied leaves)"
                )
                continue
            for destination, required in destinations:
                destination_text = ast.get_source_segment(source, destination) or ""
                # strongest helper wrapping the destination expression inline
                available = max(
                    (STRENGTH[helper_kind(part, aliases)]
                     for part in ast.walk(destination) if isinstance(part, ast.Call)),
                    default=0,
                )
                # or the LATEST prior assignment of a bare destination variable
                if function and isinstance(destination, ast.Name):
                    prior = [
                        assignment for assignment in
                        assignments.get(function, {}).get(destination.id, [])
                        if assignment[0] < node.lineno
                    ]
                    if prior:
                        available = max(available, STRENGTH[max(prior)[1]])
                if available < STRENGTH[required]:
                    need = "file-specific" if required == "file" else "boundary"
                    violations.append(
                        f"{module_name}:{node.lineno} {function_name}: "
                        f"{primitive} -> {destination_text} (needs the {need} helper)"
                    )

    assert not violations, "raw filesystem write bypasses the boundary helper:\n" + \
        "\n".join(violations)


def test_assert_target_destination_refuses_every_escape_route(tmp_path: Path):
    from forge_cli.scaffold import assert_target_destination

    target = tmp_path / "target"
    target.mkdir()
    legal = target / "missing" / "destination.txt"
    assert assert_target_destination(target, legal) is legal

    outside = tmp_path / "outside"
    outside.mkdir()
    outside_file = outside / "destination.txt"
    outside_file.write_text("outside\n")

    destination_link = target / "destination-link"
    destination_link.symlink_to(outside_file)

    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(tmp_path, target_is_directory=True)
    target_below_link = linked_parent / target.name

    loop = target / "loop"
    loop.symlink_to(loop)

    escapes = [
        destination_link,
        target_below_link / ".." / outside.name / "destination.txt",
        target / ".." / outside.name / "destination.txt",
        # a `..` inside a genuinely-missing suffix must be normalized, not
        # trusted lexically: missing-dir does not exist, yet `../..` escapes.
        target / "missing-dir" / ".." / ".." / outside.name / "destination.txt",
        loop / "destination.txt",
    ]
    for destination in escapes:
        with pytest.raises(SystemExit):
            assert_target_destination(target_below_link, destination)


def test_assert_target_destination_refuses_an_in_target_symlink_pointing_outside(
        tmp_path: Path):
    from forge_cli.scaffold import assert_target_destination

    target = tmp_path / "target"
    target.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (target / "linked-directory").symlink_to(outside, target_is_directory=True)

    destination = target / "linked-directory" / "missing" / "destination.txt"
    with pytest.raises(SystemExit):
        assert_target_destination(target, destination)


def test_assert_target_file_destination_refuses_a_directory_or_symlink(tmp_path: Path):
    # shutil.copy2 treats a directory dst as a container (writes dst/<name>), so
    # a file write must reject a non-file dst even when its path resolves inside;
    # a symlink is judged by where it RESOLVES, not by being a link.
    from forge_cli.scaffold import assert_target_file_destination

    target = tmp_path / "target"
    target.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("do not touch\n")

    # a crafted in-target directory holding a symlink out — the copy2 container
    # escape: assert_target_destination(dir) alone would pass this.
    crafted = target / "config"
    crafted.mkdir()
    (crafted / "config").symlink_to(outside / "secret.txt")
    with pytest.raises(SystemExit):
        assert_target_file_destination(target, crafted)

    # a symlink pointing OUTSIDE is refused (assert_target_destination resolves it).
    (target / "escape.txt").symlink_to(outside / "secret.txt")
    with pytest.raises(SystemExit):
        assert_target_file_destination(target, target / "escape.txt")

    # a symlink to an in-target FILE is legal — copy2 follows it and writes
    # inside the target (a real config-symlink upgrade path).
    (target / "real.txt").write_text("real\n")
    link = target / "link.txt"
    link.symlink_to(target / "real.txt")
    assert assert_target_file_destination(target, link) is link

    # a genuinely new file destination inside the target passes through.
    dest = target / "new.txt"
    assert assert_target_file_destination(target, dest) is dest


# --- companion read-only lane hardening (ported from vendored gate fixes) ---
def test_hook_denies_file_and_cwd_overrides_in_readonly_lane(repo):
    """--prompt-file exfiltrates local files; options are default-deny."""
    for cmd in (
        "node /x/codex-companion.mjs task --prompt-file /etc/passwd go",
        "node /x/codex-companion.mjs task --cwd /other/repo go",
        "node /x/codex-companion.mjs task --unknown-flag go",
    ):
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out, cmd


def test_hook_denies_mutating_companion_subcommands(repo):
    """Only allowlisted read-only verbs pass; setup/cancel/task-worker mutate."""
    for verb in ("setup", "cancel", "task-worker", "unknown-verb"):
        cmd = f"node /x/codex-companion.mjs {verb} go"
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out, cmd


def test_hook_denies_exec_capable_display_commands(repo):
    """Pagers and option-bearing display tools can execute; deny them."""
    for cmd in (
        "less '+!node /x/codex-companion.mjs task --write go' /dev/null",
        "rg --pre=/x/codex-companion.mjs pattern file.txt",
        "tail -f /tmp/codex-companion.mjs",
    ):
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out, cmd


def test_hook_denies_wrapped_or_computed_companion_launch(repo):
    """Executors that could compute argv at runtime are unverifiable."""
    for cmd in (
        "xargs node /x/codex-companion.mjs task go",
        "env FLAG=1 node /x/codex-companion.mjs task go",
        "python3 -c 'import subprocess; subprocess.run([\"node\", "
        "\"/x/codex-companion.mjs\", \"task\", \"--\" + \"write\"])'",
    ):
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out, cmd


def test_hook_denies_expansion_bearing_companion_launch(repo):
    """Unexpanded variables can smuggle write flags; deny as unverifiable."""
    for cmd in (
        "flag=--write bash -c 'node /x/codex-companion.mjs task \"$flag\" go'",
        "node /x/codex-companion.mjs task $(cat /tmp/mode) go",
        "node /x/codex-companion.mjs task `cat /tmp/mode` go",
        "node /x/codex-companion.mjs task $'--write' go",
        "node /x/codex-companion.mjs task --writ[e] go",
    ):
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out, cmd


def test_hook_allows_readonly_companion_prompt_mentioning_write_flag(repo):
    """A prompt that merely MENTIONS a write flag is not a write launch."""
    cmd = "node /x/codex-companion.mjs task 'audit how --write is handled'"
    code, out = hook(repo, {"tool_name": "Bash",
                            "permission_mode": "default",
                            "tool_input": {"command": cmd}})
    assert code == 0 and "deny" not in out, cmd
    # Even a read-only nested launch is unverifiable and therefore denied.
    nested = "bash -c 'node /x/codex-companion.mjs task \"explore\"'"
    code, out = hook(repo, {"tool_name": "Bash",
                            "permission_mode": "default",
                            "tool_input": {"command": nested}})
    assert "deny" in out, nested


def test_hook_denies_nested_quoted_companion_write_launch(repo):
    """A write flag hidden inside a quoted nested shell must still deny."""
    for cmd in (
        "bash -c 'node /x/codex-companion.mjs task --full-auto go'",
        'sh -c "node /x/codex-companion.mjs task '
        '--dangerously-bypass-approvals-and-sandbox go"',
        "bash -c 'node /x/codex-companion.mjs task --write go'",
    ):
        code, out = hook(repo, {"tool_name": "Bash",
                                "permission_mode": "default",
                                "tool_input": {"command": cmd}})
        assert "deny" in out and "forge delegate" in out, cmd
