"""Gate regression suite.

Every case here is either the factory happy path or a defect found and fixed
during review (autoreview rounds 1-8, architecture review, forge-next
walk-through). Tests run against a fresh `forge init` scaffold — the vendored
artifact client repos actually receive. Pure stdlib + pytest; scripts are
exercised through their real CLI surface.
"""
from __future__ import annotations

import argparse
import hashlib
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
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[2]


def run(repo: Path, script: str, *args: str, stdin: str | None = None,
        env: dict[str, str] | None = None):
    proc = subprocess.run(
        [sys.executable, str(repo / "factory" / "scripts" / script), *args],
        cwd=repo, capture_output=True, text=True, input=stdin,
        env={**os.environ, **(env or {})},
    )
    return proc.returncode, proc.stdout + proc.stderr


GIT_ID = ["-c", "user.email=test@knacklabs.dev", "-c", "user.name=Gate Tests"]

# Minimal payload satisfying factory/schemas/decomposition.json
DECOMP = {"status": "recorded", "generated_by": "docs-decomposer",
          "user_facing": True,
          "tasks": [{"id": "T1", "title": "core slice", "write_scope": ["src/"],
                     "objective": "Build the core slice so the feature works end to end.",
                     "acceptance_criteria": ["the slice runs green"]}]}

# Minimal plan body passing `plan save` content gates (Decisions + Surface Impact).
PLAN_BODY = ("## Decisions\nNo new decisions\n\n"
             "## Surface Impact\nAll surfaces: N-A (test plan)\n")


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
    return run(repo, "intake.py", "--issue", key, "--title", title, *extra)


def save_plan(repo: Path, tmp_path: Path) -> tuple[int, str]:
    state = run_state(repo)
    story = state.get("issue_key", "ENG-1")
    ensure_story(repo, story, state.get("title"))
    plan = tmp_path / "plan.md"
    plan.write_text(plan_draft(repo))
    record_grill(repo, "plan", digest_of=plan)  # grill bound to THIS draft
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


def test_spec_confirm_roadmap_derive_and_signoff_gate(repo, tmp_path):
    draft = tmp_path / "billing.md"
    draft.write_text("# Billing\n\nInvoices and payments.\n")
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
        "items": [{"key": "BILL-0", "title": "Missing source"}],
    }))
    code, out = run(repo, "forge.py", "roadmap", "derive",
                    "--input", str(roadmap_input))
    assert code != 0 and "'spec' is required" in out
    roadmap_input.write_text(json.dumps({
        "generated_by": "docs-decomposer",
        "epics": [{"id": "billing", "title": "Billing"}],
        "items": [{
            "key": "BILL-1", "title": "Invoices", "epic": "billing",
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
    if not signed_off(repo):
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
    story_flags = ("--story", "As a finance lead, I see monthly reports.",
                   "--ac", "the report lists every invoice")
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
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
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
    """Every direct companion command is routed to the canonical executor."""
    start_stage(repo, tmp_path, DELEGATE_TASK, launch=False)
    for mode in ("default", "plan"):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": mode,
                                "tool_input": {"command": COMPANION_WRITE}})
        assert "deny" in out and "forge delegate <task-id>" in out, mode
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": COMPANION + " 'map it'"}})
    assert "deny" in out and "forge delegate" in out


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


def test_hook_routes_every_literal_companion_token(repo):
    for command in (
        "rg codex-companion factory",
        "cat /tmp/codex-companion.mjs",
        "printf '%s\\n' codex-companion",
    ):
        code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                                "tool_input": {"command": command}})
        assert "deny" in out and "forge delegate" in out, command


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
    # Direct companion commands are always off-contract.
    companion = "node /x/codex-companion.mjs task --model gpt-5.6-terra 'map the module'"
    code, out = hook(repo, {"tool_name": "Bash", "permission_mode": "default",
                            "tool_input": {"command": companion}})
    assert "deny" in out and "forge delegate" in out
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
    events = [json.loads(line) for line in
              (repo / "plans" / "quickfixes.jsonl").read_text().splitlines()]
    assert [event["event"] for event in events] == ["open", "done"]
    assert events[-1]["files"] == [f"src/file-{number}.py" for number in range(1, 6)]

    code, out = hook(repo, {
        "tool_name": "Edit", "permission_mode": "default",
        "tool_input": {"file_path": str(repo / "src" / "again.py")},
    })
    assert code == 0 and "deny" in out


# ---------------------------------------------------------------- plan grill

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
    import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "ENG-1", "title": "frees nothing"},
        {"key": "ENG-2", "title": "frees one"},
        {"key": "ENG-3", "title": "waits", "depends_on": ["ENG-2"]},
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


