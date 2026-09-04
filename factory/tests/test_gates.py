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
import types
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[2]
FORGE_INIT_FIXTURE = HARNESS / ".factory" / "history" / "FORGE-INIT-1"
UPGRADE_PROJECT_SKILL_FIXTURE = (
    HARNESS / "install" / "claude" / "knacklabs-upgrade-project" / "SKILL.md"
)
SANITISE_PROJECT_SKILL_FIXTURE = (
    HARNESS / "install" / "claude" / "knacklabs-sanitise-project" / "SKILL.md"
)
SETUP_FIXTURE = HARNESS / "setup"
HARNESS_SOURCE_MARKER_FIXTURE = HARNESS / ".factory" / "harness-source.json"
PR_LINK_WORKFLOW_FIXTURE = HARNESS / ".github" / "workflows" / "pr-link.yml"
BOARD_INVARIANT_WORKFLOW_FIXTURE = (
    HARNESS / ".github" / "workflows" / "board-invariant.yml"
)
PLANNING_LOCK_DECISION_FIXTURE = (
    HARNESS / "docs" / "decisions" / "0013-always-armed-planning-lock.md"
)
PLAN_MODE_DECISION_FIXTURE = (
    HARNESS / "docs" / "decisions" / "0048-plan-mode-and-grill-provenance.md"
)
sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from factory_lib import (
    branch_diff_digest, grounding_digest, plan_body_digest,
    plan_digest_without_assumptions,
    product_tree_digest, require_task_grill,
    task_frontier_state, task_rows,
)
from forge_cli.events import load_events
from forge_cli.stages import task_digest, write_stages
from record_signoff import REQUIRED_BRIEF_HEADINGS


def run(repo: Path, script: str, *args: str, stdin: str | None = None,
        env: dict[str, str] | None = None):
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / script), *args],
        cwd=repo, capture_output=True, text=True, input=stdin,
        env={**os.environ, **(env or {})},
    )
    return proc.returncode, proc.stdout + proc.stderr


class FakePsutilAccessDenied(Exception):
    pass


class FakePsutilNoSuchProcess(Exception):
    pass


def fake_psutil(processes, *, current_user="owner"):
    by_pid = {process.pid: process for process in processes}
    return types.SimpleNamespace(
        AccessDenied=FakePsutilAccessDenied,
        NoSuchProcess=FakePsutilNoSuchProcess,
        Error=Exception,
        STATUS_ZOMBIE="zombie",
        process_iter=lambda _attrs=None: iter(processes),
        Process=lambda pid=None: (
            types.SimpleNamespace(username=lambda: current_user)
            if pid is None else by_pid[pid]
        ),
    )


@pytest.mark.skipif(
    not (UPGRADE_PROJECT_SKILL_FIXTURE.is_file() and SETUP_FIXTURE.is_file()),
    reason="requires the upgrade-project harness-source fixtures",
)
def test_upgrade_project_skill_structure_and_registration():
    skill_path = UPGRADE_PROJECT_SKILL_FIXTURE
    skill = skill_path.read_text()
    setup = SETUP_FIXTURE.read_text()

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


@pytest.mark.skipif(
    not UPGRADE_PROJECT_SKILL_FIXTURE.is_file(),
    reason="requires the upgrade-project harness-source fixture",
)
def test_upgrade_project_skill_uses_fill_not_import():
    skill = UPGRADE_PROJECT_SKILL_FIXTURE.read_text()

    assert '"$TARGET/forge" roadmap fill "$KEY"' in skill
    assert '--repo "$TARGET"' in skill
    assert "roadmap import" not in skill.lower()
    assert 'roadmap list --pending --repo "$TARGET"' in skill
    assert "Never select or rewrite a completed" in skill


@pytest.mark.skipif(
    not (SANITISE_PROJECT_SKILL_FIXTURE.is_file() and SETUP_FIXTURE.is_file()),
    reason="requires the sanitise-project harness-source fixtures",
)
def test_sanitise_skill_structure_and_registration():
    skill_path = SANITISE_PROJECT_SKILL_FIXTURE
    skill = skill_path.read_text()
    setup = SETUP_FIXTURE.read_text()

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

# Ready execution detail shared by stage fixtures. Generated repositories carry
# the tiny shell-free proof runner below so stage completion stays fast.
READY_TASK_FIELDS = {
    "required_tests": [{
        "id": "test_stage_contract",
        "path": "stage_contract_proof.py",
        "command": "python3 {path} {id} {report}",
    }],
    "reviewer_focus": "the bounded stage contract",
    "verify_commands": ["true"],
}


# Minimal payload satisfying factory/schemas/decomposition.json
DECOMP = {"status": "recorded", "generated_by": "docs-decomposer",
          "user_facing": True,
          "tasks": [{"id": "T1", "title": "core slice", "write_scope": ["src/"],
                     "objective": "Build the core slice so the feature works end to end.",
                     "acceptance_criteria": ["the slice runs green"],
                     **READY_TASK_FIELDS}]}

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
    # gc.auto=0 must reach forge init's OWN git commits: a detached auto-gc
    # spawned during init can still be pruning objects when a test later
    # copies .git (the review-budget copytree race). The config line below
    # only governs git run after the repo exists.
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "app", "--target", str(target)],
        capture_output=True, text=True,
        env={**os.environ, "GIT_CONFIG_COUNT": "1",
             "GIT_CONFIG_KEY_0": "gc.auto", "GIT_CONFIG_VALUE_0": "0"},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (target / "stage_contract_proof.py").write_text(
        "from pathlib import Path\n"
        "import sys\n"
        "path, test_id, report = sys.argv[0], *sys.argv[1:]\n"
        "Path(report).write_text(f'<testsuite><testcase name=\"{test_id}\" "
        "file=\"{path}\"/></testsuite>')\n"
    )
    git(target, "config", "gc.auto", "0")
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "scaffold")
    git(target, "update-ref", "refs/remotes/origin/main", head(target))
    return target


def record_grill(repo: Path, gate: str, verdict: str = "pass",
                 digest_of: Path | None = None, *,
                 seed_requirements: bool = True,
                 plan_mode: bool = True, **over) -> tuple[int, str]:
    if gate == "plan" and seed_requirements:
        code, out = record_grill(repo, "requirements")
        if code != 0:
            return code, out
    floors = {"spec": 2, "requirements": 1, "plan": 2, "task": 1}
    rounds = over.get("rounds")
    if gate in floors and rounds is None:
        rounds = grill_rounds(gate, floors[gate])
        over["rounds"] = rounds
    if rounds is not None:
        code, out = log_grill_rounds(repo, rounds)
        if code != 0:
            return code, out
    payload = {"generated_by": "griller", "gate": gate, "verdict": verdict,
               "gaps": [], "contradictions": [], "resolutions": [], **over}
    extra = ["--input-digest", str(digest_of)] if digest_of else []
    result = run(repo, "record_grill_from_json.py", "--gate", gate, *extra,
                 stdin=json.dumps(payload))
    if result[0] == 0 and gate == "plan" and digest_of and plan_mode:
        marker = post_hook(repo, plan_hook_payload(digest_of))
        if marker[0] != 0:
            return marker
    return result


def task_grill_payload(task: dict, verdict: str = "pass", **over) -> dict:
    payload = {"generated_by": "griller", "gate": "task", "verdict": verdict,
               "gaps": [], "contradictions": [], "resolutions": [],
               "inspected_refs": ["factory/scripts/record_grill_from_json.py"],
               "current_flow": "The current task contract is recorded and ready to grill.",
               "criteria_map": {
                   criterion: "Inspected against the current task flow."
                   for criterion in task["acceptance_criteria"]
               },
               "decision": "keep" if verdict == "pass" else "block",
               "new_abstractions": [], "rounds": grill_rounds("task", 1),
               "citations": []}
    if verdict == "blocked":
        payload["escalation_packet"] = {
            "issue": "The task cannot proceed as written.",
            "evidence": "The inspected task contract contains a blocking gap.",
            "recommendation": "Revise the task contract before delegation.",
            "alternatives": "Split the task or revise its acceptance criteria.",
            "rollback": "Keep the stage inactive until the contract is revised.",
        }
    payload.update(over)
    return payload


def seed_task_grill_frontier(repo: Path, task: dict) -> None:
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    plan = repo / "plans" / "active" / "TEST-1-test-plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    if not plan.exists():
        plan.write_text("---\nstatus: approved\n---\n" + PLAN_BODY)
    (repo / ".factory" / "run.json").write_text(json.dumps({
        "issue_key": "TEST-1",
        "plan_file": plan.relative_to(repo).as_posix(),
        "plan_status": "approved",
    }))
    (control / "decomposition.json").write_text(json.dumps({
        "plan_file": plan.relative_to(repo).as_posix(),
        "plan_sha256": hashlib.sha256(plan.read_bytes()).hexdigest(),
        "tasks": [task],
    }))
    task_plan = repo / ".factory" / "task-plans" / f"{task['id']}.md"
    task_plan.parent.mkdir(parents=True, exist_ok=True)
    task_plan.write_text(f"# Task plan — {task['id']}\n")
    code, out = log_grill_rounds(repo, grill_rounds("task", 1))
    assert code == 0, out


def record_task_grill(repo: Path, task: dict, verdict: str = "pass",
                      *, approve: bool = True) -> tuple[int, str]:
    source = repo / ".factory" / "task-plan-drafts" / f"{task['id']}.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(f"# Task plan — {task['id']}\n\nImplement the recorded contract.\n\n## Workflow\n\nRequest -> handler -> store.\n\n## Manual Verification\n\n1. Run it. 2. See the row.\n", encoding="utf-8")
    code, marker_out = post_hook(repo, plan_hook_payload(source))
    if code != 0:
        return code, marker_out
    code, plan_out = run(
        repo, "forge.py", "task", "plan", "save", task["id"],
        "--from", str(source),
    )
    if code != 0:
        return code, plan_out
    payload = task_grill_payload(task, verdict)
    code, round_out = log_grill_rounds(repo, payload["rounds"])
    if code != 0:
        return code, plan_out + round_out
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task",
        "--task", task["id"], stdin=json.dumps(payload),
    )
    if code != 0 or verdict != "pass" or not approve:
        return code, plan_out + out
    code, approve_out = run(
        repo, "forge.py", "task", "approve", task["id"], "--by", "Test Human",
    )
    return code, out + plan_out + approve_out


def grill_rounds(gate: str, count: int) -> list[dict]:
    rounds = [{
        "question": f"{gate} provenance round {index + 1}?",
        "options": ["Keep", "Revise"],
        "chosen": "Keep",
    } for index in range(count)]
    rounds[-1]["frontier_empty"] = True
    return rounds


def log_grill_rounds(repo: Path, rounds: list[dict]) -> tuple[int, str]:
    output = ""
    for entry in rounds:
        question = entry["question"]
        code, out = post_hook(repo, {
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{
                "question": question,
                "options": [{"label": option} for option in entry["options"]],
            }]},
            "tool_response": {"answers": {question: entry["chosen"]}},
        })
        output += out
        if code != 0:
            return code, output
    return 0, output


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
    active = next((repo / "plans" / "active").glob(f"{story}-*.md"))
    code, out = record_grill(repo, "plan", digest_of=active)
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    return run(repo, "forge.py", "plan", "save", "--from", str(active),
               "--story", story)


def save_plan_raw(repo: Path, tmp_path: Path) -> tuple[int, str]:
    state = run_state(repo)
    story = state.get("issue_key", "ENG-1")
    ensure_story(repo, story, state.get("title"))
    plan = tmp_path / "plan.md"
    plan.write_text(plan_draft(repo))
    return run(repo, "forge.py", "plan", "save", "--from", str(plan), "--story", story)


def write_passing_artifacts(repo: Path, commit: str | None = None) -> None:
    sha = commit or head(repo)
    lib = load_factory_lib(repo)
    key = run_state(repo).get("issue_key", "")
    f = (lib.story_dir(repo, key)
         if key and lib.story_uses_scoped_layout(repo, key)
         else repo / ".factory")
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
    brief_sha256 = hashlib.sha256(b"fixture branch review brief").hexdigest()
    branch_digest = lib.branch_diff_digest(repo)
    review_run_id = hashlib.sha256(
        (brief_sha256 + branch_digest).encode()
    ).hexdigest()
    for aspect in ("quality", "performance", "security"):
        (f / "reviews" / f"{aspect}.json").write_text(
            json.dumps({"score": 9, "blocking_findings": [],
                        "generated_by": "autoreview",
                        "skills_used": ["review-animations"], "commit": sha,
                        "review_run_id": review_run_id,
                        "brief_sha256": brief_sha256,
                        "branch_diff_digest": branch_digest})
        )
    (f / "outcome.json").write_text(json.dumps({
        "generated_by": "implementer", "commit": sha,
        "outcome": "The invoice list now loads for every account and can be filtered "
                   "by date, which previously required a support request."}))


def run_state(repo: Path) -> dict:
    lib = load_factory_lib(repo)
    return lib.load_json(lib.run_state_path(repo))


def story_state(repo: Path, key: str = "ENG-1") -> Path:
    return repo / ".factory" / "stories" / key


def make_legacy_story(repo: Path, key: str = "ENG-1") -> None:
    (repo / ".factory" / "run.json").write_text(json.dumps(run_state(repo)))
    (delegation_ledger(repo).parent / "run.json").unlink(missing_ok=True)
    shutil.rmtree(story_state(repo, key))


def signed_off(repo: Path) -> bool:
    """Sign-off is DERIVED from the committed harness.yaml pin, never from
    per-worktree run.json — that is the whole point of the pin."""
    match = re.search(r'^signoff_record:\s*"([^"]*)"', (repo / "harness.yaml").read_text(),
                      re.MULTILINE)
    return bool(match and match.group(1))


def test_new_story_artifacts_record_under_story_dir(repo, tmp_path):
    sign_off(repo)
    code, out = intake(repo)
    assert code == 0, out
    scoped = repo / ".factory" / "stories" / "ENG-1"
    assert scoped.is_dir()

    plan = repo / "plans" / "active" / "ENG-1-evidence-paths.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("---\nstatus: approved\n---\n\n" + PLAN_BODY)
    state = run_state(repo)
    state.update({
        "plan_file": plan.relative_to(repo).as_posix(),
        "plan_status": "approved",
        "story": "ENG-1",
    })
    lib = load_factory_lib(repo)
    lib.dump_json(lib.run_state_path(repo), state)

    code, out = record_grill(repo, "plan", digest_of=plan)
    assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])

    legacy_tests = repo / ".factory" / "tests.json"
    legacy_tests.write_text(json.dumps({"functional": {"summary": "legacy proof"}}))

    testing = {
        "generated_by": "implementer",
        "status": "passed",
        "summary": "focused evidence-path proof passed",
        "blocking_findings": [],
        "commands_run": ["pytest"],
        "skills_used": ["emil-design-eng", "frontend-design"],
    }
    code, out = run(
        repo, "record_test_from_json.py", "--kind", "automated",
        stdin=json.dumps(testing),
    )
    assert code == 0, out
    recorded_tests = json.loads((scoped / "tests.json").read_text())
    assert recorded_tests["functional"]["summary"] == "legacy proof"
    assert json.loads(legacy_tests.read_text()) == {
        "functional": {"summary": "legacy proof"},
    }

    code, out = run(repo, "forge.py", "review-brief", "--all", "--repo", str(repo))
    assert code == 0, out
    review = {
        "generated_by": "autoreview",
        "score": 9,
        "summary": "story evidence paths are consistent",
        "blocking_findings": [],
        "skills_used": ["review-animations"],
    }
    for aspect in ("quality", "performance", "security"):
        code, out = run(
            repo, "record_review_from_json.py", "--aspect", aspect,
            stdin=json.dumps(review),
        )
        assert code == 0, out

    code, out = run(repo, "verify.py", env={
        "FACTORY_STRUCTURAL_CMD": "true",
        "FACTORY_TYPECHECK_CMD": "true",
        "FACTORY_TEST_CMD": "true",
    })
    assert code == 0, out

    expected = (
        "decomposition.json",
        "grills/plan.json",
        "tests.json",
        "reviews/quality.json",
        "reviews/performance.json",
        "reviews/security.json",
        "verify.json",
    )
    for name in expected:
        assert (scoped / name).is_file(), name
        if name != "tests.json":
            assert not (repo / ".factory" / name).exists(), name


def test_intake_writes_untracked_pointer_zero_tracked_run_json(repo, tmp_path):
    sign_off(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    ensure_story(repo, "ENG-2", "Payments")
    git(repo, "add", "-A")
    if git(repo, "diff", "--cached", "--name-only"):
        git(repo, "commit", "-q", "-m", "prepare parallel stories")

    worktrees = (
        (tmp_path / "invoices", "story-invoices", "ENG-1", "Invoices"),
        (tmp_path / "payments", "story-payments", "ENG-2", "Payments"),
    )
    tracked_before = (repo / ".factory" / "run.json").read_bytes()
    pointers = []
    for worktree, branch, key, title in worktrees:
        git(repo, "worktree", "add", "-q", "-b", branch, str(worktree))
        (worktree / ".factory" / "stories" / key).mkdir(parents=True)
        code, out = intake(worktree, key, title)
        assert code == 0, out

        pointer = (
            Path(git(worktree, "rev-parse", "--absolute-git-dir"))
            / "forge" / "run.json"
        )
        pointers.append(pointer)
        assert json.loads(pointer.read_text())["issue_key"] == key
        assert (worktree / ".factory" / "run.json").read_bytes() == tracked_before
        assert git(worktree, "diff", "--", ".factory/run.json") == ""

    assert pointers[0] != pointers[1]


def test_intake_on_legacy_fixture_starts_new_layout_old_artifacts_readable(repo):
    sign_off(repo)
    (repo / ".factory" / "run.json").write_text(json.dumps({
        "issue_key": "LEG-1", "phase": "shipped",
    }))
    legacy_tests = repo / ".factory" / "tests.json"
    legacy_tests.write_text(json.dumps({"automated": {"passed": True}}))
    legacy_history = repo / ".factory" / "history" / "LEG-1"
    legacy_history.mkdir(parents=True)
    legacy_stages = legacy_history / "stages.json"
    legacy_stages.write_text(json.dumps({"stages": [{"status": "done"}]}))
    legacy_marker = repo / ".factory" / "plan-approval.json"
    legacy_marker.write_text(json.dumps({"legacy": True}))
    before = {
        path: path.read_bytes()
        for path in (legacy_tests, legacy_stages, legacy_marker)
    }

    code, out = intake(repo, "NEW-1", "New layout")

    assert code == 0, out
    lib = load_factory_lib(repo)
    assert lib.story_dir(repo, "NEW-1").is_dir()
    assert lib.run_state_path(repo).parent.name == "forge"
    assert lib.evidence_path(repo, "LEG-1", "stages.json") == legacy_stages
    assert all(path.read_bytes() == content for path, content in before.items())


def test_merge_simulation_two_stories_zero_factory_conflicts(repo, tmp_path):
    sign_off(repo)
    for key, title in (("MERGE-1", "First"), ("MERGE-2", "Second")):
        ensure_story(repo, key, title)
    roadmap = json.loads((repo / "plans" / "roadmap.json").read_text())
    for item in roadmap["items"]:
        if item.get("key") in {"MERGE-1", "MERGE-2"}:
            item["status"] = "active"
    (repo / "plans" / "roadmap.json").write_text(json.dumps(roadmap, indent=2) + "\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "prepare concurrent stories")

    branches = []
    factory_paths = []
    for key, title in (("MERGE-1", "First"), ("MERGE-2", "Second")):
        branch = key.lower()
        worktree = tmp_path / branch
        git(repo, "worktree", "add", "-q", "-b", branch, str(worktree))
        code, out = intake(worktree, key, title)
        assert code == 0, out
        scoped = worktree / ".factory" / "stories" / key
        (scoped / "tests.json").write_text(json.dumps({"story": key}) + "\n")
        git(worktree, "add", ".factory")
        git(worktree, "commit", "-q", "-m", f"record {key}")
        branches.append(branch)
        factory_paths.append({
            path for path in git(worktree, "show", "--format=", "--name-only").splitlines()
            if path.startswith(".factory/")
        })

    assert factory_paths[0].isdisjoint(factory_paths[1])

    for branch in branches:
        git(repo, "merge", "--no-edit", branch)
        assert not git(repo, "diff", "--name-only", "--diff-filter=U")
    changed = git(repo, "diff", "HEAD~2", "HEAD", "--name-only").splitlines()
    story_paths = [path for path in changed if path.startswith(".factory/stories/")]
    assert story_paths
    assert all(path.startswith((".factory/stories/MERGE-1/",
                                ".factory/stories/MERGE-2/")) for path in story_paths)


def test_shipped_new_layout_story_visible_to_board_and_consumers(repo):
    key = "SCOPED-1"
    board_story(repo, key)
    add_pr_link(repo, key)
    scoped = repo / ".factory" / "stories" / key
    reviews = scoped / "reviews"
    reviews.mkdir(parents=True)
    (scoped / "shipped.json").write_text("{}\n")
    (scoped / "stages.json").write_text(json.dumps({
        "stages": [{"status": "done"}],
    }))
    finding = {"category": "scoped-proof", "area": "history", "summary": "visible"}
    for aspect in ("quality", "performance", "security"):
        (reviews / f"{aspect}.json").write_text(json.dumps({
            "blocking_findings": [], "non_blocking_findings": [finding],
        }))
    completed = repo / "plans" / "completed" / f"{key}-scoped.md"
    completed.parent.mkdir(parents=True, exist_ok=True)
    completed.write_text(
        f"---\nissue: {key}\nstory: {key}\nstatus: shipped\n---\n\n# Scoped\n"
    )

    code, out = run(repo, "check_board_complete.py")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "list")
    assert code == 0 and "1/1" in out and completed.name in out, out
    code, out = run(repo, "forge.py", "findings", "patterns")
    assert code == 0 and "RECURRING x3" in out and key in out, out

    later = "SCOPED-2"
    board_story(repo, later)
    (repo / ".factory" / "stories" / later).mkdir(parents=True)
    code, out = run(repo, "forge.py", "audit")
    assert code == 0 and "IGNORED ESCALATION" in out and key in out, out


def test_phase_derivation_matches_legacy_run_json_semantics(repo):
    lib = load_factory_lib(repo)
    legacy = repo / ".factory" / "run.json"
    legacy_phases = (
        "discovery", "planning", "decomposing", "awaiting-approval",
        "implementing", "testing", "reviewing", "functional-check",
        "pr-ready", "shipped", "done", "degraded",
    )
    for phase in legacy_phases:
        legacy.write_text(json.dumps({"issue_key": "LEG-1", "phase": phase}))
        assert lib.load_json(lib.run_state_path(repo))["phase"] == phase
    assert lib.run_state_path(repo, "LEG-2", for_write=True) == legacy

    key = "SCOPED-1"
    scoped = lib.story_dir(repo, key)
    scoped.mkdir(parents=True)
    state = {"issue_key": key, "phase": "awaiting-approval"}
    pointer = lib.run_state_path(repo, key, for_write=True)
    lib.dump_json(pointer, state)
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "awaiting-approval"
    assert lib.run_state_path(repo, "LEG-2", for_write=True) == legacy

    (scoped / "decomposition.json").write_text("{}\n")
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "implementing"
    (scoped / "tests.json").write_text("{}\n")
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "testing"
    (scoped / "verify.json").write_text("{}\n")
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "reviewing"
    reviews = scoped / "reviews"
    reviews.mkdir()
    for aspect in ("quality", "performance", "security"):
        (reviews / f"{aspect}.json").write_text("{}\n")
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "functional-check"
    (scoped / "outcome.json").write_text("{}\n")
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "functional-check"

    lib.dump_json(pointer, {"phase": "shipped"})
    assert lib.load_json(lib.run_state_path(repo))["phase"] == "shipped"


def test_legacy_layout_stays_readable_by_every_consumer(repo):
    lib = load_factory_lib(repo)
    with pytest.raises(ValueError, match="one path component"):
        lib.story_dir(repo, "LEG\\1")
    factory = repo / ".factory"
    factory.mkdir(exist_ok=True)
    (factory / "run.json").write_text(json.dumps({"issue_key": "LEG-1"}))
    legacy_names = (
        "decomposition.json",
        "grills/plan.json",
        "grills/tasks/T1.json",
        "tests.json",
        "reviews/quality.json",
        "verify.json",
    )
    for name in legacy_names:
        path = factory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")

    assert lib.decomposition_state_path(repo) == factory / "decomposition.json"
    assert lib.tests_state_path(repo) == factory / "tests.json"
    assert lib.review_dir(repo) == factory / "reviews"
    assert lib.verify_state_path(repo) == factory / "verify.json"
    for name in legacy_names:
        assert lib.evidence_path(repo, "LEG-1", name) == factory / name

    history = factory / "history" / "LEG-1"
    for name in legacy_names:
        source = factory / name
        target = history / name
        target.parent.mkdir(parents=True, exist_ok=True)
        source.replace(target)
    (factory / "run.json").write_text(json.dumps({"issue_key": "OTHER-1"}))

    assert lib.decomposition_state_path(repo, "LEG-1") == history / "decomposition.json"
    assert lib.tests_state_path(repo, "LEG-1") == history / "tests.json"
    assert lib.review_dir(repo, "LEG-1") == history / "reviews"
    assert lib.verify_state_path(repo, "LEG-1") == history / "verify.json"
    for name in legacy_names:
        assert lib.evidence_path(repo, "LEG-1", name) == history / name


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

def prepare_pr_ready_story(
    repo: Path, tmp_path: Path, *, scoped_layout: bool = False,
) -> Path:
    sign_off(repo)
    if scoped_layout:
        (repo / ".factory" / "stories" / "ENG-1").mkdir(parents=True)
    code, out = intake(repo)
    assert code == 0, out
    if scoped_layout:
        plan = repo / "plans" / "active" / "ENG-1-invoices.md"
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(
            "---\nstatus: approved\nissue: ENG-1\nstory: ENG-1\n---\n\n" + PLAN_BODY
        )
        state = run_state(repo)
        state.update({
            "plan_file": plan.relative_to(repo).as_posix(),
            "plan_status": "approved",
            "story": "ENG-1",
        })
        lib = load_factory_lib(repo)
        lib.dump_json(lib.run_state_path(repo), state)
        code, out = record_grill(repo, "plan", digest_of=plan)
        assert code == 0, out
    else:
        code, out = save_plan(repo, tmp_path)
        assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    write_passing_artifacts(repo)
    code, out = run(repo, "update_run.py", "--decomposition-status", "recorded")
    assert code == 0, out
    return repo / ".factory" / "stories" / "ENG-1"


def test_pr_ready_ships_in_place_no_file_moves(repo, tmp_path):
    scoped = prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    outcome = scoped / "outcome.json"
    outcome.unlink()
    code, out = run(
        repo, "forge.py", "outcome", "set",
        "The invoice list now loads for every account and supports date filters "
        "without requiring a support request.",
    )
    assert code == 0, out
    assert outcome.is_file() and not (repo / ".factory" / "outcome.json").exists()

    plan = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    before = {
        path.relative_to(repo): path.read_bytes()
        for path in [plan, *scoped.rglob("*")]
        if path.is_file()
    }
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    assert "shipped in place" in out
    assert not (repo / ".factory" / "history" / "ENG-1").exists()
    assert not list((repo / "plans" / "completed").glob("ENG-1-*.md"))
    for relative, body in before.items():
        assert (repo / relative).read_bytes() == body, relative
    shipped = json.loads((scoped / "shipped.json").read_text())
    assert shipped["story"] == "ENG-1" and shipped["phase"] == "shipped"
    assert run_state(repo)["phase"] == "shipped"
    assert roadmap_items(repo)["ENG-1"]["status"] == "done"
    assert roadmap_items(repo)["ENG-1"]["history"] == ".factory/stories/ENG-1/"

    code, out = run(repo, "pr_ready.py")
    assert code == 0 and "already shipped in place: ENG-1" in out


def test_board_and_history_read_shipped_story_dir(repo, tmp_path):
    scoped = prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out

    from forge_cli.board import aggregate_state, story_detail

    detail = story_detail(repo, "ENG-1")
    assert detail is not None
    assert detail["evidence"]["outcome"]["outcome"].startswith("The invoice list")
    assert detail["evidence"]["verify"]["ok"] is True
    story = next(item for item in aggregate_state(repo)["stories"]
                 if item["key"] == "ENG-1")
    assert story["state"] == "shipped"
    assert story["lifecycle"]["verify"] is True
    assert story["lifecycle"]["tests"] is True
    assert all(story["lifecycle"]["reviews"].values())
    assert scoped.is_dir() and not (repo / ".factory" / "history" / "ENG-1").exists()

    code, out = run(repo, "forge.py", "history", "--story", "ENG-1")
    assert code == 0, out
    assert "shipped" in out and "Story: ENG-1" in out


def test_board_shows_shipped_story_tasks_when_plan_left_active_and_completed(
    repo, tmp_path,
):
    # A shipped story's plan can move out of plans/active|completed (to debt/, or
    # be archived) while its decomposition stays under .factory/stories/<key>/.
    # The board must still render its task graph from the archived decomposition,
    # never silently drop it to zero tasks (the "no task graph for a completed
    # story" board bug).
    from forge_cli.board import aggregate_state

    prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out

    def eng1():
        return next(s for s in aggregate_state(repo)["stories"] if s["key"] == "ENG-1")

    assert eng1()["state"] == "shipped" and eng1()["tasks"], "tasks present at ship"

    # Move the plan entirely out of the dirs the board scans for plan records.
    (repo / "plans" / "debt").mkdir(exist_ok=True)
    for location in ("active", "completed"):
        for plan_file in (repo / "plans" / location).glob("*.md"):
            plan_file.rename(repo / "plans" / "debt" / plan_file.name)

    story = eng1()
    assert story["state"] == "shipped"
    assert story["tasks"], "shipped story's task graph must survive the plan moving"
    assert story["lifecycle"]["planned"] is True

    # The plan RECORD (not just the task graph) must load from debt/, or the
    # shipped story reads as unplanned (no plan, stale approval blockers).
    from forge_cli.board import story_detail
    detail = story_detail(repo, "ENG-1")
    assert detail["plan"] is not None, "shipped plan in debt/ still loads on the board"
    assert detail["plan"].get("location") == "debt"


def test_board_stages_are_attributed_per_story(repo):
    # Stage status lives in a single git-local stages.json keyed to the ACTIVE
    # story. Regression: a shipped/non-active story lost its task-completion on
    # the board, and a newly-active undecomposed story inherited the previous
    # story's stages. Fix: per-story snapshots + an issue-guarded singleton read.
    from forge_cli.board import _stages_for
    from forge_cli import stages as stages_mod

    # A scoped-layout story (intake created its dir) gets a per-story snapshot.
    (repo / ".factory" / "stories" / "STORY-A").mkdir(parents=True)
    stages_mod.write_stages(
        repo, {"issue": "STORY-A",
               "stages": [{"id": "T1", "title": "t", "status": "done"}]})
    snap_a = repo / ".factory" / "stories" / "STORY-A" / "stages.json"
    assert snap_a.is_file(), "write_stages writes a per-story snapshot"

    # Decomposing STORY-B flips the singleton; the outgoing STORY-A is preserved
    # (covers a story decomposed before per-story snapshots existed).
    stages_mod.write_skeleton(repo, "STORY-B", [{"id": "T1", "title": "t"}])
    assert json.loads(snap_a.read_text(encoding="utf-8"))["stages"][0]["status"] == "done"

    # Each story shows its OWN stages; neither bleeds from the singleton.
    assert _stages_for(repo, "STORY-A")["stages"][0]["status"] == "done"
    assert all(s["status"] == "pending"
               for s in _stages_for(repo, "STORY-B")["stages"])
    assert _stages_for(repo, "STORY-C") == {}, "no bleed to an unrelated story"
    assert _stages_for(repo, "") == {}, "no active story: empty key must not crash"


def test_pr_ready_legacy_story_still_archives_to_history(repo, tmp_path):
    sign_off(repo)
    assert signed_off(repo)
    code, _ = intake(repo)
    assert code == 0
    make_legacy_story(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
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


def test_encoding_hygiene_gate_catches_each_violation_class(tmp_path):
    from check_encoding_hygiene import (
        BYTE_MODE_ALLOWLIST, BYTE_PATH_ALLOWLIST, ContentPin, check_file,
        construct_fingerprint,
    )

    violations = {
        "subprocess.py": (
            "import subprocess\n"
            "subprocess.run(['tool'], capture_output=True, "
            "encoding='latin-1')\n"
        ),
        "subprocess_alias.py": (
            "from subprocess import run as invoke\n"
            "invoke(['tool'], capture_output=True, text=True)\n"
        ),
        "subprocess_input.py": (
            "import subprocess\n"
            "subprocess.run(['tool'], input='payload', text=True)\n"
        ),
        "popen_stdin.py": (
            "import subprocess\n"
            "subprocess.Popen(['tool'], stdin=subprocess.PIPE, text=True)\n"
        ),
        "popen_stdin_alias.py": (
            "import subprocess as process\n"
            "process.Popen(['tool'], stdin=process.PIPE, text=True)\n"
        ),
        "local_subprocess_alias.py": (
            "def launch():\n"
            "    from subprocess import PIPE, Popen\n"
            "    Popen(['tool'], stdin=PIPE, text=True)\n"
        ),
        "path_text.py": "from pathlib import Path\nPath('x').read_text()\n",
        "open_text.py": "open('x', 'a')\n",
        "temp_text.py": (
            "import tempfile\n"
            "tempfile.NamedTemporaryFile(mode='w+')\n"
        ),
        "temp_alias.py": (
            "from tempfile import NamedTemporaryFile as temp\n"
            "temp(mode='w+')\n"
        ),
        "stdin.py": "import sys\nsys.stdin.read()\n",
        "input.py": "input()\n",
        "stdin_alias.py": "from sys import stdin as source\nsource.read()\n",
        "local_stdin_alias.py": (
            "def read():\n"
            "    from sys import stdin as source\n"
            "    return source.read()\n"
        ),
        "stdin_getattr.py": "import sys\ngetattr(sys, 'stdin').read()\n",
        "replace.py": (
            "from pathlib import Path\n"
            "Path('x').read_text(encoding='utf-8', errors='replace')\n"
        ),
        "surrogateescape.py": (
            "from pathlib import Path\n"
            "Path('x').read_text(encoding='utf-8', errors='surrogateescape')\n"
        ),
        "ignore.py": "open('x', encoding='utf-8', errors='ignore')\n",
        "backslashreplace.py": (
            "open('x', encoding='utf-8', errors='backslashreplace')\n"
        ),
        "dynamic_errors.py": (
            "policy = 'strict'\nopen('x', encoding='utf-8', errors=policy)\n"
        ),
    }
    expected = {
        "subprocess.py": {"subprocess-text"},
        "subprocess_alias.py": {"subprocess-text"},
        "subprocess_input.py": {"subprocess-text"},
        "popen_stdin.py": {"subprocess-text"},
        "popen_stdin_alias.py": {"subprocess-text"},
        "local_subprocess_alias.py": {"subprocess-text"},
        "path_text.py": {"text-file"},
        "open_text.py": {"text-file"},
        "temp_text.py": {"text-file"},
        "temp_alias.py": {"text-file"},
        "stdin.py": {"stdin"},
        "input.py": {"stdin"},
        "stdin_alias.py": {"stdin"},
        "local_stdin_alias.py": {"stdin"},
        "stdin_getattr.py": {"stdin"},
        "replace.py": {"errors-policy"},
        "surrogateescape.py": {"errors-policy"},
        "ignore.py": {"errors-policy"},
        "backslashreplace.py": {"errors-policy"},
        "dynamic_errors.py": {"errors-policy"},
    }
    for name, source in violations.items():
        path = tmp_path / name
        path.write_text(source, encoding="utf-8")
        assert {
            violation.rule for violation in check_file(path, root=tmp_path)
        } == expected[name]

    allowed = tmp_path / "allowed.py"
    allowed.write_text(
        "import io, os, subprocess, sys, tempfile\n"
        "subprocess.run(['tool'], capture_output=True, text=True, "
        "encoding='utf-8', errors='replace')\n"
        "open('path', encoding='utf-8', errors='surrogateescape')\n"
        "open('bytes', 'rb')\n"
        "os.open('safe', os.O_RDONLY, dir_fd=3)\n"
        "webbrowser.open('https://example.test')\n"
        "tempfile.TemporaryFile(mode='w+t', encoding='utf-8')\n"
        "io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', "
        "errors='strict').read()\n",
        encoding="utf-8",
    )
    replace_pin = ContentPin(
        "allowed.py", construct_fingerprint(
            allowed.read_text(encoding="utf-8").splitlines()[1]),
    )
    byte_path_pin = ContentPin(
        "allowed.py", construct_fingerprint(
            allowed.read_text(encoding="utf-8").splitlines()[2]),
    )
    stdin_pin = ContentPin(
        "allowed.py", construct_fingerprint(
            allowed.read_text(encoding="utf-8").splitlines()[7]),
    )
    assert check_file(
        allowed,
        root=tmp_path,
        replace_allowlist=(replace_pin,),
        byte_path_allowlist=((byte_path_pin, "lossless path"),),
        stdin_allowlist=(stdin_pin,),
    ) == []
    assert any(pin.path.endswith("phase.py") for pin, _ in BYTE_PATH_ALLOWLIST)
    assert any(pin.path.endswith("upgrade.py") for pin, _ in BYTE_MODE_ALLOWLIST)
    assert any(pin.path.endswith("pr_ready.py") for pin, _ in BYTE_MODE_ALLOWLIST)

    byte_site = tmp_path / "byte_site.py"
    byte_site.write_text(
        "import subprocess\n"
        "subprocess.run(['tool'], text=True, encoding='utf-8')\n",
        encoding="utf-8",
    )
    assert {violation.rule for violation in check_file(
        byte_site,
        root=tmp_path,
        byte_mode_allowlist=((ContentPin(
            "byte_site.py",
            construct_fingerprint(
                byte_site.read_text(encoding="utf-8").splitlines()[1]
            ),
        ), "must stay bytes"),),
    )} == {"byte-mode"}


def test_encoding_hygiene_content_pins_survive_insertion(tmp_path):
    from check_encoding_hygiene import (
        ContentPin, check_file, construct_fingerprint,
    )

    path = tmp_path / "pinned.py"
    construct = "Path('x').read_text(encoding='utf-8', errors='replace')"
    pin = ContentPin("pinned.py", construct_fingerprint(construct), 0)
    path.write_text(f"from pathlib import Path\n{construct}\n", encoding="utf-8")
    assert check_file(path, root=tmp_path, replace_allowlist=(pin,)) == []

    path.write_text(f"# insertion\nfrom pathlib import Path\n{construct}\n",
                    encoding="utf-8")
    assert check_file(path, root=tmp_path, replace_allowlist=(pin,)) == []

    path.write_text("from pathlib import Path\nPath('changed').read_text("
                    "encoding='utf-8', errors='replace')\n", encoding="utf-8")
    violations = check_file(path, root=tmp_path, replace_allowlist=(pin,))
    assert {violation.rule for violation in violations} == {"errors-policy"}
    assert any("changed or was removed" in v.message for v in violations)


def test_encoding_hygiene_gate_catches_wrapper_and_positional_tempfile(tmp_path):
    from check_encoding_hygiene import check_file

    violations = {
        "wrapper_missing.py": "import io\nio.TextIOWrapper(stream)\n",
        "wrapper_non_utf8.py": (
            "import io\nio.TextIOWrapper(stream, encoding='latin-1')\n"
        ),
        "temporary_file.py": (
            "import tempfile\ntempfile.TemporaryFile('w+t')\n"
        ),
        "named_temporary_file.py": (
            "import tempfile\ntempfile.NamedTemporaryFile('w+t')\n"
        ),
    }
    for name, source in violations.items():
        path = tmp_path / name
        path.write_text(source, encoding="utf-8")
        assert {
            violation.rule for violation in check_file(path, root=tmp_path)
        } == {"text-file"}


def test_recorder_stdin_reads_non_ascii_utf8(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    payload = json.loads(json.dumps(DECOMP))
    payload["tasks"][0]["title"] = "Unicode arrow → snowman ☃"
    record_skeleton_then_frontier(repo, payload["tasks"])
    env = {**os.environ, "PYTHONIOENCODING": "ascii:strict", "PYTHONUTF8": "0"}

    proc = subprocess.run(
        [sys.executable, str(
            repo / "factory" / "scripts" / "record_decomposition_from_json.py"
        )],
        cwd=repo,
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
        env=env,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    recorded = json.loads(
        (story_state(repo) / "decomposition.json").read_text(encoding="utf-8")
    )
    assert recorded["tasks"][0]["title"] == payload["tasks"][0]["title"]


def test_read_stdin_utf8_does_not_close_shared_buffer(monkeypatch):
    import io
    from factory_lib import read_stdin_utf8

    stream = io.TextIOWrapper(io.BytesIO("first →".encode("utf-8")))
    monkeypatch.setattr(sys, "stdin", stream)

    assert read_stdin_utf8() == "first →"
    assert read_stdin_utf8() == ""
    assert not sys.stdin.buffer.closed


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


def test_vendor_manifest_is_line_ending_independent(repo):
    """A manifest generated on a Windows working tree (CRLF) must still verify
    on a Linux CI checkout (LF). Hashing raw bytes made the whole gate surface
    read as vendor-drift right after a Windows re-vendor (project audit /
    roadmap-gate); compute_hashes now normalises CRLF->LF."""
    from importlib import import_module
    import sys
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    sys.modules.pop("check_vendor_integrity", None)
    cvi = import_module("check_vendor_integrity")

    target = next(p for p in (repo / cvi.GATE_TREES[0]).rglob("*.py")
                  if p.is_file())
    lf = target.read_bytes().replace(b"\r\n", b"\n")
    crlf = lf.replace(b"\n", b"\r\n")

    # Manifest generated from LF content (a Linux re-vendor); a CRLF working
    # tree (Windows checkout) of the same file must NOT read as drift.
    target.write_bytes(lf)
    cvi.write_manifest(repo, "test-commit")
    assert cvi.integrity_problems(repo) == []
    target.write_bytes(crlf)
    assert cvi.integrity_problems(repo) == [], \
        "CRLF working tree must verify against an LF manifest"

    # And the reverse: manifest from CRLF (a Windows re-vendor), verified on a
    # LF checkout (Linux CI) — the exact roadmap-gate failure this fixes.
    cvi.write_manifest(repo, "test-commit")
    target.write_bytes(lf)
    assert cvi.integrity_problems(repo) == [], \
        "LF checkout must verify against a CRLF manifest"


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
    # BEFORE sign-off, `roadmap add` itself refuses as post-sign-off grooming,
    # so naming it would send the caller to a command that cannot run. Name the
    # gate actually in the way, and the 0c path out of it.
    code, out = run(repo, "intake.py", "--issue", "OFF-1", "--title", "Off board")
    assert code != 0
    assert "no client sign-off yet" in out, out
    assert "roadmap derive" in out, out

    # AFTER sign-off, grooming the roadmap by hand IS the way to add a story.
    sign_off(repo)
    code, out = run(repo, "intake.py", "--issue", "OFF-2", "--title", "Off board")
    assert code != 0
    assert "roadmap add --no-spec" in out, out


def test_intake_allows_on_board_key(repo):
    ensure_story(repo, "BOARD-1", "On board")

    code, out = run(repo, "intake.py", "--issue", "BOARD-1", "--title", "On board")

    assert code == 0, out
    assert roadmap_items(repo)["BOARD-1"]["status"] == "active"


def test_intake_preserves_signoff_and_refuses_to_clobber_evidence(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    # Mid-task second intake must refuse (autoreview r3)
    code, out = intake(repo, "ENG-2", "Refunds")
    assert code != 0 and "unarchived" in out
    assert (story_state(repo) / "decomposition.json").exists()
    # Deliberate abandonment works and preserves sign-off (intake fix, r1 of first review)
    code, out = intake(repo, "ENG-2", "Refunds", "--discard-active")
    assert code == 0, out
    state = run_state(repo)
    assert signed_off(repo) and state["phase"] == "planning"
    assert not (story_state(repo) / "decomposition.json").exists()


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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    state = run_state(repo)
    state["phase"] = "shipped"
    lib = load_factory_lib(repo)
    lib.dump_json(lib.run_state_path(repo), state)
    code, out = intake(repo, "ENG-2", "Refunds")
    assert code == 0, out
    assert (repo / "plans" / "active" / "ENG-1-invoices.md").is_file()
    assert not (repo / "plans" / "debt" / "ENG-1-invoices.md").exists()


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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    code, out = run(repo, "update_run.py", "--phase", "implementing")
    assert code == 0, out


def test_update_run_enforces_artifact_phase_order(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])

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


def test_decomposition_not_frozen_by_previous_story_authority(repo, tmp_path):
    # A shipped story whose ship-time clear never ran leaves .git/forge/
    # decomposition.json + stages.json behind. The next story's FIRST
    # recording must not be prefix-frozen to that stale task graph — the
    # recorder story-scopes the protected authority the way load_stages does,
    # clearing the shipped/orphaned story's leftovers idempotently.
    sign_off(repo)
    intake(repo)
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    lib = load_factory_lib(repo)
    protected = lib.protected_decomposition_state_path(repo)
    assert protected.exists()
    assert json.loads(protected.read_text())["story"] == "ENG-1"

    # Ship ENG-1 without clear_story_authority running (the documented
    # "its clear never ran" case), then start ENG-2.
    state = run_state(repo)
    state["phase"] = "shipped"
    lib.dump_json(lib.run_state_path(repo, state["issue_key"], for_write=True),
                  state)
    code, out = intake(repo, "ENG-2", "Receipts")
    assert code == 0, out
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out

    # ENG-2's own task graph (different ids) records as a FIRST recording.
    tasks2 = [{**DECOMP["tasks"][0], "id": "T2-1",
               "title": "receipts slice"}]
    skeletons = [task_skeleton(task) for task in tasks2]
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    assert "Cleared stale protected authority" in out
    assert json.loads(protected.read_text())["story"] == "ENG-2"

    # Same-story freeze still applies to STARTED work: once T2-1 is done, a
    # non-prefix rewrite is frozen. (An unstarted rewrite would instead be an
    # amendment — allowed but human-gated — which is covered elsewhere.)
    write_stages(repo, {"issue": "ENG-2", "stages": [
        {"id": "T2-1", "title": "receipts slice", "status": "done"}]})
    rogue = [{**DECOMP["tasks"][0], "id": "T2-ROGUE", "title": "rewrite"}]
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [
                        task_skeleton(task) for task in rogue]}))
    assert code != 0 and "frozen" in out


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
    verify = story_state(repo) / "verify.json"
    verify.write_text(json.dumps({"ok": True}))  # no commit stamp
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "stamped at HEAD" in out


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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
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
    git(repo, "add", "-A", ".factory", "plans")
    git(repo, "commit", "-q", "-m", "record evidence")  # touches .factory/plans only
    write_passing_artifacts(repo)  # evidence-only commit moved HEAD; re-stamp there
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_pr_ready_tolerates_harness_upgrade_commits(repo, tmp_path):
    # Found by the pilot simulation: a forge upgrade mid-task touches factory/
    # machinery. In the harness repo that is product, so the branch review and
    # evidence are re-grounded after the upgrade and manifest refresh.
    ready_task(repo, tmp_path)
    (repo / "factory" / "scripts" / "extra_helper.py").write_text("# upgraded\n")
    refresh_manifest(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "chore: forge upgrade")
    write_passing_artifacts(repo)
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
    (repo / "factory" / "scripts" / "check_encoding_hygiene.py").unlink()
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
    assert (repo / "factory" / "scripts" / "check_encoding_hygiene.py").exists()
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


def test_upgrade_names_diverged_doc_contracts_and_writes_no_backup(repo):
    edited = repo / "docs" / "product" / "README.md"
    identical = repo / "docs" / "architecture" / "README.md"
    edited.write_text("# Client-owned edit\n")
    identical.write_bytes(
        (HARNESS / "docs" / "architecture" / "README.md").read_bytes())
    git(repo, "add", edited.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "edit a doc contract")

    proc = upgrade_into(repo)

    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    replaced = next(
        line for line in output.splitlines()
        if line.startswith("Replaced doc contracts:")
    )
    assert "docs/product/README.md" in replaced
    assert "docs/architecture/README.md" in replaced
    warning = next(
        line for line in output.splitlines()
        if line.startswith("WARNING: replaced doc contracts differed")
    )
    assert "docs/product/README.md" in warning
    assert "docs/architecture/README.md" not in warning
    assert "git diff -- docs/product/README.md" in warning
    assert "docs/product/ (except its README.md doc contract)" in output
    assert not list(repo.rglob("*.orig"))


@pytest.mark.skipif(
    not HARNESS_SOURCE_MARKER_FIXTURE.is_file(),
    reason="requires the harness-source marker fixture",
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


def test_dual_runtime_replace_decodes_tracked_source_suffix(repo):
    binary = repo / "vendor.js"
    binary.write_bytes(b"\xff\x00binary")
    git(repo, "add", "vendor.js")

    code, out = run(repo, "check_dual_runtime.py", str(repo))

    assert code == 0, out

    latin1 = repo / "legacy.js"
    latin1.write_bytes(
        "// caf\N{LATIN SMALL LETTER E WITH ACUTE}\n"
        "import '../prototype/utils';\n".encode("latin-1")
    )
    git(repo, "add", "legacy.js")

    code, out = run(repo, "check_dual_runtime.py", str(repo))

    assert code != 0 and "legacy.js:2 imports from prototype/" in out


def _route_fixture_hooks_through_forge(repo: Path) -> None:
    from check_dual_runtime import hook_script_paths

    for relative in (".claude/settings.json", ".codex/hooks.json"):
        path = repo / relative
        document = json.loads(path.read_text())
        for registrations in document["hooks"].values():
            for registration in registrations:
                for hook in registration["hooks"]:
                    scripts = hook_script_paths(hook["command"])
                    assert len(scripts) == 1
                    name = Path(scripts[0]).stem
                    hook["command"] = (
                        "sh -c '\"$(git rev-parse --show-toplevel)/forge\" "
                        f"hook {name} || exit 2' || exit 2"
                    )
        path.write_text(json.dumps(document, indent=2) + "\n")


def test_doctor_hook_health_green_on_healthy_repo(repo):
    from forge_cli.doctor import hook_health_checks

    _route_fixture_hooks_through_forge(repo)
    before = git(repo, "status", "--porcelain", "-uall")
    bytecode_before = set(repo.rglob("__pycache__"))
    checks = hook_health_checks(repo)

    assert len(checks) == 9
    assert all(check["ok"] for check in checks), checks
    assert git(repo, "status", "--porcelain", "-uall") == before
    assert set(repo.rglob("__pycache__")) == bytecode_before


def test_hook_module_chain_has_no_posix_only_imports(repo, monkeypatch):
    posix_only = {"fcntl", "grp", "pwd", "resource", "termios"}
    module_paths = (
        "factory/scripts/pre_tool_use.py",
        "factory/scripts/forge_cli/quickfix.py",
        "factory/scripts/forge_cli/stages.py",
        "factory/scripts/forge_cli/delegate.py",
    )
    offenders = []
    for relative in module_paths:
        tree = ast.parse((repo / relative).read_text(), filename=relative)
        for node in tree.body:
            if isinstance(node, ast.Import):
                names = {alias.name.partition(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = {node.module.partition(".")[0]}
            else:
                continue
            offenders.extend(
                f"{relative}:{node.lineno}:{name}"
                for name in sorted(names & posix_only)
            )
    assert offenders == []

    program = "\n".join((
        "import io, runpy, subprocess, sys",
        "sys.path.insert(0, 'factory/scripts')",
        "sys.modules.pop('fcntl', None)",
        "sys.modules['fcntl'] = None",
        "import forge_cli.quickfix",
        "import forge_cli.stages",
        "import forge_cli.delegate",
        "sys.stdin = io.StringIO('{}')",
        "runpy.run_path('factory/scripts/pre_tool_use.py', run_name='__main__')",
    ))
    result = subprocess.run(
        [sys.executable, "-c", program], cwd=repo,
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == "{}\n"

    import types
    import forge_cli.delegate as delegate

    native_os_name = delegate.os.name
    calls = []
    fake_msvcrt = types.SimpleNamespace(
        LK_NBLCK=1,
        LK_UNLCK=2,
        locking=lambda fd, mode, length: calls.append((fd, mode, length)),
    )
    monkeypatch.setattr(delegate.os, "name", "nt")
    monkeypatch.setitem(sys.modules, "msvcrt", fake_msvcrt)
    lock_path = repo / ".factory" / "windows-import-proof.lock"
    with lock_path.open("a+") as handle:
        delegate._lock_file(handle)
        delegate._unlock_file(handle)
        assert calls == [
            (handle.fileno(), fake_msvcrt.LK_NBLCK, 1),
            (handle.fileno(), fake_msvcrt.LK_UNLCK, 1),
        ]

    monkeypatch.setattr(delegate.os, "name", native_os_name)
    with lock_path.open("a+") as first, lock_path.open("a+") as second:
        delegate._lock_file(first)
        try:
            with pytest.raises(BlockingIOError):
                delegate._lock_file(second)
        finally:
            delegate._unlock_file(first)


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX only: constructs an interpreter-free PATH around a real sh binary",
)
def test_doctor_hook_health_reds_unresolvable_hook(repo, tmp_path):
    from forge_cli.doctor import HOOK_HEALTH_FIX, _display_mark, hook_health_checks

    _route_fixture_hooks_through_forge(repo)
    fake_bin = tmp_path / "hook-path"
    fake_bin.mkdir()
    (fake_bin / "sh").symlink_to(shutil.which("sh"))
    fake_git = fake_bin / "git"
    fake_git.write_text(f"#!{shutil.which('sh')}\nprintf '%s\\n' '{repo}'\n")
    fake_git.chmod(0o755)

    checks = hook_health_checks(repo, env={"PATH": str(fake_bin)})
    failures = [check for check in checks if not check["ok"]]

    assert len(failures) == 9
    assert len({check["name"] for check in failures}) == 9
    registered = json.loads((repo / ".claude" / "settings.json").read_text())
    command = registered["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    assert any(command in check["detail"] for check in failures)
    assert all("exit 2 (blocking)" in check["detail"] for check in failures)
    assert all(_display_mark(check) == "RED" for check in failures)
    assert all(check["fix"] == HOOK_HEALTH_FIX for check in failures)


def test_hook_resolution_fails_closed_without_interpreter(tmp_path):
    from forge_cli.doctor import _runnable_hook_shell

    shell = _runnable_hook_shell(dict(os.environ), HARNESS)
    assert shell, "test requires a working POSIX shell"
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()

    result = subprocess.run(
        [shell, str(HARNESS / "forge"), "hook", "session_start"],
        cwd=HARNESS,
        input="{}",
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": str(empty_path)},
    )

    assert result.returncode == 2
    assert "Python 3.10 or newer was not found" in result.stderr


@pytest.mark.parametrize("broken_target", [
    "forge", "factory/scripts/forge.py", "factory/scripts/session_start.py",
])
def test_registered_hook_command_normalizes_launch_failures(repo, broken_target):
    from forge_cli.doctor import _runnable_hook_shell

    _route_fixture_hooks_through_forge(repo)
    shell = _runnable_hook_shell(dict(os.environ), repo)
    assert shell, "test requires a shell that can launch this checkout"
    (repo / broken_target).unlink()
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]

    result = subprocess.run(
        [shell, "-c", command],
        cwd=repo,
        input="{}",
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable mode has no cmd equivalent")
def test_registered_hook_command_blocks_a_nonexecutable_launcher(repo):
    _route_fixture_hooks_through_forge(repo)
    (repo / "forge").chmod(0o644)
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]

    result = subprocess.run(
        [shutil.which("sh"), "-c", command], cwd=repo, input="{}",
        capture_output=True, text=True,
    )

    assert result.returncode == 2


@pytest.mark.skipif(os.name == "nt", reason="POSIX PATH fixture uses executable symlinks")
def test_registered_hook_command_blocks_when_git_cannot_find_the_repo(repo, tmp_path):
    _route_fixture_hooks_through_forge(repo)
    fake_bin = tmp_path / "no-git"
    fake_bin.mkdir()
    (fake_bin / "sh").symlink_to(shutil.which("sh"))
    (fake_bin / "python3").symlink_to(sys.executable)
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]

    result = subprocess.run(
        [shutil.which("sh"), "-c", command], cwd=repo, input="{}",
        capture_output=True, text=True,
        env={**os.environ, "PATH": str(fake_bin)},
    )

    assert result.returncode == 2


def test_registered_hook_command_fails_closed_when_inner_sh_is_missing(repo, tmp_path):
    from forge_cli.doctor import _runnable_hook_shell

    _route_fixture_hooks_through_forge(repo)
    shell = _runnable_hook_shell(dict(os.environ), repo)
    assert shell, "test requires a shell that can launch this checkout"
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()

    result = subprocess.run(
        [shell, "-c", command],
        cwd=repo,
        input="{}",
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": str(empty_path)},
    )

    assert result.returncode == 2


@pytest.mark.skipif(
    os.name != "nt",
    reason="Windows only: proves cmd.exe evaluates the outer fail-closed guard",
)
def test_registered_hook_command_fails_closed_when_cmd_cannot_spawn_sh(repo, tmp_path):
    _route_fixture_hooks_through_forge(repo)
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()

    result = subprocess.run(
        [os.environ["COMSPEC"], "/d", "/c", command],
        cwd=repo,
        input="{}",
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": str(empty_path)},
    )

    assert result.returncode == 2


@pytest.mark.parametrize(("hook_exit", "registered_exit"), [(0, 0), (2, 2), (7, 2)])
def test_registered_hook_command_preserves_success_and_blocks_nonzero(
        repo, hook_exit, registered_exit):
    from forge_cli.doctor import _runnable_hook_shell

    _route_fixture_hooks_through_forge(repo)
    shell = _runnable_hook_shell(dict(os.environ), repo)
    assert shell, "test requires a shell that can launch this checkout"
    launcher = repo / "forge"
    launcher.write_text(f"#!/bin/sh\nexit {hook_exit}\n")
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"]

    result = subprocess.run(
        [shell, "-c", command],
        cwd=repo,
        input="{}",
        capture_output=True,
        text=True,
    )

    assert result.returncode == registered_exit


def test_doctor_hook_health_catches_precompact_import_skew(repo):
    from forge_cli.doctor import hook_health_checks

    _route_fixture_hooks_through_forge(repo)
    scratchpad = repo / "factory" / "scripts" / "forge_cli" / "scratchpad.py"
    scratchpad.write_text("raise ImportError('broken scratchpad package')\n")

    failures = [check for check in hook_health_checks(repo) if not check["ok"]]

    assert len(failures) == 1
    assert ".claude/settings.json:PreCompact" in failures[0]["name"]
    assert "broken scratchpad package" in failures[0]["detail"]


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX only: monkeypatches all shell discovery to emulate missing Git Bash",
)
def test_doctor_hook_health_missing_sh_names_git_bash_fix(repo, monkeypatch):
    from forge_cli import doctor

    _route_fixture_hooks_through_forge(repo)
    real_which = doctor.shutil.which
    monkeypatch.setattr(
        doctor.shutil, "which",
        lambda binary, path=None: (
            None if binary == "sh" else real_which(binary, path=path)
        ),
    )

    failures = [check for check in doctor.hook_health_checks(repo)
                if not check["ok"]]

    assert len(failures) == 9
    assert all(check["fix"] == doctor.HOOK_SHELL_FIX for check in failures)
    assert all("Git for Windows" in check["fix"] for check in failures)


def test_doctor_hook_health_broken_launcher_does_not_blame_git_bash(repo):
    from forge_cli import doctor

    _route_fixture_hooks_through_forge(repo)
    (repo / "forge").unlink()

    failures = [check for check in doctor.hook_health_checks(repo)
                if not check["ok"]]

    assert len(failures) == 9
    assert all("hook launcher probe failed" in check["detail"] for check in failures)
    assert all(check["fix"] == doctor.HOOK_HEALTH_FIX for check in failures)


def test_init_and_upgrade_ship_portable_hook_commands(tmp_path):
    from check_dual_runtime import hook_script_paths

    def commands(root: Path, relative: str) -> list[str]:
        document = json.loads((root / relative).read_text())
        return [
            hook["command"]
            for registrations in document["hooks"].values()
            for registration in registrations
            for hook in registration["hooks"]
        ]

    def portable(command: str) -> bool:
        expected_exit = " || exit 0' || exit 0" \
            if "hook post_tool_use" in command else " || exit 2' || exit 2"
        return (command.startswith("sh -c ") and command.endswith(expected_exit)
                and bool(hook_script_paths(command)))

    repo = tmp_path / "portable-hooks-client"
    initialized = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "portable-hooks-client", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True,
    )
    assert initialized.returncode == 0, initialized.stdout + initialized.stderr
    assert len(commands(repo, ".claude/settings.json")) == 6
    assert len(commands(repo, ".codex/hooks.json")) == 3
    config = repo / ".codex" / "config.toml"
    assert 'sandbox_mode = "workspace-write"' in config.read_text().splitlines()
    assert (repo / "forge.cmd").is_file()
    attributes = repo / ".gitattributes"
    assert "forge text eol=lf" in attributes.read_text().splitlines()
    assert all(
        portable(command)
        for relative in (".claude/settings.json", ".codex/hooks.json")
        for command in commands(repo, relative)
    )

    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "scaffold")
    (repo / "forge.cmd").unlink()
    attributes.write_text("\n".join(
        line for line in attributes.read_text().splitlines()
        if line != "forge text eol=lf"
    ) + "\n")
    for relative in (".claude/settings.json", ".codex/hooks.json"):
        (repo / relative).write_text(json.dumps({"hooks": {}}) + "\n")
    config.write_text(config.read_text().replace(
        'sandbox_mode = "workspace-write"',
        'sandbox_mode = "danger-full-access"',
    ))
    git(repo, "add", ".claude/settings.json", ".codex/hooks.json",
        ".codex/config.toml", ".gitattributes", "forge.cmd")
    git(repo, "commit", "-q", "-m", "degrade hook registrations")

    upgraded = upgrade_into(repo)
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    assert len(commands(repo, ".claude/settings.json")) == 6
    assert len(commands(repo, ".codex/hooks.json")) == 3
    assert 'sandbox_mode = "workspace-write"' in config.read_text().splitlines()
    assert (repo / "forge.cmd").is_file()
    assert "forge text eol=lf" in attributes.read_text().splitlines()
    assert all(
        portable(command)
        for relative in (".claude/settings.json", ".codex/hooks.json")
        for command in commands(repo, relative)
    )


def test_hook_registration_extracts_every_registered_script():
    from check_dual_runtime import hook_script_paths

    synthetic = (
        'sh -c \'"$(git rev-parse --show-toplevel)/forge" '
        "hook session_start || exit 2'"
    )
    assert hook_script_paths(synthetic) == ["factory/scripts/session_start.py"]

    for relative in (".claude/settings.json", ".codex/hooks.json"):
        document = json.loads((HARNESS / relative).read_text())
        for event, registrations in document["hooks"].items():
            for registration in registrations:
                for hook in registration["hooks"]:
                    scripts = hook_script_paths(hook["command"])
                    assert scripts, f"{relative}:{event} did not expose a script path"
                    assert all((HARNESS / script).is_file() for script in scripts)
                    expected_exit = " || exit 0' || exit 0" \
                        if event == "PostToolUse" else " || exit 2' || exit 2"
                    assert hook["command"].endswith(expected_exit)


def test_forge_cmd_routes_git_bash_then_python_fallbacks(tmp_path):
    shim = (HARNESS / "forge.cmd").read_text()
    launcher = (HARNESS / "forge").read_text()
    assert 'setlocal\nset "PYTHONUTF8=1"' in shim
    assert "set -eu\nexport PYTHONUTF8=1" in launcher
    assert shim.index('set "PYTHONUTF8=1"') < shim.index("py -3")
    assert launcher.index("export PYTHONUTF8=1") < launcher.index("py -3")
    assert shim.index("CLAUDE_CODE_GIT_BASH_PATH") < shim.index("where sh")
    assert (
        shim.index("where py") < shim.index("where python")
        < shim.index("where python3") < shim.index("CLAUDE_CODE_GIT_BASH_PATH")
        < shim.index("where sh")
    )
    assert "%ProgramFiles%\\Git\\usr\\bin\\sh.exe" in shim
    assert "%LOCALAPPDATA%\\Programs\\Git\\usr\\bin\\sh.exe" in shim
    assert "call" not in shim.lower()
    assert shim.count('if /i "%%~xI"==".exe"') == 2
    assert shim.count('if /i "%%~xJ"==".exe"') == 1
    assert (
        ':run_sh\n'
        '"%FORGE_SH%" "%~dp0forge" %*\n'
        'exit /b %errorlevel%'
    ) in shim
    assert 'py -3 "%~dp0factory\\scripts\\forge.py" %*' in shim
    assert 'python "%~dp0factory\\scripts\\forge.py" %*' in shim
    assert 'python3 "%~dp0factory\\scripts\\forge.py" %*' in shim
    assert shim.count("sys.version_info >= (3, 10)") == 3
    assert (
        'cmd /d /c py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= '
        '(3, 10) else 1)" >nul 2>nul\n'
        'if errorlevel 1 goto python_fallback\n'
        'set "FORGE_PYTHON=py"\n'
        'goto discover_shell'
    ) in shim
    assert (
        'cmd /d /c python -c "import sys; raise SystemExit(0 if sys.version_info >= '
        '(3, 10) else 1)" >nul 2>nul\n'
        'if errorlevel 1 goto python3_fallback\n'
        'set "FORGE_PYTHON=python"\n'
        'goto discover_shell'
    ) in shim
    assert "exit /b 2" in shim

    if os.name == "nt":
        executable_shell = shutil.which("sh")
        assert executable_shell and Path(executable_shell).suffix.lower() == ".exe"
        override_case = tmp_path / "override"
        override_case.mkdir()
        shutil.copy2(HARNESS / "forge.cmd", override_case / "forge.cmd")
        (override_case / "forge").write_bytes(
            b"#!/bin/sh\n"
            b"if [ \"$1\" = \"--help\" ]; then printf 'OVERRIDE\\n'; exit 0; fi\n"
            b"exit 9\n"
        )
        launcher_bin = tmp_path / "launcher-bin"
        launcher_bin.mkdir()
        (launcher_bin / "python.cmd").write_text(
            '@echo off\n'
            'if "%~1"=="-c" exit /b 0\n'
            'echo PYTHON\n'
            'exit /b 0\n'
        )
        system_root = Path(os.environ["SystemRoot"])
        path_without_sh = os.pathsep.join(
            [str(launcher_bin), str(system_root / "System32")]
        )
        assert shutil.which("sh", path=path_without_sh) is None
        isolated_env = {
            **os.environ,
            "PATH": path_without_sh,
            "ProgramFiles": str(tmp_path / "no-program-files"),
            "ProgramFiles(x86)": str(tmp_path / "no-program-files-x86"),
            "LOCALAPPDATA": str(tmp_path / "no-local-app-data"),
        }
        where_sh = subprocess.run(
            ["where", "sh"],
            capture_output=True,
            text=True,
            env=isolated_env,
        )
        assert where_sh.returncode != 0, where_sh.stdout + where_sh.stderr
        via_override = subprocess.run(
            ["cmd", "/c", str(override_case / "forge.cmd"), "--help"],
            cwd=override_case,
            capture_output=True,
            text=True,
            env={
                **isolated_env,
                "CLAUDE_CODE_GIT_BASH_PATH": executable_shell,
            },
        )
        assert via_override.returncode == 0, via_override.stdout + via_override.stderr
        assert via_override.stdout.splitlines() == ["OVERRIDE"]
        override_exit = subprocess.run(
            ["cmd", "/c", str(override_case / "forge.cmd"), "status"],
            cwd=override_case,
            capture_output=True,
            text=True,
            env={
                **isolated_env,
                "CLAUDE_CODE_GIT_BASH_PATH": executable_shell,
            },
        )
        assert override_exit.returncode == 9, (
            override_exit.stdout + override_exit.stderr
        )

        fallback_case = tmp_path / "fallback"
        fallback_script = fallback_case / "factory" / "scripts" / "forge.py"
        fallback_script.parent.mkdir(parents=True)
        shutil.copy2(HARNESS / "forge.cmd", fallback_case / "forge.cmd")
        fallback_script.write_text("print('PYTHON')\n")

        shell_log = fallback_case / "git-bash.log"
        cmd_override = fallback_case / "git-bash.cmd"
        cmd_override.write_text(f'@echo called>>"{shell_log}"\n@exit /b 0\n')
        extensionless_override = fallback_case / "extensionless-sh"
        extensionless_batch = extensionless_override.with_suffix(".cmd")
        extensionless_batch.write_text(
            f'@echo called>>"{shell_log}"\n@exit /b 0\n'
        )
        for rejected_shell in (cmd_override, extensionless_override):
            rejected_override = subprocess.run(
                ["cmd", "/c", str(fallback_case / "forge.cmd"), "--help"],
                cwd=fallback_case,
                capture_output=True,
                text=True,
                env={
                    **isolated_env,
                    "CLAUDE_CODE_GIT_BASH_PATH": str(rejected_shell),
                },
            )
            assert rejected_override.returncode == 0, (
                rejected_override.stdout + rejected_override.stderr
            )
            assert rejected_override.stdout.splitlines() == ["PYTHON"]
            assert not shell_log.exists()

        literal_case = tmp_path / "literal-percent"
        literal_case.mkdir()
        shutil.copy2(HARNESS / "forge.cmd", literal_case / "forge.cmd")
        (literal_case / "forge").write_bytes(
            b'#!/bin/sh\n'
            b'if [ "$1" = "--help" ]; then exit 0; fi\n'
            b"printf 'ARG=%s\\n' \"$2\"\n"
        )
        runner = literal_case / "run-literal.cmd"
        runner.write_text(
            '@echo off\n'
            f'set "CLAUDE_CODE_GIT_BASH_PATH={executable_shell}"\n'
            f'"{literal_case / "forge.cmd"}" capture %FORGE_LITERAL%\n'
        )
        literal_percent = subprocess.run(
            ["cmd", "/c", str(runner)],
            cwd=literal_case,
            capture_output=True,
            text=True,
            env={
                **isolated_env,
                "FORGE_LITERAL": "%FORGE_LITERAL_PERCENT%",
                "FORGE_LITERAL_PERCENT": "expanded",
            },
        )
        assert literal_percent.returncode == 0, (
            literal_percent.stdout + literal_percent.stderr
        )
        assert literal_percent.stdout.splitlines() == ["ARG=%FORGE_LITERAL_PERCENT%"]

        result = subprocess.run(
            ["cmd", "/c", str(HARNESS / "forge.cmd"), "--help"],
            cwd=HARNESS,
            capture_output=True,
            text=True,
            env={
                **isolated_env,
                "CLAUDE_CODE_GIT_BASH_PATH": executable_shell,
            },
        )
        assert result.returncode == 0, result.stdout + result.stderr


def test_forge_cmd_probes_python3_as_final_fallback(tmp_path):
    shim = (HARNESS / "forge.cmd").read_text()

    assert shim.index(":python_fallback") < shim.index(":python3_fallback")
    assert shim.index(":python3_fallback") < shim.index(":bootstrap")
    assert (
        ':python3_fallback\n'
        'where python3 >nul 2>nul\n'
        'if errorlevel 1 goto bootstrap\n'
        'cmd /d /c python3 -c "import sys; raise SystemExit(0 if sys.version_info >= '
        '(3, 10) else 1)" >nul 2>nul\n'
        'if errorlevel 1 goto bootstrap\n'
        'set "FORGE_PYTHON=python3"\n'
        'goto discover_shell'
    ) in shim
    assert 'if defined FORGE_PYTHON_BOOTSTRAP_ATTEMPTED goto missing' in shim
    assert 'Python.Python.3.14 --exact --scope user --source winget' in shim
    assert "Start-Process" not in shim
    assert "RunAs" not in shim
    assert '"%~f0" %*' in shim
    assert (
        'cmd /d /c "set "FORGE_PYTHON_BOOTSTRAP_ATTEMPTED=1" & "%~f0" %*"\n'
        'exit /b %errorlevel%'
    ) in shim
    assert "https://www.python.org/downloads/windows/" in shim

    if os.name == "nt":
        executable_shell = shutil.which("sh")
        assert executable_shell and Path(executable_shell).suffix.lower() == ".exe"
        bootstrap_case = tmp_path / "bootstrap-before-shell"
        bootstrap_case.mkdir()
        shutil.copy2(HARNESS / "forge.cmd", bootstrap_case / "forge.cmd")
        (bootstrap_case / "forge").write_bytes(
            b"#!/bin/sh\nprintf 'EARLY_SHELL\\n'\nexit 0\n"
        )
        for command in ("py", "python", "python3"):
            (bootstrap_case / f"{command}.cmd").write_text("@exit /b 1\n")

        result = subprocess.run(
            ["cmd", "/d", "/c", str(bootstrap_case / "forge.cmd"), "status"],
            cwd=bootstrap_case,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": os.pathsep.join(
                    [
                        str(bootstrap_case),
                        str(Path(os.environ["SystemRoot"]) / "System32"),
                    ]
                ),
                "CLAUDE_CODE_GIT_BASH_PATH": executable_shell,
                "FORGE_PYTHON_BOOTSTRAP_ATTEMPTED": "1",
            },
        )
        assert result.returncode == 2, result.stdout + result.stderr
        assert "EARLY_SHELL" not in result.stdout
        assert "https://www.python.org/downloads/windows/" in result.stderr


def test_forge_cmd_bootstrap_runs_once_and_persists_path():
    shim = (HARNESS / "forge.cmd").read_text()
    refreshed_path = (
        'set "PATH=%FORGE_LOCAL_APP_DATA%\\Programs\\Python\\Python314;'
        '%FORGE_LOCAL_APP_DATA%\\Programs\\Python\\Launcher;'
        '%FORGE_LOCAL_APP_DATA%\\Microsoft\\WindowsApps;%PATH%"'
    )
    restart = (
        'cmd /d /c "set "FORGE_PYTHON_BOOTSTRAP_ATTEMPTED=1" & "%~f0" %*"'
    )

    assert shim.count('set "FORGE_PYTHON_BOOTSTRAP_ATTEMPTED=1"') == 1
    assert "endlocal & set" not in shim
    assert refreshed_path in shim
    assert restart in shim
    assert shim.index(refreshed_path) < shim.index(restart)
    assert shim.index(restart) < shim.index("exit /b %errorlevel%", shim.index(restart))


def test_forge_cmd_bootstrap_refuses_winget_when_elevated(tmp_path):
    shim = (HARNESS / "forge.cmd").read_text()
    whoami_probe = (
        '"%SystemRoot%\\System32\\whoami.exe" /groups >nul 2>&1'
    )
    medium_integrity_probe = (
        '"%SystemRoot%\\System32\\whoami.exe" /groups | '
        '"%SystemRoot%\\System32\\findstr.exe" /c:"S-1-16-8192" >nul 2>&1'
    )
    bootstrap_index = shim.index(":bootstrap")
    whoami_index = shim.index(whoami_probe, bootstrap_index)
    medium_integrity_index = shim.index(medium_integrity_probe, whoami_index)
    local_app_data_index = shim.index(
        'set "FORGE_LOCAL_APP_DATA="', medium_integrity_index,
    )
    winget_index = shim.index('"%FORGE_WINGET%" install', local_app_data_index)

    whoami_guard_index = shim.index("if errorlevel 1 goto missing", whoami_index)
    integrity_guard_index = shim.index(
        "if errorlevel 1 goto missing", medium_integrity_index,
    )
    assert (
        whoami_index < whoami_guard_index < medium_integrity_index
        < integrity_guard_index < local_app_data_index < winget_index
    )
    assert "normal (unelevated) prompt" in shim

    if os.name == "nt":
        bootstrap_case = tmp_path / "elevated-bootstrap"
        initial_bin = bootstrap_case / "initial-bin"
        local_app_data = bootstrap_case / "LocalAppData"
        windows_apps = local_app_data / "Microsoft" / "WindowsApps"
        initial_bin.mkdir(parents=True)
        windows_apps.mkdir(parents=True)
        (windows_apps / "winget.exe").touch()
        for command in ("py", "python", "python3"):
            (initial_bin / f"{command}.cmd").write_text("@exit /b 1\n")

        sentinel = bootstrap_case / "winget-ran"
        known_folder_probe = re.compile(
            r'set "FORGE_LOCAL_APP_DATA="\nfor /f .*?\n'
            r'if not defined FORGE_LOCAL_APP_DATA goto missing'
        )
        test_shim, replacements = known_folder_probe.subn(
            lambda _match: (
                f'set "FORGE_LOCAL_APP_DATA={local_app_data}"\n'
                'if not defined FORGE_LOCAL_APP_DATA goto missing'
            ),
            shim,
            count=1,
        )
        assert replacements == 1
        test_shim = test_shim.replace(
            '"%FORGE_WINGET%" install --id Python.Python.3.14 --exact '
            '--scope user --source winget --silent --accept-package-agreements '
            '--accept-source-agreements',
            f'echo WINGET_RAN>"{sentinel}"',
            1,
        )
        system_root = Path(os.environ["SystemRoot"])
        test_env = {
            **os.environ,
            "PATH": os.pathsep.join([str(initial_bin), str(system_root / "System32")]),
            "LOCALAPPDATA": str(local_app_data),
        }

        for case_name, probe, replacement in (
            ("elevated", medium_integrity_probe, "cmd /d /c exit /b 1"),
            ("whoami-failure", whoami_probe, "cmd /d /c exit /b 1"),
            ("findstr-failure", medium_integrity_probe, "cmd /d /c exit /b 1"),
        ):
            launcher = bootstrap_case / f"forge-{case_name}.cmd"
            launcher.write_text(test_shim.replace(probe, replacement, 1))
            result = subprocess.run(
                ["cmd", "/d", "/c", str(launcher), "status"],
                cwd=bootstrap_case,
                capture_output=True,
                text=True,
                env=test_env,
            )

            assert result.returncode == 2, result.stdout + result.stderr
            assert "normal (unelevated) prompt" in result.stderr
            assert not sentinel.exists()


def test_forge_cmd_bootstrap_converges_on_already_installed(tmp_path):
    shim = (HARNESS / "forge.cmd").read_text()
    winget_install = (
        '"%FORGE_WINGET%" install --id Python.Python.3.14 --exact --scope user'
    )
    refreshed_path = 'set "PATH=%FORGE_LOCAL_APP_DATA%\\Programs\\Python\\Python314;'
    restart = 'cmd /d /c "set "FORGE_PYTHON_BOOTSTRAP_ATTEMPTED=1"'
    install_index = shim.index(winget_install)
    refresh_index = shim.index(refreshed_path, install_index)
    restart_index = shim.index(restart, refresh_index)

    assert "if errorlevel 1 goto missing" not in shim[install_index:refresh_index]
    assert install_index < refresh_index < restart_index

    if os.name == "nt":
        bootstrap_case = tmp_path / "already-installed"
        local_app_data = bootstrap_case / "LocalAppData"
        initial_bin = bootstrap_case / "initial-bin"
        python_dir = local_app_data / "Programs" / "Python" / "Python314"
        windows_apps = local_app_data / "Microsoft" / "WindowsApps"
        initial_bin.mkdir(parents=True)
        python_dir.mkdir(parents=True)
        windows_apps.mkdir(parents=True)
        winget = windows_apps / "winget.exe"
        where_executable = shutil.which("where")
        assert where_executable
        shutil.copy2(where_executable, winget)
        for command in ("py", "python", "python3"):
            (initial_bin / f"{command}.cmd").write_text("@exit /b 1\n")
        (python_dir / "python.cmd").write_text(
            '@echo off\n'
            'if "%~1"=="-c" exit /b 0\n'
            'echo BOOTSTRAP_CONVERGED\n'
            'exit /b 0\n'
        )
        known_folder_probe = re.compile(
            r'set "FORGE_LOCAL_APP_DATA="\nfor /f .*?\n'
            r'if not defined FORGE_LOCAL_APP_DATA goto missing'
        )
        replacement = (
            f'set "FORGE_LOCAL_APP_DATA={local_app_data}"\n'
            'if not defined FORGE_LOCAL_APP_DATA goto missing'
        )
        test_shim, replacements = known_folder_probe.subn(
            lambda _match: replacement,
            shim,
            count=1,
        )
        assert replacements == 1
        elevation_guard = re.compile(
            r'if not exist "%SystemRoot%\\System32\\whoami\.exe" goto missing\n'
            r'if not exist "%SystemRoot%\\System32\\findstr\.exe" goto missing\n'
            r'"%SystemRoot%\\System32\\whoami\.exe" /groups >nul 2>&1\n'
            r'if errorlevel 1 goto missing\n'
            r'"%SystemRoot%\\System32\\whoami\.exe" /groups \| '
            r'"%SystemRoot%\\System32\\findstr\.exe" /c:"S-1-16-8192" '
            r'>nul 2>&1\n'
            r'if errorlevel 1 goto missing'
        )
        test_shim, replacements = elevation_guard.subn(
            "rem Test shim isolates bootstrap convergence from elevation policy",
            test_shim,
            count=1,
        )
        assert replacements == 1
        (bootstrap_case / "forge.cmd").write_text(test_shim)

        system_root = Path(os.environ["SystemRoot"])
        initial_path = os.pathsep.join([str(initial_bin), str(system_root / "System32")])
        winget_result = subprocess.run(
            [str(winget), "install", "--id", "Python.Python.3.14"],
            capture_output=True,
            text=True,
            env={**os.environ, "PATH": initial_path},
        )
        assert winget_result.returncode != 0
        result = subprocess.run(
            ["cmd", "/d", "/c", str(bootstrap_case / "forge.cmd"), "status"],
            cwd=bootstrap_case,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": initial_path,
                "LOCALAPPDATA": str(local_app_data),
                "ProgramFiles": str(bootstrap_case / "ProgramFiles"),
                "ProgramFiles(x86)": str(bootstrap_case / "ProgramFiles-x86"),
                "CLAUDE_CODE_GIT_BASH_PATH": str(bootstrap_case / "missing.exe"),
            },
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert "BOOTSTRAP_CONVERGED" in result.stdout


def test_init_and_upgrade_invoke_windows_remediation_when_hooks_red(
    tmp_path, monkeypatch, capsys,
):
    from forge_cli import doctor, scaffold

    statuses = iter(((False, "sh is not on PATH"), (False, "sh is not on PATH")))
    remediations = []
    monkeypatch.setattr(doctor, "_platform_name", lambda: "windows")
    monkeypatch.setattr(doctor, "fast_hook_status", lambda _target: next(statuses))
    monkeypatch.setattr(doctor, "_existing_hook_shell", lambda _env: None)
    monkeypatch.setattr(doctor, "_python_status", lambda: (False, "missing"))
    monkeypatch.setattr(
        doctor,
        "_remediate_windows_prerequisites",
        lambda **kwargs: remediations.append(kwargs),
    )

    scaffold.remediate_windows_hook_entry(tmp_path)

    assert remediations == [{"install_git": True, "install_python": True}]
    output = capsys.readouterr().out
    assert "[RED] Windows hook check" in output
    assert doctor.HOOK_SHELL_FIX in output

    monkeypatch.setattr(doctor, "_platform_name", lambda: "linux")
    monkeypatch.setattr(
        doctor,
        "fast_hook_status",
        lambda _target: (_ for _ in ()).throw(
            AssertionError("POSIX flow must not run the Windows hook check")
        ),
    )
    scaffold.remediate_windows_hook_entry(tmp_path)
    assert capsys.readouterr().out == ""

    for relative in (
        "factory/scripts/forge_cli/scaffold.py",
        "factory/scripts/forge_cli/adopt.py",
        "factory/scripts/forge_cli/upgrade.py",
    ):
        source = (HARNESS / relative).read_text()
        assert "remediate_windows_hook_entry(target)" in source

    upgrade_source = (HARNESS / "factory/scripts/forge_cli/upgrade.py").read_text()
    assert upgrade_source.rindex("remediate_windows_hook_entry(target)") \
        > upgrade_source.rindex("write_manifest(target, commit)")


def test_windows_autocrlf_checkout_preserves_forge_launcher(tmp_path):
    from forge_cli.doctor import _runnable_hook_shell

    checkout = tmp_path / "autocrlf"
    checkout.mkdir()
    (checkout / ".gitattributes").write_bytes((HARNESS / ".gitattributes").read_bytes())
    (checkout / "forge").write_bytes((HARNESS / "forge").read_bytes())
    git(checkout, "init", "-q")
    git(checkout, "config", "core.autocrlf", "true")
    git(checkout, "add", ".gitattributes", "forge")
    (checkout / "forge").unlink()
    git(checkout, "checkout-index", "--force", "forge")

    launcher = (checkout / "forge").read_bytes()
    assert b"\r\n" not in launcher
    shell = _runnable_hook_shell(dict(os.environ), HARNESS)
    assert shell, "test requires Git Bash or another POSIX shell"
    result = subprocess.run([shell, "-n", str(checkout / "forge")], capture_output=True)
    assert result.returncode == 0, result.stderr.decode(errors="replace")


def test_portable_fast_hook_status_is_subprocess_free(monkeypatch):
    from forge_cli import doctor

    def subprocess_forbidden(*args, **kwargs):
        raise AssertionError("fast hook status must not spawn a subprocess")

    monkeypatch.setattr(doctor.subprocess, "run", subprocess_forbidden)
    ok, detail = doctor.fast_hook_status()

    assert ok
    assert shutil.which("sh") in detail
    assert any(
        interpreter and interpreter in detail
        for interpreter in (shutil.which("py"), shutil.which("python3"), shutil.which("python"))
    )


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX fixture emulates Git Bash outside PATH with an executable wrapper",
)
def test_doctor_discovers_and_probes_git_bash_outside_path(tmp_path):
    from forge_cli import doctor

    program_files = tmp_path / "Program Files"
    shell = program_files / "Git" / "usr" / "bin" / "sh.exe"
    shell.parent.mkdir(parents=True)
    shell.write_text(f"#!{shutil.which('sh')}\nexec {shutil.which('sh')} \"$@\"\n")
    shell.chmod(0o755)
    env = {
        "PATH": str(tmp_path / "Git" / "cmd"),
        "ProgramFiles": str(program_files),
    }

    assert shutil.which("sh", path=env["PATH"]) is None
    assert doctor._runnable_hook_shell(env) == str(shell)


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX fixture emulates a healthy Git-for-Windows install outside PATH",
)
def test_doctor_hook_health_uses_git_bash_outside_path(repo, tmp_path):
    from forge_cli.doctor import hook_health_checks

    _route_fixture_hooks_through_forge(repo)
    program_files = tmp_path / "Program Files"
    git_root = program_files / "Git"
    shell = git_root / "usr" / "bin" / "sh.exe"
    shell.parent.mkdir(parents=True)
    shell.write_text(f"#!{shutil.which('sh')}\nexec {shutil.which('sh')} \"$@\"\n")
    shell.chmod(0o755)
    (shell.parent / "sh").symlink_to(shell)
    git_cmd = git_root / "cmd"
    git_cmd.mkdir()
    (git_cmd / "git").symlink_to(shutil.which("git"))
    (git_cmd / "python3").symlink_to(sys.executable)

    checks = hook_health_checks(repo, env={
        "PATH": str(git_cmd),
        "ProgramFiles": str(program_files),
    })

    assert len(checks) == 9
    assert all(check["ok"] for check in checks), checks


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX fixture emulates the Claude Code Git Bash override",
)
def test_doctor_falls_through_an_unrunnable_configured_shell(tmp_path):
    from forge_cli import doctor

    broken = tmp_path / "broken-sh"
    broken.write_text("#!/bin/sh\nexit 9\n")
    broken.chmod(0o755)
    healthy = tmp_path / "healthy-sh"
    healthy.write_text(f"#!{shutil.which('sh')}\nexec {shutil.which('sh')} \"$@\"\n")
    healthy.chmod(0o755)
    env = {
        "PATH": str(tmp_path),
        "CLAUDE_CODE_GIT_BASH_PATH": str(broken),
    }
    path_sh = tmp_path / "sh"
    path_sh.symlink_to(healthy)

    assert doctor._runnable_hook_shell(env) == str(path_sh)


def test_doctor_fix_windows_batches_all_elevation_into_single_confirm(tmp_path, monkeypatch):
    from forge_cli import doctor

    invocations = []
    run_kwargs = []
    refreshes = []
    reprobes = []
    local_app_data = tmp_path / "CanonicalLocalAppData"
    windows_apps = local_app_data / "Microsoft" / "WindowsApps"
    windows_apps.mkdir(parents=True)
    winget_path = windows_apps / "winget.exe"
    winget_path.write_text("trusted alias")
    user_winget = str(winget_path)

    def fake_run(argv, **kwargs):
        invocations.append(argv)
        run_kwargs.append(kwargs)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "PoisonedLocalAppData"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "PoisonedProgramFiles"))
    monkeypatch.setenv("PATH", str(tmp_path / "PoisonedPath"))
    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: local_app_data if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(doctor.subprocess, "run", fake_run)
    monkeypatch.setattr(doctor, "_refresh_windows_path", lambda: refreshes.append(True))
    monkeypatch.setattr(
        doctor.shutil, "which",
        lambda name: reprobes.append(name) or f"/tools/{name}",
    )
    monkeypatch.setattr(
        doctor, "_python_check",
        lambda: reprobes.append("python >= 3.10") or {"ok": True},
    )

    assert doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    ) == []

    assert len(invocations) == 2
    assert all(kwargs["timeout"] == doctor.WINDOWS_INSTALL_TIMEOUT for kwargs in run_kwargs)
    assert [argv[argv.index("--id") + 1] for argv in invocations] == [
        doctor.WINDOWS_GIT_PACKAGE, doctor.WINDOWS_PYTHON_PACKAGE,
    ]
    for argv in invocations:
        assert argv[0] == user_winget
        assert argv[argv.index("--scope") + 1] == "user"
        assert argv[argv.index("--source") + 1] == "winget"
        assert "--silent" in argv
        assert "--accept-package-agreements" in argv
        assert "--accept-source-agreements" in argv
        assert "Poisoned" not in " ".join(argv)
        assert all("Start-Process" not in arg and "RunAs" not in arg for arg in argv)
    assert refreshes == [True]
    assert reprobes == ["git", "python >= 3.10"]


def test_doctor_fix_refuses_user_alias_when_elevated(monkeypatch):
    from forge_cli import doctor

    invocations = []
    refreshes = []
    reprobes = []

    monkeypatch.setattr(
        doctor, "_trusted_user_winget_path",
        lambda: (_ for _ in ()).throw(
            AssertionError("elevated remediation must stop before resolving winget")
        ),
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: True)
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **_kwargs: invocations.append(argv),
    )
    monkeypatch.setattr(
        doctor, "_refresh_windows_path", lambda: refreshes.append(True),
    )
    monkeypatch.setattr(
        doctor.shutil, "which", lambda name: reprobes.append(name),
    )
    monkeypatch.setattr(
        doctor, "_python_check",
        lambda: reprobes.append("python >= 3.10") or {"ok": True},
    )

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert invocations == []
    assert refreshes == []
    assert reprobes == []
    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "elevated Windows prerequisite remediation"
    assert row["required"] and not row["ok"]
    assert "per-user install paths are user-writable" in row["detail"]
    assert "normal (unelevated) prompt" in row["fix"]
    assert doctor.WINDOWS_GIT_INSTALLER_URL in row["fix"]
    assert doctor.WINDOWS_PYTHON_INSTALLER_URL in row["fix"]


def test_fast_status_python_requires_path_resolvable_interpreter(
    tmp_path, monkeypatch, capsys,
):
    from forge_cli import doctor

    subprocess_run = doctor.subprocess.run
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fast_status must not spawn a subprocess")
        ),
    )
    monkeypatch.setattr(doctor.shutil, "which", lambda _name: None)
    monkeypatch.setattr(doctor.sys, "version_info", (3, 9, 18))
    required_missing, _ = doctor.fast_status(tmp_path)

    assert "python >= 3.10" in required_missing

    monkeypatch.setattr(doctor.sys, "version_info", (3, 10, 0))
    assert "python >= 3.10" not in doctor.fast_status(tmp_path)[0]

    monkeypatch.setattr(doctor.sys, "version_info", (3, 9, 18))
    for candidate in ("py", "python3", "python"):
        monkeypatch.setattr(
            doctor.shutil, "which",
            lambda name, candidate=candidate: (
                f"/tools/{candidate}" if name == candidate else None
            ),
        )
        assert "python >= 3.10" not in doctor.fast_status(tmp_path)[0]

    monkeypatch.setattr(doctor, "_python_status", lambda: (False, "Python 3.9.18"))
    row = doctor._python_check()
    assert row["name"] == "python >= 3.10"
    assert row["required"] and not row["ok"]

    for path in (
        doctor._codex_plugin_dir(tmp_path), doctor._gstack_dir(tmp_path),
        doctor._autoreview_dir(tmp_path),
    ):
        path.mkdir(parents=True)
    monkeypatch.setattr(doctor.subprocess, "run", subprocess_run)
    monkeypatch.setattr(doctor.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(doctor, "repo_root", lambda: (_ for _ in ()).throw(FileNotFoundError()))
    monkeypatch.setattr(doctor.shutil, "which", lambda name: f"/tools/{name}")
    monkeypatch.setattr(doctor, "_has_direnv_hook", lambda _home: True)
    monkeypatch.setattr(doctor, "_merge_check_status", lambda **_kwargs: None)
    monkeypatch.setattr(
        doctor, "run_quiet",
        lambda argv, **_kwargs: (
            (0, "v20.0.0") if argv[-1] == "--version" and "node" in argv[0]
            else (0, "codex-cli 0.144.0") if argv[-1] == "--version"
            else (0, "logged in")
        ),
    )

    with pytest.raises(SystemExit):
        doctor.cmd_doctor(argparse.Namespace(fast=False, fix=False, repo=None))
    output = capsys.readouterr().out
    assert "[MISS] python >= 3.10" in output
    assert "python >= 3.10" in required_missing


def test_doctor_psutil_row_required_and_fix_installs(tmp_path, monkeypatch):
    from forge_cli import doctor

    with monkeypatch.context() as broken:
        broken.setattr(
            doctor.subprocess, "run",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("fast_status must not spawn a subprocess")
            ),
        )
        broken.setattr(
            doctor.importlib.util, "find_spec",
            lambda name: object() if name == "psutil" else None,
        )
        broken.setattr(
            doctor.importlib, "import_module",
            lambda _name: (_ for _ in ()).throw(OSError("broken psutil ABI")),
        )
        assert "psutil" not in doctor.fast_status(tmp_path)[0]
        broken_row = doctor._psutil_check()
        assert broken_row["required"] and not broken_row["ok"]
        assert "broken psutil ABI" in broken_row["detail"]

    installed = {"psutil": False}
    commands = []
    refreshed_sites = []
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fast_status must not spawn a subprocess")
        ),
    )
    monkeypatch.setattr(
        doctor.importlib.util, "find_spec",
        lambda name: object() if name == "psutil" and installed["psutil"] else None,
    )
    monkeypatch.setattr(
        doctor, "_psutil_import_status",
        lambda: (
            (True, f"importable by {sys.executable}")
            if installed["psutil"] else (False, "import failed: ModuleNotFoundError")
        ),
    )
    monkeypatch.setattr(doctor.sys, "prefix", "/system-python")
    monkeypatch.setattr(doctor.sys, "base_prefix", "/system-python")
    monkeypatch.setattr(
        doctor.site, "getusersitepackages", lambda: "/user/site-packages",
    )
    monkeypatch.setattr(doctor.site, "addsitedir", refreshed_sites.append)
    monkeypatch.setattr(
        doctor.importlib, "invalidate_caches",
        lambda: refreshed_sites.append("caches-invalidated"),
    )

    required_missing, _ = doctor.fast_status(tmp_path)
    assert "psutil" in required_missing
    missing_row = doctor._psutil_check()
    assert missing_row["required"] and not missing_row["ok"]
    assert "pip install psutil" in missing_row["fix"]

    def install(argv, **_kwargs):
        commands.append(argv)
        installed["psutil"] = True
        return 0, "installed"

    monkeypatch.setattr(doctor, "run_quiet", install)
    row = doctor._psutil_check(fix=True)

    assert row["ok"] and row["detail"] == f"importable by {sys.executable}"
    assert commands == [[
        sys.executable, "-m", "pip", "install", "--user", "psutil",
    ]]
    assert refreshed_sites == ["/user/site-packages", "caches-invalidated"]
    assert "psutil" not in doctor.fast_status(tmp_path)[0]
    assert row["required"] and row["ok"]

    commands.clear()
    installed["psutil"] = False
    monkeypatch.setattr(doctor.sys, "prefix", "/project/.venv")
    monkeypatch.setattr(doctor.sys, "base_prefix", "/system-python")
    row = doctor._psutil_check(fix=True)
    assert row["ok"]
    assert commands == [[sys.executable, "-m", "pip", "install", "psutil"]]
    assert refreshed_sites == ["/user/site-packages", "caches-invalidated"]

    commands.clear()
    installed["psutil"] = False
    monkeypatch.setattr(doctor.sys, "prefix", "/system-python")
    monkeypatch.setattr(doctor.sys, "base_prefix", "/system-python")

    def externally_managed(argv, **_kwargs):
        commands.append(argv)
        return 1, "error: externally-managed-environment"

    monkeypatch.setattr(
        doctor, "run_quiet", externally_managed,
    )
    row = doctor._psutil_check(fix=True)
    assert not row["ok"] and "externally managed" in row["detail"]
    assert "pip install psutil" in row["fix"]
    assert commands == [[
        sys.executable, "-m", "pip", "install", "--user", "psutil",
    ]]
    assert "--break-system-packages" not in commands[0]


def test_doctor_python_row_probes_working_windows_store_alias(tmp_path, monkeypatch):
    from forge_cli import doctor

    windows_apps = tmp_path / "WindowsApps"
    windows_apps.mkdir()
    alias = windows_apps / "python.exe"
    alias.touch()
    monkeypatch.setattr(doctor, "_platform_name", lambda: "windows")
    monkeypatch.setattr(
        doctor.shutil, "which",
        lambda name: str(alias) if name == "python" else None,
    )
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(
            argv, 0, "Python 3.14.7\n", "",
        ),
    )

    assert doctor._python_candidates() == [(str(alias), ())]
    assert doctor._python_status() == (True, f"{alias}: Python 3.14.7")

    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(
            argv, 1, "", "Python was not found",
        ),
    )
    ok, detail = doctor._python_status()
    assert not ok
    assert "Python was not found" in detail


def test_doctor_fix_reports_winget_absent_as_named_red_row(monkeypatch):
    from forge_cli import doctor

    refreshes = []
    reprobes = []
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(doctor, "_windows_known_folder", lambda _folder_id: None)
    monkeypatch.setattr(doctor, "_refresh_windows_path", lambda: refreshes.append(True))
    monkeypatch.setattr(
        doctor.shutil, "which", lambda name: reprobes.append(name),
    )
    monkeypatch.setattr(
        doctor, "_python_check",
        lambda: reprobes.append("python >= 3.10") or {"ok": False},
    )
    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "winget for Windows prerequisites"
    assert row["required"] and not row["ok"]
    assert "https://git-scm.com/download/win" in row["detail"]
    assert "https://www.python.org/downloads/windows/" in row["detail"]
    assert refreshes == [True]
    assert reprobes == ["git", "python >= 3.10"]


def test_doctor_fix_winget_absent_converges_green_when_tools_present(
    monkeypatch,
):
    from forge_cli import doctor

    refreshes = []
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(doctor, "_trusted_user_winget_path", lambda: None)
    monkeypatch.setattr(doctor, "_refresh_windows_path", lambda: refreshes.append(True))
    monkeypatch.setattr(
        doctor.shutil, "which", lambda name: "/tools/git" if name == "git" else None,
    )
    monkeypatch.setattr(doctor, "_python_check", lambda: {"ok": True})

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert rows == []
    assert refreshes == [True]


def test_doctor_fix_windows_partial_install_refreshes_and_reprobes(tmp_path, monkeypatch):
    from forge_cli import doctor

    invocations = []
    refreshes = []
    reprobes = []
    local_app_data = tmp_path / "LocalAppData"
    windows_apps = local_app_data / "Microsoft" / "WindowsApps"
    windows_apps.mkdir(parents=True)
    winget = windows_apps / "winget.exe"
    winget.write_text("trusted alias")

    def fake_run(argv, **kwargs):
        invocations.append(argv)
        return subprocess.CompletedProcess(
            argv, 1 if doctor.WINDOWS_GIT_PACKAGE in argv else 0,
            "", "installer elevation declined" if doctor.WINDOWS_GIT_PACKAGE in argv else "",
        )

    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: local_app_data if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(doctor.subprocess, "run", fake_run)
    monkeypatch.setattr(doctor, "_refresh_windows_path", lambda: refreshes.append(True))
    monkeypatch.setattr(
        doctor.shutil, "which", lambda name: reprobes.append(name),
    )
    monkeypatch.setattr(
        doctor, "_python_check",
        lambda: reprobes.append("python >= 3.10") or {"ok": True},
    )

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert [argv[argv.index("--id") + 1] for argv in invocations] == [
        doctor.WINDOWS_GIT_PACKAGE, doctor.WINDOWS_PYTHON_PACKAGE,
    ]
    assert len(rows) == 1
    assert rows[0]["name"] == "Git for Windows user-scope install"
    assert rows[0]["required"] and not rows[0]["ok"]
    assert "installer elevation declined" in rows[0]["detail"]
    assert doctor.WINDOWS_GIT_INSTALLER_URL in rows[0]["detail"]
    assert refreshes == [True]
    assert reprobes == ["git", "python >= 3.10"]


def test_doctor_fix_reports_installed_but_not_found(tmp_path, monkeypatch):
    from forge_cli import doctor

    local_app_data = tmp_path / "CanonicalLocalAppData"
    alias = local_app_data / "Microsoft" / "WindowsApps" / "winget.exe"
    alias.parent.mkdir(parents=True)
    alias.write_text("trusted alias")
    refreshes = []

    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: (
            local_app_data if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None
        ),
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(argv, 0, "", ""),
    )
    monkeypatch.setattr(
        doctor, "_refresh_windows_path", lambda: refreshes.append(True),
    )
    monkeypatch.setattr(doctor.shutil, "which", lambda _name: None)
    monkeypatch.setattr(doctor, "_python_check", lambda: {"ok": False})

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert [row["name"] for row in rows] == [
        "Git for Windows installed but not found",
        "Python 3.14 installed but not found",
    ]
    assert all(row["required"] and not row["ok"] for row in rows)
    assert all("winget exited successfully" in row["detail"] for row in rows)
    assert all("after refreshing PATH" in row["detail"] for row in rows)
    assert doctor.WINDOWS_GIT_INSTALLER_URL in rows[0]["fix"]
    assert doctor.WINDOWS_PYTHON_INSTALLER_URL in rows[1]["fix"]
    assert refreshes == [True]


def test_doctor_fix_rejects_untrusted_winget_path(tmp_path, monkeypatch):
    from forge_cli import doctor

    untrusted = tmp_path / "winget.exe"
    untrusted.write_text("PATH hijack")
    canonical_local = tmp_path / "CanonicalLocalAppData"
    windows_apps = canonical_local / "Microsoft" / "WindowsApps"
    windows_apps.mkdir(parents=True)
    (windows_apps / "winget.exe").symlink_to(untrusted)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "ProgramFiles"))
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(doctor.shutil, "which", lambda name: str(untrusted) if name == "winget" else None)
    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: canonical_local if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert len(rows) == 1
    assert not rows[0]["ok"]
    assert "outside its trusted" in rows[0]["detail"]


def test_doctor_fix_nonzero_already_installed_converges_after_refresh(tmp_path, monkeypatch):
    from forge_cli import doctor

    local_app_data = tmp_path / "CanonicalLocalAppData"
    alias = local_app_data / "Microsoft" / "WindowsApps" / "winget.exe"
    alias.parent.mkdir(parents=True)
    alias.write_text("trusted alias")
    refreshed = []

    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: local_app_data if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(
            argv, 1, "No applicable upgrade found", "",
        ),
    )
    monkeypatch.setattr(
        doctor, "_refresh_windows_path", lambda: refreshed.append(True),
    )
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/tools/git")
    monkeypatch.setattr(doctor, "_python_check", lambda: {"ok": True})

    rows = doctor._remediate_windows_prerequisites(
        install_git=True, install_python=True,
    )

    assert rows == []
    assert refreshed == [True]


def test_doctor_fix_trusts_appexeclink_without_resolving(tmp_path, monkeypatch):
    from forge_cli import doctor

    local_app_data = tmp_path / "CanonicalLocalAppData"
    alias = local_app_data / "Microsoft" / "WindowsApps" / "winget.exe"
    alias.parent.mkdir(parents=True)
    alias.write_text("app execution alias")
    original_resolve = doctor.Path.resolve

    def fake_resolve(path, *args, **kwargs):
        if path == alias:
            raise OSError("[WinError 1920] The file cannot be accessed by the system")
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: local_app_data if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )
    monkeypatch.setattr(doctor.Path, "resolve", fake_resolve)
    monkeypatch.setattr(
        doctor.Path, "exists",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("winget identity check must not follow the App Execution Alias")
        ),
    )
    monkeypatch.setattr(
        doctor.Path, "glob",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unelevated parent must not enumerate WindowsApps")
        ),
    )

    assert doctor._trusted_user_winget_path() == str(alias)


@pytest.mark.skipif(os.name == "nt", reason="POSIX stub executables model refreshed PATH")
def test_doctor_fix_windows_refreshes_path_and_converges(tmp_path, monkeypatch):
    from forge_cli import doctor

    local = tmp_path / "LocalAppData"
    windows_apps = local / "Microsoft" / "WindowsApps"
    windows_apps.mkdir(parents=True)
    (windows_apps / "winget.exe").write_text("trusted alias")
    git_dir = local / "Programs" / "Git" / "cmd"
    python_dir = local / "Programs" / "Python" / "Python314"
    git_dir.mkdir(parents=True)
    python_dir.mkdir(parents=True)
    for path, output in ((git_dir / "git", "git version 2.50.0"),
                         (python_dir / "python", "Python 3.14.7")):
        path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{output}'\n")
        path.chmod(0o755)

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "PoisonedLocalAppData"))
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("ProgramW6432", raising=False)
    monkeypatch.delenv("ProgramFiles", raising=False)
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda folder_id: local if folder_id == doctor.WINDOWS_LOCAL_APP_DATA else None,
    )
    monkeypatch.setattr(doctor, "_windows_process_is_elevated", lambda: False)
    subprocess_run = doctor.subprocess.run
    monkeypatch.setattr(
        doctor.subprocess, "run",
        lambda argv, **kwargs: (
            subprocess.CompletedProcess(argv, 0, "", "")
            if argv[0].endswith("winget.exe") else subprocess_run(argv, **kwargs)
        ),
    )
    assert doctor._remediate_windows_prerequisites(
        install_git=False, install_python=True,
    ) == []

    assert shutil.which("git") == str(git_dir / "git")
    assert doctor._python_status()[0]


@pytest.mark.skipif(os.name == "nt", reason="POSIX fixture models WOW64 PATH refresh")
def test_doctor_fix_windows_refreshes_native_git_under_wow64(
    tmp_path, monkeypatch,
):
    from forge_cli import doctor

    program_files_x86 = tmp_path / "Program Files (x86)"
    program_files_x64 = tmp_path / "Program Files"
    git_dir = program_files_x64 / "Git" / "cmd"
    git_dir.mkdir(parents=True)
    git = git_dir / "git"
    git.write_text("#!/bin/sh\nexit 0\n")
    git.chmod(0o755)

    monkeypatch.setenv("PATH", "")
    monkeypatch.setenv("ProgramW6432", str(program_files_x64))
    monkeypatch.setenv("ProgramFiles", str(program_files_x86))
    monkeypatch.setenv("ProgramFiles(x86)", str(program_files_x86))
    monkeypatch.setattr(
        doctor, "_windows_known_folder",
        lambda _folder_id: None,
    )

    doctor._refresh_windows_path()

    assert shutil.which("git") == str(git)
    assert not hasattr(doctor, "WINDOWS_PROGRAM_FILES_X64")


def test_phase_names_doctor_first_when_hook_launcher_is_broken(repo, capsys):
    from forge_cli import phase

    (repo / "forge").unlink()
    phase.cmd_next(argparse.Namespace(repo=str(repo)))
    output = capsys.readouterr().out
    first = output.split("NEXT:\n", 1)[1].splitlines()[0]

    assert "./forge doctor --fix" in first

    shutil.copy2(HARNESS / "forge", repo / "forge")
    (repo / "forge").chmod(0o644)
    phase.cmd_next(argparse.Namespace(repo=str(repo)))
    output = capsys.readouterr().out
    first = output.split("NEXT:\n", 1)[1].splitlines()[0]

    assert "./forge doctor --fix" in first

    (repo / "forge").chmod(0o755)
    (repo / "factory" / "scripts" / "forge.py").unlink()
    phase.cmd_next(argparse.Namespace(repo=str(repo)))
    output = capsys.readouterr().out
    first = output.split("NEXT:\n", 1)[1].splitlines()[0]

    assert "./forge doctor --fix" in first


def test_precompact_hook_health_resolves_context_before_returning():
    source = (HARNESS / "factory" / "scripts" / "pre_compact.py").read_text()

    read_input = source.index("payload = read_hook_input()")
    resolve_repo = source.index("root = repo_root()", read_input)
    import_scratchpad = source.index(
        "from forge_cli.scratchpad import notes_section, scratchpad_path",
        resolve_repo,
    )
    health_return = source.index(
        'if os.environ.get("FACTORY_HOOK_HEALTH") == "1":', import_scratchpad,
    )
    first_write = min(
        source.index("path.parent.mkdir", health_return),
        source.index("path.write_text", health_return),
    )

    assert read_input < resolve_repo < import_scratchpad < health_return < first_write


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
    events = load_events(repo)
    filled = [event for event in events if event["event"] == "roadmap-filled"]
    assert len(filled) == 1 and filled[0]["story"] == "ENG-9"

    roadmap_before = path.read_bytes()
    events_before = load_events(repo)
    code, out = run(repo, "forge.py", *args)
    assert code == 0 and "already has the requested values" in out, out
    assert path.read_bytes() == roadmap_before
    assert load_events(repo) == events_before


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
    run(repo, "forge.py", "roadmap", "link-spec", "ENG-1",
        "--spec", "docs/specs/base.md")  # task-3 requirements round needs a confirmed spec
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    items = roadmap_items(repo)
    assert items["ENG-1"]["status"] == "done"
    assert items["ENG-1"]["history"] == ".factory/stories/ENG-1/"
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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
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
    mint_review_run(repo)
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({"generated_by": "autoreview", "score": 9,
                                      "summary": "ok", "blocking_findings": [],
                                      "skills_used": ["review-animations"]}))
    assert code == 0, out
    recorded = json.loads((
        repo / ".factory" / "stories" / "ENG-1" / "reviews" / "quality.json"
    ).read_text())
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
    f = story_state(repo)
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
    f = story_state(repo)
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
    assert (repo / "factory" / "scripts" / "check_encoding_hygiene.py").exists()
    assert (repo / "src" / "app.js").read_text() == "console.log('prototype')\n"
    # project README preserved, onboarding section appended (never rewritten)
    readme = (repo / "README.md").read_text()
    assert readme.startswith("# Legacy prototype\n")
    assert "Working in this repo — Symphony Forge" in readme
    assert (repo / ".github" / "workflows" / "their-ci.yml").exists()
    # harness factory workflow delivered alongside the preserved project one
    assert (repo / ".github" / "workflows" / "factory-scaffold.yml").exists()
    assert "--with psutil" in (repo / ".envrc").read_text()
    # old CLAUDE.md preserved for harvest; shim installed
    kept = repo / "docs" / "context" / "migrated-CLAUDE.md"
    assert kept.exists() and "tabs" in kept.read_text()
    assert "@AGENTS.md" in (repo / "CLAUDE.md").read_text()
    # sign-off gate armed, project-owned files created
    assert not signed_off(repo)  # an adopted repo inherits no sign-off
    assert (repo / "harness.yaml").exists()
    assert "./forge spec save + spec confirm" in out
    assert "./forge roadmap derive" in out
    assert "roadmap epic add + roadmap add" in out
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

@pytest.mark.skipif(
    not PR_LINK_WORKFLOW_FIXTURE.is_file(),
    reason="requires the pr-link workflow harness-source fixture",
)
def test_pr_link_commit_skips_ci():
    # D-0017: without [skip ci], the bot-attributed synchronize wave is held
    # action_required and strands the PR's checks behind a manual re-trigger.
    workflow = PR_LINK_WORKFLOW_FIXTURE.read_text()
    assert "workflow_run:\n    workflows: [factory-scaffold]\n    types: [completed]" in workflow
    assert "github.event.workflow_run.conclusion == 'success'" in workflow
    assert "statuses: write" in workflow
    commit_guard = "steps.link.outputs.story != '' && steps.link.outputs.already_linked != 'true'"
    commit_step, status_step = workflow.split("- name: Commit the durable link to the PR branch", 1)[1].split(
        "- name: Carry scaffold-check to the link commit", 1
    )
    assert f"if: {commit_guard}" in commit_step
    assert f"if: {commit_guard}" in status_step
    assert "statuses/$SHA" in status_step
    assert "context=scaffold-check" in status_step
    assert "[skip ci]" in workflow.split("git commit -m")[1].splitlines()[0]


def test_scaffold_delivers_factory_workflows(repo):
    # forge init vendors the harness factory workflows (by allowlist, not by
    # copying the whole .github tree).
    wf = repo / ".github" / "workflows"
    assert (wf / "factory-scaffold.yml").exists()
    assert (wf / "gardener.yml").exists()
    assert (wf / "harness-health.yml").exists()
    assert (wf / "roadmap-gate.yml").exists()
    assert (repo / "factory/scripts/check_encoding_hygiene.py").exists()


def test_scaffold_pins_gstack_into_the_repo(repo):
    envrc = repo / ".envrc"
    assert envrc.exists() and 'GSTACK_HOME="$PWD/.gstack"' in envrc.read_text()
    assert "--with psutil" in envrc.read_text()
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
    assert "--with psutil" in (repo / ".envrc").read_text()
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
    # Design-skill routing is PER TASK: the active/frontier task's OWN
    # user_facing flag decides, not the story's.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    ui_task = {**DECOMP["tasks"][0], "user_facing": True}
    record_skeleton_then_frontier(repo, [ui_task])
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "emil-design-eng" in out
    # a backend task in the same story: no design skills suggested
    decomp_path = story_state(repo) / "decomposition.json"
    data = json.loads(decomp_path.read_text())
    data["tasks"][0]["user_facing"] = False
    decomp_path.write_text(json.dumps(data))
    (delegation_ledger(repo).parent / "decomposition.json").write_text(json.dumps(data))
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

def _record_spec_rounds(repo: Path, rounds: list[dict]) -> tuple[int, str]:
    spec = repo / "docs" / "specs" / "base.md"
    spec.parent.mkdir(parents=True, exist_ok=True)
    spec.write_text("# Base spec\n")
    return run(
        repo, "record_grill_from_json.py", "--gate", "spec",
        "--input-digest", str(spec),
        stdin=json.dumps({
            "generated_by": "griller", "gate": "spec", "verdict": "pass",
            "gaps": [], "contradictions": [], "resolutions": [],
            "rounds": rounds,
        }),
    )


def test_grill_refuses_round_not_in_ledger(repo):
    rounds = grill_rounds("spec", 2)
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    rounds[0]["chosen"] = "Revise"
    code, out = _record_spec_rounds(repo, rounds)
    assert code != 0 and "does not match an AskUserQuestion ledger record" in out


def test_grill_refuses_below_gate_floor(repo):
    rounds = grill_rounds("spec", 1)
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    code, out = _record_spec_rounds(repo, rounds)
    assert code != 0 and "requires at least 2 logged round(s)" in out


def test_grill_refuses_missing_frontier_empty(repo):
    rounds = grill_rounds("spec", 2)
    rounds[-1].pop("frontier_empty")
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    code, out = _record_spec_rounds(repo, rounds)
    assert code != 0 and "final round requires frontier_empty true" in out


def test_grill_accepts_ledger_matched_rounds_happy_path(repo):
    rounds = grill_rounds("spec", 2)
    code, out = log_grill_rounds(repo, rounds)
    assert code == 0, out
    code, out = _record_spec_rounds(repo, rounds)
    assert code == 0, out
    code, out = _record_spec_rounds(repo, rounds)
    assert code == 0, out  # byte-identical re-record may reuse its own rounds


def test_task_grill_requires_saved_task_plan_with_tolerance(repo):
    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    plan = repo / ".factory" / "task-plans" / "T1.md"
    plan.unlink()
    payload = task_grill_payload(task)
    command = ("record_grill_from_json.py", "--gate", "task", "--task", "T1")
    code, out = run(repo, *command, stdin=json.dumps(payload))
    assert code != 0 and "requires a saved task plan first" in out

    source = repo / "plans" / "T1-draft.md"
    source.write_text("# T1 plan\n\n\n## Workflow\n\nRequest -> handler -> store.\n\n## Manual Verification\n\n1. Run it. 2. See the row.\n")
    code, out = post_hook(repo, plan_hook_payload(source))
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "task", "plan", "save", "T1", "--from", str(source),
    )
    assert code == 0, out
    code, out = run(repo, *command, stdin=json.dumps(payload))
    assert code == 0, out

    grill_path = repo / ".factory" / "grills" / "tasks" / "T1.json"
    legacy = json.loads(grill_path.read_text())
    legacy.pop("task_plan_sha256")
    legacy["recorded_at"] = "2000-01-01T00:00:00+00:00"
    grill_path.write_text(json.dumps(legacy))
    plan.unlink()
    code, out = run(
        repo, "forge.py", "task", "plan", "save", "T1", "--from", str(source),
    )
    assert code == 0, out
    migrated = json.loads(grill_path.read_text())
    assert migrated["task_plan_sha256"] == plan_digest_without_assumptions(plan)


def test_frontier_orders_task_plan_before_grill(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    assert task_frontier_state(repo)[0] == "author-task-plan"
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "do NOT present it in chat" in out \
        and "mode-agnostic" in out  # 0050

    source = tmp_path / "T1.md"
    source.write_text("# T1 plan\n\n\n## Workflow\n\nRequest -> handler -> store.\n\n## Manual Verification\n\n1. Run it. 2. See the row.\n")
    code, out = post_hook(repo, plan_hook_payload(source))
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "task", "plan", "save", "T1", "--from", str(source),
    )
    assert code == 0, out
    assert task_frontier_state(repo)[0] == "grill"
    code, out = run(repo, "forge.py", "next")
    assert code == 0 and "Grill the saved T1 plan" in out

    payload = task_grill_payload(STAGE_TASK)
    code, out = log_grill_rounds(repo, payload["rounds"])
    assert code == 0, out
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        stdin=json.dumps(payload),
    )
    assert code == 0, out
    assert task_frontier_state(repo)[0] == "await-approval"

def test_record_task_grill_writes_per_id_file(repo):
    task_id = "FORGE-BOARD-2.1"
    task = {**STAGE_TASK, "id": task_id}
    seed_task_grill_frontier(repo, task)
    payload = task_grill_payload(task, task_id=task_id)

    code, out = run(repo, "record_grill_from_json.py", "--gate", "task",
                    "--task", task_id,
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads(
        (repo / ".factory" / "grills" / "tasks" / f"{task_id}.json").read_text()
    )
    assert recorded["verdict"] == "pass"
    assert recorded["gate"] == "task"
    assert recorded["task_id"] == task_id
    assert not (repo / ".factory" / "grills" / "task.json").exists()


def test_record_task_grill_binds_derived_digest(repo):
    task_id = "FORGE-BOARD-2.1"
    task = {**STAGE_TASK, "id": task_id}
    seed_task_grill_frontier(repo, task)
    payload = task_grill_payload(task)

    code, out = run(repo, "record_grill_from_json.py", "--gate", "task",
                    "--task", task_id,
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads(
        (repo / ".factory" / "grills" / "tasks" / f"{task_id}.json").read_text()
    )
    assert recorded["input_sha256"] == grounding_digest(repo, task)


def test_board_survives_active_story_whose_approved_plan_is_gone(repo):
    # A shipped/archived story can remain the active run pointer while its
    # approved plan has moved out of plans/active/ (its task-plan + grill still
    # exist). grounding_digest then raises SystemExit; the read-only board's
    # task_rows/aggregate_state must degrade (grill = not-fresh), not crash the
    # /api/state response and strand the connection pill on "connecting".
    from factory_lib import task_rows
    from forge_cli.board import aggregate_state

    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    code, out = record_task_grill(repo, task)
    assert code == 0, out
    assert task_rows(repo)  # sanity: rows build while the plan is present

    (repo / "plans" / "active" / "TEST-1-test-plan.md").unlink()

    rows = task_rows(repo)  # must NOT raise SystemExit
    assert isinstance(rows, list)
    assert not any(row.get("fresh") for row in rows)
    assert isinstance(aggregate_state(repo), dict)  # /api/state stays 200


def test_grounding_digest_staleness_matrix(repo):
    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    plan = repo / "plans" / "active" / "TEST-1-test-plan.md"

    def record_current() -> None:
        code, out = record_task_grill(repo, task)
        assert code == 0, out

    def state() -> str:
        frontier = task_frontier_state(repo)
        assert frontier is not None
        return frontier[0]

    record_current()
    assert state() == "stage-start"

    changed_contract = {**task, "reviewer_focus": "changed full-contract field"}
    seed_task_grill_frontier(repo, changed_contract)
    assert state() == "grill"
    seed_task_grill_frontier(repo, task)
    record_current()

    original_plan = plan.read_text()
    plan.write_text(original_plan.replace(
        "Test content for Risks.", "Changed approved risk analysis."
    ))
    assert state() == "grill"
    plan.write_text(original_plan)
    record_current()

    code, out = run(repo, "forge.py", "plan", "assume", "The adapter stays internal.")
    assert code == 0, out
    assert state() == "stage-start"

    product = repo / "src" / "grounding.py"
    product.parent.mkdir(exist_ok=True)
    product.write_text("BOUND = True\n")
    git(repo, "add", product.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "product change")
    assert state() == "grill"
    record_current()

    evidence = repo / ".factory" / "grounding-note.json"
    evidence.write_text("{}\n")
    git(repo, "add", "-f", evidence.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "factory-only change")
    assert state() == "stage-start"

    plan_note = repo / "plans" / "grounding-note.md"
    plan_note.write_text("planning note\n")
    git(repo, "add", plan_note.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "plans-only change")
    assert state() == "stage-start"

    write_stages(repo, {
        "issue": "TEST-1",
        "stages": [{"id": "T1", "title": "grounding", "status": "pending"}],
    })
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out


def test_task_digest_arg_is_removed_and_gates_rederive(repo):
    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    payload = task_grill_payload(task)

    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        "--task-digest", "0" * 64, stdin=json.dumps(payload),
    )
    assert code != 0 and "--task-digest is no longer accepted" in out
    assert "digest is derived" in out

    code, out = record_task_grill(repo, task)
    assert code == 0, out
    grill = repo / ".factory" / "grills" / "tasks" / "T1.json"
    recorded = json.loads(grill.read_text())
    assert recorded["input_sha256"] == grounding_digest(repo, task)

    recorded["input_sha256"] = task_digest(task)
    grill.write_text(json.dumps(recorded))
    with pytest.raises(SystemExit) as exc:
        require_task_grill(repo, "T1", task)
    out = str(exc.value)
    assert "STALE" in out and "digest is derived" in out
    assert "--task-digest was removed" in out


def test_task_grill_requires_proofs_and_rounds(repo):
    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    command = ("record_grill_from_json.py", "--gate", "task", "--task", "T1")

    def record(payload):
        return run(repo, *command, stdin=json.dumps(payload))

    complete = task_grill_payload(task)
    for field in ("inspected_refs", "current_flow", "criteria_map", "decision",
                  "new_abstractions", "rounds", "citations"):
        code, out = record({key: value for key, value in complete.items() if key != field})
        assert code != 0 and field in out

    code, out = record({**complete, "inspected_refs": ["missing.py:symbol"]})
    assert code != 0 and "does not exist" in out
    code, out = record({**complete, "criteria_map": {}})
    assert code != 0 and "acceptance criterion" in out
    code, out = record({**complete, "decision": "split"})
    assert code != 0 and "requires decision 'keep'" in out

    gap = "Should this task keep its current boundary?"
    cited_gap = "Does the contract already dictate the test command?"
    uncovered = {**complete, "verdict": "blocked", "decision": "split",
                 "gaps": [gap], "resolutions": ["Operator decision recorded."]}
    code, out = record(uncovered)
    assert code != 0 and "lack a rounds entry or citation" in out
    code, out = record({**uncovered, "rounds": [{
        "question": gap, "options": ["Keep", "Split"], "chosen": "Elsewhere",
    }]})
    assert code != 0 and "chosen must be one of" in out
    four_option_round = {
        **uncovered,
        "rounds": [{
            "question": gap,
            "options": ["Keep", "Split", "Block", "Revise"],
            "chosen": "Revise",
            "frontier_empty": True,
        }],
    }
    code, out = log_grill_rounds(repo, four_option_round["rounds"])
    assert code == 0, out
    code, out = record(four_option_round)
    assert code == 0, out
    code, out = record({**uncovered, "citations": [{"finding": gap, "source": ""}]})
    assert code != 0 and "named source document" in out

    proved = {
        **complete,
        "inspected_refs": ["factory/scripts/record_grill_from_json.py:_validate_task_grill"],
        "gaps": [gap, cited_gap],
        "resolutions": ["The operator chose to keep the bounded task.",
                        "The declared test command remains binding."],
        "rounds": [{"question": gap, "options": ["Keep", "Split"],
                    "chosen": "Keep", "frontier_empty": True}],
        "citations": [{"finding": cited_gap, "source": "docs/QUALITY.md"}],
    }
    code, out = log_grill_rounds(repo, proved["rounds"])
    assert code == 0, out
    code, out = record(proved)
    assert code == 0, out


def test_task_grill_block_requires_escalation_packet(repo):
    task = STAGE_TASK
    seed_task_grill_frontier(repo, task)
    payload = task_grill_payload(task, verdict="blocked", escalation_packet={})
    command = ("record_grill_from_json.py", "--gate", "task", "--task", "T1")

    code, out = run(repo, *command, stdin=json.dumps(payload))
    assert code != 0 and "escalation_packet" in out

    payload["escalation_packet"] = {"issue": "The task is blocked."}
    code, out = run(repo, *command, stdin=json.dumps(payload))
    assert code != 0 and "exactly" in out

    payload["escalation_packet"] = {
        "issue": "The task boundary cannot be implemented safely as written.",
        "evidence": "The inspected flow conflicts with the acceptance criteria.",
        "recommendation": "Revise the task contract before delegation.",
        "alternatives": "Split the task or remove the conflicting criterion.",
        "rollback": "Keep the stage inactive until the contract is revised.",
    }
    code, out = run(repo, *command, stdin=json.dumps({
        **payload,
        "escalation_packet": {**payload["escalation_packet"], "rollback": " "},
    }))
    assert code != 0 and "non-empty" in out
    code, out = run(repo, *command, stdin=json.dumps({
        **payload,
        "escalation_packet": {**payload["escalation_packet"], "owner": "PM"},
    }))
    assert code != 0 and "exactly" in out

    code, out = run(repo, *command, stdin=json.dumps(payload))
    assert code == 0, out


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
    # Enforcement keys off the ACTIVE TASK's user_facing flag, so the story
    # needs an active, user_facing task before the recorders gate on skills.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    ui_task = {**DECOMP["tasks"][0], "user_facing": True}
    record_skeleton_then_frontier(repo, [ui_task])
    control = delegation_ledger(repo).parent
    (control / "stages.json").write_text(json.dumps(
        {"issue": "ENG-1", "stages": [{"id": "T1", "status": "active"}]}))
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
    mint_review_run(repo)
    review = {"generated_by": "autoreview", "score": 9, "summary": "ok",
              "blocking_findings": []}
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review))
    assert code != 0 and "review-animations" in out
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps({**review, "skills_used": ["review-animations"]}))
    assert code == 0, out
    # a backend active task in the same story: no design-skill requirement —
    # the active task's OWN flag governs, so flip it and re-check.
    data = json.loads((control / "decomposition.json").read_text())
    data["tasks"][0]["user_facing"] = False
    (control / "decomposition.json").write_text(json.dumps(data))
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


def test_success_output_budget(repo):
    """Success = one output line (terse-output spec). Exceptions are inline."""
    def expect(budget, *args):
        code, out = run(repo, *args)
        assert code == 0, out
        assert len(out.splitlines()) == budget, f"{args}: {out!r}"
        return out

    expect(1, "forge.py", "decision", "new", "budget-probe", "--repo", str(repo))
    record = next((repo / "docs" / "decisions").glob("*-budget-probe.md"))
    record.write_text(record.read_text()
        .replace("<!-- Why this decision was needed; the forces at play. -->", "Why.")
        .replace("<!-- What was decided, in one or two sentences. -->", "What.")
        .replace("<!-- What follows: tradeoffs accepted, doors closed, work implied. -->",
                 "So."))
    expect(1, "forge.py", "decision", "accept", "budget-probe", "--by", "PM")
    expect(1, "forge.py", "quickfix", "start", "budget probe")
    expect(1, "forge.py", "quickfix", "done")
    draft = repo / "probe-draft.md"
    draft.write_text("# Probe capability\n\nBody.\n")
    expect(1, "forge.py", "spec", "save", "budget-probe", "--from", str(draft))
    expect(1, "forge.py", "context", "scan")
    expect(1, "forge.py", "lesson", "add", "--topic", "probe",
           "--lesson", "One-line successes stay one line.",
           "--source", "test", "--applies-to", "factory/**",
           "--severity", "low", "--by", "implementer")
    expect(1, "forge.py", "defer", "add", "budget probe deferral",
           "--why", "probe", "--trigger", "never")
    # Documented exception: signal raise is worker-facing and keeps PAUSE.
    out = expect(2, "forge.py", "signal", "raise", "--kind", "confusion",
                 "--by", "implementer", "-m", "budget probe")
    sig_id = out.split()[1]
    expect(1, "forge.py", "signal", "resolve", sig_id, "--notes", "probe done")


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
    assert code == 0 and out.count("\n") == 1 and "Supersedes" in out, out
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


def post_hook(repo: Path, payload: dict) -> tuple[int, str]:
    return run(repo, "forge.py", "hook", "post_tool_use", stdin=json.dumps(payload))


def plan_hook_payload(path: Path, *, tool="Write", mode="plan", session_id=None):
    payload = {
        "tool_name": tool, "permission_mode": mode,
        "tool_input": {"file_path": str(path)},
    }
    if session_id is not None:
        payload["session_id"] = session_id
    return payload


def test_post_tool_use_records_plan_mode_marker(repo):
    root_plan = repo / "plans" / "root-draft.md"
    root_plan.write_text("# Root draft\n", encoding="utf-8")
    code, out = post_hook(repo, plan_hook_payload(root_plan, session_id="session-root"))
    assert code == 0, out
    root_records = list((repo / ".factory" / "plan-mode").glob("*.json"))
    assert len(root_records) == 1

    code, out = intake(repo, "PLAN-1", "Plan provenance")
    assert code == 0, out
    plan = repo / "plans" / "draft.md"
    plan.write_text("# Draft\n\nBody\n\n## Implementation Assumptions\n- ignored\n")
    records_dir = story_state(repo, "PLAN-1") / "plan-mode"
    for tool in ("Write", "Edit", "MultiEdit"):
        payload = plan_hook_payload(plan, tool=tool, session_id=f"session-{tool}")
        before = set(records_dir.glob("*.json"))
        code, out = post_hook(repo, payload)
        assert code == 0, out
        records = set(records_dir.glob("*.json"))
        assert len(records) == len(before) + 1
        marker = json.loads((records - before).pop().read_text())
        assert marker == {
            "generated_by": "claude-code:plan-mode",
            "path": str(plan),
            "sha256": hashlib.sha256(plan.read_bytes()).hexdigest(),
            "sha256_body": plan_digest_without_assumptions(plan),
            "at": marker["at"],
            "session_id": f"session-{tool}",
        }

    code, out = post_hook(repo, {**payload, "permission_mode": "default"})
    assert code == 0, out
    assert len(list(records_dir.glob("*.json"))) == 3


def test_post_tool_use_records_ask_user_question_round(repo):
    root_payload = {
        "tool_name": "AskUserQuestion",
        "session_id": "session-root",
        "tool_input": {"questions": [{
            "question": "Start the grill?",
            "options": [{"label": "Start"}],
        }]},
        "tool_response": {"answers": {"Start the grill?": "Start"}},
    }
    code, out = post_hook(repo, root_payload)
    assert code == 0, out
    assert len(list((repo / ".factory" / "grill-rounds").glob("*.json"))) == 1

    code, out = intake(repo, "GRILL-1", "Grill provenance")
    assert code == 0, out
    payload = {
        "tool_name": "AskUserQuestion",
        "permission_mode": "default",
        "session_id": "session-2",
        "tool_input": {"questions": [{
            "question": "Keep this boundary?",
            "options": [
                {"label": "Keep", "description": "Keep the task bounded."},
                {"label": "Split", "description": "Split the task."},
            ],
        }]},
        "tool_response": {
            "answers": {"Keep this boundary?": "Keep"},
            "notes": "private free text must not be persisted",
        },
    }

    code, out = post_hook(repo, payload)
    assert code == 0, out
    records = list((story_state(repo, "GRILL-1") / "grill-rounds").glob("*.json"))
    assert len(records) == 1
    assert json.loads(records[0].read_text()) == {
        "generated_by": "claude-code:plan-mode",
        "questions": [{
            "question": "Keep this boundary?",
            "options": ["Keep", "Split"],
            "chosen": "Keep",
        }],
        "at": json.loads(records[0].read_text())["at"],
        "session_id": "session-2",
    }
    assert "private free text" not in records[0].read_text()


def test_post_tool_use_is_fail_open(repo):
    code, out = run(repo, "post_tool_use.py", stdin="not json")
    assert code == 0 and out == ""
    code, out = post_hook(repo, {
        "tool_name": "AskUserQuestion",
        "tool_input": {"questions": "not a list"},
        "tool_response": {"notes": "do not record me"},
    })
    assert code == 0 and out == ""
    assert not (repo / ".factory" / "grill-rounds").exists()

    schema = repo / "factory" / "schemas" / "plan-mode-marker.json"
    schema.write_text(json.dumps({"required": {"missing": "str"}}))
    plan = repo / "plans" / "draft.md"
    plan.write_text("# Draft\n")
    code, out = post_hook(repo, plan_hook_payload(plan, session_id="session-3"))
    assert code == 0 and out == ""
    assert not (repo / ".factory" / "plan-mode").exists()


def test_vendor_integrity_covers_post_tool_use(repo):
    files = json.loads(
        (repo / "constitution" / "VENDOR_MANIFEST.json").read_text()
    )["files"]
    assert "factory/scripts/post_tool_use.py" in files
    assert "factory/schemas/plan-mode-marker.json" in files
    assert "factory/schemas/grill-round.json" in files
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out


def test_post_tool_use_marks_plan_outside_repo_with_raw_and_body_digests(
        repo, tmp_path):
    plan = tmp_path / "outside-plan.md"
    plan.write_bytes(b"# Draft\n\nBody\n\n## Implementation Assumptions\n- ignored\n")
    code, out = post_hook(repo, plan_hook_payload(plan))
    assert code == 0, out
    records = list((repo / ".factory" / "plan-mode").glob("*.json"))
    assert len(records) == 1
    marker = json.loads(records[0].read_text())
    assert marker["path"] == str(plan.resolve())
    assert marker["sha256"] == hashlib.sha256(plan.read_bytes()).hexdigest()
    assert marker["sha256_body"] == plan_digest_without_assumptions(plan)
    assert marker["session_id"] == ""


def test_post_tool_use_round_without_response_records_chosen_null(repo):
    payload = {
        "tool_name": "AskUserQuestion",
        "tool_input": {"questions": [{
            "question": "Keep this boundary?",
            "options": [{"label": "Keep"}, {"label": "Split"}],
        }]},
    }
    records_dir = repo / ".factory" / "grill-rounds"
    for response in (None, {"answers": {"Keep this boundary?": "free text"}}):
        before = set(records_dir.glob("*.json"))
        call = payload if response is None else {**payload, "tool_response": response}
        code, out = post_hook(repo, call)
        assert code == 0, out
        added = set(records_dir.glob("*.json")) - before
        assert len(added) == 1
        record = json.loads(added.pop().read_text())
        assert record["questions"][0]["chosen"] is None
        assert record["session_id"] == ""


def test_post_tool_use_records_without_session_id(repo):
    plan = repo / "plans" / "draft.md"
    plan.write_text("# Draft\n", encoding="utf-8")
    code, out = post_hook(repo, plan_hook_payload(plan, tool="Edit"))
    assert code == 0, out
    marker = next((repo / ".factory" / "plan-mode").glob("*.json"))
    assert json.loads(marker.read_text())["session_id"] == ""


def make_unmerged(repo: Path, rel: str = "src/conflict.ts") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("base\n")
    git(repo, "add", rel)
    git(repo, "commit", "-m", "conflict base")
    oid = git(repo, "rev-parse", f"HEAD:{rel}")
    records = "".join(f"100644 {oid} {stage}\t{rel}\n" for stage in (1, 2, 3))
    proc = subprocess.run(
        ["git", "update-index", "--index-info"], cwd=repo, input=records,
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_hook_denylist_fallback_on_unparseable_state_or_import(repo):
    state = repo / ".factory" / "run.json"
    valid_state = state.read_text()
    state.write_text("<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n")
    payload = {"tool_name": "Edit", "tool_input": {
        "file_path": str(repo / "src" / "app.ts")}}

    code, out = hook(repo, payload)
    assert code == 0 and "deny" in out and "emergency deny-list" in out
    code, out = run(repo, "stop_continue.py", stdin="{}")
    assert code == 0 and json.loads(out) == {"continue": True}

    state.write_text(valid_state)
    library = repo / "factory" / "scripts" / "factory_lib.py"
    library.write_text("this is not valid Python !!!\n")
    code, out = hook(repo, payload)
    assert code == 0 and "deny" in out and "SyntaxError" in out
    code, out = hook(repo, {"tool_name": "Bash", "tool_input": {"command": "sed -i x src/app.ts"}})
    assert code == 0 and "deny" in out and "emergency deny-list" in out
    code, out = hook(repo, {"tool_name": "Bash", "tool_input": {"command": "git status"}})
    assert code == 0 and out == "{}\n"
    code, out = run(repo, "stop_continue.py", stdin="{}")
    assert code == 0 and json.loads(out) == {"continue": True}


def test_hook_permits_git_native_resolution_on_unmerged_paths(repo):
    make_unmerged(repo)
    for command in (
        "git checkout --ours -- src/conflict.ts",
        "git checkout --theirs -- src/conflict.ts",
        "git add -- src/conflict.ts",
        "git rm -- src/conflict.ts",
        "git reset -- src/conflict.ts",
        "git merge --abort",
        "git rebase --abort",
        "git cherry-pick --abort",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "tool_input": {"command": command}})
        assert code == 0 and out == "{}\n", command


def test_hook_refuses_handwrite_and_merged_paths_during_merge(repo):
    make_unmerged(repo)
    for payload in (
        {"tool_name": "Edit", "tool_input": {
            "file_path": str(repo / "src" / "conflict.ts")}},
        {"tool_name": "Write", "tool_input": {
            "file_path": str(repo / "src" / "conflict.ts")}},
        {"tool_name": "Bash", "tool_input": {"command": "git add -- src/app.ts"}},
        {"tool_name": "Bash", "tool_input": {
            "command": "git checkout --ours -- src/app.ts"}},
        {"tool_name": "Bash", "tool_input": {
            "command": "git add -- src/conflict.ts src/app.ts"}},
    ):
        code, out = hook(repo, payload)
        assert code == 0 and "deny" in out, payload


def test_commit_belt_stages_refreshed_ledger(repo):
    context_file = repo / "docs" / "context" / "commit-note.md"
    context_file.write_text("new client context\n")
    git(repo, "add", "docs/context/commit-note.md")

    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "git commit -m context"},
    })

    assert code == 0
    assert out == "{}\n"
    staged = git(repo, "diff", "--cached", "--name-only").splitlines()
    assert staged == ["docs/context/commit-note.md", "docs/context/ledger.json"]
    ledger = json.loads((repo / "docs" / "context" / "ledger.json").read_text())
    assert ledger["files"]["commit-note.md"]["status"] == "pending"


def test_commit_belt_denies_commit_while_context_file_refused(repo):
    context_file = repo / "docs" / "context" / "secret.txt"
    context_file.write_text('password = "hunter2secret"\n')
    git(repo, "add", "docs/context/secret.txt")

    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "git commit -m context"},
    })

    assert code == 0
    decision = json.loads(out)["hookSpecificOutput"]
    assert decision["permissionDecision"] == "deny"
    assert "secret.txt" in decision["permissionDecisionReason"]
    assert "REDACT" in decision["permissionDecisionReason"]
    assert "secret.txt" not in json.loads(
        (repo / "docs" / "context" / "ledger.json").read_text()
    )["files"]


def test_commit_belt_clean_inbox_is_pass_through(repo):
    ledger_path = repo / "docs" / "context" / "ledger.json"

    # Never-scanned empty inbox: the belt leaves no untracked ledger residue.
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "git commit -m clean"},
    })
    assert code == 0
    assert out == "{}\n"
    assert not ledger_path.exists()

    code, out = run(repo, "forge.py", "context", "scan")
    assert code == 0, out
    before = ledger_path.read_bytes()

    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "git commit -m clean"},
    })

    assert code == 0
    assert out == "{}\n"
    assert ledger_path.read_bytes() == before
    assert git(repo, "diff", "--cached", "--name-only") == ""


COMPANION = "node /x/codex-companion.mjs task --model gpt-5.6-sol"
COMPANION_WRITE = (COMPANION + " --write --prompt-file .factory/briefs/T1.md "
                   "'build the slice'")


def test_companion_guard_admits_read_only_and_refuses_write_shapes(repo):
    run_state = json.loads((repo / ".factory" / "run.json").read_text())
    assert "issue_key" not in run_state and "plan_status" not in run_state
    assert not (repo / ".factory" / "stages.json").exists()
    allowed = (
        "node /x/codex-companion.mjs status --json",
        "node /x/codex-companion.mjs task-resume-candidate --json",
        "node /x/codex-companion.mjs task 'audit how --write is handled'",
        "node /x/codex-companion.mjs task 'trace a;b and $HOME literally'",
        "'node' '/x/codex-companion.mjs' 't''ask' 'map the module'",
    )
    refused = (
        "node /x/codex-companion.mjs task '--write' repair",
        "node /x/codex-companion.mjs task --full-auto repair",
        "node /x/codex-companion.mjs setup",
        "env MODE=x node /x/codex-companion.mjs status --json",
        "bash -c 'node /x/codex-companion.mjs status --json'",
        'node /x/codex-companion.mjs task "expand $HOME"',
    )
    for harness_source in (False, True):
        if harness_source:
            mark_harness_source(repo)
        for command in allowed:
            code, out = hook(repo, {
                "tool_name": "Bash", "permission_mode": "default",
                "tool_input": {"command": command},
            })
            assert code == 0 and "deny" not in out, (harness_source, command)
        for command in refused:
            code, out = hook(repo, {
                "tool_name": "Bash", "permission_mode": "default",
                "tool_input": {"command": command},
            })
            assert code == 0 and "deny" in out and "forge delegate" in out, (
                harness_source, command,
            )


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


def test_lockout_denies_product_write_under_approved_plan(repo, tmp_path):
    mark_harness_source(repo)
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])

    payloads = (
        {"tool_name": "Edit", "tool_input": {
            "file_path": str(repo / "src" / "app.ts")}},
        {"tool_name": "Write", "tool_input": {
            "file_path": str(repo / "AGENTS.md")}},
        {"tool_name": "NotebookEdit", "tool_input": {
            "notebook_path": str(repo / "tests" / "analysis.ipynb")}},
        {"tool_name": "Bash", "tool_input": {
            "command": "printf x > .github/workflows/build.yml"}},
    )
    for payload in payloads:
        code, out = hook(repo, {**payload, "permission_mode": "default"})
        assert code == 0 and "deny" in out, payload
        assert "forge delegate <task-id>" in out
        assert "forge mode degraded start --reason" in out


def test_registered_hook_path_keeps_recorder_and_lockout_armed(repo, tmp_path):
    from forge_cli.doctor import _runnable_hook_shell

    mark_harness_source(repo)
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])

    _route_fixture_hooks_through_forge(repo)
    shell = _runnable_hook_shell(dict(os.environ), repo)
    assert shell, "test requires a shell that can launch this checkout"
    document = json.loads((repo / ".claude" / "settings.json").read_text())
    command = document["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    payload = {
        "tool_name": "Edit",
        "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "app.ts")},
    }

    result = subprocess.run(
        [shell, "-c", command],
        cwd=repo,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "deny" in result.stdout
    assert "forge delegate <task-id>" in result.stdout


def test_degraded_window_allows_and_ledgers_product_write(repo):
    base = pr_ticket_base(repo)
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "companion outage")
    assert code == 0 and "Degraded mode" in out, out
    active = json.loads((repo / ".factory" / "quickfix.json").read_text())
    assert active["profile"] == "degraded" and active["kind"] == "degraded"
    assert active["reason"] == "companion outage" and active["max_files"] == 5

    claimed = (
        "src/app.ts", "AGENTS.md", ".github/workflows/build.yml",
        "factory/scripts/repair.py", "tests/test_repair.py",
    )
    for rel in claimed:
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / rel)},
        })
        assert code == 0 and "deny" not in out, (rel, out)

    for rel in ("docs/notes.md", "plans/draft.md", "prototype/probe.md",
                ".gstack/projects/probe.md"):
        code, out = hook(repo, {
            "tool_name": "Write", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / rel)},
        })
        assert code == 0 and "deny" not in out, rel

    active = json.loads((repo / ".factory" / "quickfix.json").read_text())
    assert active["files"] == list(claimed)
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "sixth.py")},
    })
    assert code == 0 and "deny" in out and "five-file" in out

    window_id = active["id"]
    code, out = run(repo, "forge.py", "mode", "done")
    assert code == 0 and window_id in out and "5 file(s)" in out, out
    records = [json.loads(path.read_text())
               for path in (repo / "plans" / "quickfixes").glob("*.json")]
    done = next(record for record in records
                if record.get("event") == "done" and record.get("id") == window_id)
    assert done["kind"] == "degraded" and done["files"] == list(claimed)

    git(repo, "add", "plans/quickfixes")
    git(repo, "commit", "-q", "-m", "record degraded window")
    code, out = check_pr_ticket(
        repo, base, "fix/degraded-window", f"Ticket: {window_id}\n",
    )
    assert code == 0 and f"window {window_id}" in out, out


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
    brief = repo / "brief.md"
    brief.write_text("Inspect the sender chain.\nKeep this read-only.\n")
    (repo / "brief-link.md").symlink_to(brief)
    for command in (
        COMPANION + " --effort xhigh 'explore the sender chain'",
        COMPANION + " --prompt-file brief.md",
        COMPANION + " --prompt-file brief-link.md",
        "node /x/codex-companion.mjs task-resume-candidate --json",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" not in out, command


def test_hook_allows_display_options_on_companion_mentions(repo):
    # grep -n / rg -i / ls -la / tail -n only read or format: a display
    # command that merely mentions the companion may carry them.
    for command in (
        "grep -n codex-companion factory/scripts",
        "rg -n --ignore-case codex-companion .",
        "ls -la /x/codex-companion.mjs",
        "tail -n 20 /x/codex-companion.log",
        "head -c 400 /x/codex-companion.mjs",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" not in out, command


def test_hook_still_denies_exec_capable_options_on_companion_mentions(repo):
    # rg --pre / --pre-glob run a preprocessor and tail -f follows forever:
    # the pinned exec-capable display options stay off-contract even though
    # read/format flags are now allowed.
    for command in (
        "rg --pre ./decode codex-companion .",
        "rg --pre-glob '*.gz' --pre gunzip codex-companion .",
        "tail -f /x/codex-companion.log",
        "tail --follow=name /x/codex-companion.log",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" in out and "forge delegate" in out, command


def test_hook_allows_readonly_companion_result_and_background(repo):
    # `result` only prints a stored job (the fetch path for a backgrounded
    # rescue run); `--background` detaches a read-only task. Neither writes.
    for command in (
        "node /x/codex-companion.mjs result task-abc123 --json",
        "node /x/codex-companion.mjs result --json",
        COMPANION + " --background 'explore the sender chain'",
        "node /x/codex-companion.mjs task --background --effort high 'explore'",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" not in out, command
    for command in (
        "node /x/codex-companion.mjs cancel task-abc123 --json",
        "node /x/codex-companion.mjs task --background --write 'explore'",
        "node /x/codex-companion.mjs setup --json",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" in out and "forge delegate" in out, command


def test_hook_allows_note_heredoc_that_mentions_the_companion(repo):
    # A heredoc whose only consumer is a data sink is data: a note may name
    # the companion and hold a quote/backtick that breaks shlex.
    note = (
        "cat >> plans/exploration/notes.md <<'EOF'\n"
        "it's the codex-companion.mjs `task` launcher; see $CODEX_COMPANION\n"
        "EOF\n"
    )
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": note}})
    assert code == 0 and "deny" not in out, out


def test_hook_keeps_heredoc_bodies_fed_to_executors(repo):
    # A body that reaches sh, a pipe, a separator, or trailing text can
    # carry a launch: nothing outside the exact sink shape is stripped.
    launch = "node /x/codex-companion.mjs task --write\n"
    for command in (
        "sh <<'EOF'\n" + launch + "EOF",
        "cat <<'EOF' | sh\n" + launch + "EOF",
        "cat >> plans/notes.md <<'EOF'\n" + launch + "EOF\nsh plans/notes.md",
        "cat <<'EOF'; sh plans/notes.md\n" + launch + "EOF",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert code == 0 and "deny" in out and "forge delegate" in out, command


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
    # Plan mode is for authoring the plan; it is not a product-write licence.
    for mode in ("default", "plan"):
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": mode,
            "tool_input": {"file_path": str(repo / "src" / "app.ts")},
        })
        assert code == 0 and "deny" in out and "forge delegate" in out, mode
    # planning-phase writes stay open: the plan itself, decisions, docs
    # (.factory/ is NOT among them — recorded state is never hand-written)
    for ok_path in ("plans/draft.md", "docs/decisions/0009-x.md", "docs/notes.md"):
        code, out = hook(repo, {"tool_name": "Write", "permission_mode": "default",
                                "tool_input": {"file_path": str(repo / ok_path)}})
        assert "deny" not in out, ok_path
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
    # Env-var prefixes do not open a side door.
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command":
                                           "FACTORY_DEGRADED=1 codex exec -s read-only 'map it'"}})
    assert "deny" in out and "codex:rescue" in out
    # Approval and decomposition authorize delegation, never session writes.
    save_plan(repo, tmp_path)
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" in out and "forge delegate" in out
    task = task_with_plan_contracts(DECOMP["tasks"][0])
    record_skeleton_then_frontier(repo, [task])
    code, out = hook(repo, {"tool_name": "Edit", "permission_mode": "default",
                            "tool_input": {"file_path": str(repo / "src" / "app.ts")}})
    assert "deny" in out and "forge delegate" in out
    # ...but a WRITE delegation still needs a started, briefed stage: the plan
    # authorizes the work, the brief is what the executor is actually given
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion + " --write"}})
    assert "deny" in out and "forge delegate" in out
    code, out = record_task_grill(repo, task)
    assert code == 0, out
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
    assert "forge delegate <task-id>" in out
    assert './forge mode degraded start --reason \\"<reason>\\"' in out

    code, out = hook(repo, {**payload, "permission_mode": "plan"})
    assert code == 0 and "deny" in out
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
        assert code == 0 and "deny" in out and "forge delegate" in out
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
        assert code == 0 and "deny" in out and "forge delegate" in out, rel
    code, out = hook(repo, {
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": {"command": "printf x > factory/scripts/pre_tool_use.py"},
    })
    assert code == 0 and "deny" in out and "forge delegate" in out

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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    # Approval authorizes the delegated worker, not direct session writes.
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
        assert code == 0 and "deny" in out, out


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


def test_harness_degraded_claims_machinery_files_against_budget(repo):
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "repair machinery")
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

    code, out = run(repo, "forge.py", "mode", "done")
    assert code == 0 and "5 file(s)" in out, out
    events = [json.loads(path.read_text())
              for path in (repo / "plans" / "quickfixes").glob("*.json")]
    done = [event for event in events if event.get("event") == "done"]
    assert len(done) == 1
    assert done[0]["files"] == expected


def test_harness_degraded_cannot_delete_the_repo_kind_marker(repo):
    # The attack: open a quickfix, rm the marker as the first claimed file to
    # flip the repo to client-mode, then flood machinery past the 5-file budget.
    # The marker is plan-only, so the window can never touch it.
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "sneaky")
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


def test_degraded_pins_repo_kind_so_marker_deletion_cannot_escape_budget(repo):
    # The structural guarantee (decision 0030): a quickfix pins the repo kind at
    # start, so even if the marker is removed mid-window by an UNCAUGHT vector,
    # classification stays 'harness' and machinery keeps being claimed against
    # the budget. Without the pin, the deletion would flip the repo to client and
    # let unlimited machinery writes bypass the 5-file budget.
    from forge_cli.repo_kind import is_harness_source_repo
    mark_harness_source(repo)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "pinned")
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
    code, out = run(repo, "forge.py", "mode", "done")
    assert code != 0 and "missing" in out, out
    (repo / ".factory" / "harness-source.json").write_text('{"role": "harness-source"}\n')
    code, out = run(repo, "forge.py", "mode", "done")
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


def test_harness_degraded_refuses_opaque_machinery_deletes(repo):
    # The 5-file budget is only honest if each claimed slot is a bounded file. A
    # recursive/globbed/brace-expanded DELETE of machinery would spend one slot on
    # an unbounded set, so a quickfix refuses it; explicit single-file ops stay
    # allowed, and — critically — read-OUT copies (product source, external dest)
    # are NOT blocked (they modify nothing in the repo).
    mark_harness_source(repo)
    (repo / "factory" / "scripts").mkdir(parents=True, exist_ok=True)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "opaque")
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


def test_harness_degraded_counts_each_file_copied_into_a_machinery_dir(repo):
    # `cp <src> factory/scripts/` creates factory/scripts/<basename>; six such
    # copies must spend six budget slots (resolved per created file), not one for
    # the shared directory — so the sixth is refused.
    mark_harness_source(repo)
    (repo / "factory" / "scripts").mkdir(parents=True, exist_ok=True)
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "copies")
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
        ".gstack/projects/probe.md",
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


def test_degraded_lifecycle_tracks_files_and_enforces_budget(repo):
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "repair parser")
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

    code, out = run(repo, "forge.py", "mode", "list")
    assert code == 0 and "repair parser" in out and "5/5" in out
    code, out = run(repo, "forge.py", "mode", "done")
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


def test_degraded_enforces_budget_inside_an_active_story(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "repair active story")
    assert code == 0, out

    active_path = repo / ".factory" / "quickfix.json"
    for number in range(1, 6):
        code, out = hook(repo, {
            "tool_name": "Edit", "permission_mode": "default",
            "tool_input": {"file_path": str(repo / "src" / f"story-{number}.py")},
        })
        assert code == 0 and "deny" not in out, out
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "story-6.py")},
    })
    assert code == 0 and "deny" in out and "scope exceeded" in out
    assert json.loads(active_path.read_text())["files"] == [
        f"src/story-{number}.py" for number in range(1, 6)
    ]


def test_degraded_budget_refuses_over_limit_when_unplanned(repo):
    code, out = run(repo, "forge.py", "mode", "degraded", "start",
                    "--reason", "bounded repair")
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


def test_quickfix_window_authorizes_nothing(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    code, out = run(repo, "forge.py", "quickfix", "start", "zero-budget probe")
    assert code == 0, out

    active_path = repo / ".factory" / "quickfix.json"
    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "recorded.py")},
    })
    assert code == 0 and "deny" in out and "forge delegate" in out
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


def test_mode_done_clears_scoped_reviews_without_legacy_dir(repo):
    # CFS-1 layout: reviews live under the story dir and .factory/reviews never
    # exists. Lite close must clean the scoped gate reviews and not crash on the
    # absent legacy directory (the pre-fix rmtree targeted .factory/reviews).
    code, out = intake(repo)
    assert code == 0, out
    lib = load_factory_lib(repo)
    key = run_state(repo)["issue_key"]
    assert lib.story_uses_scoped_layout(repo, key)

    open_lite(repo)
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "scoped_fix.py").write_text("ok = True\n")
    git(repo, "add", "src/scoped_fix.py")
    git(repo, "commit", "-q", "-m", "scoped lite fix")

    scoped_reviews = lib.story_dir(repo, key) / "reviews"
    scoped_reviews.mkdir(parents=True, exist_ok=True)
    for aspect in ("quality", "performance", "security"):
        (scoped_reviews / f"{aspect}.json").write_text(json.dumps({
            "generated_by": "autoreview", "score": 9, "summary": "clean",
            "blocking_findings": [], "commit": head(repo),
        }))
    # CFS-1 migrates the legacy reviews dir away; its absence used to crash the
    # close (rmtree on a missing path).
    shutil.rmtree(repo / ".factory" / "reviews", ignore_errors=True)

    code, out = run(repo, "forge.py", "mode", "done")
    assert code == 0 and "1 file(s)" in out, out
    assert not scoped_reviews.exists()  # ephemeral gate reviews cleared
    assert not (repo / ".factory" / "quickfix.json").exists()  # window closed


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
    companion_env = {
        **fake_companion_env(tmp_path),
        "PYTHONPATH": str(_fake_psutil_module(tmp_path)),
    }
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


def test_lite_window_does_not_authorize_session_product_write(repo):
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--by", "Ada", "--reason", "bounded delivery")
    assert code == 0, out

    code, out = hook(repo, {
        "tool_name": "Edit",
        "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "lite.py")},
    })
    assert code == 0 and "deny" in out and "forge delegate" in out


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


@pytest.mark.skipif(
    not PLANNING_LOCK_DECISION_FIXTURE.is_file(),
    reason="requires the planning-lock decision harness-source fixture",
)
def test_docs_describe_three_planning_lock_exits():
    decision = PLANNING_LOCK_DECISION_FIXTURE.read_text().lower()
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

def test_plan_save_refuses_without_fresh_requirements_grill(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "requirements-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = record_grill(
        repo, "plan", digest_of=plan, seed_requirements=False,
    )
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "requirements grill required" in out.lower()

    roadmap_path = repo / "plans" / "roadmap.json"
    roadmap = json.loads(roadmap_path.read_text())
    item = next(entry for entry in roadmap["items"] if entry["key"] == "ENG-1")
    spec_ref = item.pop("spec")
    roadmap_path.write_text(json.dumps(roadmap, indent=2) + "\n")
    code, out = record_grill(repo, "requirements")
    assert code != 0 and "no confirmed spec" in out
    item["spec"] = spec_ref
    roadmap_path.write_text(json.dumps(roadmap, indent=2) + "\n")

    code, out = record_grill(repo, "requirements", verdict="blocked")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "blocked" in out

    code, out = record_grill(repo, "requirements")
    assert code == 0, out
    requirements_path = story_state(repo) / "grills" / "requirements.json"
    assert json.loads(requirements_path.read_text())["issue"] == "ENG-1"

    spec = repo / "docs" / "specs" / "base.md"
    spec.write_text(spec.read_text() + "\nRepository reality changed.\n")
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "requirements grill is stale" in out.lower()

    code, out = record_grill(repo, "requirements")
    assert code == 0, out
    product = repo / "requirements-grounding.txt"
    product.write_text("current repository\n")
    git(repo, "add", product.name)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "requirements grill is stale" in out.lower()

    code, out = record_grill(repo, "requirements")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out


def test_forge_next_routes_requirements_round_first(repo):
    sign_off(repo)
    intake(repo)

    code, out = run(repo, "forge.py", "next", "--repo", str(repo))
    assert code == 0, out
    dev_actions = [line for line in out.splitlines() if "[dev]" in line]
    assert len(dev_actions) == 1
    assert "FIRST: re-grill" in dev_actions[0] and "--gate requirements" in out
    assert "enter plan mode" not in out

    code, out = record_grill(repo, "requirements")
    assert code == 0, out
    code, out = run(repo, "forge.py", "next", "--repo", str(repo))
    assert code == 0, out
    # 0050 removed the "enter plan mode" instruction; the planning step is
    # still what appears once the requirements round is recorded.
    assert "MANDATORY: plan per factory/prompts/planner.md" in out
    assert "FIRST: re-grill" not in out

    product = repo / "requirements-routing.txt"
    product.write_text("changed\n")
    git(repo, "add", product.name)
    code, out = run(repo, "forge.py", "next", "--repo", str(repo))
    assert code == 0, out
    dev_actions = [line for line in out.splitlines() if "[dev]" in line]
    assert len(dev_actions) == 1 and "FIRST: re-grill" in dev_actions[0]
    assert "enter plan mode" not in out


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


def test_plan_save_accepts_a_plan_authored_in_any_mode(repo, tmp_path):
    """Plan authoring is mode-agnostic (0050).

    The plan-mode marker used to be required, which forced an operator running
    in auto mode into plan mode purely to get a file written. It proved only
    that a mode was entered; the grill — digest-bound, with a floor of recorded
    human rounds — is the provenance that means something.
    """
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "normal-mode-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = record_grill(repo, "plan", digest_of=plan, plan_mode=False)
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")

    assert "plan-mode marker" not in out
    assert code != 0 and "awaiting-approval" in out, out
    assert list((repo / "plans" / "active").glob("ENG-1-*.md"))


def test_plan_save_and_approve_accept_plan_with_plan_mode_marker(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "plan-mode-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = record_grill(repo, "plan", digest_of=plan, plan_mode=False)
    assert code == 0, out
    code, out = post_hook(repo, plan_hook_payload(plan))
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out, out
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    code, out = record_grill(repo, "plan", digest_of=active, plan_mode=False)
    assert code == 0, out
    code, out = post_hook(repo, plan_hook_payload(active))
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")
    assert code == 0 and run_state(repo)["plan_status"] == "approved", out


def test_task_plan_save_and_approve_are_mode_agnostic(repo, tmp_path):
    """No plan-mode marker anywhere: save and approve both succeed (0050)."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out
    for marker in (story_state(repo) / "plan-mode").glob("*.json"):
        marker.unlink()

    code, out = run(repo, "forge.py", "task", "approve", "T1",
                    "--by", "Test Human")

    assert "plan-mode marker" not in out
    assert code == 0 and "Approved task plan" in out, out


def test_task_plan_save_requires_workflow_and_manual_verification(repo, tmp_path):
    """A task plan is read by the human approving it and by whoever confirms
    the thing works. A file-by-file work order serves neither (0050)."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    source = tmp_path / "T1-thin.md"
    source.write_text("# T1 plan\n\nEdit three files.\n")

    code, out = run(repo, "forge.py", "task", "plan", "save", "T1",
                    "--from", str(source))

    assert code != 0, out
    assert "2 required section(s)" in out
    assert "## Workflow" in out and "## Manual Verification" in out
    assert "mermaid" in out
    assert not (story_state(repo) / "task-plans" / "T1.md").exists()

    source.write_text("# T1 plan\n\n### Workflow\n\nA -> B.\n"
                      "\n### Manual Verification\n\n1. Run it.\n")
    code, out = run(repo, "forge.py", "task", "plan", "save", "T1",
                    "--from", str(source))
    # Heading LEVEL is not the point: a deeper structure still wrote them.
    assert code == 0, out


def test_task_approve_refuses_a_stale_or_failing_grill(repo, tmp_path):
    """The board withholds a task plan until its grill passed against the
    current text. Approval used to only CLAIM to check that, so a plan the
    board refused to show could still be approved."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])

    # require_ready_task's grill gate runs first, so this is the refusal an
    # unprepared task actually gets -- asserted here so the ordering is pinned
    # rather than assumed.
    code, out = run(repo, "forge.py", "task", "approve", "T1",
                    "--by", "Test Human")
    assert code != 0 and "Task grill required first" in out, out

    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out
    saved = story_state(repo) / "task-plans" / "T1.md"
    saved.write_text(saved.read_text(encoding="utf-8") + "\nEdited after the grill.\n",
                     encoding="utf-8")

    code, out = run(repo, "forge.py", "task", "approve", "T1",
                    "--by", "Test Human")

    assert code != 0, out
    assert "recorded against different plan text" in out
    assert "why the board is not showing it" in out


def test_plan_mode_marker_matches_body_not_assumptions(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "assumptions-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = post_hook(repo, plan_hook_payload(plan))
    assert code == 0, out
    plan.write_text(plan.read_text() + "\n## Implementation Assumptions\n- Later detail.\n")
    code, out = record_grill(repo, "plan", digest_of=plan, plan_mode=False)
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")

    assert code != 0 and "awaiting-approval" in out, out
    assert "plan-mode marker required" not in out


def test_plan_mode_marker_in_root_scope_counts_for_active_story(repo, tmp_path):
    sign_off(repo)
    plan = tmp_path / "root-scope-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = post_hook(repo, plan_hook_payload(plan))
    assert code == 0, out
    assert list((repo / ".factory" / "plan-mode").glob("*.json"))

    intake(repo)
    code, out = record_grill(repo, "plan", digest_of=plan, plan_mode=False)
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")

    assert code != 0 and "awaiting-approval" in out, out
    assert "plan-mode marker required" not in out


def test_plan_save_restamp_does_not_invalidate_marker(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    plan = tmp_path / "restamped-plan.md"
    plan.write_text(plan_draft(repo))
    code, out = record_grill(repo, "plan", digest_of=plan, plan_mode=False)
    assert code == 0, out
    code, out = post_hook(repo, plan_hook_payload(plan))
    assert code == 0, out

    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan),
                    "--story", "ENG-1")
    assert code != 0 and "awaiting-approval" in out, out
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    code, out = record_grill(repo, "plan", digest_of=active, plan_mode=False)
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")

    assert code == 0 and run_state(repo)["plan_status"] == "approved", out


def test_plan_approve_refuses_without_a_fresh_plan_grill(repo, tmp_path):
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
    assert code != 0 and "awaiting plan" in out and "Re-grill" in out

    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    code, out = record_grill(repo, "plan", digest_of=active)
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out

    marker_path = story_state(repo) / "plan-approval.json"
    marker = json.loads(marker_path.read_text())
    assert marker["approved_plan_sha256"] == plan_digest_without_assumptions(active)
    assert marker["approver"] == "Client PM"
    assert marker["issue"] == "ENG-1" and marker["story"] == "ENG-1"
    assert marker["at"]
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")
    assert code == 0, out
    assert run_state(repo)["plan_status"] == "approved"
    assert run_state(repo)["approved_plan_sha256"] == (
        plan_digest_without_assumptions(active)
    )

    # The marker cannot be replayed in a DIFFERENT context: a marker whose
    # body digest matches but whose story is another one does NOT approve —
    # the human reviewed this plan for THIS story, not that one.
    code, out = record_grill(repo, "plan", digest_of=active)
    assert code == 0, out
    tampered = {**marker, "story": "ENG-2"}
    marker_path.write_text(json.dumps(tampered))
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
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
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    record_grill(repo, "plan", digest_of=active)
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    approved_digest = json.loads(
        (story_state(repo) / "plan-approval.json").read_text()
    )["approved_plan_sha256"]

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
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    record_grill(repo, "plan", digest_of=active)
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Client PM")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")
    assert code == 0 and run_state(repo)["plan_status"] == "approved", out
    assert not (story_state(repo) / "plan-approval.json").exists()

    # Same body, marker gone -> save refuses, no silent re-approval.
    record_grill(repo, "plan", digest_of=active)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
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
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    record_grill(repo, "plan", digest_of=active)
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
                    "--story", "ENG-1")
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
    data = json.loads((story_state(repo) / "grills" / "plan.json").read_text())
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
    active = next((repo / "plans" / "active").glob("ENG-1-*.md"))
    record_grill(repo, "plan", digest_of=active)
    code, out = run(repo, "forge.py", "plan", "approve", "--by", "Gate Test Human")
    assert code == 0, out
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(active),
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

def test_ci_locale_forcing_selectors_reference_existing_tests():
    workflow = (
        HARNESS / ".github" / "workflows" / "factory-scaffold.yml"
    ).read_text()
    suite = ast.parse(
        (HARNESS / "factory" / "tests" / "test_gates.py").read_text()
    )
    test_ids = {
        node.name
        for node in suite.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    selectors = set(re.findall(
        r"factory/tests/test_gates\.py::([A-Za-z_][A-Za-z0-9_]*)",
        workflow,
    ))

    assert selectors
    assert not selectors - test_ids


def test_roadmap_gate_workflow_shape():
    workflow = (HARNESS / ".github" / "workflows" / "roadmap-gate.yml").read_text()
    pr_job, coverage_job = workflow.split("\n  coverage:\n", 1)
    pr_job = pr_job.split("\n  pr-contract:\n", 1)[1]

    assert re.search(r"^  pull_request:\s*$", workflow, re.MULTILINE)
    assert re.search(r"^  push:\s*$", workflow, re.MULTILINE)
    assert "  pr-contract:" in workflow
    assert "  coverage:" in workflow
    assert workflow.count("- uses: actions/checkout@v4") == 2
    assert workflow.count("- uses: actions/setup-python@v5") == 2
    assert workflow.count("python-version: '3.11'") == 2
    assert workflow.count("id: arm") == 2
    assert workflow.count("constitution/VENDORED_FROM") == 2
    assert workflow.count("plans/roadmap.json") == 2
    assert workflow.count("json.loads(roadmap.read_text())") == 2
    assert workflow.count('len(data["epics"]) >= 1') == 2
    assert workflow.count(
        'armed = Path("constitution/VENDORED_FROM").is_file() and has_epics'
    ) == 2
    assert "except" not in workflow
    assert workflow.count("GITHUB_OUTPUT") == 2
    # Three guarded steps across two jobs: pr-contract runs BOTH the ticket
    # gate and the task-proof gate (0049). Every gated step must carry the
    # guard -- a new gate that forgot it would fire in the harness itself and
    # in clients that have not signed off.
    assert workflow.count("steps.arm.outputs.armed == 'true'") == 3
    assert workflow.count("fetch-depth: 0") == 1
    assert "fetch-depth: 0" in pr_job and "fetch-depth: 0" not in coverage_job
    assert "github.event_name == 'push'" in coverage_job
    assert "github.ref_name == github.event.repository.default_branch" in coverage_job
    for name in ("HEAD_SHA", "HEAD_BRANCH", "PR_BODY"):
        assert f"{name}:" in pr_job and f"{name}:" not in coverage_job
    # BASE_SHA is derived from the merge-base of the PR head and its target, not
    # declared as an env var (fix/pr-ticket-check-merge-base).
    assert 'BASE_SHA="$(git merge-base' in pr_job
    assert "BASE_SHA:" not in pr_job
    for job in (pr_job, coverage_job):
        assert job.count("id: arm") == 1
        assert job.count("constitution/VENDORED_FROM") == 1
        assert job.count("plans/roadmap.json") == 1
    # One armed gate in coverage (project audit), two in pr-contract (ticket
    # declaration + task proof).
    assert coverage_job.count("steps.arm.outputs.armed == 'true'") == 1
    assert pr_job.count("steps.arm.outputs.armed == 'true'") == 2
    assert "python3 factory/scripts/check_task_proof.py" in pr_job
    assert "check_task_proof.py" not in coverage_job
    assert "python3 factory/scripts/check_pr_ticket.py" in pr_job
    assert "project audit" not in pr_job
    assert "python3 factory/scripts/forge.py project audit" in coverage_job
    assert "check_pr_ticket.py" not in coverage_job
    assert "pytest" not in workflow
    assert "factory/tests" not in workflow
    assert "gh api" not in workflow
    assert "|| true" not in workflow

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


def test_story_closeout_requires_all_task_markers_and_completed_stories_reads_shipped(
    repo, tmp_path,
):
    scoped = prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    control = delegation_ledger(repo).parent
    decomposition_path = control / "decomposition.json"
    decomposition = json.loads(decomposition_path.read_text())
    decomposition["tasks"].append({
        **decomposition["tasks"][0], "id": "T2", "title": "second slice",
    })
    decomposition_path.write_text(json.dumps(decomposition))
    (scoped / "decomposition.json").write_text(json.dumps(decomposition))
    write_passing_artifacts(repo)
    configure_origin_main(repo, tmp_path / "closeout-origin.git")
    pointer = json.loads((control / "run.json").read_text())
    pointer["base_main_sha"] = git(repo, "rev-parse", "origin/main")
    (control / "run.json").write_text(json.dumps(pointer))

    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "T1" in out and "T2" in out, out
    assert not (scoped / "shipped.json").exists()
    assert roadmap_items(repo)["ENG-1"]["status"] == "active"

    publish_task_marker(repo, "ENG-1", "T1")
    write_passing_artifacts(repo)
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "T2" in out, out
    assert not (scoped / "shipped.json").exists()

    publish_task_marker(repo, "ENG-1", "T2")
    write_passing_artifacts(repo)
    closeout_base = head(repo)
    code, out = run(repo, "pr_ready.py")
    assert code == 0 and "shipped in place" in out, out
    assert (scoped / "shipped.json").is_file()
    assert roadmap_items(repo)["ENG-1"]["status"] == "done"

    git(repo, "add", "plans/roadmap.json", ".factory/stories/ENG-1/shipped.json")
    git(repo, "commit", "-q", "-m", "close out story")
    code, out = check_pr_ticket(repo, closeout_base, "feat/ENG-1-closeout")
    assert code == 0 and "story ENG-1" in out, out


def test_check_pr_ticket_passes_base_absent_story(repo):
    key = "BOARD-107"
    base = pr_ticket_base(repo)
    ensure_story(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "add and complete story")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code == 0 and f"story {key}" in out, out


def test_check_pr_ticket_passes_when_base_has_no_roadmap(repo):
    key = "BOARD-110"
    roadmap = repo / "plans" / "roadmap.json"
    if roadmap.exists():
        roadmap.unlink()
        git(repo, "add", "-u", "plans/roadmap.json")
        git(repo, "commit", "-q", "-m", "remove roadmap from base")
    base = head(repo)
    missing = subprocess.run(
        ["git", "show", f"{base}:plans/roadmap.json"], cwd=repo,
        capture_output=True, text=True,
    )
    assert missing.returncode != 0
    ensure_story(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "introduce roadmap and complete story")

    code, out = check_pr_ticket(repo, base, f"feat/{key}-gate-a")

    assert code == 0 and f"story {key}" in out, out


def test_check_pr_ticket_infers_ticket_from_feature_branch(repo):
    key = "BOARD-111"
    base = pr_ticket_base(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "complete story from feature branch")

    code, out = check_pr_ticket(repo, base, f"feature/{key}-gate-a")

    assert code == 0 and f"story {key}" in out, out


def test_pr_ticket_accepts_a_validated_task_marker_as_work_record(repo):
    key, task_id = "BOARD-112", "T1"
    base = pr_ticket_base(repo, key)
    marker = (
        repo / ".factory" / "stories" / key / "tasks" / task_id
        / "pr-ready.json"
    )
    marker.parent.mkdir(parents=True)
    marker.write_text(json.dumps({
        "task_id": task_id,
        "branch": f"feat/{key}-{task_id}",
        "base_main_sha": base,
        "commit": head(repo),
    }) + "\n")
    git(repo, "add", marker.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "add incomplete task marker")

    code, out = check_pr_ticket(
        repo, base, "chore/task-marker", f"Ticket: {key}/{task_id}\n",
    )
    assert code != 0 and "no completed work record" in out, out

    payload = json.loads(marker.read_text())
    payload["sealed_at"] = "2026-08-19T00:00:00Z"
    marker.write_text(json.dumps(payload) + "\n")
    git(repo, "add", marker.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", "seal task marker")

    code, out = check_pr_ticket(
        repo, base, "chore/task-marker", f"Ticket: {key}/{task_id}\n",
    )
    assert code == 0 and f"task {key}/{task_id}" in out, out

    code, out = check_pr_ticket(repo, base, f"feat/{key}-{task_id}")
    assert code == 0 and f"task {key}/{task_id}" in out, out


def test_pr_ticket_story_and_quickfix_handling_unchanged(repo):
    key, window_id = "BOARD-113", "Q-0042-bcde"
    base = pr_ticket_base(repo, key)
    complete_story(repo, key)
    ledger = repo / "plans" / "quickfixes"
    ledger.mkdir(exist_ok=True)
    (ledger / "window-done.json").write_text(json.dumps({
        "event": "done", "id": window_id, "files": ["src/fix.py"],
    }) + "\n")
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}",
        "plans/quickfixes/window-done.json")
    git(repo, "commit", "-q", "-m", "complete story and work window")

    code, out = check_pr_ticket(
        repo, base, f"feat/{key}-gate-a", f"Ticket: {window_id}\n",
    )

    assert code == 0, out
    assert f"story {key}" in out and f"window {window_id}" in out, out


def test_check_pr_ticket_fails_no_ticket(repo):
    key = "BOARD-102"
    base = pr_ticket_base(repo, key)
    complete_story(repo, key)
    git(repo, "add", "plans/roadmap.json", f".factory/history/{key}")
    git(repo, "commit", "-q", "-m", "complete unlinked story")

    code, out = check_pr_ticket(repo, base, "chore/unlinked")

    assert code != 0 and "no ticket was found" in out, out


def test_check_pr_ticket_harness_source_dev_accepts_ticket(repo):
    # The harness-SOURCE repo defines the roadmap/quickfix machinery, so its own
    # development PRs complete no client story; a `Ticket:` line tracks them.
    (repo / ".factory").mkdir(exist_ok=True)
    (repo / ".factory" / "harness-source.json").write_text("{}\n")
    base = pr_ticket_base(repo)
    (repo / "factory" / "scripts" / "verify.py").write_text("# harness change\n")
    git(repo, "add", "factory/scripts/verify.py")
    git(repo, "commit", "-q", "-m", "feat: harness change")

    code, out = check_pr_ticket(
        repo, base, "feat/ponytail-and-cyclomatic", body="Ticket: 152\n")

    assert code == 0 and "harness-source development PR" in out, out


def test_check_pr_ticket_harness_source_dev_requires_a_ticket(repo):
    (repo / ".factory").mkdir(exist_ok=True)
    (repo / ".factory" / "harness-source.json").write_text("{}\n")
    base = pr_ticket_base(repo)
    (repo / "factory" / "scripts" / "verify.py").write_text("# harness change\n")
    git(repo, "add", "factory/scripts/verify.py")
    git(repo, "commit", "-q", "-m", "feat: harness change")

    code, out = check_pr_ticket(repo, base, "chore/no-ticket")

    assert code != 0 and "harness-source development PR needs a" in out, out


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


def test_check_pr_ticket_exempts_harness_revendor(repo):
    # A harness re-vendor changes only harness-owned paths AND rewrites the
    # vendor manifest — it completes no roadmap story and needs no ticket.
    base = pr_ticket_base(repo)
    (repo / "constitution" / "VENDOR_MANIFEST.json").write_text(
        '{"harness_commit": "deadbeef", "files": {}}\n')
    (repo / "factory" / "scripts" / "verify.py").write_text("# re-vendored\n")
    git(repo, "add", "constitution/VENDOR_MANIFEST.json",
        "factory/scripts/verify.py")
    git(repo, "commit", "-q", "-m", "chore: re-vendor harness")

    code, out = check_pr_ticket(repo, base, "chore/harness-upgrade-abc123")

    assert code == 0 and "harness re-vendor" in out, out


def test_check_pr_ticket_revendor_requires_manifest_marker(repo):
    # Harness-owned edits WITHOUT the manifest marker are not a sanctioned
    # re-vendor (vendor-integrity refuses hand-edits), so the ticket still holds.
    base = pr_ticket_base(repo)
    (repo / "factory" / "scripts" / "verify.py").write_text("# tweaked\n")
    git(repo, "add", "factory/scripts/verify.py")
    git(repo, "commit", "-q", "-m", "poke a harness file")

    code, out = check_pr_ticket(repo, base, "chore/harness-poke")

    assert code != 0 and "no completed work record" in out, out


def test_check_pr_ticket_revendor_rejects_mixed_product_change(repo):
    # A PR that also touches product paths is not a pure re-vendor: the ticket
    # requirement still applies even with the manifest in the diff.
    base = pr_ticket_base(repo)
    (repo / "constitution" / "VENDOR_MANIFEST.json").write_text(
        '{"harness_commit": "deadbeef", "files": {}}\n')
    (repo / "plans").mkdir(exist_ok=True)
    (repo / "plans" / "product-note.md").write_text("product change\n")
    git(repo, "add", "constitution/VENDOR_MANIFEST.json",
        "plans/product-note.md")
    git(repo, "commit", "-q", "-m", "re-vendor plus product change")

    code, out = check_pr_ticket(repo, base, "chore/mixed")

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


def test_vendored_docs_do_not_reference_unvendored_workflows():
    # Regression guard: a doc that forge upgrade vendors to clients (WORKFLOW.md,
    # CLAUDE.md, harness.yaml, ...) must not reference a .github/workflows/*.yml
    # that is NOT vendored. Only COPY_WORKFLOWS travel to clients; referencing a
    # harness-internal gate workflow (board-invariant/pr-ticket-check/pr-link)
    # breaks a client's own doc-reference check on upgrade.
    from forge_cli.scaffold import COPY_FILES, COPY_WORKFLOWS
    root = Path(__file__).resolve().parents[2]
    vendored = {Path(w).name for w in COPY_WORKFLOWS}
    ref = re.compile(r"\.github/workflows/([a-z0-9-]+\.yml)")
    offenders = []
    for name in COPY_FILES:
        doc = root / name
        if not doc.is_file():
            continue
        for m in ref.finditer(doc.read_text(errors="ignore")):
            if m.group(1) not in vendored:
                offenders.append(f"{name} -> {m.group(0)}")
    assert not offenders, (
        "vendored docs reference un-vendored workflows (breaks client doc-checks): "
        + "; ".join(offenders)
    )


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


@pytest.mark.skipif(
    not (PR_LINK_WORKFLOW_FIXTURE.is_file() and
         BOARD_INVARIANT_WORKFLOW_FIXTURE.is_file()),
    reason="requires the Gate B workflow harness-source fixtures",
)
def test_gate_b_workflows_link_the_branch_and_check_main():
    link = PR_LINK_WORKFLOW_FIXTURE.read_text()
    invariant = BOARD_INVARIANT_WORKFLOW_FIXTURE.read_text()

    assert "workflow_run:" in link
    assert "workflows: [factory-scaffold]" in link
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


def test_project_audit_flags_discovery_without_roadmap(repo):
    ledger = repo / "docs" / "context" / "ledger.json"
    ledger.write_text(json.dumps({
        "files": {"interview.md": {"status": "harvested"}},
    }))

    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))

    assert code != 0, out
    assert out.count("[no-roadmap]") == 1
    assert "forge spec save" in out and "forge spec confirm" in out
    assert "forge roadmap derive" in out
    assert "forge roadmap epic add" in out and "forge roadmap add" in out
    assert "[spec-coverage]" not in out

    code, out = run(
        repo, "forge.py", "sanitise", "--check", "--repo", str(repo),
        env={"PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert code != 0, out
    assert "[ISSUE] [board-no-roadmap]" in out

    # An epic with zero stories is still an empty roadmap, not a cleared gap.
    roadmap_path = repo / "plans" / "roadmap.json"
    epic = {"id": "onboarding", "title": "Onboarding", "objective": "First epic"}
    roadmap_path.write_text(json.dumps({"epics": [epic], "items": []}))
    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))
    assert code != 0, out
    assert out.count("[no-roadmap]") == 1

    roadmap_path.write_text(json.dumps({"epics": [epic], "items": [{
        "key": "ONB-1", "title": "First story", "epic": "onboarding",
        "story": "As a user, I onboard", "acceptance_criteria": ["onboards"],
        "status": "pending", "order": 1,
    }]}))
    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))
    assert "[no-roadmap]" not in out


def test_project_audit_clean_on_fresh_scaffold(repo):
    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))

    assert code == 0, out
    assert "Project audit OK: no project-state gaps." in out


def test_project_audit_flags_unreferenced_confirmed_spec(repo):
    from forge_cli.specs import unreferenced_confirmed_specs

    specs = repo / "docs" / "specs"
    specs.joinpath("covered.md").write_text(
        "---\nslug: covered\nstatus: confirmed\n---\n# Covered\n"
    )
    specs.joinpath("missing.md").write_text(
        "---\nslug: missing\nstatus: confirmed\n---\n# Missing\n"
    )
    (repo / "plans" / "roadmap.json").write_text(json.dumps({
        "generated_by": "docs-decomposer",
        "epics": [ROADMAP_EPIC],
        "items": [{
            **authored_story("ALIGN-1", "Alignment"),
            "spec": "docs/specs/covered.md",
            "status": "pending",
        }],
    }))

    assert unreferenced_confirmed_specs(repo) == ["docs/specs/missing.md"]

    code, out = run(repo, "forge.py", "project", "audit", "--repo", str(repo))

    assert code != 0, out
    assert "[spec-coverage] docs/specs/missing.md" in out
    assert "forge roadmap add --spec docs/specs/missing.md" in out
    assert "docs/specs/covered.md" not in out


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
    return load_events(repo)


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
        "events": load_events(repo),
    }
    second = backfill_project(repo, gh=gh_fixture)

    assert first["linked"] == 1
    assert second == {"linked": 0, "unresolved": 0, "ambiguous": 0,
                      "reconstructed": 0}
    assert calls == 1
    assert (repo / "plans" / "roadmap.json").read_bytes() == before["roadmap"]
    assert load_events(repo) == before["events"]


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


def test_forge_next_auto_heals_roadmap_after_merge(repo, tmp_path):
    import_roadmap(repo, tmp_path)
    path = repo / "plans" / "roadmap.json"
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-m", "roadmap base")
    branch = git(repo, "branch", "--show-current")
    git(repo, "checkout", "-b", "roadmap-side")
    side = json.loads(path.read_text())
    side["items"][0]["status"] = "active"
    path.write_text(json.dumps(side, indent=2) + "\n")
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-m", "roadmap active")
    git(repo, "checkout", branch)
    main = json.loads(path.read_text())
    main["items"][0]["status"] = "done"
    main["items"][0]["history"] = ".factory/history/ENG-1/"
    path.write_text(json.dumps(main, indent=2) + "\n")
    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-m", "roadmap done")
    merge = subprocess.run(
        ["git", *GIT_ID, "merge", "roadmap-side"], cwd=repo,
        capture_output=True, text=True,
    )
    assert merge.returncode != 0 and "CONFLICT" in merge.stdout + merge.stderr

    code, first = run(repo, "forge.py", "next")
    assert code == 0 and "Healed plans/roadmap.json" in first, first
    assert roadmap_items(repo)["ENG-1"]["status"] == "done"
    code, second = run(repo, "forge.py", "next")
    assert code == 0 and "Healed plans/roadmap.json" not in second, second

    git(repo, "add", "plans/roadmap.json")
    git(repo, "commit", "-m", "resolve roadmap merge")
    marker = Path(git(repo, "rev-parse", "--git-path", "forge-roadmap-healed"))
    (marker if marker.is_absolute() else repo / marker).unlink()
    merged = json.loads(path.read_text())
    merged["items"].append({**merged["items"][0], "status": "active"})
    path.write_text(json.dumps(merged, indent=2) + "\n")
    code, after_commit = run(repo, "forge.py", "next")
    assert code == 0 and "1 duplicate(s) unioned" in after_commit, after_commit


# ------------------------------------------------- the record of what shipped

def test_outcome_is_required_to_ship_and_survives_in_the_record(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    (story_state(repo) / "outcome.json").unlink()
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
    assert json.loads((story_state(repo) / "outcome.json").read_text())["outcome"] == text
    assert "outcome" not in run_state(repo)


def test_story_timeline_is_recorded_and_archived_with_its_story(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    events = load_events(repo)
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
    live = load_events(repo)
    assert "shipped" in [e["event"] for e in live]
    assert [e for e in live if e.get("story") == "ENG-1"], live
    assert "client-signoff" in [e["event"] for e in live]


def test_ship_archives_the_plan_grill_not_the_project_grills(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    run(repo, "record_decomposition_from_json.py", stdin=json.dumps(DECOMP))
    write_passing_artifacts(repo)
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    assert (story_state(repo) / "grills" / "plan.json").exists()
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    history = story_state(repo)
    # the interrogation record of THIS story survives the ship
    assert json.loads((history / "grills" / "plan.json").read_text())["issue"] == "ENG-1"
    # project-level grills are not this story's evidence
    assert not (history / "grills" / "signoff.json").exists()


def test_tagged_process_scan_skips_unreadable_environments(monkeypatch):
    """An unreadable environment falls back without aborting the sweep."""
    sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
    import forge_cli.delegate as delegate

    class Process:
        def __init__(self, pid, environ, command):
            self.pid = pid
            self._environ = environ
            self._command = command

        def username(self):
            return "owner"

        def environ(self):
            if self._environ is None:
                raise FakePsutilAccessDenied()
            return self._environ

        def cmdline(self):
            if self._command is None:
                raise FakePsutilAccessDenied()
            return self._command

        def create_time(self):
            return float(self.pid)

    unreadable = Process(101, None, None)
    readable = Process(202, {"FORGE_PROCESS_TOKEN": "owned"}, [])
    monkeypatch.setattr(
        delegate, "_psutil", lambda: fake_psutil([unreadable, readable]))

    found = delegate._tagged_processes(
        "owned", current={101: (1, 101.0), 202: (1, 202.0)})

    assert found == {202: 202.0}


def test_delegate_process_model_uses_psutil_not_ps():
    source = (HARNESS / "factory/scripts/forge_cli/delegate.py").read_text()
    tree = ast.parse(source)

    top_level_psutil_imports = [
        node for node in tree.body
        if isinstance(node, (ast.Import, ast.ImportFrom))
        and (
            any(alias.name == "psutil" for alias in getattr(node, "names", []))
            or getattr(node, "module", None) == "psutil"
        )
    ]
    forbidden_calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "os"
        and node.func.attr == "killpg"
    ]
    ps_subprocesses = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "subprocess"
        and node.func.attr in {"run", "Popen"}
        and node.args
        and isinstance(node.args[0], (ast.List, ast.Tuple))
        and node.args[0].elts
        and isinstance(node.args[0].elts[0], ast.Constant)
        and node.args[0].elts[0].value == "ps"
    ]

    assert top_level_psutil_imports == []
    assert forbidden_calls == []
    assert ps_subprocesses == []
    assert "process_iter" in source
    assert "children(recursive=True)" in source


def test_delegate_import_does_not_require_psutil():
    script = (
        "import builtins,sys; "
        "real=builtins.__import__; "
        "builtins.__import__=lambda name,*a,**k: "
        "(_ for _ in ()).throw(ModuleNotFoundError(name)) "
        "if name=='psutil' else real(name,*a,**k); "
        f"sys.path.insert(0,{str(HARNESS / 'factory/scripts')!r}); "
        "from forge_cli import delegate"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


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
    assert 'data-board-view="dependencies" aria-selected="false"' in page
    assert page.index('data-board-view="overview"') < page.index(
        'data-board-view="lifecycle"')
    assert page.index('data-board-view="lifecycle"') < page.index(
        'data-board-view="dependencies"')
    assert 'id="overview-view"' in page
    assert 'id="lifecycle-view" hidden' in page
    assert 'id="dependencies-view" hidden' in page
    assert 'document.body.dataset.view = view' in page
    assert '$("overview-view").hidden = view !== "overview"' in page
    assert '$("lifecycle-view").hidden = view !== "lifecycle"' in page
    assert '$("dependencies-view").hidden = view !== "dependencies"' in page
    # All tabs stay in the tab order. A roving tabIndex without an
    # ArrowLeft/ArrowRight handler stranded keyboard-only users in whichever
    # view they picked first — with three tabs, keeping all focusable is the
    # smaller fix than implementing the full tablist key protocol.
    assert "tabIndex" not in page

    # Adding a default view must not replace any part of the lifecycle render.
    render = page[page.index("function render(state)"):
                  page.index("async function poll()")]
    for existing_affordance in (
            "renderRunline(state)", "renderProgress(state)",
            "renderBanner(state)", "renderNext(state)", "renderColhead()",
            "patchLanes(state)", "renderDag(state)"):
        assert existing_affordance in render


def test_overview_is_the_project_brief():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    overview = page[page.index("function renderOverview(state)"):
                    page.index("/* ═══ dependency DAG")]

    # The Overview is deliberately the high-level project brief ONLY. The other
    # three operational questions live on the Lifecycle (kanban) view now.
    assert "What is this project?" in page
    assert "What is this project?" in overview

    assert "state.project" in overview and "state.root" not in overview
    assert "depends_on" not in overview
    assert "ageDays(" not in overview and "Date(" not in overview
    assert not re.search(r"\b(?:wave|layer)\s*\d", overview, re.IGNORECASE)


def test_dependency_view_is_an_authored_read_only_dag():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    dag = page[page.index("function layoutDag("):
               page.index("function showBoardView(")]

    assert "Story dependency map" in page
    assert "Every arrow is authored roadmap data" in page
    assert 'role="region" aria-label="Interactive read-only story dependency map"' in page
    assert 'data-dag-reset' in page and 'data-dag-fit' in page
    assert 'data-dag-zoom="in"' in page
    assert 'data-dag-open hidden' in page
    assert 'id="dag-scene"' in page and 'class="dag-boot"' not in page
    assert "globeVectors" in dag and "dagGlobeEdgePath" in dag
    assert "playDagEntrance" in dag and 'classList.add("is-forming")' in dag
    assert "story.depends_on || []" in dag
    assert "layout.children.get(story.key)" in dag
    assert "dagPathSets" in dag and "ancestors" in dag and "descendants" in dag
    assert 'addEventListener("pointerenter"' in dag
    assert 'addEventListener("pointerleave"' in dag
    node_hover_handlers = dag[dag.index('node.addEventListener("pointerenter"'):
                              dag.index('node.addEventListener("focus"')]
    hover_state = dag[dag.index("function setDagHovered("):
                      dag.index("function renderDag(")]
    hover_style = page[page.index(".dag-node.is-hovered:not(.is-selected) {"):
                       page.index(".dag-node.is-hovered:not(.is-selected)::before")]
    hover_motion = page[page.index(".dag-node.is-hovered:not(.is-selected) {"):
                        page.index("@keyframes dag-guide-form")]
    signal_style = page[page.index(".dag-signal.is-upstream, .dag-signal.is-downstream {"):
                        page.index(".dag-shell.is-forming .dag-edge")]
    status_style = page[page.index(".dag-status {"):
                        page.index(".dag-status b")]
    mobile = page[page.index("@media (max-width: 620px)"):
                  page.index("@media (prefers-reduced-motion: reduce)")]
    mobile_status = mobile[mobile.index(".dag-status {"):
                           mobile.index(".dag-actions")]
    selection_state = dag[dag.index("function applyDagSelection("):
                          dag.index("function setDagHovered(")]
    node_dim_state = selection_state[
        selection_state.index('node.classList.toggle("is-dim"'):
        selection_state.index('node.setAttribute("aria-pressed"')]
    click_motion = dag[dag.index("function playDagSelection("):
                       dag.index("function selectDagNode(")]
    assert "setDagHovered(story.key)" in node_hover_handlers
    assert "setDagHovered(null, true)" in node_hover_handlers
    assert "if (defer)" in hover_state and "setTimeout(commit" in hover_state
    assert "transform: scale(" in hover_style and "translateY" not in hover_style
    assert "&& !selected" in node_dim_state
    assert ".dag-node-title" not in hover_motion
    assert 'pathNode.querySelector(".dag-node-title")' in click_motion
    assert "title.animate([" in click_motion
    assert "drop-shadow" not in signal_style and "filter:" not in signal_style
    assert "white-space: nowrap" in status_style
    assert "overflow: hidden" in status_style and "text-overflow: ellipsis" in status_style
    assert "min-height: 2.6em" in mobile_status
    assert "-webkit-line-clamp: 2" in mobile_status and "white-space: normal" in mobile_status
    assert 'addEventListener("focus"' in dag and 'addEventListener("blur"' in dag
    assert "playDagSelection" in dag
    assert "setPointerCapture" in dag and "rubberband" in dag and "springDagPan" in dag
    assert "retargetDagZoom" in dag and "stepDagZoom" in dag
    assert "requestAnimationFrame(stepDagZoom)" in dag
    assert "event.deltaMode" in dag and "{passive: false}" in dag
    assert "event.metaKey" not in dag and "event.ctrlKey" not in dag
    assert 'node.addEventListener("dblclick"' in dag
    assert 'if (DAG.mode !== "stories") return' in dag
    assert 'openDagTaskView(story.key' in dag
    assert 'node.addEventListener("keydown"' in dag
    assert 'event.key !== "Enter"' in dag
    assert 'openDagTaskView(story.key, false, node)' in dag
    assert 'node.matches(":focus-visible")' in dag
    assert 'focusDagStory(story.key, !REDUCE.matches, 220)' in dag
    assert "if (REDUCE.matches)" in dag[dag.index("function retargetDagZoom("):
                                              dag.index("function stepDagZoom(")]
    assert "fetch(" not in dag
    assert all(method not in page for method in (
        "do_POST", "do_PUT", "do_PATCH", "do_DELETE"))
    assert "prefers-reduced-motion: reduce" in page
    assert "dag-cue" not in page and "⌘" not in page

    node_template = dag[dag.index('node.innerHTML ='):
                        dag.index('node.setAttribute("aria-label"')]
    assert "dag-node-title" in node_template
    assert "dag-node-status" not in node_template and "dag-node-wave" in node_template
    assert 'kindLabel("STORY")' not in node_template
    assert "dag-node-key" not in node_template and "dag-node-meta" not in node_template
    assert '${kind} ${story.key}' in dag


def test_dependency_entry_projects_the_same_graph_as_a_quarter_turn_3d_globe():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    dag = page[page.index("function layoutDag("):
               page.index("function showBoardView(")]
    projection = dag[dag.index("function projectDagGlobePoint("):
                     dag.index("function dagGlobeEdgePoints(")]
    globe_frame = dag[dag.index("function renderDagGlobeFrame("):
                      dag.index("function playDagEntrance(")]
    entrance = dag[dag.index("function playDagEntrance("):
                   dag.index("function focusDagStory(")]

    # This is the authored story graph in a temporary spatial presentation,
    # not a separate decorative orbital loader. Every story starts from a 3D
    # sphere vector, and the frame renderer projects both its node and edges.
    assert "const DAG_GLOBE_ROTATION_RADIANS = Math.PI / 2;" in page
    assert "const DAG_GLOBE_ROTATION_RADIANS = Math.PI;" not in page
    assert "const DAG_GLOBE_SPEED = 3;" in page
    assert "const DAG_GLOBE_TOTAL_MS = (520 + 1480 + 920) / DAG_GLOBE_SPEED;" in page
    assert "DAG_GLOBE_ROTATE_START_MS = DAG_GLOBE_TOTAL_MS * .08" in page
    assert "DAG_GLOBE_UNFOLD_START_MS = DAG_GLOBE_TOTAL_MS * .62" in page
    assert "DAG_GLOBE_ROTATE_MS = DAG_GLOBE_TOTAL_MS * .68" in page
    assert "DAG_GLOBE_UNFOLD_MS = DAG_GLOBE_TOTAL_MS * .38" in page
    assert "projectDagGlobePoint" in dag and "dagSlerp" in dag
    assert "Math.cos" in projection and "Math.sin" in projection
    assert "perspective" in projection and "depth" in projection
    assert "turn * DAG_GLOBE_ROTATION_RADIANS" in projection
    assert "Math.PI * 2" not in projection and "DAG_GLOBE_TURNS" not in page
    assert "DAG.edges = layout.edges.map" in dag
    assert "layout.globeVectors" in globe_frame
    assert "DAG.nodes" in globe_frame and "DAG.edges" in globe_frame
    assert "projectDagGlobePoint" in globe_frame
    assert "dagGlobeEdgePoints" in globe_frame
    assert 'edge.globe.setAttribute("d"' in globe_frame
    assert "nodeUnfold" in globe_frame and "edgeUnfold" in globe_frame
    assert "dagGlobeEdgeVectors" in dag
    assert "edge.globeVectors || dagGlobeEdgeVectors(edge)" in dag
    assert "globeVectors = dagGlobeEdgeVectors(edge)" in dag
    assert "DAG_GLOBE_CURVE_STEPS" in dag and "dagCubicPath" in dag
    assert 'node.style.willChange = "transform, opacity"' not in globe_frame
    assert "node.style.filter" not in globe_frame
    assert "Math.round(point.depth * 8)" in globe_frame
    assert "(unfold - nodeDelay) / (1 - nodeDelay)" in globe_frame
    assert "(unfold - edgeDelay) / (1 - edgeDelay)" in globe_frame
    assert "var(--depth-duration" in page and "var(--edge-duration" in page
    assert 'base.style.setProperty("--edge-duration"' in dag

    # One bounded 0 → π/2 quarter-turn leads into a morph/unfold and the ordinary
    # dependency camera; re-entering the tab may replay that same sequence.
    assert "renderDagGlobeFrame" in entrance
    assert "const rotationProgress = clamp" in entrance
    assert "const rotation = dagEaseInOutCubic(rotationProgress)" in entrance
    assert "turn: rotation" in entrance and "unfold" in entrance
    assert "const total = DAG_GLOBE_TOTAL_MS" in entrance
    assert "elapsed - DAG_GLOBE_ROTATE_START_MS" in entrance
    assert "elapsed - DAG_GLOBE_UNFOLD_START_MS" in entrance
    assert "requestAnimationFrame" in entrance
    assert "landDagOnEntryTarget" in entrance
    assert "selectDagEntryTarget" in entrance
    assert "2π" not in entrance and "full revolution" not in entrance.lower()
    assert "half-turn" not in entrance.lower() and "0 → π Y-axis" not in entrance

    assert "dag-scene-orbit" not in page
    assert 'class="dag-boot"' not in page


def test_dependency_cards_use_full_surfaces_without_redundant_status_dots():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    shipped = page[page.index('.dag-node[data-state="shipped"] {'):
                   page.index('.dag-node[data-state="shipped"] .dag-node-title')]
    building = page[page.index('.dag-node[data-state="building"] {'):
                    page.index('.dag-node[data-state="building"] .dag-node-title')]
    ready = page[page.index('.dag-node[data-state="ready"] {'):
                 page.index('.dag-node[data-state="ready"] .dag-node-title')]
    selected = page[page.index(".dag-node.is-selected {"):
                    page.index(".dag-node.is-selected .dag-port")]

    # State belongs to the whole card, not only its status dot. Selection adds
    # an outline/scale while deliberately retaining that semantic fill.
    assert all(token in page for token in (
        "--done-surface:", "--active-surface:", "--ready-surface:"))
    assert "background: var(--done-surface)" in shipped
    assert "border-color: var(--shipped)" in shipped
    assert "background: var(--active-surface)" in building
    assert "border-color: var(--ready)" in building
    assert "background: var(--ready-surface)" in ready
    assert "border-color: var(--build)" in ready
    assert "dag-node-status" not in page
    assert "background" not in selected
    assert "border-color: var(--accent)" in selected


def test_dependency_entry_prefers_active_work_then_the_authoritative_frontier():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    preferred = page[page.index("function preferredDagStory("):
                     page.index("function dagTaskVisualState(")]
    render = page[page.index("function renderDag(state)"):
                  page.index("function dagTransform(")]
    landing = page[page.index("function landDagOnEntryTarget("):
                   page.index("function focusDagStory(")]
    entrance = page[page.index("function playDagEntrance("):
                    page.index("function focusDagStory(")]

    # The raw run pointer is accepted only when it resolves to genuinely
    # active, non-terminal work. Otherwise the server-derived frontier is the
    # authoritative unlocked-story fallback.
    assert "const runKey = run.issue_key || run.story" in preferred
    assert "const runStory = byKey.get(runKey)" in preferred
    assert 'runStory.status === "active"' in preferred
    assert 'runStory.state !== "shipped"' in preferred
    assert "!terminalPhases.has(run.phase)" in preferred
    assert "const unlocked = (state.frontier || []).find" in preferred
    assert "byKey.get(key)?.ready_to_plan" in preferred
    assert preferred.index("return runStory.key") < preferred.index(
        "const unlocked = (state.frontier || []).find")
    assert "DAG.entryTarget = preferredDagStory(state, roadmapStories)" in render

    # Both reduced-motion and animated entry land on and select that target,
    # rather than merely framing the root of the roadmap.
    assert "focusDagStory(DAG.entryTarget, animate, duration)" in landing
    assert "DAG.selected = DAG.entryTarget" in landing
    assert "applyDagSelection()" in landing
    assert "landDagOnEntryTarget(false)" in entrance
    assert "landDagOnEntryTarget(true, DAG_GLOBE_UNFOLD_MS)" in entrance
    assert entrance.count("selectDagEntryTarget()") == 2


def test_story_double_click_opens_a_task_graph_inside_the_same_read_only_shell():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    dag = page[page.index("/* ═══ dependency DAG"):
               page.index("function showBoardView(")]
    node_click = dag[dag.index('node.addEventListener("click"'):
                     dag.index("nodes.appendChild(node)")]
    open_tasks = dag[dag.index("function openDagTaskView("):
                     dag.index("function zoomDag(")]
    chrome = dag[dag.index("function setDagLevelChrome("):
                 dag.index("function setDagCameraDisabled(")]

    assert page.count('id="dag-shell"') == 1
    assert page.count('id="dag-viewport"') == 1
    assert page.count('id="dag-world"') == 1
    assert 'data-dag-back hidden' in page
    assert 'node.addEventListener("click"' in node_click
    assert 'selectDagNode(story.key' in node_click
    assert 'node.addEventListener("dblclick"' in node_click
    assert 'if (DAG.mode !== "stories") return' in node_click
    assert 'openDagTaskView(story.key' in node_click
    assert 'node.addEventListener("keydown"' in node_click
    assert 'event.key !== "Enter"' in node_click
    assert 'openDagTaskView(story.key, false, node)' in node_click
    assert node_click.index('selectDagNode(story.key') < node_click.index(
        'node.addEventListener("dblclick"')
    assert 'swapDagLevel("tasks", key, animate, originNode)' in open_tasks
    assert 'swapDagLevel("stories", null, animate)' in open_tasks
    assert 'const returningToStories = DAG.mode === "stories" && Boolean(DAG.returnView)' in dag
    assert 'DAG.mode === "stories" && !returningToStories' in dag
    assert 'document.querySelector("[data-dag-back]").hidden = !isTasks' in chrome
    assert 'DAG.mode === "tasks"' in chrome

    # In-panel graph navigation is local state only. It neither navigates the
    # browser nor introduces a mutating board request.
    assert "location.href" not in dag and "location.assign" not in dag
    assert "window.open" not in dag and "fetch(" not in dag
    assert all(f'method: "{method}"' not in dag
               for method in ("POST", "PUT", "PATCH", "DELETE"))


def test_task_dag_uses_forge_task_states_and_effective_dependencies():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    tasks = page[page.index("function dagTaskVisualState("):
                 page.index("function layoutDag(")]
    render = page[page.index("function renderDag(state)"):
                  page.index("function dagTransform(")]
    status = page[page.index("function updateDagStatus("):
                  page.index("function applyDagSelection(")]

    assert 'if (state === "done") return "shipped"' in tasks
    assert 'if (state === "active" || state === "await-merge") return "building"' in tasks
    assert "const tasks = story && story.tasks || []" in tasks
    assert "return tasks.map((task, index)" in tasks
    assert "state: dagTaskVisualState(task)" in tasks

    # Forge treats explicit non-empty dependencies as authoritative. An
    # omitted/empty list preserves decomposition order via the predecessor.
    assert "const explicit = tasks[index].dependencies" in tasks
    assert "Array.isArray(explicit) && explicit.length" in tasks
    assert "return index ? [tasks[index - 1].id] : []" in tasks
    assert "effectiveDagTaskDependencies(tasks, index)" in tasks
    assert ".filter(key => ids.has(key))" in tasks

    # Stories and tasks render through the same node factory, so the shipped
    # and building card fills above apply at both levels.
    assert 'DAG.mode === "tasks" ? taskDagItems(taskStory)' in render
    assert "node.dataset.state = story.state" in render
    assert 'node.dataset.kind = story.kind || "story"' in render
    assert 'const isTasks = DAG.mode === "tasks"' in status
    assert 'const noun = isTasks ? "task" : "story"' in status
    assert 'const dependencyWord = isTasks ? "effective" : "authored"' in status
    assert "do_PATCH" not in page


def test_epic_story_and_task_are_explicitly_labelled():
    page = (HARNESS / "factory" / "board" / "index.html").read_text()

    make_lane = page[page.index("function makeLane("):
                     page.index("function rollCount(")]
    make_card = page[page.index("function makeCard("):
                     page.index("function makeLane(")]
    task_block = page[page.index("function taskBlock("):
                      page.index("function findingList(")]
    proof_block = page[page.index("function proofBlock("):
                       page.index("const RAW_SOURCE")]

    assert 'kindLabel("EPIC")' in make_lane
    assert 'kindLabel("STORY")' in make_card
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
                       page.index("function tabBar(")]
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
    # The complete graph is captured up front; re-recording keeps completed
    # state while the already-declared future task remains pending.
    first = task_with_plan_contracts(DECOMP["tasks"][0])
    second = {"id": "T2", "title": "second", "objective": "more",
              "acceptance_criteria": ["works"]}
    record_skeleton_then_frontier(repo, [first, second])
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "stage baseline")
    code, out = record_task_grill(repo, first)
    assert code == 0, out
    code, out = record_task_grill(repo, DECOMP["tasks"][0])
    assert code == 0, out
    run(repo, "forge.py", "stage", "start", "T1")
    launch_fake(repo, tmp_path, "T1")
    write_in_scope(repo, "src/core.py")  # stage done measures the diff
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    rerecorded = {**DECOMP, "tasks": [first, second]}
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(rerecorded)
    )
    assert code == 0, out
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
    # Scoped to md()'s own body: other block renderers split lines too, and a
    # bare page.index() finds whichever of them appears first in the file.
    body = page[page.index("function md(src) {"):]
    strip = body.index("replace(/<!--[\\s\\S]*?-->/g")
    assert strip < body.index("split(/\\r?\\n/)")
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
    # base/key only steer the per-task plan lookup; with no saved plan on disk
    # the dossier still assembles (plan_state "none"), so coverage matching runs.
    dossiers = task_dossiers(HARNESS, "RETURN-1", detail)  # must not raise
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


def test_append_event_writes_new_file_no_shared_ledger(repo):
    attrs = (repo / ".gitattributes").read_text()
    ledger = repo / ".factory" / "events.jsonl"
    event_dir = repo / ".factory" / "events"
    before_event_files = set(event_dir.glob("*.json"))
    ledger.parent.mkdir(exist_ok=True)
    ledger.write_text('{"event": "legacy"}\n')
    before = ledger.read_bytes()

    code, out = run(repo, "forge.py", "pr-link", "ENG-1", "acme/widgets#42")
    assert code == 0, out

    event_files = [
        path for path in event_dir.glob("*.json") if path not in before_event_files
    ]
    assert len(event_files) == 1
    written = json.loads(event_files[0].read_text())
    assert written["event"] == "pr-linked"
    assert written["story"] == "ENG-1"
    assert ledger.read_bytes() == before
    assert ".factory/*.jsonl merge=union" not in attrs
    assert ".factory/signals.jsonl merge=union" in attrs


def test_history_merges_legacy_and_per_file_events(repo):
    ledger = repo / ".factory" / "events.jsonl"
    ledger.parent.mkdir(exist_ok=True)
    ledger.write_text(
        '{"event": "intake", "at": "2026-07-01T09:00:00+00:00", '
        '"story": "ENG-1", "detail": "legacy event"}\n'
        "torn legacy line\n"
    )
    event_dir = repo / ".factory" / "events"
    event_dir.mkdir()
    (event_dir / "one.json").write_text(json.dumps({
        "event": "stage-done", "at": "2026-07-02T10:00:00+00:00",
        "story": "ENG-1", "detail": "per-file event",
    }))

    code, out = run(repo, "forge.py", "history", "--story", "ENG-1")
    assert code == 0, out
    assert "legacy event" in out
    assert "per-file event" in out
    assert out.index("legacy event") < out.index("per-file event")


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
    linked = load_events(repo)[-1]
    assert linked["event"] == "pr-linked"
    assert linked["story"] == "ENG-1"
    assert linked["detail"] == reference

    git(repo, "add", "-f", ".factory/events")
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
    assert code == 0 and len(out.splitlines()) == 2 and "S-0001" in out and "PAUSE" in out
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
    assert code == 0 and out.splitlines() == [f"Signal {sig_id} resolved"]
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    # channel archived with the task, working copy cleaned
    assert (repo / ".factory" / "signals.jsonl").exists()


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
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
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
    assert "deny" in out and "forge delegate" in out
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
    run(repo, "forge.py", "roadmap", "link-spec", "G-1", "--spec", "docs/specs/base.md")
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


def mint_review_run(repo: Path) -> dict:
    code, out = run(repo, "forge.py", "review-brief", "--all", "--repo", str(repo))
    assert code == 0, out
    key = run_state(repo)["issue_key"]
    return json.loads((story_state(repo, key) / "review-run.json").read_text())


def record_stage_local(repo: Path, **over) -> tuple[int, str]:
    return run(
        repo, "record_review_from_json.py", "--aspect", "stage-local",
        stdin=json.dumps(review_payload(**over)),
    )


def stamp_and_commit(repo: Path, *paths: str) -> None:
    if not paths:
        from forge_cli.stages import WORKFLOW_PATHS, dirty_paths
        paths = tuple(
            path for path in dirty_paths(repo)
            if not path.startswith(WORKFLOW_PATHS)
        )
    if paths:
        git(repo, "add", *paths)
    code, out = record_stage_local(repo)
    assert code == 0, out
    if subprocess.run(
            ["git", "diff", "--cached", "--quiet"], cwd=repo).returncode:
        git(repo, "commit", "-qm", "reviewed stage work")


def test_structured_findings_recorded_and_malformed_refused(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    mint_review_run(repo)
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
    recorded = json.loads((
        repo / ".factory" / "stories" / "ENG-1" / "reviews" / "quality.json"
    ).read_text())
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
    t1 = task_with_plan_contracts({
        **STAGE_TASK, "id": "T1", "title": "api",
        "write_scope": ["src/api/"], "objective": "Serve invoices over the api.",
        "acceptance_criteria": ["200 ok"],
    }, "T1-C")
    decomp = {**DECOMP, "tasks": [
        t1,
        {"id": "T2", "title": "ui", "objective": "Render the invoice list.",
         "acceptance_criteria": ["rows show"]},
    ]}
    record_skeleton_then_frontier(repo, decomp["tasks"])
    # Order is strict inside one story worktree.
    code, out = run(repo, "forge.py", "stage", "start", "T2")
    assert code != 0 and "T1" in out
    code, out = run(repo, "forge.py", "stage", "start", "T2", "--parallel")
    assert code != 0 and "task stages are sequential" in out
    # done requires the stage to have actually started
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "not active" in out
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "stage baseline")
    code, out = record_task_grill(repo, t1)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    launch_fake(repo, tmp_path, "T1")
    write_in_scope(repo, "src/api/invoices.py")
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    decomp["tasks"][1] = task_with_plan_contracts({
        **STAGE_TASK,
        "id": "T2",
        "title": "ui",
        "write_scope": ["src/ui/"],
        "objective": "Render the invoice list.",
        "acceptance_criteria": ["rows show"],
    }, "T2-C")
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(decomp)
    )
    assert code == 0, out
    # pr_ready refuses while a stage is open
    stages_before_artifacts = json.loads(
        (repo / ".factory" / "stages.json").read_text())
    write_passing_artifacts(repo)
    quality_path = story_state(repo) / "reviews" / "quality.json"
    quality = json.loads(quality_path.read_text())
    quality["contract_verdicts"] = [
        {
            "contract_id": contract_id,
            "verdict": "implemented",
            "evidence": "focused stage proof",
        }
        for contract_id in ("T1-C1", "T2-C1")
    ]
    quality_path.write_text(json.dumps(quality))
    # write_passing_artifacts stamps the single-task DECOMP; T2's contract has
    # to survive, or stage done has nothing to measure it against
    (story_state(repo) / "decomposition.json").write_text(
        json.dumps({**decomp, "commit": head(repo)}))
    (repo / ".factory" / "stages.json").write_text(json.dumps(stages_before_artifacts))
    (delegation_ledger(repo).parent / "stages.json").write_text(
        json.dumps(stages_before_artifacts))
    run(repo, "update_run.py", "--decomposition-status", "recorded")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "stage completion" in out and "T2" in out
    # The next task starts only after its predecessor is done.
    code, out = record_task_grill(repo, decomp["tasks"][1])
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T2")
    assert code == 0, out
    launch_fake(repo, tmp_path, "T2")
    write_in_scope(repo, "src/ui/list.py")
    stamp_and_commit(repo, "src/ui/list.py")
    code, out = run(repo, "forge.py", "stage", "done", "T2")
    assert code == 0, out
    # re-stamp the closeout evidence at the final HEAD (verify/reviews/outcome)
    write_passing_artifacts(repo, commit=head(repo))
    quality_path = story_state(repo) / "reviews" / "quality.json"
    quality = json.loads(quality_path.read_text())
    quality["contract_verdicts"] = [
        {"contract_id": cid, "verdict": "implemented", "evidence": "focused stage proof"}
        for cid in ("T1-C1", "T2-C1")
    ]
    quality_path.write_text(json.dumps(quality))
    both_done = {"issue": run_state(repo).get("issue_key", ""),
                 "stages": [{"id": "T1", "title": "api", "status": "done"},
                            {"id": "T2", "title": "ui", "status": "done"}]}
    (story_state(repo) / "stages.json").write_text(json.dumps(both_done))
    (delegation_ledger(repo).parent / "stages.json").write_text(json.dumps(both_done))
    (story_state(repo) / "decomposition.json").write_text(
        json.dumps({**decomp, "commit": head(repo)}))
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out
    assert (repo / ".factory" / "stages.json").exists()


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
    return {"HOME": str(fake_companion_home(tmp_path))}


def _fake_psutil_module(tmp_path: Path) -> Path:
    """Provide the minimal process-discovery contract for CLI fixture runs."""
    module = tmp_path / "psutil.py"
    module.write_text(
        "class Error(Exception): pass\n"
        "class AccessDenied(Exception): pass\n"
        "class NoSuchProcess(Exception): pass\n"
        "STATUS_ZOMBIE = 'zombie'\n"
        "class Process:\n"
        "    def __init__(self, _pid=None): pass\n"
        "    def create_time(self): return 1.0\n"
        "    def children(self, recursive=False): return []\n"
        "    def username(self): return 'fixture-user'\n"
        "    def is_running(self): return False\n"
        "    def status(self): return STATUS_ZOMBIE\n"
        "def process_iter(_attrs=None): return iter(())\n"
    )
    return tmp_path


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


def task_skeleton(task: dict) -> dict:
    fields = ("id", "title", "objective", "acceptance_criteria", "dependencies")
    return {field: task[field] for field in fields if field in task}


def task_with_plan_contracts(task: dict, prefix: str = "C") -> dict:
    return {
        **task,
        "plan_contracts": [
            {
                "id": f"{prefix}{index}",
                "statement": criterion,
                "source": "plans/active/TEST-1-test-plan.md#acceptance-criteria",
            }
            for index, criterion in enumerate(task["acceptance_criteria"], 1)
        ],
    }


def record_skeleton_then_frontier(repo: Path, tasks: list[dict]) -> None:
    skeletons = [task_skeleton(task) for task in tasks]
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": skeletons}),
    )
    assert code == 0, out
    if tasks != skeletons:
        code, out = run(
            repo, "record_decomposition_from_json.py",
            stdin=json.dumps({**DECOMP, "tasks": tasks}),
        )
        assert code == 0, out


def seed_task_start_inputs(
    repo: Path, key: str, tasks: list[dict], target_id: str,
) -> dict:
    state = run_state(repo)
    plan_file = state["plan_file"]
    plan = repo / plan_file
    decomposition = {
        "plan_file": plan_file,
        "plan_sha256": plan_digest_without_assumptions(plan),
        "tasks": tasks,
    }
    control = delegation_ledger(repo).parent
    control.mkdir(parents=True, exist_ok=True)
    (control / "decomposition.json").write_text(json.dumps(decomposition))
    scoped = story_state(repo, key)
    scoped.mkdir(parents=True, exist_ok=True)
    (scoped / "decomposition.json").write_text(json.dumps(decomposition))
    grill = scoped / "grills" / "tasks" / f"{target_id}.json"
    grill.parent.mkdir(parents=True, exist_ok=True)
    grill.write_text(json.dumps({"verdict": "pass", "approved_by": "Test Human"}))
    task_plan = scoped / "task-plans" / f"{target_id}.md"
    task_plan.parent.mkdir(parents=True, exist_ok=True)
    task_plan.write_text(f"# Task plan — {target_id}\n", encoding="utf-8")
    return {
        "plan": plan,
        "decomposition": scoped / "decomposition.json",
        "grill": grill,
        "task_plan": task_plan,
    }


def fake_gh_env(tmp_path: Path) -> tuple[dict[str, str], Path]:
    bin_dir = tmp_path / "fake-gh-bin"
    bin_dir.mkdir()
    argv_path = tmp_path / "gh-argv.txt"
    executable = bin_dir / "gh"
    executable.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GH_ARGV_FILE\"\n"
        "printf '%s\\n' 'https://example.test/pr/1'\n"
    )
    executable.chmod(0o755)
    return {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
        "GH_ARGV_FILE": str(argv_path),
    }, argv_path


def configure_origin_main(repo: Path, remote: Path) -> None:
    proc = subprocess.run(["git", "init", "--bare", str(remote)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    if "origin" not in git(repo, "remote").split():
        git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "origin", f"{head(repo)}:refs/heads/main")


def publish_task_marker(repo: Path, key: str, task_id: str) -> Path:
    marker = story_state(repo, key) / "tasks" / task_id / "pr-ready.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{}\n")
    git(repo, "add", marker.relative_to(repo).as_posix())
    git(repo, "commit", "-q", "-m", f"mark {task_id} ready")
    git(repo, "push", "-q", "origin", "HEAD:main")
    return marker


def prepare_task_pr_ready(repo: Path, tmp_path: Path) -> Path:
    # forge task pr-ready commits the marker with clean_git_env (no inline
    # identity), so the repo needs a local git identity on identity-less runners.
    git(repo, "config", "user.email", "test@knacklabs.dev")
    git(repo, "config", "user.name", "Gate Tests")
    remote = tmp_path / "pr-origin.git"
    if not remote.exists():
        proc = subprocess.run(["git", "init", "--bare", str(remote)],
                              capture_output=True, text=True)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        if "origin" not in git(repo, "remote").split():
            git(repo, "remote", "add", "origin", str(remote))
        # publish the existing origin/main sha to the bare remote WITHOUT moving
        # the local tracking ref, so base_main_sha stays stable while pushes work
        main_sha = git(repo, "rev-parse", "origin/main")
        git(repo, "push", "-q", str(remote), f"{main_sha}:refs/heads/main")
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out
    control = delegation_ledger(repo).parent
    stage = json.loads((control / "stages.json").read_text())["stages"][0]
    brief = repo / ".factory" / "briefs" / "T1.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_bytes((repo / ".factory" / "diagnostic-briefs" / "T1.md").read_bytes())
    companion = "/tmp/test-companion.mjs"
    argv = [
        shutil.which("node") or "node", companion, "task", "--json", "--cwd",
        str(repo), "--model", "gpt-test", "--effort", "medium",
        "--prompt-file", ".factory/briefs/T1.md", "--write",
    ]
    launch = {
        "launch_id": "task-pr-ready-test", "task": "T1", "write": True,
        "brief_sha256": hashlib.sha256(brief.read_bytes()).hexdigest(),
        "task_sha256": task_digest(STAGE_TASK), "model": "gpt-test",
        "effort": "medium", "companion_path": companion, "argv": argv,
        "argv_sha256": hashlib.sha256(json.dumps(
            argv, separators=(",", ":")).encode()).hexdigest(),
        "stage_started_at": stage["started_at"], "process_token": "test-process",
    }
    delegation_ledger(repo).write_text("\n".join(json.dumps({
        **launch, "launch_status": status,
        **({"exit_code": 0} if status == "succeeded" else {}),
    }) for status in ("starting", "running", "succeeded")) + "\n")
    pointer = json.loads((control / "run.json").read_text())
    pointer.update({
        "task_id": "T1",
        "branch": git(repo, "symbolic-ref", "--short", "HEAD"),
        "base_main_sha": git(repo, "rev-parse", "origin/main"),
    })
    (control / "run.json").write_text(json.dumps(pointer))
    return story_state(repo) / "tasks" / "T1" / "pr-ready.json"


def finish_task_for_pr_ready(repo: Path) -> None:
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    code, out = record_stage_local(repo)
    assert code == 0, out
    git(repo, "commit", "-qm", "seal task work")
    data = json.loads((delegation_ledger(repo).parent / "stages.json").read_text())
    data["stages"][0]["status"] = "done"
    write_stages(repo, data)


def test_task_start_creates_worktree_off_main_and_gates_on_predecessor_marker(
    repo, tmp_path,
):
    remote = tmp_path / "origin.git"
    proc = subprocess.run(["git", "init", "--bare", str(remote)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "origin", f"{head(repo)}:refs/heads/main")

    key = "ENG-1"
    sign_off(repo)
    code, out = intake(repo, key)
    assert code == 0, out
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    first = {**DECOMP["tasks"][0], "id": "T1", "title": "first"}
    second = {**DECOMP["tasks"][0], "id": "T2", "title": "second"}

    seed_task_start_inputs(repo, key, [first], "T1")
    code, out = run(repo, "forge.py", "task", "start", "T1")
    assert code == 0, out
    first_worktree = repo.parent / f"{repo.name}-{key}-T1"
    assert git(first_worktree, "symbolic-ref", "--short", "HEAD") == "feat/ENG-1-T1"

    sources = seed_task_start_inputs(repo, key, [first, second], "T2")
    second_worktree = repo.parent / f"{repo.name}-{key}-T2"
    code, out = run(repo, "forge.py", "task", "start", "T2")
    assert code != 0 and "predecessor T1 marker is absent" in out, out
    assert not second_worktree.exists()

    marker = repo / ".factory" / "stories" / key / "tasks" / "T1" / "pr-ready.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{}\n")
    git(repo, "add", str(marker.relative_to(repo)))
    git(repo, "commit", "-q", "-m", "mark T1 ready")
    git(repo, "push", "-q", "origin", "HEAD:main")
    expected_base = git(repo, "rev-parse", "origin/main")

    code, out = run(repo, "forge.py", "task", "start", "T2")
    assert code == 0, out
    assert head(second_worktree) == expected_base
    assert git(second_worktree, "symbolic-ref", "--short", "HEAD") == "feat/ENG-1-T2"
    destinations = {
        "plan": second_worktree / sources["plan"].relative_to(repo),
        "decomposition": story_state(second_worktree, key) / "decomposition.json",
        "grill": story_state(second_worktree, key) / "grills/tasks/T2.json",
        "task_plan": story_state(second_worktree, key) / "task-plans/T2.md",
    }
    assert all(destinations[name].read_bytes() == source.read_bytes()
               for name, source in sources.items())
    control = Path(git(second_worktree, "rev-parse", "--absolute-git-dir")) / "forge"
    pointer = json.loads((control / "run.json").read_text())
    assert pointer | {"issue_key": key, "task_id": "T2",
                      "branch": "feat/ENG-1-T2", "base_main_sha": expected_base} == pointer
    assert (control / "decomposition.json").read_bytes() == sources["decomposition"].read_bytes()
    assert [stage["status"] for stage in json.loads(
        (control / "stages.json").read_text())["stages"]] == ["done", "pending"]
    code, out = run(repo, "forge.py", "task", "start", "T2")
    assert code != 0 and "task branch already exists" in out, out


def test_task_frontier_awaits_marker_on_main_between_tasks(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    second = task_skeleton({**STAGE_TASK, "id": "T2", "title": "second slice"})
    record_skeleton_then_frontier(repo, [STAGE_TASK, second])
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "core slice", "status": "done"},
            {"id": "T2", "title": "second slice", "status": "pending"},
        ],
    })
    configure_origin_main(repo, tmp_path / "frontier-origin.git")
    control = delegation_ledger(repo).parent
    pointer = json.loads((control / "run.json").read_text())
    pointer["base_main_sha"] = git(repo, "rev-parse", "origin/main")
    (control / "run.json").write_text(json.dumps(pointer))

    assert task_frontier_state(repo)[0:1] == ("await-merge",)
    assert task_rows(repo)[0]["state"] == "await-merge"
    code, out = run(repo, "forge.py", "next")
    actions = [line for line in out.splitlines() if ". [dev]" in line]
    assert code == 0 and len(actions) == 1, out
    assert "T1" in actions[0] and "pr-ready" in actions[0]
    assert "T2" not in actions[0]

    publish_task_marker(repo, "ENG-1", "T1")
    frontier = task_frontier_state(repo)
    assert frontier and frontier[0] == "author-contract" and frontier[1]["id"] == "T2"
    assert task_rows(repo)[0]["state"] == "done"
    code, out = run(repo, "forge.py", "next")
    actions = [line for line in out.splitlines() if ". [dev]" in line]
    assert code == 0 and len(actions) == 1, out
    assert "T2" in actions[0] and "T1" not in actions[0]


def test_story_level_frontier_surfaces_per_task_pr(repo, tmp_path):
    # Per-task PRs are the symphony standard in BOTH run-pointer modes. A
    # STORY-level run (no base_main_sha, tasks running as stages in the story
    # worktree) must still surface the per-task PR for a stage-done task whose
    # completion marker is not yet on the trunk — it must NOT skip ahead to the
    # next task (WORKFLOW.md Stage Loop). This replaces the earlier
    # "frontier_unchanged" test, which asserted the old skip-past-done behavior.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    second = task_skeleton({**STAGE_TASK, "id": "T2", "title": "second slice"})
    record_skeleton_then_frontier(repo, [STAGE_TASK, second])
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "core slice", "status": "done"},
            {"id": "T2", "title": "second slice", "status": "pending"},
        ],
    })
    configure_origin_main(repo, tmp_path / "story-frontier-origin.git")

    # Story-level pointer: `forge task start` never ran, so no base_main_sha.
    control = delegation_ledger(repo).parent
    pointer = json.loads((control / "run.json").read_text())
    assert "base_main_sha" not in pointer

    frontier = task_frontier_state(repo)
    assert frontier and frontier[0] == "await-merge" and frontier[1]["id"] == "T1"
    assert task_rows(repo)[0]["state"] == "await-merge"
    code, out = run(repo, "forge.py", "next")
    actions = [line for line in out.splitlines() if ". [dev]" in line]
    assert code == 0 and len(actions) == 1, out
    assert "T1" in actions[0] and "T2" not in actions[0]

    # Once T1's marker lands on the trunk, the frontier advances to T2.
    publish_task_marker(repo, "ENG-1", "T1")
    frontier = task_frontier_state(repo)
    assert frontier and frontier[0] == "author-contract" and frontier[1]["id"] == "T2"


def test_task_pr_ready_refuses_unsealed_then_writes_marker_and_opens_pr(
    repo, tmp_path,
):
    marker = prepare_task_pr_ready(repo, tmp_path)
    gh_env, argv_path = fake_gh_env(tmp_path)

    code, out = run(repo, "forge.py", "task", "pr-ready", "T1", env=gh_env)
    assert code != 0 and "stage status must be done" in out, out
    assert not marker.exists() and not argv_path.exists()

    finish_task_for_pr_ready(repo)
    expected_head = head(repo)
    code, out = run(repo, "forge.py", "task", "pr-ready", "T1", env=gh_env)
    assert code == 0, out
    payload = json.loads(marker.read_text())
    pointer = json.loads(
        (delegation_ledger(repo).parent / "run.json").read_text()
    )
    assert payload == {
        "task_id": "T1",
        "branch": git(repo, "symbolic-ref", "--short", "HEAD"),
        "base_main_sha": pointer["base_main_sha"],
        "commit": expected_head,
        "sealed_at": payload["sealed_at"],
    }
    # the marker rides an evidence commit that is pushed to origin (AC2)
    assert head(repo) != expected_head  # a marker commit was made on top of the seal
    assert marker.relative_to(repo).as_posix() in git(
        repo, "show", "--name-only", "--format=", "HEAD"
    )
    assert git(repo, "cat-file", "-e", f"origin/{git(repo, 'symbolic-ref', '--short', 'HEAD')}:{marker.relative_to(repo).as_posix()}") == ""
    argv = argv_path.read_text().splitlines()
    # The task PR targets origin's DEFAULT branch (here main) and names an
    # explicit --head so gh never guesses the source branch from local tracking.
    assert argv[:6] == [
        "pr", "create", "--base", "main",
        "--head", git(repo, "symbolic-ref", "--short", "HEAD"),
    ]
    assert "--title" in argv and "ENG-1 T1: core slice" in argv
    assert "--body" in argv
    assert marker.relative_to(repo).as_posix() in argv_path.read_text()


def test_task_pr_ready_does_not_flip_roadmap_or_write_outcome(repo, tmp_path):
    marker = prepare_task_pr_ready(repo, tmp_path)
    finish_task_for_pr_ready(repo)
    gh_env, _ = fake_gh_env(tmp_path)
    roadmap = repo / "plans" / "roadmap.json"
    before = roadmap.read_bytes()

    code, out = run(repo, "forge.py", "task", "pr-ready", "T1", env=gh_env)

    assert code == 0, out
    assert marker.is_file() and roadmap.read_bytes() == before
    assert roadmap_items(repo)["ENG-1"]["status"] == "active"
    for path in (
        story_state(repo) / "outcome.json",
        story_state(repo) / "shipped.json",
        repo / ".factory" / "outcome.json",
        repo / ".factory" / "shipped.json",
    ):
        assert not path.exists()


def test_task_reconcile_adopts_out_of_band_merge_without_a_pr(repo, tmp_path):
    # A task can ship OUTSIDE the per-task pr-ready flow (a story-level PR, a
    # direct PR). Then no completion marker is on the trunk and the frontier is
    # stuck at "await-merge" forever. `forge task reconcile` adopts that
    # already-merged task: it verifies the work is on the trunk, writes the
    # marker, flips the stage done, opens NO PR, and the frontier advances.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    git(repo, "config", "user.email", "test@knacklabs.dev")
    git(repo, "config", "user.name", "Gate Tests")
    second = task_skeleton({**STAGE_TASK, "id": "T2", "title": "second slice"})
    record_skeleton_then_frontier(repo, [STAGE_TASK, second])
    # T1's work shipped but its stage was never sealed: mark it active, T2 pending.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "core slice", "status": "active",
             "base_sha": head(repo)},
            {"id": "T2", "title": "second slice", "status": "pending"},
        ],
    })
    # The task's work is genuinely on the trunk: src/ is pushed to origin/main.
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "ship T1 work via a story PR")
    configure_origin_main(repo, tmp_path / "reconcile-origin.git")

    marker = story_state(repo) / "tasks" / "T1" / "pr-ready.json"
    gh_env, argv_path = fake_gh_env(tmp_path)
    assert not marker.exists()

    code, out = run(repo, "forge.py", "task", "reconcile", "T1", env=gh_env)
    assert code == 0, out
    # The five-field marker is written and NO PR was opened.
    payload = json.loads(marker.read_text())
    assert set(payload) == {
        "task_id", "branch", "base_main_sha", "commit", "sealed_at", "reconciled"}
    assert payload["task_id"] == "T1" and payload["branch"] == "feat/ENG-1-T1"
    # Adopted, not sealed: the PR proof gate exempts already-shipped work.
    assert payload["reconciled"] is True
    assert not argv_path.exists()
    # The stage flipped to done, and the marker rides an evidence commit.
    data = json.loads((delegation_ledger(repo).parent / "stages.json").read_text())
    assert data["stages"][0]["status"] == "done"
    assert marker.relative_to(repo).as_posix() in git(
        repo, "show", "--name-only", "--format=", "HEAD")
    # Push the reconcile commit so the marker lands on the trunk; the frontier
    # then advances to T2 and the row reads done.
    git(repo, "push", "-q", "origin", "HEAD:main")
    frontier = task_frontier_state(repo)
    assert frontier and frontier[1]["id"] == "T2"
    assert task_rows(repo)[0]["state"] == "done"


def test_task_reconcile_refuses_when_work_is_not_on_the_trunk(repo, tmp_path):
    # Reconcile must never fabricate a ship: if the task's write_scope is not on
    # the trunk, it refuses and writes no marker.
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    git(repo, "config", "user.email", "test@knacklabs.dev")
    git(repo, "config", "user.name", "Gate Tests")
    second = task_skeleton({**STAGE_TASK, "id": "T2", "title": "second slice"})
    record_skeleton_then_frontier(repo, [STAGE_TASK, second])
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "core slice", "status": "active"},
            {"id": "T2", "title": "second slice", "status": "pending"},
        ],
    })
    # origin/main carries no src/ content — the task's work never shipped.
    configure_origin_main(repo, tmp_path / "reconcile-origin-empty.git")
    marker = story_state(repo) / "tasks" / "T1" / "pr-ready.json"

    code, out = run(repo, "forge.py", "task", "reconcile", "T1")
    assert code != 0 and "does not look shipped" in out
    assert not marker.exists()


def test_board_renders_a_workflow_diagram_as_structure_not_source(repo):
    # A ```mermaid block is the part of a plan a reader most needs and, shown
    # as a code block, least can read. Rendering the structure costs nothing;
    # a real layout engine would cost a megabyte of vendored JavaScript in
    # every client repo, for a picture.
    page = (HARNESS / "factory" / "board" / "index.html").read_text(
        encoding="utf-8")

    assert "function mermaidOutline(" in page
    # md() escapes the document before any block renderer sees it, so the
    # arrows arrive as entities and a naive split finds nothing.
    assert "function mermaidDecode(" in page
    assert "&lt;" in page and "&amp;" in page
    # Diagram fences must be intercepted BEFORE the generic code-fence path.
    fence = page.index("if (/^```/.test(line)) {")
    assert "mermaid" in page[fence:fence + 700]
    # Anything unrecognised must fall through to the code block, never vanish.
    assert "if (outline) {" in page


def test_board_separates_never_grilled_from_grilled_then_edited(repo, tmp_path):
    # One "grilling" label covered two different problems. Only the second
    # matters to a human who already reviewed the plan: the text has moved
    # since they read it.
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.board import task_plan_view  # noqa: E402

    lib = load_factory_lib(repo)
    key = "ENG-1"
    task = {"id": "T1"}
    plan = lib.evidence_path(repo, key, "task-plans/T1.md", for_write=True)
    plan.parent.mkdir(parents=True, exist_ok=True)

    # No plan at all.
    assert task_plan_view(repo, key, task, None)["plan_state"] == "none"

    plan.write_text("# T1\n\nDo the thing.\n", encoding="utf-8")
    # Saved, never survived a grill.
    assert task_plan_view(repo, key, task, None)["plan_state"] == "ungrilled"
    assert task_plan_view(
        repo, key, task, {"verdict": "fail"})["plan_state"] == "ungrilled"

    digest = lib.plan_digest_without_assumptions(plan)
    passing = {"verdict": "pass", "task_plan_sha256": digest}
    assert task_plan_view(repo, key, task, passing)["plan_state"] == "clean"

    # It passed, and then the text changed underneath the record.
    plan.write_text("# T1\n\nDo the thing, differently.\n", encoding="utf-8")
    assert task_plan_view(repo, key, task, passing)["plan_state"] == "stale"


def test_state_audit_reports_a_stage_split_between_working_copies(repo, tmp_path):
    # The harness gates TRANSITIONS and never re-validates STATE, so a record
    # that stopped being true is invisible. This is the split that made a
    # passing grill unverifiable and took hours to trace by hand.
    lib = load_factory_lib(repo)
    worktree = tmp_path / "repo-T1"
    git(repo, "worktree", "add", "-q", "-b", "feat/S-T1", str(worktree))

    def control(root):
        return Path(git(root, "rev-parse", "--absolute-git-dir")) / "forge"

    for root, status in ((repo, "active"), (worktree, "done")):
        target = control(root)
        target.mkdir(parents=True, exist_ok=True)
        lib.dump_json(target / "stages.json", {"issue": "ENG-1", "stages": [
            {"id": "T1", "title": "t", "status": status}]})

    code, out = run(repo, "forge.py", "audit", "--state")
    assert code != 0, out
    assert "differs between working copies" in out
    assert "active" in out and "done" in out
    # It must say which copy wins, not merely that they disagree.
    assert "authoritative" in out


def test_state_audit_is_read_only_and_clean_when_nothing_disagrees(repo):
    # No decomposition, no stages, nothing recorded: nothing to contradict.
    before = git(repo, "status", "--porcelain")
    code, out = run(repo, "forge.py", "audit", "--state")
    assert code == 0, out
    assert "re-derives" in out
    # Reporting must never repair -- a repair is the same unchecked assertion
    # that makes records untrustworthy in the first place.
    assert git(repo, "status", "--porcelain") == before


def test_incomplete_is_refused_when_the_proof_says_the_work_is_done(
        repo, tmp_path):
    # `--incomplete` is the only escape from a refusing seal, so it is the
    # tempting move for work that IS finished -- and then the frontier and the
    # PR gate read a completed task as unfinished. The recorded proof already
    # answers the question.
    task = task_with_plan_contracts({**DECOMP["tasks"][0], "user_facing": False})
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [task])
    record_task_grill(repo, task)
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out

    lib = load_factory_lib(repo)
    key = "ENG-1"
    lib.dump_json(lib.evidence_path(repo, key, "verify.json", for_write=True),
                  {"generated_by": "t", "ok": True})
    lib.dump_json(lib.evidence_path(repo, key, "tests.json", for_write=True),
                  {"automated": {"generated_by": "t", "passed": True,
                                 "tests_added_or_updated": ["t1"]}})
    for aspect in ("quality", "performance", "security"):
        lib.dump_json(
            lib.evidence_path(repo, key, f"reviews/{aspect}.json",
                              for_write=True),
            # review_passed also requires a score >= MIN_SCORE: a lens nobody
            # rated is not evidence the lens was clean.
            {"generated_by": "t", "aspect": aspect, "verdict": "pass",
             "score": 9, "blocking_findings": [], "non_blocking_findings": []})

    code, out = run(repo, "forge.py", "stage", "done", "T1",
                    "--incomplete", "cannot seal, gate refuses")
    assert code != 0, out
    assert "WORK REMAINS" in out
    assert "audit --state" in out  # it names the tool that finds the real cause


def test_scope_amendment_breaks_the_seal_deadlock_without_touching_the_contract(
        repo, tmp_path):
    # `stage done` measures the diff, finds an under-declared path, and tells
    # the operator to re-record the decomposition. Doing that changes the
    # contract digest -- which invalidates the delegate launch `stage done`
    # matches on and stales the grill ground on it. The same command then
    # demands a fresh Codex run for a correction it demanded itself, and any
    # further correction restarts the loop. There is no flag out of it.
    lib = load_factory_lib(repo)
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    from forge_cli.stages import (  # noqa: E402
        amended_scope_paths, effective_scope, out_of_scope,
        scope_amendments_path,
    )

    task = {
        "id": "T3",
        "write_scope": ["src/api"],
        "required_tests": [{"id": "t1", "path": "t/a.spec.ts", "command": "x"}],
        "verify_commands": ["pnpm verify"],
        "acceptance_criteria": ["it works"],
    }
    before = lib.task_digest(task)
    # What the refusal used to instruct: widen the scope in the contract.
    corrected = {**task, "write_scope": ["src/api", "src/db"]}
    assert lib.task_digest(corrected) != before, (
        "expected a contract correction to break the launch binding")

    # The amendment records the same measured truth ALONGSIDE the contract.
    lib.dump_json(scope_amendments_path(repo), {"tasks": {"T3": {
        "added_paths": ["src/db"],
        "amendments": [{"reason": "measured", "added_paths": ["src/db"]}],
    }}})
    assert amended_scope_paths(repo, "T3") == ["src/db"]
    effective = effective_scope(repo, "T3", task["write_scope"])
    assert effective == ["src/api", "src/db"]

    # The contract is untouched, so both bindings still hold.
    assert lib.task_digest(task) == before

    # And the boundary still bites: only MEASURED paths were added.
    assert out_of_scope(repo, ["src/api/x.ts", "src/db/y.ts"], effective) == []
    assert out_of_scope(repo, ["src/secret/k.ts"], effective) == ["src/secret/k.ts"]


def test_amend_scope_refuses_a_reason_that_says_nothing(repo):
    # The measurement supplies the paths; the reason is the only part a human
    # has to supply, so an empty one makes the record worthless.
    code, out = run(repo, "forge.py", "stage", "amend-scope", "T1",
                    "--reason", "oops")
    assert code != 0
    assert "--reason" in out


def test_stage_done_scope_refusal_names_amend_scope_not_a_rerecord(repo):
    # The old refusal instructed the one action that deadlocks the close.
    source = (HARNESS / "factory" / "scripts" / "forge_cli" / "stages.py"
              ).read_text(encoding="utf-8")
    refusal = source[source.index("changed {len(strays)} path(s) outside"):]
    refusal = refusal[:1200]
    assert "amend-scope" in refusal
    assert "Do NOT" in refusal and "re-record the decomposition" in refusal


def test_task_stage_resolves_from_the_tasks_own_worktree(repo, tmp_path):
    # `forge task start` gives a task its own worktree, and a worktree has its
    # own git control dir -- so stages.json exists once per tree and the copies
    # drift the moment one closes a stage. A task closed in its worktree still
    # read `active` in the main repo, so `record_grill` there ground the grill
    # on the working tree while the seal (run in the worktree, where the stage
    # reads done) checked the stage baseline. Same task, same code, two
    # answers, and a passing grill that could never verify.
    lib = load_factory_lib(repo)
    worktree = tmp_path / "repo-T1"
    git(repo, "worktree", "add", "-q", "-b", "feat/S-T1", str(worktree))

    def control(root):
        return Path(git(root, "rev-parse", "--absolute-git-dir")) / "forge"

    baseline = git(repo, "rev-parse", "HEAD")
    for root, status, pointer in (
        (repo, "active", {"issue_key": "ENG-1"}),
        (worktree, "done", {"issue_key": "ENG-1", "task_id": "T1",
                            "base_main_sha": baseline}),
    ):
        target = control(root)
        target.mkdir(parents=True, exist_ok=True)
        lib.dump_json(target / "stages.json", {"issue": "ENG-1", "stages": [
            {"id": "T1", "title": "t", "status": status,
             "base_sha": baseline}]})
        lib.dump_json(target / "run.json", pointer)

    # The split is real: each directory reports its own copy.
    assert json.loads((control(repo) / "stages.json").read_text()
                      )["stages"][0]["status"] == "active"
    assert json.loads((control(worktree) / "stages.json").read_text()
                      )["stages"][0]["status"] == "done"

    # The task's own worktree is the authority, from EITHER directory.
    for root in (repo, worktree):
        assert lib.task_state_root(root, "T1").resolve() == worktree.resolve()
        assert lib.task_stage_record(root, "T1").get("status") == "done"

    # A task with no worktree falls back to the local copy rather than guessing.
    assert lib.task_state_root(repo, "T-none").resolve() == repo.resolve()


def test_task_grill_names_a_basis_mismatch_instead_of_reporting_stale(
        repo, tmp_path):
    # A digest mismatch has two very different causes. Reporting a
    # different-BASIS grill as "STALE" sent a reader hunting for a content
    # change that never happened -- and no amount of re-grilling converges,
    # because the two sides are measuring different trees.
    task = task_with_plan_contracts({**DECOMP["tasks"][0], "user_facing": False})
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [task])
    record_task_grill(repo, task)

    lib = load_factory_lib(repo)
    key = "ENG-1"
    grill_path = lib.evidence_path(repo, key, "grills/tasks/T1.json")
    grill = json.loads(grill_path.read_text())
    # Recorded against the working tree (an active task), then checked as a
    # completed one -- exactly the split the worktree bug produced.
    grill["grounding_basis"] = "working-tree"
    grill_path.write_text(json.dumps(grill), encoding="utf-8")

    # The task's work then lands. That is what moves the product tree, and it
    # is why the two bases now yield different digests -- on a clean tree they
    # agree, so there would be nothing to report.
    (repo / "src").mkdir(exist_ok=True)
    (repo / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "T1 work")

    with pytest.raises(SystemExit) as excinfo:
        lib.require_task_grill(repo, "T1", task, treeish=git(repo, "rev-parse", "HEAD"))
    message = str(excinfo.value)
    assert "working-tree" in message and "stage-baseline" in message
    assert "STALE" not in message
    # It must name the fix, and say not to hand-edit the digest.
    assert "worktree" in message and "by hand" in message


def test_require_task_worktree_noops_for_story_level_run(repo, tmp_path):
    # A story-level run pointer carries `branch` (from intake) but no task_id;
    # require_task_worktree must NOT gate it. Regression: it refused a
    # branch-without-task_id pointer, deadlocking every story-level stage start.
    task = task_with_plan_contracts({**DECOMP["tasks"][0], "user_facing": False})
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [task])
    record_task_grill(repo, task)
    control = delegation_ledger(repo).parent
    pointer = json.loads((control / "run.json").read_text())
    assert pointer.get("branch") and "task_id" not in pointer
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out


def test_stage_start_and_delegate_refuse_from_wrong_task_worktree(repo, tmp_path):
    task = task_with_plan_contracts({**DECOMP["tasks"][0], "user_facing": False})
    sign_off(repo)
    code, out = intake(repo)
    assert code == 0, out
    code, out = save_plan(repo, tmp_path)
    assert code == 0, out
    record_skeleton_then_frontier(repo, [task])
    code, out = record_task_grill(repo, task)
    assert code == 0, out

    control = delegation_ledger(repo).parent
    pointer = json.loads((control / "run.json").read_text())
    current_branch = git(repo, "symbolic-ref", "--short", "HEAD")
    pointer.update({"task_id": "T1", "branch": "feat/ENG-1-wrong"})
    (control / "run.json").write_text(json.dumps(pointer))
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "task worktree required" in out, out

    pointer["branch"] = current_branch
    (control / "run.json").write_text(json.dumps(pointer))
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    pointer["branch"] = "feat/ENG-1-wrong"
    (control / "run.json").write_text(json.dumps(pointer))
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code != 0 and "task worktree required" in out, out
    pointer["branch"] = current_branch
    (control / "run.json").write_text(json.dumps(pointer))
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env=fake_companion_env(tmp_path))
    assert code == 0, out


def start_stage(repo: Path, tmp_path: Path, task: dict, stage_id: str = "T1",
                *, launch: bool = True,
                future_tasks: list[dict] | None = None) -> None:
    """Signed off, planned, decomposed, and the stage started — the state every
    stage-done measurement test needs before it can measure anything."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [task, *(future_tasks or [])])
    git(repo, "add", "-A", "--", "harness.yaml", "docs/decisions")
    if subprocess.run(
            ["git", "diff", "--cached", "--quiet"], cwd=repo).returncode:
        git(repo, "commit", "-qm", "settle stage fixture inputs")
    code, out = record_task_grill(repo, task)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", stage_id)
    assert code == 0, out
    if launch:
        launch_fake(repo, tmp_path, stage_id)


def test_plan_digest_is_newline_stable_across_record_and_stage_start(repo, tmp_path):
    """Windows writes the saved plan with CRLF; the recorder and stage start
    must agree on the plan digest regardless of newline shape (PR #107 CI)."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    plan = next((repo / "plans" / "active").glob("*.md"))
    plan.write_bytes(
        plan.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    )
    before = plan.read_bytes()
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    assert plan.read_bytes() == before
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out


def write_in_scope(repo: Path, rel: str, text: str = "print('work')\n") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


STAGE_TASK = {"id": "T1", "title": "core slice", "write_scope": ["src/"],
              "objective": "Build the core slice so the feature works end to end.",
              "acceptance_criteria": ["the slice runs green"],
              "plan_contracts": [{
                  "id": "C1",
                  "statement": "the slice runs green",
                  "source": "plans/active/TEST-1-test-plan.md#acceptance-criteria",
              }],
              **READY_TASK_FIELDS}


def skeletal_stage_task(task_id: str, title: str = "future slice") -> dict:
    return {
        "id": task_id,
        "title": title,
        "objective": "Build the next bounded slice when it reaches the frontier.",
        "acceptance_criteria": ["the next slice runs green"],
    }


def test_initial_recording_is_fully_skeletal_and_graph_freezes(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = skeletal_stage_task("T1", "first slice")
    second = {**skeletal_stage_task("T2", "second slice"),
              "dependencies": ["T1"]}

    execution_detail = {
        "write_scope": ["src/"],
        "required_tests": READY_TASK_FIELDS["required_tests"],
        "verify_commands": ["true"],
        "reviewer_focus": "the first bounded slice",
        "review_budget": {"max_changed_files": 4, "max_changed_lines": 200},
        "plan_contracts": [{
            "id": "C1",
            "statement": first["acceptance_criteria"][0],
            "source": "plans/active/TEST-1-test-plan.md#acceptance-criteria",
        }],
    }
    for field, value in execution_detail.items():
        payload = {**DECOMP, "tasks": [{**first, field: value}, second]}
        code, out = run(
            repo, "record_decomposition_from_json.py", stdin=json.dumps(payload)
        )
        assert code != 0 and "fully skeletal" in out and field in out
    payload = {**DECOMP, "tasks": [{**first, "write_scope": []}, second]}
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(payload)
    )
    assert code != 0 and "fully skeletal" in out and "write_scope" in out

    skeleton = {**DECOMP, "tasks": [first, second]}
    code, out = run(
        repo, "record_decomposition_from_json.py", stdin=json.dumps(skeleton)
    )
    assert code == 0, out

    # Nothing has STARTED yet: the pending graph may be reshaped, but every such
    # change is an APPROVED-PLAN AMENDMENT (it prints the amendment NOTE and marks
    # the approval/grills stale), never a silent reshuffle.
    graph_edits = [
        [{**first, "id": "RENAMED"},
         {**second, "dependencies": ["RENAMED"]}],
        [{**second, "dependencies": []},
         {**first, "dependencies": ["T2"]}],
        [first, {**second, "dependencies": []}],
    ]
    for tasks in graph_edits:
        code, out = run(
            repo, "record_decomposition_from_json.py",
            stdin=json.dumps({**DECOMP, "tasks": tasks}),
        )
        assert code == 0 and "AMENDED" in out, out
    # Restore the original skeleton for the checks that follow.
    run(repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [first, second]}))

    # Once T1 has STARTED (here: done) its graph position — id, order,
    # dependencies — is HARD frozen; only `forge task reopen` can move started
    # work, a plain re-record cannot.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": first["title"], "status": "done"},
            {"id": "T2", "title": second["title"], "status": "pending"},
        ],
    })
    for tasks in (
        [{**first, "id": "RENAMED"}, {**second, "dependencies": ["RENAMED"]}],
        [{**second, "dependencies": []}, {**first, "dependencies": ["T2"]}],
    ):
        code, out = run(
            repo, "record_decomposition_from_json.py",
            stdin=json.dumps({**DECOMP, "tasks": tasks}),
        )
        assert code != 0 and "frozen for work that has started" in out, out
    # Back to pending so the append + frontier-detail checks below are unaffected.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": first["title"], "status": "pending"},
            {"id": "T2", "title": second["title"], "status": "pending"},
        ],
    })

    appended = {**skeletal_stage_task("T3", "split-out slice"),
                "dependencies": ["T2"]}
    detailed_append = {**appended, "write_scope": ["src/split/"]}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [first, second, detailed_append]}),
    )
    assert code != 0 and "pending non-frontier task must not declare" in out, out
    empty_detail_append = {**appended, "write_scope": []}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [first, second, empty_detail_append]}),
    )
    assert code != 0 and "pending non-frontier task must not declare" in out, out
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [first, second, appended]}),
    )
    assert code == 0, out

    frontier = {**first, **execution_detail}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [frontier, second, appended]}),
    )
    assert code == 0, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": frontier["title"], "status": "active"},
            {"id": "T2", "title": second["title"], "status": "pending"},
            {"id": "T3", "title": appended["title"], "status": "pending"},
        ],
    })
    repaired = {**frontier, "write_scope": ["src/", "billing/"]}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [repaired, second, appended]}),
    )
    assert code == 0, out


def test_task_reopen_moves_frontier_back_and_ripples_the_done_tail(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(
        repo, [skeletal_stage_task("T1"), skeletal_stage_task("T2")])
    # T1 and the tail built on it (T2) are both done but unshipped.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": "first", "status": "done", "task_sha256": "abc",
             "local_review_stamp": {"score": 9}},
            {"id": "T2", "title": "second", "status": "done", "task_sha256": "def"},
        ],
    })
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code == 0 and "Reopened" in out and "T1" in out and "T2" in out, out
    # T1 is now the pending frontier again; reopening a pending task refuses.
    code, out = run(repo, "forge.py", "task", "reopen", "T1")
    assert code != 0 and "not done" in out, out


def test_task_reopen_refuses_a_task_not_in_the_decomposition(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [skeletal_stage_task("T1")])
    code, out = run(repo, "forge.py", "task", "reopen", "NOPE")
    assert code != 0 and "not in the current decomposition" in out, out


def test_done_contracts_immutable_and_criteria_map_binds_plan_contracts(
        repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    skeleton = skeletal_stage_task("T1")
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [skeleton]}),
    )
    assert code == 0, out
    task = {
        **skeleton,
        "write_scope": ["src/"],
        **READY_TASK_FIELDS,
        "plan_contracts": [{
            "id": "C1",
            "statement": skeleton["acceptance_criteria"][0],
            "source": "plans/active/TEST-1-test-plan.md#acceptance-criteria",
        }],
    }
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task]}),
    )
    assert code == 0, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": task["title"], "status": "done",
                    "task_sha256": task_digest(task)}],
    })

    changed_full_contract = {**task, "reviewer_focus": "rewritten after done"}
    assert task_digest(changed_full_contract) == task_digest(task)
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [changed_full_contract]}),
    )
    assert code != 0 and "full contract" in out

    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": task["title"], "status": "pending"}],
    })
    payload = task_grill_payload(task)
    without_plan_contracts = {
        key: value for key, value in task.items() if key != "plan_contracts"
    }
    seed_task_grill_frontier(repo, without_plan_contracts)
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        stdin=json.dumps(payload),
    )
    assert code != 0 and "requires the task's plan_contracts" in out

    seed_task_grill_frontier(repo, task)
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        stdin=json.dumps(payload),
    )
    assert code == 0, out

    mismatched = {**task, "plan_contracts": [{
        **task["plan_contracts"][0], "statement": "a different plan promise",
    }]}
    seed_task_grill_frontier(repo, mismatched)
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        stdin=json.dumps(payload),
    )
    assert code != 0 and "plan_contracts statements" in out


def test_decomposition_refuses_future_execution_detail(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = task_skeleton(STAGE_TASK)
    second = skeletal_stage_task("T2")
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [first, second]}),
    )
    assert code == 0, out
    future_detail = {
        "write_scope": ["src/future/"],
        "required_tests": [{
            "id": "test_future",
            "path": "factory/tests/test_gates.py",
            "command": "python3 -m pytest {path}::{id} --junitxml={report}",
        }],
        "verify_commands": ["true"],
        "reviewer_focus": "the future bounded slice",
        "plan_contracts": [{
            "id": "C2",
            "statement": "the next slice runs green",
            "source": "plans/active/TEST-1-test-plan.md#acceptance-criteria",
        }],
    }

    for field, detail in future_detail.items():
        future = {**skeletal_stage_task("T2"), field: detail}
        payload = {**DECOMP, "tasks": [STAGE_TASK, future]}
        code, out = run(
            repo, "record_decomposition_from_json.py", stdin=json.dumps(payload)
        )

        assert code != 0
        assert "T2" in out and field in out


def test_decomposition_accepts_frontier_detail_and_exempts_done_tasks(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    completed = {
        **STAGE_TASK,
        "required_tests": [{
            "id": "test_completed",
            "path": "factory/tests/test_gates.py",
            "command": "python3 -m pytest {path}::{id} --junitxml={report}",
        }],
        "verify_commands": ["true"],
    }
    initial = {**DECOMP, "tasks": [completed, skeletal_stage_task("T2")]}
    record_skeleton_then_frontier(repo, initial["tasks"])
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": completed["title"], "status": "done"},
            {"id": "T2", "title": "future slice", "status": "pending"},
        ],
    })
    frontier = {
        **skeletal_stage_task("T2"),
        "write_scope": ["src/frontier/"],
        "required_tests": [{
            "id": "test_frontier",
            "path": "factory/tests/test_gates.py",
            "command": "python3 -m pytest {path}::{id} --junitxml={report}",
        }],
        "verify_commands": ["true"],
    }

    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [completed, frontier]}),
    )

    assert code == 0, out
    recorded = json.loads((story_state(repo) / "decomposition.json").read_text())
    assert recorded["tasks"][0]["write_scope"] == completed["write_scope"]
    assert recorded["tasks"][0]["required_tests"] == completed["required_tests"]
    assert recorded["tasks"][0]["verify_commands"] == completed["verify_commands"]
    assert recorded["tasks"][1]["write_scope"] == ["src/frontier/"]
    assert recorded["tasks"][1]["required_tests"] == frontier["required_tests"]
    assert recorded["tasks"][1]["verify_commands"] == ["true"]


def test_stage_done_refuses_empty_diff(repo, tmp_path):
    """The silent-stall signature: a delegation that wrote nothing. Workflow
    paths churn on every forge command, so they must not count as work."""
    start_stage(repo, tmp_path, STAGE_TASK)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "EMPTY diff" in out
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    code, out = record_stage_local(repo)
    assert code == 0, out
    git(repo, "commit", "-qm", "reviewed stage work")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


def test_stage_done_refuses_without_fresh_stage_local_stamp(repo, tmp_path):
    start_stage(
        repo, tmp_path, STAGE_TASK, launch=False,
    )

    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "EMPTY diff" in out

    write_in_scope(repo, "src/core.py", "version = 1\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no stage-local review stamp" in out

    git(repo, "add", "src/core.py")
    code, out = record_stage_local(repo)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "uncommitted or staged PRODUCT changes" in out

    write_in_scope(repo, "src/core.py", "version = 2\n")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "different from reviewed tree")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "STALE stage-local review stamp" in out

    write_in_scope(repo, "src/core.py", "version = 3\n")
    git(repo, "add", "src/core.py")
    code, out = record_stage_local(repo)
    assert code == 0, out
    git(repo, "commit", "-qm", "exact reviewed tree")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out
    assert "stage-local review stamp" not in out
    assert "PRODUCT changes" not in out


def test_stage_local_stamp_is_a_stages_token_not_a_fourth_review(repo, tmp_path):
    start_stage(
        repo, tmp_path, STAGE_TASK, launch=False,
    )
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")

    brief = repo / ".factory" / "briefs" / "T1.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text("composed task brief\n")
    brief_sha256 = hashlib.sha256(brief.read_bytes()).hexdigest()
    stage = json.loads((repo / ".factory" / "stages.json").read_text())["stages"][0]
    launch = {
        "launch_id": "launch-stage-local-test",
        "task": "T1",
        "brief_sha256": brief_sha256,
        "task_sha256": task_digest(STAGE_TASK),
        "write": True,
        "model": "gpt-test",
        "effort": "medium",
        "companion_path": "/tmp/companion.mjs",
        "argv": ["node", "companion.mjs"],
        "argv_sha256": "fixture",
        "stage_started_at": stage["started_at"],
        "process_token": "delegation-stage-local-test",
    }
    ledger = delegation_ledger(repo)
    ledger.write_text("\n".join(json.dumps({
        **launch,
        "launch_status": status,
        **({"exit_code": 0} if status == "succeeded" else {}),
    }) for status in ("starting", "running", "succeeded")) + "\n")

    code, out = record_stage_local(repo, score=7)
    assert code != 0 and "must be clean" in out

    code, out = record_stage_local(repo)
    assert code == 0, out
    mirror = json.loads((repo / ".factory" / "stages.json").read_text())
    protected = json.loads(
        (delegation_ledger(repo).parent / "stages.json").read_text()
    )
    stamp = mirror["stages"][0]["local_review_stamp"]
    assert protected["stages"][0]["local_review_stamp"] == stamp
    assert stamp == {
        "stage_id": "T1",
        "task_sha256": task_digest(STAGE_TASK),
        "brief_sha256": brief_sha256,
        "base_sha": mirror["stages"][0]["base_sha"],
        "product_tree_digest": product_tree_digest(repo),
        "recorded_at": stamp["recorded_at"],
        "generated_by": "autoreview",
    }
    reviews = story_state(repo) / "reviews"
    assert not (reviews / "stage-local.json").exists()
    assert sorted(path.name for path in reviews.glob("*.json")) == []


def test_review_budget_default_lowered_raised_and_exceeded(
        repo, tmp_path, capsys):
    from forge_cli.stages import _measure

    def clone_case(name: str) -> Path:
        target = tmp_path / name
        shutil.copytree(repo, target)
        return target

    def measure_case(
            name: str, task: dict, files: int, *, commit_after: int = 0,
            delete_tracked_lines: int = 0, lines_per_file: int = 1) -> None:
        target = clone_case(name)
        if delete_tracked_lines:
            write_in_scope(
                target, "src/removed.py",
                "".join(f"line_{index}\n" for index in range(delete_tracked_lines)),
            )
            git(target, "add", "src/removed.py")
            git(target, "commit", "-qm", "tracked removal fixture")
        stage = {"id": "T1", "base_sha": head(target), "dirty_at_start": {}}
        if delete_tracked_lines:
            (target / "src" / "removed.py").unlink()
        for index in range(files):
            write_in_scope(
                target, f"src/part_{index}.py", "changed = True\n" * lines_per_file,
            )
            if index + 1 == commit_after:
                git(target, "add", "src")
                git(target, "commit", "-qm", "stage work")
        _measure(target, "T1", stage, task)

    measure_case("budget-default", STAGE_TASK, 1)

    lowered = {**STAGE_TASK, "review_budget": {
        "max_changed_files": 1,
        "max_changed_lines": 2,
    }}
    measure_case("budget-lowered", lowered, 0, delete_tracked_lines=2)

    raised = {**STAGE_TASK, "review_budget": {
        "max_changed_files": 9,
        "max_changed_lines": 401,
        "reason": "This mechanical split remains one reviewable change.",
    }}
    measure_case("budget-raised", raised, 9, commit_after=4)

    exceeded_files = {**STAGE_TASK, "review_budget": {
        "max_changed_files": 1,
        "max_changed_lines": 10,
    }}
    with pytest.raises(SystemExit) as refusal:
        measure_case("budget-files-exceeded", exceeded_files, 2)
    assert refusal.value.code == 1
    out = capsys.readouterr().out
    assert "measured files=2, lines=2; budget files=1, lines=10" in out
    assert "default 8 files / 400 lines is the policy target" in out
    assert "decision=split" in out and "frozen graph prefix" in out
    assert "stage done T1 --incomplete" in out

    exceeded_lines = {**STAGE_TASK, "review_budget": {
        "max_changed_files": 2,
        "max_changed_lines": 1,
    }}
    with pytest.raises(SystemExit) as refusal:
        measure_case(
            "budget-lines-exceeded", exceeded_lines, 1, lines_per_file=2,
        )
    assert refusal.value.code == 1
    out = capsys.readouterr().out
    assert "measured files=1, lines=2; budget files=2, lines=1" in out

    validation = clone_case("budget-validation")
    sign_off(validation)
    intake(validation)
    save_plan(validation, tmp_path)
    code, out = run(
        validation,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task_skeleton(raised)]}),
    )
    assert code == 0, out
    invalid_budgets = [
        (None, "must be an object"),
        ({"max_changed_files": 1}, "needs exactly"),
        ({"max_changed_files": True, "max_changed_lines": 1},
         "positive integer"),
        ({"max_changed_files": 1, "max_changed_lines": 0},
         "positive integer"),
        ({"max_changed_files": 1, "max_changed_lines": 1, "reason": 3},
         "reason must be a string"),
        ({"max_changed_files": 9, "max_changed_lines": 401},
         "non-empty reason"),
    ]
    for budget, message in invalid_budgets:
        malformed = {**raised, "review_budget": budget}
        code, out = run(
            validation,
            "record_decomposition_from_json.py",
            stdin=json.dumps({**DECOMP, "tasks": [malformed]}),
        )
        assert code != 0 and message in out, (budget, out)


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
    stamp_and_commit(repo)
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


def test_stage_done_accepts_committed_directory_replacement_after_proof(
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
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and name in out
    write_in_scope(repo, "src/test_core.py", f"def {name}():\n    pass\n")
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    threading.Event().wait(6)
    assert not (repo / "src" / "late.py").exists()


def test_stage_done_refuses_failing_verify_command(repo, tmp_path):
    task = {**STAGE_TASK, "verify_commands": ["exit 3"]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "exit 3" in out


def test_stage_done_remeasures_after_verify_command(repo, tmp_path):
    command = ("python3 -c \"from pathlib import Path; "
               "p=Path('billing/generated.py'); p.parent.mkdir(exist_ok=True); "
               "p.write_text('generated = True\\\\n')\"")
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo, "src/core.py")
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
        spawned = {}
        probes = iter([OSError("process identity unavailable"), 4242.0])

        def process_identity(_pid):
            result = next(probes)
            if isinstance(result, Exception):
                raise result
            return result

        def spawn(*_args, **kwargs):
            spawned.update(kwargs)
            return fake_process

        monkeypatch.setattr(stages.subprocess, "Popen", spawn)
        monkeypatch.setattr(delegate, "_process_table", lambda: {})
        monkeypatch.setattr(delegate, "_process_start_identity", process_identity)
        monkeypatch.setattr(
            delegate, "_signal_verified_process_group",
            lambda pid, identity: signals.append((pid, identity)) or True)
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
    assert signals == [(fake_process.pid, 4242.0)]
    assert spawned["env"]["PYTHONUTF8"] == "1"
    assert spawned["stdout"].encoding == "utf-8"
    assert spawned["stdout"].errors == "replace"
    assert spawned["stderr"].encoding == "utf-8"
    assert spawned["stderr"].errors == "replace"


def test_stage_done_reloads_launch_after_proof_commands(repo, tmp_path):
    command = ("python3 -c \"from pathlib import Path; "
               "p=Path('.factory/briefs/T1.md'); "
               "p.write_text(p.read_text() + 'changed')\"")
    task = {**STAGE_TASK, "verify_commands": [command]}
    start_stage(repo, tmp_path, task)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


def test_stage_tasks_are_sequential_and_parallel_flag_is_refused(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    decomp = {**DECOMP, "tasks": [
        {**STAGE_TASK, "id": "T1", "write_scope": ["src/api/"]},
        skeletal_stage_task("T2"),
    ]}
    record_skeleton_then_frontier(repo, decomp["tasks"])
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
    stamp_and_commit(repo, "billing/ledger.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    assert "contract changed" in out

    stage = next(s for s in json.loads(
        (repo / ".factory" / "stages.json").read_text())["stages"]
        if s["id"] == "T1")
    assert stage["contract_changed"]["from"] != stage["contract_changed"]["to"]
    assert "stage-contract-changed" in [event["event"] for event in load_events(repo)]


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
    assert "task graph is frozen" in out


def test_decomposition_refuses_to_rewrite_a_completed_task_contract(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
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
    assert code != 0 and "full contract" in out


def test_decomposition_backfills_unchanged_legacy_completed_contract(
        repo, tmp_path):
    follow_up = skeletal_stage_task("T2", "follow-up")
    follow_up["objective"] = "Add the next bounded slice."
    follow_up["acceptance_criteria"] = ["the follow-up is recorded"]
    start_stage(repo, tmp_path, STAGE_TASK, future_tasks=[follow_up])
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
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
            follow_up,
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
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    changed_task = {
        **STAGE_TASK,
        "acceptance_criteria": ["worker rewrote the prior contract"],
    }
    decomposition = story_state(repo) / "decomposition.json"
    forged_prior = json.loads(decomposition.read_text())
    forged_prior["tasks"] = [changed_task]
    decomposition.write_text(json.dumps(forged_prior))
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [changed_task]}))
    assert code != 0 and "full contract" in out


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

    # An upstream branch that touches a path this task does not own.
    git(repo, "checkout", "-q", "-b", "upstream")
    (repo / "unrelated.py").write_text("upstream = True\n")
    git(repo, "add", "unrelated.py")
    git(repo, "commit", "-qm", "upstream work outside this task")
    git(repo, "checkout", "-q", "-")
    git(repo, "commit", "--allow-empty", "-qm", "keep stage branch divergent")
    git(repo, "merge", "--no-edit", "-q", "upstream")

    assert (repo / "unrelated.py").exists()
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo, "src/core.py")
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
    stamp_and_commit(repo, "src/core.py")
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
                    ".factory/signals.jsonl"):
        line = next(l for l in attributes.splitlines() if l.startswith(pattern))
        assert line.endswith("merge=union"), line


def test_stage_done_refuses_a_task_with_no_boundary(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    unbounded = {**STAGE_TASK, "write_scope": []}
    protected = delegation_ledger(repo).parent / "decomposition.json"
    decomposition = json.loads(protected.read_text())
    decomposition["tasks"] = [unbounded]
    protected.write_text(json.dumps(decomposition))
    (repo / ".factory" / "decomposition.json").write_text(
        json.dumps(decomposition)
    )
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
    widened = {**STAGE_TASK, "write_scope": ["src/", "billing/"]}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [widened]}),
    )
    assert code == 0, out
    code, out = record_task_grill(repo, widened)
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "delegate", "T1",
        env={"HOME": str(fake_companion_home(tmp_path))},
    )
    assert code == 0, out
    write_in_scope(repo, "billing/ledger.py", "before = 1\n")
    stamp_and_commit(repo, "src/core.py", "billing/ledger.py")
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
    events = load_events(repo)
    assert any(event["event"] == "stage-incomplete"
               and "retry path" in event.get("detail", "") for event in events)
    # and it clears once the stage really closes
    stamp_and_commit(repo, "src/core.py")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    stages = json.loads((repo / ".factory" / "stages.json").read_text())["stages"]
    assert stages[0]["status"] == "done" and "incomplete" not in stages[0]


def test_edited_approved_plan_refused_at_rerecord_and_stage_start(repo, tmp_path):
    """The realistic staleness is the plan being edited AFTER the task graph
    was recorded — the decomposition was current when written, so no
    record-time check can see it. Catch it before work starts."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    plan = next((repo / "plans" / "active").glob("*.md"))
    plan.write_text(plan.read_text() + "\n<!-- edited after decomposition -->\n")
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}),
    )
    assert code != 0, out
    expected_refusal = (
        "approved plan binding is missing or no longer matches the live plan. "
        "Re-grill the current plan and re-approve it."
    )
    assert out.strip() == expected_refusal
    shared_refusal = out

    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0, out
    assert out == shared_refusal

    # Absence must refuse too: a stamped decomposition claims a binding, so
    # failing to VERIFY it is not permission to proceed.
    plan.unlink()
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0, out
    assert out == shared_refusal


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
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task_skeleton(STAGE_TASK)]}),
    )
    assert code == 0, out
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
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**payload, "tasks": [task_skeleton(payload["tasks"][0])]}),
    )
    assert code == 0, out

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(payload))

    assert code == 0, out
    recorded = json.loads((story_state(repo) / "decomposition.json").read_text())
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
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task_skeleton(task)]}),
    )
    assert code == 0, out

    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps({**DECOMP, "tasks": [task]}))

    assert code == 0, out
    recorded = json.loads((story_state(repo) / "decomposition.json").read_text())
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
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task_skeleton(task)]}),
    )
    assert code == 0, out
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


def test_doctor_reports_missing_roadmap_with_discovery(repo, capsys):
    from forge_cli.doctor import legacy_roadmap_gaps, report_legacy_roadmap_gaps

    (repo / "docs" / "decisions" / "0001-existing-choice.md").write_text(
        "# Existing choice\n"
    )

    gaps = legacy_roadmap_gaps(repo)
    assert len(gaps) == 1 and gaps[0][0] == "roadmap"
    assert report_legacy_roadmap_gaps(repo) is None
    out = capsys.readouterr().out
    assert out.startswith("[opt ] roadmap/roadmap plans/roadmap.json: absent")
    assert "forge roadmap derive" in out

    (repo / "docs" / "decisions" / "0001-existing-choice.md").unlink()
    report_legacy_roadmap_gaps(repo)
    assert capsys.readouterr().out == ""


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


def test_stage_start_refuses_unready_or_ungrilled_contract(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    authority = delegation_ledger(repo).parent / "stages.json"
    mirror = repo / ".factory" / "stages.json"
    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [task_skeleton(STAGE_TASK)]}),
    )
    assert code == 0, out

    for field, empty in (
        ("write_scope", []),
        ("required_tests", []),
        ("verify_commands", []),
        ("reviewer_focus", ""),
    ):
        unready = {**STAGE_TASK, field: empty}
        code, out = run(
            repo,
            "record_decomposition_from_json.py",
            stdin=json.dumps({**DECOMP, "tasks": [unready]}),
        )
        assert code == 0, out
        before = (authority.read_bytes(), mirror.read_bytes())
        code, out = run(repo, "forge.py", "stage", "start", "T1")
        assert code != 0 and field in out
        assert "record_decomposition_from_json.py --input <json>" in out
        assert (authority.read_bytes(), mirror.read_bytes()) == before

    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}),
    )
    assert code == 0, out
    before = (authority.read_bytes(), mirror.read_bytes())
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "Task plan required first" in out
    assert "./forge task plan save T1 --from <path>" in out
    assert (authority.read_bytes(), mirror.read_bytes()) == before

    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    changed = {**STAGE_TASK, "write_scope": ["src/changed/"]}
    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [changed]}),
    )
    assert code == 0, out
    before = (authority.read_bytes(), mirror.read_bytes())
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "STALE" in out and "grounding inputs changed" in out
    assert (authority.read_bytes(), mirror.read_bytes()) == before


def test_delegate_refuses_active_empty_scope_and_read_only_passes(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    authority = delegation_ledger(repo).parent / "decomposition.json"
    mirror = repo / ".factory" / "decomposition.json"
    decomposition = json.loads(authority.read_text())
    decomposition["tasks"][0]["write_scope"] = []
    authority.write_text(json.dumps(decomposition))
    mirror.write_text(json.dumps(decomposition))

    code, out = run(
        repo, "forge.py", "delegate", "T1", env=fake_companion_env(tmp_path)
    )
    assert code != 0 and "write_scope" in out
    assert "record_decomposition_from_json.py --input <json>" in out
    assert "forge delegate T1 --read-only" in out
    assert not delegation_ledger(repo).exists()

    code, out = run(
        repo,
        "forge.py",
        "delegate",
        "T1",
        "--read-only",
        "--print-only",
        env=fake_companion_env(tmp_path),
    )
    assert code == 0, out
    assert "Write access: NO" in out and "--write" not in out
    assert not delegation_ledger(repo).exists()

    decomposition["tasks"] = [STAGE_TASK]
    authority.write_text(json.dumps(decomposition))
    mirror.write_text(json.dumps(decomposition))
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out


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


def test_brief_states_budget_and_narration_line(repo, tmp_path):
    task = {**DELEGATE_TASK, "review_budget": {
        "max_changed_files": 3,
        "max_changed_lines": 120,
    }}
    start_stage(repo, tmp_path, task, launch=False)
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    brief = (repo / ".factory" / "diagnostic-briefs" / "T1.md").read_text()
    assert (
        "Review budget: 3 files / 120 changed lines (additions + deletions), "
        "excluding `.factory/` and `plans/`. If the work will exceed it, stop "
        "and return incomplete so the orchestrator can split the task before "
        "more work."
    ) in brief
    assert (
        "Narration budget: one line per state change, findings and refusals "
        "always in full, process chatter never (conduct §8)."
    ) in brief


def test_delegate_derives_write_from_stage_state(repo, tmp_path):
    """Write permission stopped being a per-request opinion: three layers
    disagreed on the default and a read-only sandbox can neither write nor ask."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [DELEGATE_TASK])
    # stage not started -> read only
    home = str(fake_companion_home(tmp_path))
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": home})
    assert (code == 0 and len(out.splitlines()) == 1 and "--write" not in out
            and "Write access: NO" in out and "not launched" in out)
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
    grill = story_state(repo) / "grills" / "tasks" / "T1.json"
    grill.unlink()
    command = (
        "python3 factory/scripts/record_grill_from_json.py --gate task "
        "--task T1"
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
    grill = story_state(repo) / "grills" / "tasks" / "T1.json"
    payload = json.loads(grill.read_text())
    payload["input_sha256"] = "0" * 64
    grill.write_text(json.dumps(payload))

    code, out = run(repo, "forge.py", "delegate", "T1",
                    env=fake_companion_env(tmp_path))
    assert code != 0 and "STALE" in out
    assert "record_grill_from_json.py --gate task --task T1" in out
    assert "--task-digest was removed" in out
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
    (story_state(repo) / "grills" / "tasks" / "T1.json").unlink()

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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo, "src/core.py")
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
    stamp_and_commit(repo, "src/core.py")
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
    stamp_and_commit(repo)
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
    stamp_and_commit(repo)
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
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    mirror = story_state(repo) / "decomposition.json"
    forged = json.loads(mirror.read_text())
    forged["tasks"][0]["write_scope"] = ["billing/"]
    mirror.write_text(json.dumps(forged))
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
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


def test_shipped_or_orphaned_authority_does_not_phantom_block(repo, tmp_path):
    """A shipped story's leftover git-local stage authority must not report a
    phantom active stage. With no active issue (or a mismatched one) load_stages
    returns {}, so quickfix / mode / stage start all open freely; `stage clear`
    retires the authority left behind by a story that shipped before it existed.
    """
    start_stage(repo, tmp_path, STAGE_TASK)
    lib = load_factory_lib(repo)
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        from forge_cli.stages import authoritative_stages_path
    finally:
        sys.path.pop(0)

    # While the story is active the stage IS reported and blocks a new window.
    code, out = run(repo, "forge.py", "stage", "list")
    assert code == 0 and "[>]" in out
    code, out = run(repo, "forge.py", "quickfix", "start", "phantom check")
    assert code != 0 and "stage is active" in out

    # Post-ship run.json is project fields only, no issue_key. The authority
    # file is still on disk — the bug is that its clear never ran.
    lib.dump_json(lib.run_state_path(repo), {"project": "app", "phase": "shipped"})
    assert authoritative_stages_path(repo).is_file()

    # load_stages returns {} with no active issue: no phantom stage.
    code, out = run(repo, "forge.py", "stage", "list")
    assert code == 0 and "No stage tracker" in out
    # quickfix start is no longer blocked.
    code, out = run(repo, "forge.py", "quickfix", "start", "unblocked")
    assert code == 0, out
    run(repo, "forge.py", "quickfix", "done")

    # Mismatch case: a DIFFERENT active story must not adopt the leftover T1.
    lib.dump_json(lib.run_state_path(repo),
                  {"project": "app", "issue_key": "OTHER-9"})
    code, out = run(repo, "forge.py", "stage", "list")
    assert code == 0 and "No stage tracker" in out
    code, out = run(repo, "forge.py", "mode", "lite",
                    "--reason", "no phantom", "--by", "Test Human")
    assert code == 0, out
    run(repo, "forge.py", "mode", "done")

    # `stage clear` retires the orphaned authority, idempotently.
    control = authoritative_stages_path(repo).parent
    code, out = run(repo, "forge.py", "stage", "clear")
    assert code == 0 and "stages.json" in out, out
    assert not authoritative_stages_path(repo).is_file()
    assert not (control / "decomposition.json").exists()
    code, out = run(repo, "forge.py", "stage", "clear")
    assert code == 0 and "No git-local story authority" in out


def test_stage_migrate_requires_confirmation_and_adopts_legacy_state(
        repo, tmp_path):
    sign_off(repo)
    intake(repo)
    make_legacy_story(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
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
    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out


@pytest.mark.parametrize("protected_name", ["decomposition.json", "stages.json"])
def test_stage_migrate_refuses_partial_protected_authority(
        repo, tmp_path, protected_name):
    sign_off(repo)
    intake(repo)
    make_legacy_story(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
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
    make_legacy_story(repo)
    save_plan(repo, tmp_path)
    tasks = tasks or [STAGE_TASK]
    record_skeleton_then_frontier(repo, tasks)
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
        skeletal_stage_task("T2"),
        skeletal_stage_task("T3"),
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


def test_safe_factory_windows_helper_opens_nested_regular_file(tmp_path):
    factory_lib = load_factory_lib(HARNESS)
    target = tmp_path / ".factory"
    descriptor = factory_lib._safe_factory_nt_open(
        target, ("briefs", "T1.md"), os.O_WRONLY | os.O_CREAT)
    assert descriptor is not None
    try:
        os.write(descriptor, b"brief\n")
    finally:
        os.close(descriptor)
    assert (target / "briefs" / "T1.md").read_bytes() == b"brief\n"


@pytest.mark.parametrize("parts, reparse_relative", [
    (("T1.md",), "."),
    (("T1.md",), "T1.md"),
    (("briefs", "T1.md"), "briefs"),
])
def test_safe_factory_windows_helper_refuses_reparse_components(
        tmp_path, monkeypatch, parts, reparse_relative):
    factory_lib = load_factory_lib(HARNESS)
    target = tmp_path / ".factory"
    reparse_path = target / reparse_relative
    if reparse_relative == parts[-1]:
        target.mkdir()
        reparse_path.touch()
    real_lstat = factory_lib.os.lstat
    reparse_flag = 0x400
    monkeypatch.setattr(
        factory_lib.stat, "FILE_ATTRIBUTE_REPARSE_POINT", reparse_flag,
        raising=False)

    def lstat(path):
        if os.fspath(path) == os.fspath(reparse_path):
            return types.SimpleNamespace(st_file_attributes=reparse_flag)
        return real_lstat(path)

    monkeypatch.setattr(factory_lib.os, "lstat", lstat)
    assert factory_lib._safe_factory_nt_open(
        target, parts, os.O_WRONLY | os.O_CREAT) is None


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
    stamp_and_commit(repo)
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "no successful write launch" in out
    with ledger.open("a") as fh:
        fh.write(json.dumps({**first, "launch_status": "succeeded",
                             "exit_code": 0}) + "\n")
    code, out = record_stage_local(repo)
    assert code == 0, out
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
    stamp_and_commit(repo)
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
        terminated = []

        class Process:
            def __init__(self, pid, identity):
                self.pid = pid
                self.identity = identity

            def status(self):
                return "running"

            def create_time(self):
                return self.identity

            def terminate(self):
                terminated.append(self.pid)

        replacement = Process(101, 2.0)
        live = Process(102, 3.0)
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([replacement, live]))
        signalled = delegate._signal_identified_processes({
            101: 1.0,
            102: 3.0,
        })
    finally:
        sys.path.pop(0)
    assert signalled == {102: 3.0}
    assert terminated == [102]


def test_process_signal_uses_portable_sigkill(repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        terminated = []
        killed = []

        class Process:
            pid = 101

            def status(self):
                return "running"

            def create_time(self):
                return 1.0

            def terminate(self):
                terminated.append(self.pid)

            def kill(self):
                killed.append(self.pid)

        monkeypatch.delattr(delegate.signal, "SIGKILL", raising=False)
        monkeypatch.setattr(delegate, "SIGKILL", None)
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([Process()]))
        assert delegate._signal_identified_processes(
            {101: 1.0}, signal.SIGTERM) == {101: 1.0}
        assert delegate._signal_identified_processes(
            {101: 1.0}, delegate.SIGKILL) == {101: 1.0}
    finally:
        sys.path.pop(0)
    assert terminated == [101]
    assert killed == [101]


def test_process_signal_revalidates_identity_after_zombie_probe(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        state = {"identity": 1.0}
        terminated = []

        class Process:
            pid = 101

            def status(self):
                state["identity"] = 2.0
                return "running"

            def create_time(self):
                return state["identity"]

            def terminate(self):
                terminated.append(self.pid)

        process = Process()
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([process]))
        signalled = delegate._signal_identified_processes({
            101: 1.0,
        })
    finally:
        sys.path.pop(0)
    assert signalled == {}
    assert terminated == []


def test_terminate_reaps_worker_tree_by_create_time_identity(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        terminated = []

        class Process:
            def __init__(self, pid, identity, children=()):
                self.pid = pid
                self.identity = identity
                self._children = list(children)

            def status(self):
                return "running"

            def create_time(self):
                return self.identity

            def children(self, *, recursive):
                assert recursive is True
                return self._children

            def terminate(self):
                terminated.append(self.pid)

        class ReusedChild(Process):
            def __init__(self):
                super().__init__(104, 41.0)
                self.identities = iter((41.0, 42.0))

            def create_time(self):
                return next(self.identities)

        child = Process(102, 20.0)
        reused_child = ReusedChild()
        leader = Process(101, 10.0, [child, reused_child])
        reused = Process(103, 31.0)
        monkeypatch.setattr(
            delegate, "_psutil",
            lambda: fake_psutil([leader, child, reused_child, reused]))

        assert delegate._signal_verified_process_group(101, 10.0) is True
        assert delegate._signal_verified_process_group(103, 30.0) is False
    finally:
        sys.path.pop(0)
    assert terminated == [102, 101]


def test_tagged_process_scan_is_limited_to_same_user_processes(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        class Process:
            def __init__(self, pid, user, environment):
                self.pid = pid
                self.user = user
                self._environment = environment

            def username(self):
                return self.user

            def environ(self):
                return self._environment

            def cmdline(self):
                return []

            def create_time(self):
                return float(self.pid)

        mine = Process(101, "owner", {})
        other = Process(202, "other", {"FORGE_PROCESS_TOKEN": "owned"})
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([mine, other]))
        found = delegate._tagged_processes(
            "owned", current={101: (1, 101.0), 202: (1, 202.0)})
    finally:
        sys.path.pop(0)
    assert found == {}


def test_tagged_process_scan_skips_permission_denied_candidates(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        class Process:
            def __init__(self, pid, environment, denied=False):
                self.pid = pid
                self._environment = environment
                self.denied = denied

            def username(self):
                return "owner"

            def environ(self):
                if self.denied:
                    raise FakePsutilAccessDenied()
                return self._environment

            def cmdline(self):
                if self.denied:
                    raise FakePsutilAccessDenied()
                return []

            def create_time(self):
                return float(self.pid)

        hidden = Process(101, None, denied=True)
        readable = Process(202, {"FORGE_PROCESS_TOKEN": "owned"})
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([hidden, readable]))
        found = delegate._tagged_processes(
            "owned", current={101: (1, 101.0), 202: (1, 202.0)})
    finally:
        sys.path.pop(0)
    assert found == {202: 202.0}


def test_tagged_process_scan_falls_back_when_cached_environment_is_denied(
        repo, monkeypatch):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate

        class Process:
            pid = 101

            def username(self):
                return "owner"

            def environ(self):
                raise FakePsutilAccessDenied()

            def cmdline(self):
                return ["worker", "FORGE_PROCESS_TOKEN=owned"]

            def create_time(self):
                return 101.0

        process = Process()
        monkeypatch.setattr(
            delegate, "_psutil", lambda: fake_psutil([process]))
        found = delegate._tagged_processes(
            "owned", current={101: (1, 101.0)})
    finally:
        sys.path.pop(0)
    assert found == {101: 101.0}


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
            raise delegate.ProcessDiscoveryError(
                "process discovery unavailable")

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
            raise delegate.ProcessDiscoveryError(
                "process discovery unavailable")

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
            raise delegate.ProcessDiscoveryError("process discovery unavailable")

        monkeypatch.setattr(delegate, "_descendants", lambda _pid: unavailable())
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
        monkeypatch.setattr(delegate, "_descendants", lambda _pid: {})
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


@pytest.mark.parametrize("platform", ("posix", "nt"))
def test_launch_companion_uses_platform_specific_spawn_options(
        repo, tmp_path, monkeypatch, platform):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        captured = {}

        class Process:
            pid = 101
            returncode = 0

        def spawn(_argv, **kwargs):
            captured.update(kwargs)
            return Process()

        monkeypatch.setattr(delegate.os, "name", platform)
        monkeypatch.setattr(
            delegate.subprocess, "CREATE_NEW_PROCESS_GROUP", 1,
            raising=False)
        monkeypatch.setattr(delegate, "append_delegation", lambda *_args: None)
        monkeypatch.setattr(
            delegate, "safe_factory_write_bytes", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(delegate, "sha256_of", lambda _path: "digest")
        monkeypatch.setattr(delegate, "companion_script", lambda: tmp_path / "x")
        monkeypatch.setattr(delegate.shutil, "which", lambda _name: "node")
        monkeypatch.setattr(delegate, "_process_table", lambda: {})
        monkeypatch.setattr(delegate, "_capture_spawn_identity", lambda _proc: 1.0)
        monkeypatch.setattr(delegate, "_wait_and_reap", lambda *_args: True)
        monkeypatch.setattr(delegate.subprocess, "Popen", spawn)
        delegate.launch_companion(
            repo, task_id="T1", text="brief", path=repo / ".factory" / "x.md",
            task_sha256_value="digest", model="model", effort="effort",
            write=False,
        )
    finally:
        sys.path.pop(0)
    if platform == "nt":
        assert captured["creationflags"] == 1
        assert "preexec_fn" not in captured
    else:
        assert captured["start_new_session"] is True
        assert captured["preexec_fn"] is delegate.unblock_termination_signals_in_child
    assert captured["env"]["PYTHONUTF8"] == "1"
    assert captured["stdout"].encoding == "utf-8"
    assert captured["stdout"].errors == "replace"
    assert captured["stderr"].encoding == "utf-8"
    assert captured["stderr"].errors == "replace"


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
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes", lambda _token: True)
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
            "pid_started": "10.0",
        }
        recorded = []
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: True)
        monkeypatch.setattr(
            delegate, "_process_start_identity",
            lambda _pid: 11.0,
        )
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes", lambda _token: True)
        monkeypatch.setattr(
            delegate, "append_delegation",
            lambda _base, record: recorded.append(record),
        )
        delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert recorded[-1]["launch_status"] == "failed"


def test_stale_launch_reconciliation_preserves_live_legacy_identity(
        repo, monkeypatch, capsys):
    sys.path.insert(0, str(repo / "factory" / "scripts"))
    try:
        import forge_cli.delegate as delegate
        entry = {
            "task": "T1", "write": True, "launch_id": "old",
            "launch_status": "running", "pid": 123, "pgid": 123,
            "pid_started": "Mon Aug 12 10:00:00 2024",
        }
        reaped = []
        monkeypatch.setattr(delegate, "load_delegations", lambda _base: [entry])
        monkeypatch.setattr(delegate, "_pid_alive", lambda _pid: True)
        monkeypatch.setattr(delegate, "_process_start_identity", lambda _pid: 10.0)
        monkeypatch.setattr(
            delegate, "_terminate_tagged_processes",
            lambda _token: reaped.append(_token) or True)
        with pytest.raises(SystemExit):
            delegate._reconcile_stale_launches(repo, "T1")
    finally:
        sys.path.pop(0)
    assert reaped == []
    assert "already has a foreground delegation running" in capsys.readouterr().out


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


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX only: wrapper termination also exercises HUP/QUIT",
)
@pytest.mark.parametrize("wrapper_signal", (
    [signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT]
    if os.name != "nt" else []
))
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


@pytest.mark.skipif(os.name != "nt", reason="native Windows process-group E2E")
def test_windows_delegation_launches_and_reaps(repo, tmp_path):
    import psutil

    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    home = fake_companion_home(tmp_path)
    companion = next(home.glob(
        ".claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs"))
    companion.write_text(
        "import { spawn } from 'node:child_process';\n"
        "import { writeFileSync } from 'node:fs';\n"
        "const child = spawn(process.execPath, ['-e', "
        "'setInterval(() => {}, 1000)'], {stdio: 'ignore'});\n"
        "writeFileSync('.factory/windows-worker.pid', String(child.pid));\n"
        "setInterval(() => {}, 1000);\n"
    )
    proc = subprocess.Popen(
        [sys.executable, str(repo / "factory/scripts/forge.py"),
         "delegate", "T1"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "HOME": str(home), "USERPROFILE": str(home)},
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    child_pid = 0
    child_started = 0.0
    try:
        lock = delegation_lock(repo, "T1")
        child_pid_path = repo / ".factory" / "windows-worker.pid"
        latest = {}
        for _ in range(200):
            if lock.exists() and delegation_ledger(repo).exists():
                latest = json.loads(
                    delegation_ledger(repo).read_text().splitlines()[-1])
                if (latest.get("launch_status") == "running"
                        and child_pid_path.exists()):
                    break
            threading.Event().wait(0.05)
        if latest.get("launch_status") != "running":
            if proc.poll() is None:
                proc.terminate()
            out, err = proc.communicate(timeout=10)
            assert lock.exists() and latest.get("launch_status") == "running", (
                f"delegate never recorded running; stdout={out!r} stderr={err!r}")
        assert lock.exists()
        assert latest["argv"][-1] == "--write"
        child_pid = int(child_pid_path.read_text())
        child_started = psutil.Process(child_pid).create_time()

        psutil.Process(latest["pid"]).terminate()
        proc.communicate(timeout=20)
        assert proc.returncode != 0

        def child_is_alive() -> bool:
            try:
                child = psutil.Process(child_pid)
                return (child.create_time() == child_started
                        and child.is_running()
                        and child.status() != psutil.STATUS_ZOMBIE)
            except psutil.NoSuchProcess:
                return False

        for _ in range(100):
            if not child_is_alive():
                break
            threading.Event().wait(0.05)
        assert not child_is_alive()
        sys.path.insert(0, str(repo / "factory" / "scripts"))
        try:
            from forge_cli.delegate import _lock_is_held
            assert not _lock_is_held(lock)
        finally:
            sys.path.pop(0)
        terminal = json.loads(
            delegation_ledger(repo).read_text().splitlines()[-1])
        assert terminal["launch_status"] == "failed"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate(timeout=10)
        if child_pid:
            try:
                child = psutil.Process(child_pid)
                if child.create_time() == child_started:
                    child.kill()
            except psutil.NoSuchProcess:
                pass


@pytest.mark.skipif(os.name != "nt", reason="native Windows encoding E2E")
def test_windows_delegation_success_round_trips_unicode_handoff(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    home = fake_companion_home(tmp_path)
    companion = next(home.glob(
        ".claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs"))
    companion.write_text(
        "process.stdout.write('worker\\u2192handoff');\n"
    )

    proc = subprocess.run(
        [sys.executable, str(repo / "factory/scripts/forge.py"),
         "delegate", "T1"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "HOME": str(home), "USERPROFILE": str(home)},
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "worker→handoff" in proc.stdout
    terminal = json.loads(
        delegation_ledger(repo).read_text().splitlines()[-1])
    assert terminal["launch_status"] == "succeeded"
    assert terminal["argv"][-1] == "--write"


def test_read_only_diagnostic_does_not_revoke_write_launch(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK)
    home = str(fake_companion_home(tmp_path))
    code, out = run(repo, "forge.py", "delegate", "T1", "--read-only",
                    env={"HOME": home})
    assert code == 0, out
    write_in_scope(repo, "src/core.py")
    stamp_and_commit(repo)
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
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    code, out = run(repo, "forge.py", "next")
    assert code == 0, out
    assert "forge delegate T1" in out and "forge codex status" not in out


def test_forge_next_routes_the_jit_frontier_states(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    # A user_facing task, so the per-task design-skill guidance surfaces at
    # every frontier state as the task walks toward delegation.
    ui_task = {**STAGE_TASK, "user_facing": True}

    def next_action() -> str:
        code, out = run(repo, "forge.py", "next")
        assert code == 0 and "PHASE: implementing" in out, out
        actions = [line for line in out.splitlines() if ". [dev]" in line]
        assert len(actions) == 1, out
        assert "emil-design-eng" in out
        return actions[0]

    skeleton = skeletal_stage_task("T1")
    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [skeleton]}),
    )
    assert code == 0, out
    action = next_action()
    assert "plan mode" not in action  # 0050: authoring is mode-agnostic
    assert "factory/prompts/planner.md" in action
    assert "record_decomposition_from_json.py" in action
    assert "stage start" not in action and "forge delegate" not in action

    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [ui_task]}),
    )
    assert code == 0, out
    action = next_action()
    assert "mode-agnostic" in action  # 0050
    assert "do NOT present it in chat" in action
    assert "## Workflow" in action and "## Manual Verification" in action
    assert "task plan save" in action
    assert "stage start" not in action and "forge delegate" not in action

    source = tmp_path / "T1.md"
    source.write_text(
        "# Task plan — T1\n\nImplement the recorded contract.\n\n## Workflow\n\nRequest -> handler -> store.\n\n## Manual Verification\n\n1. Run it. 2. See the row.\n",
        encoding="utf-8",
    )
    code, out = post_hook(repo, plan_hook_payload(source))
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "task", "plan", "save", "T1", "--from", str(source),
    )
    assert code == 0, out
    action = next_action()
    assert "factory/prompts/griller.md --gate task" in action
    assert "stage start" not in action and "forge delegate" not in action

    code, out = record_task_grill(repo, ui_task)
    assert code == 0, out
    stale = {**ui_task, "reviewer_focus": "the changed bounded contract",
             "write_scope": ["src/changed/"]}
    code, out = run(
        repo,
        "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [stale]}),
    )
    assert code == 0, out
    assert "factory/prompts/griller.md --gate task" in next_action()

    code, out = record_task_grill(repo, stale)
    assert code == 0, out
    action = next_action()
    assert f"./forge stage start {stale['id']}" in action
    assert "forge delegate" not in action

    code, out = run(repo, "forge.py", "stage", "start", stale["id"])
    assert code == 0, out
    action = next_action()
    assert f"./forge delegate {stale['id']}" in action
    assert "stage start" not in action

    from forge_cli.board import next_actions
    assert action.split(". ", 1)[1] in next_actions(repo)["steps"]


def test_board_task_rows_match_frontier_states(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)

    def assert_state(action: str | None, state: str) -> None:
        frontier = task_frontier_state(repo)
        assert (frontier[0] if frontier else None) == action
        assert task_rows(repo) == [{
            "id": "T1", "state": state, "grill_freshness": "missing",
            "budget": None,
        }]

    skeleton = skeletal_stage_task("T1")
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [skeleton]}),
    )
    assert code == 0, out
    assert_state("author-contract", "skeleton")

    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [STAGE_TASK]}),
    )
    assert code == 0, out
    assert_state("author-task-plan", "author-task-plan")

    code, out = record_task_grill(repo, STAGE_TASK)
    assert code == 0, out
    frontier = task_frontier_state(repo)
    assert frontier and frontier[0] == "stage-start"
    assert task_rows(repo)[0]["state"] == "grilled"
    assert task_rows(repo)[0]["grill_freshness"] == "fresh"

    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    frontier = task_frontier_state(repo)
    assert frontier and frontier[0] == "delegate"
    assert task_rows(repo)[0]["state"] == "active"

    # Per-task PRs are the symphony standard: a stage-done task first surfaces
    # its own PR (await-merge) and only reads "done" once its marker is on the
    # trunk. Configure a trunk and land the marker so the story is truly done.
    configure_origin_main(repo, tmp_path / "board-rows-origin.git")
    stages = json.loads((repo / ".factory" / "stages.json").read_text())
    stages["stages"][0]["status"] = "done"
    write_stages(repo, stages)
    assert task_frontier_state(repo)[0:1] == ("await-merge",)
    assert task_rows(repo)[0]["state"] == "await-merge"

    publish_task_marker(repo, "ENG-1", "T1")
    assert task_frontier_state(repo) is None
    assert task_rows(repo)[0]["state"] == "done"


def test_task_frontier_honours_dependency_dag(repo, tmp_path):
    """#145 stage A: a deps-met task may start ahead of an unrelated earlier task."""
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    from factory_lib import require_ready_task, task_ready_ids
    def task(task_id: str, **extra) -> dict:
        contracts = [
            {**contract, "id": f"{contract['id']}-{task_id}"}
            for contract in STAGE_TASK["plan_contracts"]
        ]
        return {**STAGE_TASK, "id": task_id, "plan_contracts": contracts,
                "acceptance_criteria": [c["statement"] for c in contracts],
                **extra}

    tasks = [
        task("T1"),
        task("T2"),
        task("T3", dependencies=["T1"]),
        task("T4", dependencies=["T2"]),
    ]
    skeletons = [
        {**skeletal_stage_task(t["id"]), **({"dependencies": t["dependencies"]}
                                            if "dependencies" in t else {})}
        for t in tasks
    ]
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": skeletons}),
    )
    assert code == 0, out
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [tasks[0], *skeletons[1:]]}),
    )
    assert code == 0, out
    # Nothing done yet: only T1 is ready (T2 follows its predecessor T1).
    assert task_ready_ids(repo) == ["T1"]
    configure_origin_main(repo, tmp_path / "dag-origin.git")
    stages = json.loads((repo / ".factory" / "stages.json").read_text())
    stages["stages"][0]["status"] = "done"
    write_stages(repo, stages)
    # T1 done: T2 (predecessor default) and T3 (explicit dep) are ready; T4 waits on T2.
    assert task_ready_ids(repo) == ["T2", "T3"]
    # Per-task PRs are the symphony standard: T1's own PR merges (its marker
    # lands on the trunk) before the next task, so the frontier advances to T2
    # rather than staying on T1's await-merge.
    publish_task_marker(repo, "ENG-1", "T1")
    frontier = task_frontier_state(repo)
    assert frontier and frontier[1]["id"] == "T2"
    # Execution detail may be authored on the ready T3 ahead of T2, never on T4.
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [tasks[0], skeletons[1], tasks[2], skeletons[3]]}),
    )
    assert code == 0, out
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [tasks[0], skeletons[1], tasks[2], tasks[3]]}),
    )
    assert code != 0 and "T4: pending non-frontier task" in out
    require_ready_task(repo, "T3", require_approval=False, require_grill=False)
    with pytest.raises(SystemExit, match="T4 is not ready: waiting on T2"):
        require_ready_task(repo, "T4", require_approval=False, require_grill=False)
    # One active stage at a time: with T2 active, T3 must wait for it.
    stages["stages"][1]["status"] = "active"
    write_stages(repo, stages)
    frontier = task_frontier_state(repo)
    assert frontier and frontier[1]["id"] == "T2"
    with pytest.raises(SystemExit, match="T3 cannot start while T2 is active"):
        require_ready_task(repo, "T3", require_approval=False, require_grill=False)


def test_stage_start_and_delegate_refuse_without_approved_task_plan(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "Task plan required first" in out
    code, out = record_task_grill(repo, STAGE_TASK, approve=False)
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code != 0 and "Task plan approval required" in out

    code, out = run(
        repo, "forge.py", "task", "approve", "T1", "--by", "Test Human",
    )
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    task_plan = story_state(repo) / "task-plans" / "T1.md"
    task_plan.write_text(task_plan.read_text() + "\nChanged after approval.\n")
    code, out = run(
        repo, "forge.py", "delegate", "T1", env=fake_companion_env(tmp_path),
    )
    assert code != 0 and "Task plan approval required" in out
    assert not delegation_ledger(repo).exists()


def test_forge_next_and_board_route_author_task_plan_and_await_approval(
        repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [STAGE_TASK])
    from forge_cli.board import next_actions

    def assert_route(frontier: str, row_state: str, command: str) -> None:
        assert task_frontier_state(repo)[0] == frontier
        assert task_rows(repo)[0]["state"] == row_state
        code, output = run(repo, "forge.py", "next")
        assert code == 0, output
        action = next(
            line.split(". ", 1)[1]
            for line in output.splitlines() if ". [dev]" in line
        )
        assert command in action
        assert action in next_actions(repo)["steps"]

    assert_route("author-task-plan", "author-task-plan", "task plan save T1")
    source = tmp_path / "T1.md"
    source.write_text("# T1 plan\n\nImplement the bounded task.\n\n## Workflow\n\nRequest -> handler -> store.\n\n## Manual Verification\n\n1. Run it. 2. See the row.\n")
    code, out = post_hook(repo, plan_hook_payload(source))
    assert code == 0, out
    code, out = run(
        repo, "forge.py", "task", "plan", "save", "T1", "--from", str(source),
    )
    assert code == 0, out
    assert_route("grill", "ready", "Grill the saved T1 plan")
    payload = task_grill_payload(STAGE_TASK)
    code, out = log_grill_rounds(repo, payload["rounds"])
    assert code == 0, out
    code, out = run(
        repo, "record_grill_from_json.py", "--gate", "task", "--task", "T1",
        stdin=json.dumps(payload),
    )
    assert code == 0, out
    assert_route("await-approval", "await-approval", "task approve T1")

    code, out = run(
        repo, "forge.py", "task", "approve", "T1", "--by", "Test Human",
    )
    assert code == 0, out
    assert task_frontier_state(repo)[0] == "stage-start"
    assert task_rows(repo)[0]["state"] == "grilled"


def test_board_task_rows_show_grill_freshness_and_budget(
        repo, tmp_path, monkeypatch):
    task = {**STAGE_TASK, "review_budget": {
        "max_changed_files": 2, "max_changed_lines": 5,
    }}
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, [task])
    code, out = record_task_grill(repo, task)
    assert code == 0, out
    assert task_rows(repo)[0]["grill_freshness"] == "fresh"

    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    write_in_scope(repo, "src/core.py", "first\nsecond\n")
    git(repo, "add", "src/core.py")
    row = task_rows(repo)[0]
    assert row["state"] == "active"
    assert row["grill_freshness"] == "stale"
    assert row["budget"] == {
        "used": {"files": 1, "lines": 2},
        "limit": {"files": 2, "lines": 5},
    }

    from forge_cli import board
    real_task_rows = board.task_rows
    calls = []

    def counted_task_rows(root):
        calls.append(root)
        return real_task_rows(root)

    monkeypatch.setattr(board, "task_rows", counted_task_rows)
    state = board.aggregate_state(repo)
    story = next(item for item in state["stories"] if item["key"] == "ENG-1")
    assert story["tasks"][0]["state"] == "active"
    assert len(calls) == 1
    calls.clear()
    detail = board.story_detail(repo, "ENG-1")
    assert detail["tasks"][0]["budget"] == row["budget"]
    assert len(calls) == 1

    page = (HARNESS / "factory" / "board" / "index.html").read_text()
    task_block = page[page.index("function taskBlock(story)"):
                      page.index("function findingList(")]
    assert "task-state" in task_block
    assert "t.grill_freshness" in task_block
    assert "t.budget.used.files" in task_block
    assert "<b>Budget</b>" in task_block


def test_docs_state_the_enforced_jit_contract():
    factory_doc = (HARNESS / "docs" / "FACTORY.md").read_text()
    workflow = (HARNESS / "WORKFLOW.md").read_text()
    decomposer = (HARNESS / "factory" / "prompts" / "decomposer.md").read_text()
    forge_skill = (HARNESS / "factory" / "skills" / "forge.md").read_text()
    agents = (HARNESS / "AGENTS.md").read_text()

    initial_contract = factory_doc.split(
        "The first decomposition records the ordered task list.", 1
    )[1].split("Immediately before the next pending leaf", 1)[0]
    for deferred in ("write scope", "verify commands", "required tests",
                     "reviewer focus"):
        assert deferred not in initial_contract.lower()

    for text in (factory_doc, workflow, decomposer):
        assert "factory/prompts/planner.md" in text
        lowered = text.lower()
        assert "re-record" in lowered
        assert "task grill" in lowered
        assert "stage start" in lowered
        assert "delegate" in lowered
    assert "Do not guess later-task" in factory_doc  # JIT rule (wraps in FACTORY.md)
    assert "later-task detail during the initial decomposition" in workflow
    assert "later tasks remains deferred" in decomposer
    for field in ("`write_scope`", "`required_tests`", "`verify_commands`",
                  "`acceptance_criteria`"):
        assert field in decomposer.split("freshness digest", 1)[1]

    implementing_route = next(
        line for line in forge_skill.splitlines()
        if line.startswith("| implementing |")
    )
    assert "one frontier action" in implementing_route
    assert "author/re-record" in implementing_route
    assert "task griller" in implementing_route
    assert "stage start" in implementing_route and "delegate" in implementing_route
    assert "findings and refusals always in full" in agents


@pytest.mark.skipif(
    not PLAN_MODE_DECISION_FIXTURE.is_file(),
    reason="requires the plan-mode decision harness-source fixture",
)
def test_docs_state_enforced_order():
    decision = PLAN_MODE_DECISION_FIXTURE.read_text()
    loop_spec = (
        HARNESS / "docs" / "specs" / "accountable-engineering-loop.md"
    ).read_text()
    approval_spec = (
        HARNESS / "docs" / "specs" / "plan-approval.md"
    ).read_text()
    workflow = (HARNESS / "WORKFLOW.md").read_text()

    assert "status: accepted" in decision
    assert 'confirmed_by: "Ravi Kiran Vemula"' in decision
    assert "status: confirmed" in loop_spec
    assert "status: confirmed" in approval_spec

    assert "zero-gap grill may validly have" not in loop_spec
    assert "plan mode cannot be the enforcement signal" not in approval_spec
    assert "recommended review step" not in approval_spec
    assert "marker the agent cannot mint" not in approval_spec
    for text in (decision, loop_spec, approval_spec):
        unwrapped = " ".join(text.split())
        assert "GATE_ROUND_FLOORS" in text or "floors spec 2" in unwrapped
        assert "frontier_empty: true" in text
        assert "ledger-matched" in text or "match a logged record" in unwrapped
    for text in (decision, approval_spec):
        assert "plan_body_digest" in text

    task_loop = workflow.split("## Task Planning", 1)[1].split(
        "During implementation", 1
    )[0]
    enforced_order = (
        "task plan is authored in plan mode",
        "task grill delivers its rounds",
        "human approves",
        "stage start",
        "delegate",
    )
    positions = [task_loop.index(step) for step in enforced_order]
    assert positions == sorted(positions)


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
    run(repo, "forge.py", "roadmap", "link-spec", "REF-1", "--spec", "docs/specs/base.md")
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
    task = task_with_plan_contracts(DECOMP["tasks"][0])
    record_skeleton_then_frontier(repo, [task])
    code, out = record_task_grill(repo, task)
    assert code == 0, out
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
    quality_path = story_state(repo) / "reviews" / "quality.json"
    quality = json.loads(quality_path.read_text())
    quality["contract_verdicts"] = [{
        "contract_id": "C1",
        "verdict": "implemented",
        "evidence": "src/core.py:1",
    }]
    quality_path.write_text(json.dumps(quality))
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
    assert ".codex/hooks.json" in files
    assert not any("__pycache__" in f or f.endswith(".pyc") for f in files)
    code, out = run(repo, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out
    # disarmed vendored hook -> drift
    hooks = repo / ".codex" / "hooks.json"
    hooks.write_text(json.dumps({"hooks": {}}) + "\n")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "edited: .codex/hooks.json" in out, out
    # edited gate file -> drift
    git(repo, "checkout", "--", ".codex/hooks.json")
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


def test_decomposition_recorder_validates_plan_contracts(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)

    task = {**DECOMP["tasks"][0], "id": "T1"}
    for malformed in (None, False, 0, "", {}):
        payload = {**DECOMP, "tasks": [{**task, "plan_contracts": malformed}]}
        code, out = run(repo, "record_decomposition_from_json.py",
                        stdin=json.dumps(payload))
        assert code != 0 and "task T1" in out and "plan_contracts must be a list" in out

    malformed_entries = [
        "not-an-object",
        {"id": "C1", "statement": "does the thing"},
        {"id": "C1", "statement": "does the thing", "source": "plan#scope",
         "extra": "no"},
        {"id": "", "statement": "does the thing", "source": "plan#scope"},
    ]
    for entry in malformed_entries:
        payload = {**DECOMP, "tasks": [{**task, "plan_contracts": [entry]}]}
        code, out = run(repo, "record_decomposition_from_json.py",
                        stdin=json.dumps(payload))
        assert code != 0 and "task T1" in out and "entry 1" in out

    skeletons = [task_skeleton(task),
                 {**skeletal_stage_task("T2", "second slice"),
                  "dependencies": ["T1"]}]
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": skeletons}),
    )
    assert code == 0, out

    contract = {"id": "C1", "statement": "does the thing",
                "source": "plans/active/plan.md#scope"}
    second = {**skeletal_stage_task("T2", "second slice"),
              "dependencies": ["T1"], "plan_contracts": [contract]}
    duplicate = {**DECOMP, "tasks": [
        {**task, "plan_contracts": [contract]}, second,
    ]}
    code, out = run(repo, "record_decomposition_from_json.py",
                    stdin=json.dumps(duplicate))
    assert code != 0 and "task T2" in out and "entry 1" in out and "duplicate" in out

    valid = {**DECOMP, "tasks": [
        {**task, "plan_contracts": [contract]}, skeletons[1],
    ]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(valid))
    assert code == 0, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": task["title"], "status": "done"},
            {"id": "T2", "title": second["title"], "status": "pending"},
        ],
    })
    valid["tasks"][1] = {
        **second, "plan_contracts": [{**contract, "id": "C2"}],
    }
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(valid))
    assert code == 0, out
    recorded = json.loads((story_state(repo) / "decomposition.json").read_text())
    assert [item["id"] for item in recorded["tasks"][1]["plan_contracts"]] == ["C2"]


def test_review_brief_composes_contract_brief(repo, tmp_path):
    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code != 0 and "No recorded decomposition" in out

    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    first = {**DECOMP["tasks"][0], "id": "T1", "reviewer_focus": "focus one",
             "plan_contracts": [{"id": "C1", "statement": "first statement",
                                  "source": "plan.md#first"}]}
    second = {**skeletal_stage_task("T2", "second slice"),
              "dependencies": ["T1"], "reviewer_focus": ["focus two", "focus three"],
              "plan_contracts": [{"id": "C2", "statement": "second statement",
                                   "source": "plan.md#second"}]}
    skeletons = [task_skeleton(first), task_skeleton(second)]
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first, skeletons[1]]}))
    assert code == 0, out
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": first["title"], "status": "done"},
            {"id": "T2", "title": second["title"], "status": "pending"},
        ],
    })
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [first, second]}))
    assert code == 0, out

    code, out = run(repo, "forge.py", "review-brief", "T1", "--repo", str(repo))
    assert code == 0 and out.strip() == ".factory/review-briefs/T1.md"
    per_task = (repo / out.strip()).read_text()
    assert all(value in per_task for value in (
        "C1", "plan.md#first", "first statement", "focus one",
        "implemented | partial | missing", "contract_verdicts", "file:line",
    ))
    assert "C2" not in per_task and "focus two" not in per_task

    code, out = run(repo, "forge.py", "review-brief", "--all", "--repo", str(repo))
    assert code == 0 and out.strip() == ".factory/review-briefs/all.md"
    branch = (repo / out.strip()).read_text()
    assert all(value in branch for value in (
        "C1", "C2", "focus one", "- focus two", "- focus three"))

    for args, expected in [
        (("review-brief",), "exactly one"),
        (("review-brief", "T1", "--all"), "exactly one"),
        (("review-brief", "UNKNOWN"), "Unknown decomposition task id"),
    ]:
        code, out = run(repo, "forge.py", *args, "--repo", str(repo))
        assert code != 0 and expected in out
    module = (repo / "factory" / "scripts" / "forge_cli" / "review_brief.py").read_text()
    assert "forge_cli.delegate" not in module and "import delegate" not in module


def test_review_brief_mints_run_id_and_lenses_echo_it(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    record_skeleton_then_frontier(repo, DECOMP["tasks"])
    (repo / "app.py").write_text("print('reviewed branch')\n")
    git(repo, "add", "app.py")
    git(repo, "commit", "-q", "-m", "product change")

    code, out = run(repo, "forge.py", "review-brief", "--all", "--repo", str(repo))
    assert code == 0, out
    brief = repo / ".factory" / "review-briefs" / "all.md"
    token = json.loads((story_state(repo) / "review-run.json").read_text())
    assert token["brief_sha256"] == hashlib.sha256(brief.read_bytes()).hexdigest()
    assert token["branch_diff_digest"] == branch_diff_digest(repo)
    assert token["review_run_id"] == hashlib.sha256(
        (token["brief_sha256"] + token["branch_diff_digest"]).encode()
    ).hexdigest()
    assert token["minted_at"]

    for aspect in ("quality", "performance", "security"):
        code, out = run(repo, "record_review_from_json.py", "--aspect", aspect,
                        stdin=json.dumps(review_payload()))
        assert code == 0, out
        review = json.loads(
            (story_state(repo) / "reviews" / f"{aspect}.json").read_text()
        )
        for field in ("review_run_id", "brief_sha256", "branch_diff_digest"):
            assert review[field] == token[field]

    (repo / "app.py").write_text("print('changed after review run')\n")
    git(repo, "add", "app.py")
    git(repo, "commit", "-q", "-m", "change reviewed branch")
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload()))
    assert code != 0 and "Branch changed after the review run" in out


def test_quality_review_requires_contract_verdicts(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    contracts = [
        {"id": "C1", "statement": "first statement", "source": "plan.md#first"},
        {"id": "C2", "statement": "second statement", "source": "plan.md#second"},
    ]
    tasks = [
        {**DECOMP["tasks"][0], "id": "T1", "plan_contracts": [contracts[0]]},
        {**skeletal_stage_task("T2", "second slice"),
         "dependencies": ["T1"], "plan_contracts": [contracts[1]]},
    ]
    skeletons = [task_skeleton(task) for task in tasks]
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [tasks[0], skeletons[1]]}))
    assert code == 0, out
    # BOTH tasks are in scope here: a review only verdicts the contracts of
    # tasks that have started or shipped (0049), so leaving T2 pending would
    # take C2 out of scope and make the refusal matrix below meaningless. The
    # scoping rule itself is pinned by
    # test_quality_review_ignores_contracts_of_tasks_that_have_not_started.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": tasks[0]["title"], "status": "done"},
            {"id": "T2", "title": tasks[1]["title"], "status": "active"},
        ],
    })
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": tasks}))
    assert code == 0, out
    mint_review_run(repo)

    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload()))
    assert code != 0 and "contract_verdicts" in out

    def verdict(contract_id, value="implemented", evidence="src/app.py:12"):
        return {"contract_id": contract_id, "verdict": value, "evidence": evidence}

    refused = [
        ([verdict("C1")], "C2"),
        ([verdict("C1"), verdict("UNKNOWN")], "unknown contract id"),
        ([verdict("C1"), verdict("C1")], "duplicate contract id"),
        ([verdict("C1", "almost"), verdict("C2")], "implemented, partial, or missing"),
        ([verdict("C1", evidence=""), verdict("C2")], "evidence"),
    ]
    for contract_verdicts, expected in refused:
        code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                        stdin=json.dumps(review_payload(
                            contract_verdicts=contract_verdicts)))
        assert code != 0 and expected in out

    partial = [verdict("C1", "partial"), verdict("C2")]
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload(contract_verdicts=partial)))
    assert code == 0, out
    quality = json.loads((story_state(repo) / "reviews" / "quality.json").read_text())
    assert quality["blocking_findings"] == [{
        "category": "plan-contract-partial",
        "area": "plan.md#first",
        "summary": "C1: first statement",
    }]

    code, out = run(repo, "record_review_from_json.py", "--aspect", "performance",
                    stdin=json.dumps(review_payload()))
    assert code == 0, out


def test_quality_review_ignores_contracts_of_tasks_that_have_not_started(
        repo, tmp_path):
    """A per-task review verdicts the contracts of tasks that have STARTED or
    shipped -- never those of a task nobody has begun (0049).

    Under the old story-level shape, reviewing the first task demanded verdicts
    for every later task's contracts, which a reviewer cannot honestly give.
    """
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    contracts = [
        {"id": "C1", "statement": "first statement", "source": "plan.md#first"},
        {"id": "C2", "statement": "second statement", "source": "plan.md#second"},
    ]
    tasks = [
        {**DECOMP["tasks"][0], "id": "T1", "plan_contracts": [contracts[0]]},
        {**skeletal_stage_task("T2", "second slice"),
         "dependencies": ["T1"], "plan_contracts": [contracts[1]]},
    ]
    skeletons = [task_skeleton(task) for task in tasks]
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": skeletons}))
    assert code == 0, out
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": [tasks[0], skeletons[1]]}))
    assert code == 0, out
    # T1 done, so T2 is the frontier and may carry its contract -- a pending
    # non-frontier task is refused one outright (JIT execution detail). T2 has
    # still not STARTED, which is the case under test.
    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [
            {"id": "T1", "title": tasks[0]["title"], "status": "done"},
            {"id": "T2", "title": tasks[1]["title"], "status": "pending"},
        ],
    })
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(
        {**DECOMP, "tasks": tasks}))
    assert code == 0, out
    mint_review_run(repo)

    only_c1 = [{"contract_id": "C1", "verdict": "implemented",
                "evidence": "src/app.py:12"}]
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload(contract_verdicts=only_c1)))

    assert code == 0, out
    # And C2 is not merely optional -- it is out of scope, so volunteering it
    # is an unknown id rather than a bonus.
    both = only_c1 + [{"contract_id": "C2", "verdict": "implemented",
                       "evidence": "src/app.py:20"}]
    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload(contract_verdicts=both)))
    assert code != 0 and "unknown contract id" in out


def test_lite_quality_review_ignores_shipped_plan_contracts(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    task = {**DECOMP["tasks"][0], "plan_contracts": [{
        "id": "C1", "statement": "first statement", "source": "plan.md#first",
    }]}
    record_skeleton_then_frontier(repo, [task])

    state = run_state(repo)
    lib = load_factory_lib(repo)
    lib.dump_json(lib.run_state_path(repo), {
        "project": state["project"], "phase": "shipped",
    })
    code, out = run(repo, "forge.py", "mode", "lite", "--by", "test",
                    "--reason", "x")
    assert code == 0, out

    code, out = run(repo, "record_review_from_json.py", "--aspect", "quality",
                    stdin=json.dumps(review_payload()))
    assert code == 0, out


def test_pr_ready_blocks_on_unverified_plan_contracts(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    save_plan(repo, tmp_path)
    contracts = [
        {"id": "C1", "statement": "first statement", "source": "plan.md#first"},
        {"id": "C2", "statement": "second statement", "source": "plan.md#second"},
    ]
    task = {**DECOMP["tasks"][0], "plan_contracts": contracts}
    record_skeleton_then_frontier(repo, [task])
    write_passing_artifacts(repo)

    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "C1, C2" in out and "./forge review-brief" in out

    quality_path = story_state(repo) / "reviews" / "quality.json"
    quality = json.loads(quality_path.read_text())
    quality["contract_verdicts"] = [
        {"contract_id": "C1", "verdict": "implemented", "evidence": "src/a.py:1"},
        {"contract_id": "C2", "verdict": "partial", "evidence": "src/b.py:2"},
    ]
    quality_path.write_text(json.dumps(quality))
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "C2" in out and "review-brief" in out

    quality["contract_verdicts"][1]["verdict"] = "implemented"
    quality_path.write_text(json.dumps(quality))
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_pr_ready_refuses_incoherent_lens_set(repo, tmp_path):
    scoped = prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    performance_path = scoped / "reviews" / "performance.json"
    performance = json.loads(performance_path.read_text())
    original_run_id = performance["review_run_id"]
    performance["review_run_id"] = "different-run"
    performance_path.write_text(json.dumps(performance))

    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "must share one review_run_id" in out

    performance["review_run_id"] = original_run_id
    performance_path.write_text(json.dumps(performance))
    (repo / "app.py").write_text("print('changed after branch review')\n")
    git(repo, "add", "app.py")
    git(repo, "commit", "-q", "-m", "change reviewed branch")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "branch review is stale" in out


def test_pr_ready_refuses_out_of_order_or_dirty_or_unstamped_closeout(repo, tmp_path):
    scoped = prepare_pr_ready_story(repo, tmp_path, scoped_layout=True)
    verify_path = scoped / "verify.json"
    verify = json.loads(verify_path.read_text())

    # Later evidence cannot make up for a missing verify prerequisite.
    verify_path.unlink()
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "successful .factory/verify.json" in out, out
    verify_path.write_text(json.dumps(verify))

    performance_path = scoped / "reviews" / "performance.json"
    performance = json.loads(performance_path.read_text())
    performance["commit"] = "deadbeef"
    performance_path.write_text(json.dumps(performance))
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "performance review must be stamped at HEAD" in out, out
    performance["commit"] = head(repo)
    performance_path.write_text(json.dumps(performance))

    outcome_path = scoped / "outcome.json"
    outcome = json.loads(outcome_path.read_text())
    outcome.pop("commit")
    outcome_path.write_text(json.dumps(outcome))
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "outcome must be stamped at HEAD" in out, out
    outcome["commit"] = head(repo)
    outcome_path.write_text(json.dumps(outcome))

    dirty = repo / "src" / "dirty.py"
    dirty.parent.mkdir(exist_ok=True)
    dirty.write_text("dirty = True\n")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "clean product worktree and index" in out, out
    git(repo, "add", "src/dirty.py")
    code, out = run(repo, "pr_ready.py")
    assert code != 0 and "clean product worktree and index" in out, out

    git(repo, "reset", "-q", "HEAD", "--", "src/dirty.py")
    dirty.unlink()
    code, out = run(repo, "pr_ready.py")
    assert code == 0, out


def test_mode_start_refuses_while_a_stage_is_active(repo, tmp_path):
    start_stage(repo, tmp_path, STAGE_TASK, launch=False)
    # quickfix and lite are out-of-band windows and must refuse mid-stage.
    refused = (
        ("forge.py", "quickfix", "start", "blocked repair"),
        ("forge.py", "mode", "lite", "--by", "Ada", "--reason", "blocked repair"),
    )
    for command in refused:
        code, out = run(repo, *command)
        assert code != 0 and "T1" in out and "stage done" in out, out
        assert not (repo / ".factory" / "quickfix.json").exists()

    # A DEGRADED window is the host-exception valve: it IS allowed mid-stage
    # (bounded + ledgered) so a fix that provably cannot be verified in the
    # companion sandbox can be made without tearing down the active stage.
    code, out = run(repo, "forge.py", "mode", "degraded", "start", "--reason", "host exception")
    assert code == 0, out
    assert (repo / ".factory" / "quickfix.json").exists()
    code, out = run(repo, "forge.py", "mode", "abandon", "--reason", "test cleanup")
    assert code == 0, out

    write_stages(repo, {
        "issue": "ENG-1",
        "stages": [{"id": "T1", "title": "core slice", "status": "done"}],
    })
    all_windows = refused + (
        ("forge.py", "mode", "degraded", "start", "--reason", "blocked repair"),
    )
    for command in all_windows:
        code, out = run(repo, *command)
        assert code == 0, out
        if command[1] == "quickfix":
            code, out = run(repo, "forge.py", "quickfix", "done")
        else:
            code, out = run(repo, "forge.py", "mode", "abandon", "--reason", "test cleanup")
        assert code == 0, out


def test_adopt_and_upgrade_refreeze_the_manifest(repo, tmp_path):
    # adopt repairs a client hook and arms the migrated repo
    legacy = existing_repo(tmp_path)
    legacy_hooks = legacy / ".codex" / "hooks.json"
    legacy_hooks.parent.mkdir(parents=True)
    legacy_hooks.write_text(json.dumps({"hooks": {}}) + "\n")
    git(legacy, "add", ".codex/hooks.json")
    git(legacy, "commit", "-q", "-m", "disable vendored hooks")
    code, out = adopt(legacy)
    assert code == 0, out
    legacy_manifest = legacy / "constitution" / "VENDOR_MANIFEST.json"
    assert legacy_manifest.exists()
    assert ".codex/hooks.json" in json.loads(legacy_manifest.read_text())["files"]
    assert json.loads(legacy_hooks.read_text())["hooks"]
    code, out = run(legacy, "check_vendor_integrity.py")
    assert code == 0 and "OK" in out, out
    # upgrade repairs a drifted hook and re-hashes it clean
    hooks = repo / ".codex" / "hooks.json"
    hooks.write_text(json.dumps({"hooks": {}}) + "\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "drift")
    code, out = run(repo, "check_vendor_integrity.py")
    assert code != 0 and "edited: .codex/hooks.json" in out, out
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "upgrade", "--target", str(repo)],
        cwd=HARNESS, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((repo / "constitution" / "VENDOR_MANIFEST.json").read_text())
    assert ".codex/hooks.json" in manifest["files"]
    assert json.loads(hooks.read_text())["hooks"]
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
        path.relative_to(target / ".claude").as_posix()
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
         "shipped_roadmap_satisfies_the_story_contract or "
         "upgrade_project_skill_structure_and_registration or "
         "upgrade_project_skill_uses_fill_not_import or "
         "sanitise_skill_structure_and_registration or "
         "upgrade_does_not_vendor_the_harness_source_marker or "
         "pr_link_commit_skips_ci or "
         "docs_describe_three_planning_lock_exits or "
         "gate_b_workflows_link_the_branch_and_check_main or "
         "docs_state_enforced_order"],
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

    lib = load_factory_lib(target)
    run_path = lib.run_state_path(target)
    run_state = json.loads(run_path.read_text())
    assert run_state.get("issue_key"), "intake did not actually write run state"

    # And through SHIP: pr_ready reduces run.json to a stable object
    # (pr_ready.py:334) — that projection must keep `project`, or every
    # shipped repo's board would fall back to its directory slug.
    shipped = {k: run_state[k] for k in ("project",) if k in run_state}
    shipped["phase"] = "shipped"
    run_path.write_text(json.dumps(shipped))
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
    """Prompt files stay repo-contained; other options remain default-deny."""
    (repo / "brief.md").write_text("read only\n")
    (repo / "brief-dir").mkdir()
    outside = repo.parent / "outside.md"
    outside.write_text("outside\n")
    (repo / "outside-link.md").symlink_to(outside)
    (repo / "dangling-link.md").symlink_to(repo.parent / "missing.md")
    for cmd in (
        f"node /x/codex-companion.mjs task --prompt-file {outside} go",
        "node /x/codex-companion.mjs task --prompt-file nested/../brief.md go",
        "node /x/codex-companion.mjs task --prompt-file outside-link.md go",
        "node /x/codex-companion.mjs task --prompt-file dangling-link.md go",
        "node /x/codex-companion.mjs task --prompt-file brief-dir go",
        ("node /x/codex-companion.mjs task --prompt-file brief.md "
         "--prompt-file brief.md go"),
        "node /x/codex-companion.mjs task --prompt-file",
        "node /x/codex-companion.mjs status --prompt-file brief.md",
        ("node /x/codex-companion.mjs task-resume-candidate "
         "--prompt-file brief.md"),
        "node /x/codex-companion.mjs task --prompt-file=brief.md go",
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
        'node "$COMPANION" task --write go',
        'bash -c "$COMPANION_CMD"',
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


# --- fix/windows-stage-close-and-plan-change-signoff ---------------------------
# Three regression tests for: the Windows node.EXE launch-binding check, the
# vendored-client factory/ scope exemption, and change-time re-validation when
# an active task's execution contract is amended.


def _seed_valid_launch(repo: Path, stage_id: str, task: dict,
                       started_at: str, argv0: str) -> None:
    """Write a fully valid succeeded write-launch ledger whose argv[0] is
    `argv0`, so `_require_successful_launch` exercises the real predicate."""
    from forge_cli.delegate import argv_digest
    from factory_lib import sha256_of

    brief = repo / ".factory" / "briefs" / f"{stage_id}.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text("composed task brief\n")
    companion_path = "/opt/codex/codex-companion.mjs"
    model, effort = "gpt-test", "medium"
    argv = [
        argv0, companion_path, "task", "--json", "--cwd", str(repo),
        "--model", model, "--effort", effort,
        "--prompt-file", brief.relative_to(repo).as_posix(), "--write",
    ]
    row = {
        "launch_id": "launch-node-ext",
        "task": stage_id,
        "brief_sha256": sha256_of(brief),
        "task_sha256": task_digest(task),
        "write": True,
        "model": model,
        "effort": effort,
        "companion_path": companion_path,
        "argv": argv,
        "argv_sha256": argv_digest(argv),
        "stage_started_at": started_at,
        "process_token": "tok-node-ext",
    }
    ledger = delegation_ledger(repo)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text("\n".join(json.dumps({
        **row,
        "launch_status": status,
        **({"exit_code": 0} if status == "succeeded" else {}),
    }) for status in ("starting", "running", "succeeded")) + "\n")


def test_require_successful_launch_accepts_windows_node_exe(repo):
    """On Windows the launcher is `node.EXE`; the argv[0] check must recognise
    it (stem, case-insensitive) on every platform, while a non-node launcher
    stays rejected."""
    from forge_cli.stages import _require_successful_launch

    started_at = "2026-01-01T00:00:00Z"
    stage = {"id": "T1", "started_at": started_at}
    for argv0 in (
        "C:/Program Files/nodejs/node.EXE",
        "node.exe",
        "/usr/bin/node",
    ):
        _seed_valid_launch(repo, "T1", STAGE_TASK, started_at, argv0)
        # No SystemExit: the launch is recognised as a valid bound write launch.
        _require_successful_launch(repo, "T1", stage, STAGE_TASK)

    _seed_valid_launch(repo, "T1", STAGE_TASK, started_at, "/usr/bin/python3")
    with pytest.raises(SystemExit):
        _require_successful_launch(repo, "T1", stage, STAGE_TASK)


def test_vendored_client_extends_workflow_prefixes(repo, tmp_path):
    """In a vendored client, factory/ (and the other harness machinery) is
    infrastructure a `forge upgrade` may rewrite mid-task, so it never counts as
    a task's product change. The source harness repo keeps the strict set."""
    from factory_lib import vendored_client
    from forge_cli.stages import out_of_scope, workflow_prefixes

    # forge init writes constitution/VENDORED_FROM: this repo is a client.
    assert (repo / "constitution" / "VENDORED_FROM").is_file()
    assert vendored_client(repo) is True
    assert "factory/" in workflow_prefixes(repo)
    assert out_of_scope(repo, ["factory/scripts/x.py"], ["apps/api"]) == []

    # Top-level vendored harness FILES are excluded too (not only directories):
    # a coordinator's own harness patch can leave WORKFLOW.md dirty at stage
    # start, and reverting it mid-stage must not read as an out-of-scope change.
    assert "WORKFLOW.md" in workflow_prefixes(repo)
    assert out_of_scope(repo, ["WORKFLOW.md"], ["apps/api"]) == []

    # A source-harness checkout has no marker: factory/ IS the product.
    source = tmp_path / "source"
    shutil.copytree(repo, source)
    (source / "constitution" / "VENDORED_FROM").unlink()
    assert vendored_client(source) is False
    assert "factory/" not in workflow_prefixes(source)
    assert out_of_scope(
        source, ["factory/scripts/x.py"], ["apps/api"]
    ) == ["factory/scripts/x.py"]
    assert "WORKFLOW.md" not in workflow_prefixes(source)
    assert out_of_scope(source, ["WORKFLOW.md"], ["apps/api"]) == ["WORKFLOW.md"]


def test_rerecord_active_task_contract_change_warns_and_clears_stamp(
        repo, tmp_path):
    """Amending an active task's execution contract is allowed, but its grill
    and plan approval are now stale — surface that AT CHANGE TIME and drop the
    now-stale local review stamp instead of silently deferring to close."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    code, out = record_stage_local(repo)
    assert code == 0, out
    before = json.loads((repo / ".factory" / "stages.json").read_text())
    assert before["stages"][0].get("local_review_stamp")

    amended = {**STAGE_TASK, "write_scope": ["src/", "lib/"]}
    code, out = run(
        repo, "record_decomposition_from_json.py",
        stdin=json.dumps({**DECOMP, "tasks": [amended]}),
    )
    assert code == 0, out
    assert "NOTE: T1 execution contract changed" in out
    assert "STALE" in out
    assert "record_grill_from_json.py --gate task --task T1" in out
    assert "WARNING: T1 was already implemented/reviewed" in out

    after = json.loads((repo / ".factory" / "stages.json").read_text())
    assert after["stages"][0]["status"] == "active"
    assert "local_review_stamp" not in after["stages"][0]


# --- fix/per-task-user-facing-skills ------------------------------------------
# Design-skill enforcement keys off the ACTIVE TASK's user_facing flag, not the
# story's — a backend task in a user_facing story is not forced to attest UI
# design skills.


def test_active_task_user_facing_is_per_task(repo):
    from factory_lib import (active_task_user_facing, git_control_dir,
                             protected_decomposition_state_path)

    control = git_control_dir(repo)
    control.mkdir(parents=True, exist_ok=True)
    (control / "stages.json").write_text(
        json.dumps({"issue": "S", "stages": [{"id": "T1", "status": "active"}]}))
    decomp = protected_decomposition_state_path(repo)
    decomp.parent.mkdir(parents=True, exist_ok=True)

    # user_facing STORY, but the active BACKEND task is not user_facing
    decomp.write_text(json.dumps(
        {"user_facing": True, "tasks": [{"id": "T1", "user_facing": False}]}))
    assert active_task_user_facing(repo) is False

    # a UI task explicitly marked user_facing
    decomp.write_text(json.dumps(
        {"user_facing": True, "tasks": [{"id": "T1", "user_facing": True}]}))
    assert active_task_user_facing(repo) is True

    # no active stage -> not user_facing (nothing to gate)
    (control / "stages.json").write_text(
        json.dumps({"issue": "S", "stages": [{"id": "T1", "status": "done"}]}))
    assert active_task_user_facing(repo) is False


# --- fix/coordinator-contract-and-windows-lock-read ---------------------------
# The Windows lock-read race in the authority snapshot, and robust required-test
# attribution (vitest/jest leaf names + classname / root-relative file paths).


def test_protected_authority_snapshot_excludes_locks(repo):
    """The transient locks/ subtree is not attested authority: the delegation
    machinery holds those files open (exclusively on Windows) while the snapshot
    runs, so including them attests nothing durable and hard-fails the read on
    Windows. Non-lock authority is still captured."""
    from factory_lib import git_control_dir
    from forge_cli.stages import protected_authority_snapshot

    control = git_control_dir(repo)
    control.mkdir(parents=True, exist_ok=True)
    (control / "run.json").write_text('{"issue_key":"X"}')
    (control / "locks" / "task").mkdir(parents=True, exist_ok=True)
    (control / "locks" / "task" / "T1.lock").write_text('{"kind":"stage-close"}')
    snap = protected_authority_snapshot(repo)
    assert "run.json" in snap, "snapshot must still capture non-lock authority"
    assert not any(rel == "locks" or rel.startswith("locks/") for rel in snap)


def test_junit_case_matches_id_exact_and_leaf():
    import xml.etree.ElementTree as ET

    from forge_cli.stages import _junit_case_matches_id

    exact = ET.fromstring('<testcase name="t1-boot-migrate"/>')
    leaf = ET.fromstring(
        '<testcase name="application backbone &gt; t1-boot-migrate"/>')
    other = ET.fromstring('<testcase name="unrelated case"/>')
    assert _junit_case_matches_id(exact, "t1-boot-migrate")
    assert _junit_case_matches_id(leaf, "t1-boot-migrate")
    assert not _junit_case_matches_id(other, "t1-boot-migrate")


def test_junit_case_attributed_file_or_classname_suffix():
    import xml.etree.ElementTree as ET

    from forge_cli.stages import _junit_case_attributed

    rel = "apps/api/test/backbone.e2e-spec.ts"
    # vitest/jest: the source path is in `classname`, relative to the runner root
    vitest = ET.fromstring(
        '<testcase classname="test/backbone.e2e-spec.ts" name="t1-boot-migrate"/>')
    # some runners emit an explicit `file`, repo-relative with a ./ prefix
    withfile = ET.fromstring(f'<testcase file="./{rel}" name="t1-boot-migrate"/>')
    wrong = ET.fromstring(
        '<testcase classname="test/other.spec.ts" name="t1-boot-migrate"/>')
    assert _junit_case_attributed(vitest, rel)
    assert _junit_case_attributed(withfile, rel)
    assert not _junit_case_attributed(wrong, rel)


def test_plan_body_digest_is_line_ending_agnostic(tmp_path):
    """The plan-mode marker digest must be stable across platforms and Git
    autocrlf. plan_body_digest is computed once from the plan-mode source (marker
    create) and again from the saved/committed task plan (marker check); if a
    write_text() on Windows or a core.autocrlf checkout turned LF into CRLF, an
    unnormalised digest would never match and `task approve` would demand a
    spurious re-grill. So LF, CRLF, and CR renderings of the same body must hash
    identically."""
    body = "---\ntitle: T\nkey: value\n---\n\n# Plan\n\nline one\nline two\n"
    lf = tmp_path / "lf.md"
    lf.write_bytes(body.encode("utf-8"))
    crlf = tmp_path / "crlf.md"
    crlf.write_bytes(body.replace("\n", "\r\n").encode("utf-8"))
    cr = tmp_path / "cr.md"
    cr.write_bytes(body.replace("\n", "\r").encode("utf-8"))
    assert plan_body_digest(lf) == plan_body_digest(crlf) == plan_body_digest(cr)

    # The Implementation Assumptions appendix is excluded regardless of newline
    # style, so appending it (in any rendering) does not change the digest.
    with_appendix = body + "\n## Implementation Assumptions\n\n- later\n"
    appended = tmp_path / "appended.md"
    appended.write_bytes(with_appendix.replace("\n", "\r\n").encode("utf-8"))
    assert plan_body_digest(appended) == plan_body_digest(lf)


def test_default_trunk_branch_derives_from_origin_head(tmp_path):
    """The trunk (task markers, task-start base, review diff) is whatever
    origin/HEAD points at — main, develop, trunk — not a hardcoded 'main', so the
    harness works on any repo. Falls back to 'main' when unresolved, preserving
    main-trunk behaviour."""
    from factory_lib import default_trunk_branch
    repo = tmp_path / "r"
    repo.mkdir()
    def git(*a):
        subprocess.run(["git", *GIT_ID, *a], cwd=repo, check=True,
                       capture_output=True, text=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True,
                   capture_output=True, text=True)
    (repo / "f").write_text("x", encoding="utf-8")
    git("add", "."); git("commit", "-qm", "c")
    # No origin/HEAD and no 'origin' remote -> fall back to 'main'.
    assert default_trunk_branch(repo) == "main"
    # A develop-trunk remote: origin/HEAD -> origin/develop resolves to 'develop'.
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                         capture_output=True, text=True).stdout.strip()
    git("update-ref", "refs/remotes/origin/develop", sha)
    git("symbolic-ref", "refs/remotes/origin/HEAD",
        "refs/remotes/origin/develop")
    assert default_trunk_branch(repo) == "develop"


def test_forge_deps_lock_detects_manager_and_guards(tmp_path):
    """`forge deps lock` infers the package manager from the lockfile present
    (generic across pnpm/npm/yarn) and fails clearly with no package.json or no
    lockfile, so it never silently no-ops."""
    from forge_cli.deps import detect_locker, cmd_lock
    root = tmp_path / "app"
    root.mkdir()
    assert detect_locker(root) is None
    (root / "package-lock.json").write_text("{}", encoding="utf-8")
    assert detect_locker(root)[1] == "npm"
    (root / "pnpm-lock.yaml").write_text("", encoding="utf-8")
    assert detect_locker(root)[1] == "pnpm"  # first-match precedence
    # Guard: no package.json -> refuse.
    bare = tmp_path / "bare"
    bare.mkdir()
    with pytest.raises(SystemExit):
        cmd_lock(argparse.Namespace(repo=str(bare)))
    # Guard: package.json but no lockfile -> refuse.
    only_pkg = tmp_path / "pkg"
    only_pkg.mkdir()
    (only_pkg / "package.json").write_text("{}", encoding="utf-8")
    with pytest.raises(SystemExit):
        cmd_lock(argparse.Namespace(repo=str(only_pkg)))


def test_ceremony_target_redirects_rounds_and_markers(repo, tmp_path):
    # A second full factory checkout is the ceremony target.
    target = tmp_path / "sibling"
    proc = subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "sibling", "--target", str(target)],
        capture_output=True, text=True,
        env={**os.environ, "GIT_CONFIG_COUNT": "1",
             "GIT_CONFIG_KEY_0": "gc.auto", "GIT_CONFIG_VALUE_0": "0"},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr

    code, out = run(repo, "forge.py", "ceremony", "target", "set", str(target))
    assert code == 0, out
    code, out = log_grill_rounds(repo, grill_rounds("spec", 1))
    assert code == 0, out
    session_rounds = list((repo / ".factory").rglob("grill-rounds/*.json"))
    target_rounds = list((target / ".factory").rglob("grill-rounds/*.json"))
    assert not session_rounds, "round leaked into the session checkout"
    assert len(target_rounds) == 1, "round did not reach the ceremony target"

    # Clearing the pointer restores self-ledgering.
    code, out = run(repo, "forge.py", "ceremony", "target", "clear")
    assert code == 0, out
    code, out = log_grill_rounds(repo, grill_rounds("spec", 1))
    assert code == 0, out
    assert len(list((repo / ".factory").rglob("grill-rounds/*.json"))) == 1
    assert len(list((target / ".factory").rglob("grill-rounds/*.json"))) == 1

    # A stale pointer fails OPEN to the session checkout (evidence never drops).
    (repo / ".factory" / "ceremony-target").write_text(str(tmp_path / "gone"), encoding="utf-8")
    code, out = log_grill_rounds(repo, grill_rounds("spec", 1))
    assert code == 0, out
    assert len(list((repo / ".factory").rglob("grill-rounds/*.json"))) == 2

    # The CLI refuses self-pointing and non-factory targets.
    code, out = run(repo, "forge.py", "ceremony", "target", "set", str(repo))
    assert code != 0 and "DIFFERENT checkout" in out
    bare = tmp_path / "bare"
    bare.mkdir()
    code, out = run(repo, "forge.py", "ceremony", "target", "set", str(bare))
    assert code != 0 and "not an adopted factory repo" in out
