"""The three review lenses run at the same time.

They read one detached worktree and write separate prompt, output and log
files; the skill isolates each run's workspace. One after another cost ~24
minutes a round on WF-1 T2; the slowest lens alone is ~8. Fixes stay one
delegate per round: `close` stops once with every lens's findings.

Its own module: test_gates.py is one very large file where every added
branch collides with every other.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from test_gates import (  # noqa: F401
    HARNESS, STAGE_TASK, git, head, load_factory_lib, repo, run, start_stage,
    story_state, write_in_scope,
)

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
from forge_cli.review import (  # noqa: E402
    LENSES, codex_runs_path, lenses_may_run_together, review_log_path,
    review_task,
)
from forge_cli.stages import load_stages  # noqa: E402

FAKE_LENS = '''
import json, os, sys, time
args = sys.argv[1:]
out = args[args.index("--json-output") + 1]
prompt = args[args.index("--prompt-file") + 1]
lens = prompt.rsplit(".", 2)[-2]
time.sleep(float(os.environ.get("FAKE_LENS_SLEEP", "0")))
print(f"fake {lens} lens ran", flush=True)
if os.environ.get("FAKE_LENS_CRASH") == lens:
    print("simulated crash", file=sys.stderr)
    sys.exit(3)
json.dump({
    "findings": [],
    "overall_explanation": "VERDICT C1: implemented — src/core.py:1 the slice runs.",
}, open(out, "w", encoding="utf-8"))
sys.exit(0)
'''


def _fake_skill(tmp_path: Path) -> Path:
    path = tmp_path / "fake-autoreview.py"
    path.write_text(FAKE_LENS, encoding="utf-8")
    return path


def _built(repo: Path, tmp_path: Path) -> None:
    """A started stage with committed work and the story-level proof the
    review demands on disk."""
    start_stage(repo, tmp_path, STAGE_TASK)
    write_in_scope(repo, "src/core.py")
    git(repo, "add", "src/core.py")
    git(repo, "commit", "-qm", "work")
    lib = load_factory_lib(repo)
    for name, body in (("verify.json", {"ok": True, "commit": head(repo)}),
                       ("tests.json", {"kind": "automated", "commit": head(repo)})):
        path = lib.evidence_path(repo, "ENG-1", name, for_write=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        lib.dump_json(path, body)


def _stamp(repo: Path) -> dict | None:
    return next(s for s in load_stages(repo)["stages"] if s["id"] == "T1").get(
        "local_review_stamp")


def test_lenses_run_together_and_record_all_three(repo, tmp_path, monkeypatch):
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "4")
    started = time.monotonic()
    outcome = review_task(repo, "T1", skill=str(_fake_skill(tmp_path)), parallel=True)
    took = time.monotonic() - started
    # Three 4-second lenses: together they take about one lens, not three.
    assert took < 10, f"parallel review took {took:.1f}s"
    assert outcome["blocking"] == 0 and outcome["stamped"] is True
    # Artifacts are task-scoped (stories/<key>/tasks/<id>/reviews/).
    lib = load_factory_lib(repo)
    for lens in LENSES:
        recorded = lib.load_json(
            lib.proof_path(repo, "ENG-1", f"reviews/{lens}.json", task_id="T1"),
            default={})
        assert recorded.get("aspect") == lens, f"{lens} artifact not recorded"
    assert _stamp(repo) is not None and "delta_id" in _stamp(repo)
    for lens in LENSES:
        assert review_log_path(repo, "T1", lens).is_file()
        assert f"fake {lens} lens ran" in review_log_path(repo, "T1", lens).read_text()


def test_sequential_is_still_available(repo, tmp_path, monkeypatch):
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "2")
    started = time.monotonic()
    outcome = review_task(repo, "T1", skill=str(_fake_skill(tmp_path)), parallel=False)
    took = time.monotonic() - started
    assert took >= 6, f"sequential review took only {took:.1f}s"
    assert outcome["stamped"] is True


def test_the_environment_switch_forces_sequential(repo, tmp_path, monkeypatch):
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "2")
    monkeypatch.setenv("FORGE_REVIEW_SEQUENTIAL", "1")
    started = time.monotonic()
    review_task(repo, "T1", skill=str(_fake_skill(tmp_path)))  # parallel=None -> env decides
    assert time.monotonic() - started >= 6


def test_the_run_ledger_stays_whole_under_three_writers(repo, tmp_path, monkeypatch):
    """Every lens appends starting/running/finished rows to ONE file from the
    same process. A torn line would make `forge codex status` blind to a
    review that was in flight."""
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "1")
    review_task(repo, "T1", skill=str(_fake_skill(tmp_path)), parallel=True)
    # The ledger lives in the review worktree's copy of .factory, which is
    # removed after the run; the base repo's copy is the one that persists.
    rows = []
    for line in codex_runs_path(repo).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))  # a torn line raises here
    kinds = [r["status"] for r in rows if r.get("kind") == "review"]
    assert kinds.count("starting") >= 3 and kinds.count("finished") >= 3


def test_one_crashing_lens_reaps_the_others_and_names_itself(repo, tmp_path, monkeypatch):
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "1")
    monkeypatch.setenv("FAKE_LENS_CRASH", "performance")
    try:
        review_task(repo, "T1", skill=str(_fake_skill(tmp_path)), parallel=True)
    except SystemExit:
        pass
    else:
        raise AssertionError("a crashed lens did not fail the review")
    # The two healthy lenses ran to completion and left their output.
    for lens in ("quality", "security"):
        assert f"fake {lens} lens ran" in review_log_path(repo, "T1", lens).read_text()
    # Nothing was recorded and nothing was stamped: a crash is not a verdict.
    lib = load_factory_lib(repo)
    for lens in LENSES:
        assert not lib.proof_path(
            repo, "ENG-1", f"reviews/{lens}.json", task_id="T1").is_file()
    assert _stamp(repo) is None


# The installed skill scans each outgoing pack with TruffleHog. These are the
# two shapes of that call the guard has to tell apart, embedded in a fake
# skill that otherwise behaves like FAKE_LENS.
SCAN_WITH_UPDATE = """
# scan_outgoing_review_pack:
#     result = run([
#         trufflehog_bin,
#         "filesystem",
#         str(pack_path),
#         "--json",
#         "--fail-on-scan-errors",
#     ], Path(tempdir), check=False)
"""
SCAN_WITHOUT_UPDATE = SCAN_WITH_UPDATE.replace(
    '#         "--json",\n', '#         "--json",\n#         "--no-update",\n')


def _fake_skill_with_scan(tmp_path: Path, scan: str) -> Path:
    path = tmp_path / "fake-autoreview-scanning.py"
    path.write_text(FAKE_LENS + scan, encoding="utf-8")
    return path


def test_the_guard_reads_the_scan_call_in_the_installed_skill(tmp_path):
    plain = _fake_skill(tmp_path)
    assert lenses_may_run_together(plain) == (
        True, "the review skill runs no scanner that could collide")
    updating = _fake_skill_with_scan(tmp_path, SCAN_WITH_UPDATE)
    ok, why = lenses_may_run_together(updating)
    assert ok is False and "--no-update" in why and str(updating) in why
    fixed = _fake_skill_with_scan(tmp_path, SCAN_WITHOUT_UPDATE)
    assert lenses_may_run_together(fixed) == (
        True, "the review skill runs TruffleHog with --no-update")
    # A flag elsewhere in the file is not the flag on the scan.
    elsewhere = tmp_path / "fake-autoreview-elsewhere.py"
    elsewhere.write_text(
        FAKE_LENS + SCAN_WITH_UPDATE + '\nUNRELATED = "--no-update"\n',
        encoding="utf-8")
    assert lenses_may_run_together(elsewhere)[0] is False
    missing = tmp_path / "nope"
    ok, why = lenses_may_run_together(missing)
    assert ok is False and "cannot read the review skill" in why


def test_a_self_updating_scanner_forces_the_lenses_one_at_a_time(
        repo, tmp_path, monkeypatch, capsys):
    """Asked to run together, with a skill whose scanner would collide, the
    review runs the lenses one after another and says why once."""
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "2")
    skill = _fake_skill_with_scan(tmp_path, SCAN_WITH_UPDATE)
    started = time.monotonic()
    outcome = review_task(repo, "T1", skill=str(skill), parallel=True)
    took = time.monotonic() - started
    assert took >= 6, f"lenses still ran together: {took:.1f}s"
    assert outcome["stamped"] is True
    out = capsys.readouterr().out
    assert out.count("lenses run one at a time:") == 1
    assert "--no-update" in out


def test_a_scanner_with_no_update_keeps_the_lenses_together(
        repo, tmp_path, monkeypatch, capsys):
    """The mechanism, not the clock: the run announces one shape or the
    other, and the timing test above already pins how long together takes."""
    _built(repo, tmp_path)
    monkeypatch.setenv("FAKE_LENS_SLEEP", "1")
    skill = _fake_skill_with_scan(tmp_path, SCAN_WITHOUT_UPDATE)
    outcome = review_task(repo, "T1", skill=str(skill), parallel=True)
    assert outcome["stamped"] is True
    out = capsys.readouterr().out
    assert "lenses running together:" in out
    assert "lenses run one at a time" not in out