def test_adhoc_capture_is_visible_debt_not_a_build_bypass(repo, tmp_path):
    """The client emails a new ask mid-sprint. It must be capturable — an
    ask that cannot be recorded gets built off the books — without becoming a
    way around decision 0014."""
    sign_off(repo)
    code, out = run(repo, "forge.py", "roadmap", "add", "ENG-7", "Urgent export",
                    "--story", "As a finance lead, I export invoices to CSV.",
                    "--ac", "the export downloads", "--no-spec",
                    "--reason", "client asked mid-sprint, spec to follow")
    assert code == 0, out
    item = roadmap_items(repo)["ENG-7"]
    assert item["origin"] == "adhoc" and "spec" not in item
    intake(repo, "ENG-7", "Urgent export")
    # building it is refused while the debt stands, and the refusal says how
    code, out = save_plan(repo, tmp_path)
    assert code != 0 and "link-spec" in out and "0014" in out, out
    spec = tmp_path / "export.md"
    spec.write_text("# Export\n\nCSV export of invoices.\n")
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
    (repo / "plans" / "quickfixes.jsonl").unlink()
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


def launch_fake(repo: Path, tmp_path: Path, stage_id: str) -> None:
    code, out = run(repo, "forge.py", "delegate", stage_id,
                    env={"HOME": str(fake_companion_home(tmp_path))})
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
    code, out = run(repo, "forge.py", "stage", "done", "T1")
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
        "\"import time; from pathlib import Path; time.sleep(0.5); "
        "Path('src/late.py').write_text('late')\"], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, "
        "start_new_session=True)\n",
    )
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out
    threading.Event().wait(0.7)
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


def test_stage_done_refuses_a_contract_rewritten_mid_stage(repo, tmp_path):
    """Re-recording is the sanctioned repair for a wrong scope, but it must not
    be a way to widen write_scope moments before closing over it."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "billing/ledger.py")
    widened = {**DECOMP, "tasks": [{**STAGE_TASK, "write_scope": ["src/", "billing/"]}]}
    code, out = run(repo, "record_decomposition_from_json.py", stdin=json.dumps(widened))
    assert code == 0, out
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code != 0 and "task contract changed" in out
    # re-baselining is deliberate and on the record
    code, out = run(repo, "forge.py", "stage", "start", "T1")
    assert code == 0, out
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(fake_companion_home(tmp_path))})
    assert code == 0, out
    write_in_scope(repo, "billing/ledger.py", "changed = True\n")
    code, out = run(repo, "forge.py", "stage", "done", "T1")
    assert code == 0, out


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
    run(repo, "forge.py", "stage", "start", "T1")
    code, out = run(repo, "forge.py", "delegate", "T1", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "--write" in out
    # ...and --read-only is the explicit exception
    code, out = run(repo, "forge.py", "delegate", "T1", "--read-only", "--print-only",
                    env={"HOME": home})
    assert code == 0 and "--write" not in out


def test_delegate_records_ledger_entry(repo, tmp_path):
    start_stage(repo, tmp_path, DELEGATE_TASK, launch=False)
    home_path = fake_companion_home(tmp_path)
    unlisted = home_path / ".claude/plugins/cache/openai-codex/codex/9.9.9/scripts/codex-companion.mjs"
    unlisted.parent.mkdir(parents=True)
    unlisted.write_text("process.exit(9);\n")
    code, out = run(repo, "forge.py", "delegate", "T1",
                    env={"HOME": str(home_path)})
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
    code, out = run(repo, "forge.py", "stage", "migrate")
    assert code != 0 and "--confirm-workspace-state" in out
    code, out = run(
        repo, "forge.py", "stage", "migrate", "--confirm-workspace-state")
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
        repo, "forge.py", "stage", "migrate", "--confirm-workspace-state")
    assert code != 0
    assert "partial protected" in out


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


def test_plan_save_requires_surface_impact_section(repo, tmp_path):
    sign_off(repo)
    intake(repo)
    ensure_story(repo, "ENG-1", "Invoices")
    plan = tmp_path / "plan.md"
    plan.write_text(plan_draft(
        repo, body="## Decisions\nNo new decisions\n"))  # no Surface Impact
    record_grill(repo, "plan", digest_of=plan)
    code, out = run(repo, "forge.py", "plan", "save", "--from", str(plan))
    assert code != 0 and "Surface Impact" in out


def test_refactor_ratchet_blocks_growing_refactors(repo, tmp_path):
    import_roadmap(repo, tmp_path, {"generated_by": "docs-decomposer", "items": [
        {"key": "REF-1", "title": "Shrink the api layer", "kind": "refactor"},
    ]})
    # invalid kind refused at grooming time
    code, out = run(repo, "forge.py", "roadmap", "add", "X-1", "t", "--kind", "cleanup",
                    "--story", "As a dev, I keep the api small.", "--ac", "smaller")
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


def _init(target: Path):
    return subprocess.run(
        [sys.executable, str(HARNESS / "factory" / "scripts" / "forge.py"),
         "init", "--name", "app", "--target", str(target)],
        capture_output=True, text=True,
    )


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
