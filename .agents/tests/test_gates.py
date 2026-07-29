"""Gate regression suite.

Every case here is either the factory happy path or a defect found and fixed
during review (autoreview rounds 1-8, architecture review, forge-next
walk-through). Tests run against a fresh `forge init` scaffold — the vendored
artifact client repos actually receive. Pure stdlib + pytest; scripts are
exercised through their real CLI surface.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[2]


def run(repo: Path, script: str, *args: str, stdin: str | None = None):
    proc = subprocess.run(
        [sys.executable, str(repo / ".agents" / "scripts" / script), *args],
        cwd=repo, capture_output=True, text=True, input=stdin,
    )
    return proc.returncode, proc.stdout + proc.stderr


GIT_ID = ["-c", "user.email=test@knacklabs.dev", "-c", "user.name=Gate Tests"]

# Minimal payload satisfying .agents/schemas/decomposition.json
DECOMP = {"status": "recorded", "generated_by": "docs-decomposer",
          "user_facing": True,
          "tasks": [{"id": "T1", "title": "core slice", "write_scope": ["src/"]}]}

# Minimal plan body passing `plan save` content gates (Decisions + Surface Impact)
PLAN_BODY = ("## Decisions\nNo new decisions\n\n"
             "## Surface Impact\nAll surfaces: N-A (test plan)\n")


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *GIT_ID, *args], cwd=repo,
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout.strip()


def head(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    target = tmp_path / "app"
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
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


def sign_off(repo: Path) -> None:
    if json.loads((repo / ".factory" / "run.json").read_text()).get("client_signoff"):
        return  # idempotent: already signed off
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
    return run(repo, "intake.py", "--issue", key, "--title", title, *extra)


def save_plan(repo: Path, tmp_path: Path) -> tuple[int, str]:
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN_BODY)
    record_grill(repo, "plan", digest_of=plan)  # grill bound to THIS draft
    return run(repo, "forge.py", "plan", "save", "--from", str(plan))


def save_plan_raw(repo: Path, tmp_path: Path) -> tuple[int, str]:
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN_BODY)
    return run(repo, "forge.py", "plan", "save", "--from", str(plan))


def write_passing_artifacts(repo: Path, commit: str | None = None) -> None:
    sha = commit or head(repo)
    f = repo / ".factory"
    (f / "decomposition.json").write_text(
        json.dumps({**DECOMP, "commit": sha}))
    (f / "verify.json").write_text(json.dumps({"ok": True, "commit": sha}))
    (f / "tests.json").write_text(json.dumps({
        "automated": {"status": "passed", "generated_by": "implementer",
                      "skills_used": ["emil-design-eng", "frontend-design"]},
        "functional": {"status": "passed", "score": 9,
                       "generated_by": "functional-checker"},
        "commit": sha,
    }))
    (f / "stages.json").write_text(json.dumps({
        "issue": "", "stages": [{"id": t["id"], "title": t["title"], "status": "done"}
                                for t in DECOMP["tasks"]]}))
    (f / "reviews").mkdir(exist_ok=True)
    for aspect in ("quality", "performance", "security"):
        (f / "reviews" / f"{aspect}.json").write_text(
            json.dumps({"score": 9, "blocking_findings": [],
                        "generated_by": "autoreview",
                        "skills_used": ["review-animations"], "commit": sha})
        )


def run_state(repo: Path) -> dict:
    return json.loads((repo / ".factory" / "run.json").read_text())


def refresh_manifest(repo: Path) -> None:
    """What a real forge upgrade does after touching the gate surface."""
    proc = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; "
         "from check_vendor_integrity import write_manifest; "
         "write_manifest(Path(sys.argv[2]), 'test')",
         str(repo / ".agents" / "scripts"), str(repo)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


# ---------------------------------------------------------------- happy path

def test_full_lifecycle_and_archive(repo, tmp_path):
    sign_off(repo)
    assert run_state(repo)["client_signoff"] is True
    code, _ = intake(repo)
    assert code == 0
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(DECOMP))
    assert code == 0, out
    write_passing_artifacts(repo)
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
    live = run_state(repo)
    assert live["phase"] == "shipped" and live["client_signoff"] is True
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
    assert state["phase"] == "planning" and state["client_signoff"] is True


def test_record_signoff_requires_accepted_and_confirmed(repo):
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "grill" in out.lower()  # grill gate fires first
    record_grill(repo, "signoff")
    code, out = run(repo, "record_signoff.py")
    assert code != 0  # grilled, but no decision record yet
    run(repo, "forge.py", "decision", "new", "client-signoff", "--repo", str(repo))
    code, out = run(repo, "record_signoff.py")
    assert code != 0 and "status" in out  # proposed, not accepted


# ------------------------------------------------------- plan approval gates

def test_update_run_approved_requires_plan_file(repo):
    sign_off(repo)
    intake(repo)
    code, out = run(repo, "update_run.py", "--plan-status", "approved")
    assert code != 0 and "plan save" in out


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
    assert state["client_signoff"] is True and state["phase"] == "planning"
    assert not (repo / ".factory" / "decomposition.json").exists()


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
    # Found by the pilot simulation: a forge upgrade mid-task touches .agents/
    # machinery — that is not product code and must not invalidate evidence.
    # A real upgrade also re-freezes the vendor manifest; simulate both halves.
    ready_task(repo, tmp_path)
    (repo / ".agents" / "scripts" / "extra_helper.py").write_text("# upgraded\n")
    refresh_manifest(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "chore: forge upgrade")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_upgrade_replaces_machinery_preserves_project(repo, tmp_path):
    # Degrade machinery, add project-owned content + a proposed skill
    (repo / ".agents" / "scripts" / "verify.py").unlink()
    proposed = repo / ".agents" / "skills" / "proposed"
    proposed.mkdir(parents=True, exist_ok=True)
    (proposed / "keep-me.md").write_text("status: proposed\n")
    run(repo, "forge.py", "decision", "new", "keep-decision", "--repo", str(repo))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "project state")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (repo / ".agents" / "scripts" / "verify.py").exists()  # machinery restored
    assert (proposed / "keep-me.md").exists()  # evolution state preserved
    assert list((repo / "docs" / "decisions").glob("*keep-decision.md"))  # project-owned untouched
    assert head(repo) in (repo / "constitution" / "VENDORED_FROM").read_text() or \
        "symphony-forge @" in (repo / "constitution" / "VENDORED_FROM").read_text()


def test_upgrade_refreshes_factory_workflows_and_keeps_project_ones(repo):
    # .github/workflows/ is mixed ownership: upgrade must refresh the harness
    # factory workflows without deleting the project's own (deployment/release).
    wf = repo / ".github" / "workflows"
    (wf / "deploy.yml").write_text("name: deploy to prod\n")
    (wf / "factory-scaffold.yml").write_text("name: stale factory\n")  # drift
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "project deploy workflow + drifted factory workflow")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
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
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert proc.returncode != 0 and "uncommitted" in proc.stdout + proc.stderr


# --------------------------------------------------------- misc deterministic

def test_decision_accept_and_plain_issue_keys(repo):
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

ROADMAP = {"generated_by": "human", "items": [
    {"key": "ENG-1", "title": "Invoices", "epic": "billing"},
    {"key": "ENG-2", "title": "Payments", "epic": "billing"},
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
    if not json.loads((repo / ".factory" / "run.json").read_text()).get("client_signoff"):
        sign_off(repo)  # roadmap mutations are post-sign-off
    src = tmp_path / "roadmap-input.json"
    src.write_text(json.dumps(payload if payload is not None else ROADMAP))
    approve_epics(repo, src)
    return run(repo, "forge.py", "roadmap", "import", "--input", str(src))


def roadmap_items(repo: Path) -> dict:
    data = json.loads((repo / "plans" / "roadmap.json").read_text())
    return {item["key"]: item for item in data["items"]}


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
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "human", "items": [
        {"key": "ENG-1", "title": "Invoices v2", "epic": "billing"},
        {"key": "ENG-3", "title": "Reports", "epic": "insights"},
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
        {"key": "A", "title": "x"}, {"key": "A", "title": "y"},
    ]})
    assert code != 0 and "duplicate" in out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports")
    assert code == 0, out
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-9", "Reports")
    assert code != 0 and "already" in out


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
    schema = repo / ".agents" / "schemas" / "review.json"
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
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
         "adopt", "--target", str(repo), "--name", "legacy"],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_adopt_vendors_harness_and_preserves_project(tmp_path):
    repo = existing_repo(tmp_path)
    code, out = adopt(repo)
    assert code == 0, out
    # machinery is in; project content untouched; their CI survived the merge
    assert (repo / ".agents" / "scripts" / "forge.py").exists()
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
    state = json.loads((repo / ".factory" / "run.json").read_text())
    assert state["client_signoff"] is False
    assert (repo / "harness.yaml").exists()
    # the adopted repo passes the same checks as a scaffold
    code, out = run(repo, "check_dual_runtime.py", str(repo))
    assert code == 0, out
    code, out = run(repo, "check_factory_scaffold.py", str(repo))
    assert code == 0, out
    # adopting twice routes to upgrade instead
    code, out = adopt(repo)
    assert code != 0 and "upgrade" in out


def test_adopt_refuses_dirty_tree(tmp_path):
    repo = existing_repo(tmp_path)
    (repo / "wip.txt").write_text("uncommitted\n")
    code, out = adopt(repo)
    assert code != 0 and "uncommitted" in out


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
    assert attrs.exists() and "merge=jsonl-append" in attrs.read_text()
    assert ".gstack/sessions/" in (repo / ".gitignore").read_text()


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
    gitignore.write_text(
        "\n".join(l for l in gitignore.read_text().splitlines() if ".gstack" not in l) + "\n"
    )
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "old-style scaffold")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'GSTACK_HOME="$PWD/.gstack"' in (repo / ".envrc").read_text()
    assert "merge=jsonl-append" in (repo / ".gitattributes").read_text()
    assert ".gstack/sessions/" in gitignore.read_text()


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
        "epics": [{"id": "billing", "title": "Billing", "objective": "money in"}],
        "items": [{"key": "ENG-1", "title": "Invoices", "epic": "billing",
                   "story": "As an admin, I invoice clients",
                   "acceptance_criteria": ["PDF generated"], "skill": "backend"}],
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

def test_grill_recorder_refuses_pass_with_unresolved_findings(repo):
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
    schema = repo / ".agents" / "schemas" / "test-automated.json"
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
    assert code == 0 and "Superseded" in out, out
    old = next((repo / "docs" / "decisions").glob("*-event-bus.md")).read_text()
    assert "status: superseded" in old and "superseded_by:" in old
    substantiate("event-bus-v2")
    run(repo, "forge.py", "decision", "accept", "event-bus-v2", "--by", "PM")
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


def test_planning_lock_forces_plan_mode(repo, tmp_path):
    sign_off(repo)
    intake(repo)  # planning phase, no approved plan
    # product-code edit in normal mode -> denied, routed to plan mode
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert code == 0 and "deny" in out and "PLAN MODE" in out
    # planning-phase writes stay open: the plan itself, decisions, docs
    for ok_path in ("plans/draft.md", "docs/decisions/0009-x.md", ".factory/notes.json"):
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
    # the sanctioned runtime: companion read-only tasks (exploration) pass,
    # writing delegation is blocked while unplanned
    companion = "node /x/codex-companion.mjs task --model gpt-5.6-terra 'map the module'"
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion}})
    assert "deny" not in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write"}})
    assert "deny" in out and "PLAN MODE" in out
    # there is NO escape hatch — env-var prefixes don't open a side door
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command":
                                           "FACTORY_DEGRADED=1 codex exec -s read-only 'map it'"}})
    assert "deny" in out and "codex:rescue" in out
    # approved plan lifts the lock entirely
    save_plan(repo, tmp_path)
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" not in out
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write"}})
    assert "deny" not in out
    # ...but raw codex exec stays off-contract even after approval
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": "codex exec 'build it'"}})
    assert "deny" in out and "codex:rescue" in out


# ---------------------------------------------------------------- plan grill

def test_plan_save_requires_a_fresh_same_issue_grill(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    # ungrilled plan -> refused
    code, out = save_plan_raw(repo, tmp_path)
    assert code != 0 and "grill" in out.lower()
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(PLAN_BODY)
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
    # passing grill bound to THIS draft -> save works
    code, out = record_grill(repo, "plan", digest_of=plan_file)
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


# ------------------------------------------------------------ parallelization

def test_roadmap_parallel_frontier(repo, tmp_path):
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "P-1", "title": "Auth API", "skill": "backend"},
        {"key": "P-2", "title": "Notes UI", "skill": "frontend"},
        {"key": "P-3", "title": "Profile page", "skill": "frontend",
         "depends_on": ["P-1"]},
    ]})
    assert code == 0, out
    # dangling and self edges are refused at import
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "P-4", "title": "X", "depends_on": ["P-99"]}]})
    assert code != 0 and "P-99" in out
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "P-5", "title": "Y", "depends_on": ["P-5"]}]})
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
        {"key": "P-1", "title": "Auth API", "skill": "backend"}]})  # no-op merge keeps status
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
    for cmd in ('cat > notes.md << EOF\nthe hook denies raw codex exec always\nEOF',
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
    import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "G-1", "title": "API"},
        {"key": "G-2", "title": "UI", "depends_on": ["G-1"]},
    ]})
    # cycles refused at import
    code, out = import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "C-1", "title": "a", "depends_on": ["C-2"]},
        {"key": "C-2", "title": "b", "depends_on": ["C-1"]},
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
    path = repo / "plans" / "lessons.jsonl"
    path.write_text(path.read_text() + "<<<<<<< HEAD\n")
    code, out = run(repo, "forge.py", "lesson", "list")
    assert code != 0 and "merge artifact" in out


def test_stage_loop_orders_execution_and_gates_pr_ready(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    decomp = {**DECOMP, "tasks": [
        {"id": "T1", "title": "api", "write_scope": ["src/api/"]},
        {"id": "T2", "title": "ui", "write_scope": ["src/ui/"]},
    ]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(decomp))
    assert code == 0 and "stages.json" in out
    # order enforced: T2 cannot start before T1 is done...
    code, out = run(repo, "forge.py", "stage", "start", "T2")
    assert code != 0 and "T1" in out
    # ...unless the caller asserts disjoint write scopes
    code, out = run(repo, "forge.py", "stage", "start", "T2", "--parallel")
    assert code == 0, out
    # done requires the stage to have actually started
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "not active" in out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    # pr_ready refuses while a stage is open
    write_passing_artifacts(repo)
    (repo / ".factory" / "stages.json").write_text(json.dumps({
        "issue": "ENG-1", "stages": [
            {"id": "T1", "title": "api", "status": "done"},
            {"id": "T2", "title": "ui", "status": "active"}]}))
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "stage completion" in out and "T2" in out
    # all stages done -> ships, tracker archived and cleaned
    run(repo, "forge.py", "stage", "done", "T2")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    assert not (repo / ".factory" / "stages.json").exists()
    assert (repo / ".factory" / "history" / "ENG-1" / "stages.json").exists()


def test_plan_save_requires_surface_impact_section(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "plan.md"
    plan.write_text("## Decisions\nNo new decisions\n")  # no Surface Impact
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "Surface Impact" in out


def test_refactor_ratchet_blocks_growing_refactors(repo, tmp_path):
    import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "REF-1", "title": "Shrink the api layer", "kind": "refactor"},
    ]})
    # invalid kind refused at grooming time
    code, out = run(repo, "forge.py", "roadmap", "add", "X-1", "t", "--kind", "cleanup")
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
    (repo / ".agents" / "skills" / "own-agents-skill").mkdir(parents=True, exist_ok=True)
    (repo / ".agents" / "skills" / "own-agents-skill" / "SKILL.md").write_text("client agents skill")
    # ...and locally drifts a harness-owned file (must be refreshed)
    (repo / ".claude" / "skills" / "forge" / "SKILL.md").write_text("stale local edit")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "client surfaces + drift")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
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
    # client-installed .agents/skills survive; harness-shipped ones refresh
    assert (repo / ".agents" / "skills" / "own-agents-skill" / "SKILL.md").read_text() == "client agents skill"
    assert (repo / ".agents" / "skills" / "forge.md").exists()
    # vendoring never ships build noise
    assert not list((repo / ".agents").rglob("__pycache__"))
    assert not list((repo / ".agents").rglob("*.pyc"))


def test_repo_budget_refuses_tracked_build_noise(repo):
    pyc = repo / ".agents" / "scripts" / "__pycache__"
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
        [sys.executable, str(repo / ".agents" / "scripts" / "forge.py"),
         "doctor", "--fast"], cwd=repo, env=env, capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0
    assert "codex-plugin-cc" in out and "autoreview" in out and "--fix" in out
    # the session hook banners it on EVERY session in a fresh clone
    proc = subprocess.run(
        [sys.executable, str(repo / ".agents" / "scripts" / "session_start.py")],
        cwd=repo, env=env, capture_output=True, text=True, input="{}")
    assert proc.returncode == 0 and "MACHINE NOT READY" in proc.stdout


def test_adopt_normalizes_case_variant_contract_files(repo, tmp_path):
    target = tmp_path / "legacy"
    target.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=target, check=True)
    (target / "agents.md").write_text("# old lowercase rules\nproject standards here\n")
    (target / "README.md").write_text("app\n")
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "pre-harness")
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
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
    assert ".agents/scripts/verify.py" in files and "forge" in files
    assert not any("__pycache__" in f or f.endswith(".pyc") for f in files)
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out
    # edited gate file -> drift
    verify = repo / ".agents" / "scripts" / "verify.py"
    verify.write_text(verify.read_text() + "# weakened\n")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "edited: .agents/scripts/verify.py" in out and "upstream" in out, out
    # unexpected file in the gate surface -> drift too
    git(repo, "checkout", "--", ".agents/scripts/verify.py")
    (repo / ".agents" / "prompts" / "rogue.md").write_text("softer review\n")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "unexpected: .agents/prompts/rogue.md" in out, out
    # no manifest -> unarmed, advisory only
    (repo / ".agents" / "prompts" / "rogue.md").unlink()
    manifest.unlink()
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "unarmed" in out, out


def test_pr_ready_refuses_drifted_gate_surface(repo, tmp_path):
    ready_task(repo, tmp_path)
    prompt = repo / ".agents" / "prompts" / "reviewer.md"
    prompt.write_text(prompt.read_text() + "\nScore generously.\n")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "vendor integrity" in out and "reviewer.md" in out, out
    # the SessionStart hook warns about the same drift at session start
    code, out = run(repo, "session_start.py", stdin="{}")
    assert code == 0 and "GATE SURFACE DRIFTED" in out, out
    git(repo, "checkout", "--", ".agents/prompts/reviewer.md")
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
    verify = repo / ".agents" / "scripts" / "verify.py"
    verify.write_text(verify.read_text() + "# local patch\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "drift")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0
    proc = subprocess.run(
        [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
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
            [sys.executable, str(HARNESS / ".agents" / "scripts" / "forge.py"),
             "upgrade", "--target", str(repo)],
            cwd=HARNESS, capture_output=True, text=True)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"upgrade {i}", "--allow-empty")
    text = readme.read_text()
    assert text.startswith("# app\n")
    assert text.count("Working in this repo — Symphony Forge") == 1
