"""The review reads the tree it judges (decision 0076).

The autoreview skill starts Codex in an empty folder and its read-only sandbox
refuses every path outside it, so a verdict about unchanged code was a guess
(WF-1 T5: `partial` five rounds running, a different file each time; eleven of
the first twenty-five blockers refuted by opening the callee). `forge review`
now hands the skill a launcher that starts Codex inside the review worktree,
read-only, and the brief tells the reviewer to read before it writes partial.
"""
from __future__ import annotations

import json
import os
import subprocess

import pytest
import sys
from pathlib import Path

from test_gates import HARNESS, repo  # noqa: F401
from test_review_lenses_in_parallel import _built  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
import forge_cli.review as review_mod  # noqa: E402
from factory_lib import git_control_dir  # noqa: E402
from forge_cli.review import (  # noqa: E402
    COMMON_PREAMBLE, DIFF_ONLY_PREAMBLE, _combined_prompt, _lens_prompt, _skill_argv,
    review_task,
)
from forge_cli.review_launcher import (  # noqa: E402
    CODEX_BIN_ENV, EMPTY_WORKSPACE_ENV, repo_readable, write_launcher,
)

__all__ = ["repo"]

FAKE_CODEX = '''
import json, os, sys
record = os.environ["FAKE_CODEX_RECORD"]
json.dump({"argv": sys.argv[1:], "stdin": sys.stdin.read(),
           "codex_home": os.environ.get("CODEX_HOME")},
          open(record, "w", encoding="utf-8"))
print("fake codex spoke")
sys.exit(3)
'''

# The skill's real argv shape: config overrides with spaces, quotes and
# Windows paths, then `exec`, the empty workspace under -C, and `-` for stdin.
SKILL_ARGV = [
    "--ask-for-approval", "never", "--search", "--model", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="high"',
    "-c", 'sqlite_home="C:\\\\Users\\\\someone\\\\Temp\\\\state"',
    "-c", 'shell_environment_policy.set={ GIT_TERMINAL_PROMPT = "0", GIT_PAGER = "cat" }',
    "-c", 'projects."C:\\\\tmp\\\\empty".trust_level="untrusted"',
    "exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--ephemeral", "-C", "C:\\tmp\\empty", "--output-schema", "schema.json",
    "--output-last-message", "last.json", "-",
]

# Main's fake review helper, plus a record of what it was handed.
FAKE_SKILL = r'''
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
out = pathlib.Path(args[args.index("--json-output") + 1])
prompt = pathlib.Path(args[args.index("--prompt-file") + 1])
dataset = pathlib.Path(args[args.index("--dataset") + 1])
assert "### Approved task inputs" in dataset.read_text(encoding="utf-8")
seen = pathlib.Path(os.environ["FAKE_SKILL_SEEN"])
seen.mkdir(parents=True, exist_ok=True)
json.dump({"argv": args, "cwd": os.getcwd()}, open(seen / "run.json", "w"))
shutil.copy(prompt, seen / "brief.md")
if "--codex-bin" in args:
    launcher = pathlib.Path(args[args.index("--codex-bin") + 1])
    shutil.copy(launcher.parent / "codex_in_worktree.py", seen / "launcher.py")
provider = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": (
        "BEGIN FORGE ASSESSMENT quality\n"
        "VERDICT C1: implemented — src/core.py:1\n"
        "END FORGE ASSESSMENT quality\n"
        "BEGIN FORGE ASSESSMENT performance\nNo repeated work.\n"
        "END FORGE ASSESSMENT performance\n"
        "BEGIN FORGE ASSESSMENT security\nNo unsafe boundary.\n"
        "END FORGE ASSESSMENT security"
    ),
    "overall_confidence": 0.9,
}
report = {**provider, "provider_report": provider, "review_status": "scoped-clean"}
out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
sys.exit(0)
'''


def _executable(tmp_path: Path, name: str, body: str) -> Path:
    """A fake binary the launcher can hand over to: a .cmd shim on Windows, a
    shell script elsewhere, both running the given Python body."""
    script = tmp_path / f"{name}.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        shim = tmp_path / f"{name}.cmd"
        shim.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        shim = tmp_path / name
        shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n',
                        encoding="utf-8")
        shim.chmod(0o755)
    return shim


def test_the_launcher_swaps_only_the_working_folder(tmp_path, monkeypatch):
    fake = _executable(tmp_path, "fake-codex", FAKE_CODEX)
    monkeypatch.setenv(CODEX_BIN_ENV, str(fake))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "no-codex-home"))  # no [windows] table
    review_dir = tmp_path / "review-launcher-x"
    worktree = tmp_path / "wt"
    worktree.mkdir()
    launcher = write_launcher(review_dir, worktree)
    # Never inside the reviewed tree: the skill refuses an in-repo binary.
    assert launcher.parent == review_dir / "bin"
    assert not str(launcher).startswith(str(worktree))
    record = tmp_path / "record.json"
    proc = subprocess.run([str(launcher), *SKILL_ARGV], input="the prompt\n",
                          capture_output=True, text=True,
                          env={**os.environ, "FAKE_CODEX_RECORD": str(record)})
    assert proc.returncode == 3, proc.stdout + proc.stderr  # exit code passes through
    assert "fake codex spoke" in proc.stdout                # stdout passes through
    seen = json.loads(record.read_text(encoding="utf-8"))
    assert seen["stdin"] == "the prompt\n"                  # the prompt passes through
    expected = list(SKILL_ARGV)
    expected[expected.index("-C") + 1] = str(worktree)
    assert seen["argv"] == expected                         # only -C changed
    assert (review_dir / "bin" / "launch.log").read_text(encoding="utf-8").count("\n") == 1


def test_the_launcher_carries_the_windows_sandbox_the_skill_drops(tmp_path, monkeypatch):
    """The skill's --ignore-user-config drops `[windows] sandbox`, and without
    it Codex on Windows refuses every command in read-only mode ("blocked by
    policy" for Get-Location itself). The skill also hands Codex a fresh home
    without the sandbox's set-up state, so set-up re-runs and its UAC prompt
    is cancelled (1223). The launcher carries the key and points CODEX_HOME
    back at the home that holds the state."""
    fake = _executable(tmp_path, "fake-codex", FAKE_CODEX)
    monkeypatch.setenv(CODEX_BIN_ENV, str(fake))
    home = tmp_path / "codex-home"
    home.mkdir()
    (home / "config.toml").write_text(
        'model = "gpt-5.6-sol"\n\n[features]\nfoo = true\n\n[windows]\n'
        'sandbox = "elevated"\n\n[projects."C:\\\\x"]\ntrust_level = "trusted"\n',
        encoding="utf-8")
    (home / ".sandbox").mkdir()  # the elevated sandbox's set-up state lives here
    monkeypatch.setenv("CODEX_HOME", str(home))
    review_dir = tmp_path / "review-launcher-y"
    worktree = tmp_path / "wt"
    worktree.mkdir()
    launcher = write_launcher(review_dir, worktree)
    record = tmp_path / "record2.json"
    runtime_home = tmp_path / "skill-runtime-codex-home"  # what the skill hands the engine
    subprocess.run([str(launcher), *SKILL_ARGV], input="", capture_output=True, text=True,
                   env={**os.environ, "FAKE_CODEX_RECORD": str(record),
                        "CODEX_HOME": str(runtime_home)})
    seen = json.loads(record.read_text(encoding="utf-8"))
    expected = list(SKILL_ARGV)
    expected[expected.index("-C") + 1] = str(worktree)
    if os.name == "nt":
        # Inserted as a global -c override just before the subcommand, and the
        # engine is pointed back at the home that holds the sandbox state.
        at = expected.index("exec")
        expected[at:at] = ["-c", 'windows.sandbox="elevated"']
        assert seen["codex_home"] == str(home)
    else:
        assert seen["codex_home"] == str(runtime_home)
    assert seen["argv"] == expected


def test_repo_readable_says_why_when_it_cannot_offer_the_tree(tmp_path, monkeypatch):
    monkeypatch.setenv(CODEX_BIN_ENV, sys.executable)
    assert repo_readable("codex") == (True, "")
    assert repo_readable("claude")[0] is False
    monkeypatch.setenv(EMPTY_WORKSPACE_ENV, "1")
    ok, why = repo_readable("codex")
    assert ok is False and EMPTY_WORKSPACE_ENV in why
    monkeypatch.delenv(EMPTY_WORKSPACE_ENV)
    monkeypatch.setenv(CODEX_BIN_ENV, str(tmp_path / "no-such-codex"))
    monkeypatch.setenv("PATH", str(tmp_path))
    ok, why = repo_readable("codex")
    assert ok is False and "not on PATH" in why


def test_the_brief_tells_the_reviewer_to_read_before_it_writes_partial():
    task = {"id": "T5", "plan_contracts": [
        {"id": "C1", "statement": "the slice runs green", "source": "plan#ac"}]}
    readable = _lens_prompt(task, "quality", repo_readable=True).decode()
    assert "READ-ONLY" in readable and "open it (cat, sed -n, rg)" in readable
    assert '"Cannot verify from the diff" is not a verdict' in readable
    assert "no finding\non code the diff neither touches nor calls" in readable
    assert "does not apply to this run" in readable
    fallback = _lens_prompt(task, "quality", repo_readable=False).decode()
    assert "no repository access" in fallback
    assert "not thereby partial or missing" in fallback
    assert COMMON_PREAMBLE in readable and DIFF_ONLY_PREAMBLE in fallback
    # The combined brief (the default review) carries the same rule.
    combined = _combined_prompt(task).decode()
    assert "You are the three-lens code review" in combined and "READ-ONLY" in combined
    assert "not thereby partial" in _combined_prompt(task, repo_readable=False).decode()
    argv = _skill_argv(Path("skill"), "abc", "p.md", Path("o.json"), "codex", "P3")
    assert "--codex-bin" not in argv
    assert _skill_argv(Path("skill"), "abc", "p.md", Path("o.json"), "codex", "P3",
                       "C:/x/codex.cmd")[-2:] == ["--codex-bin", "C:/x/codex.cmd"]


def _seen(tmp_path: Path) -> tuple[dict, str]:
    seen = tmp_path / "seen"
    return (json.loads((seen / "run.json").read_text(encoding="utf-8")),
            (seen / "brief.md").read_text(encoding="utf-8"))


def test_review_hands_the_skill_a_launcher_in_the_control_dir(repo, tmp_path, monkeypatch, capsys):
    _built(repo, tmp_path)
    skill = tmp_path / "fake-autoreview.py"
    skill.write_text(FAKE_SKILL, encoding="utf-8")
    monkeypatch.setenv("FAKE_SKILL_SEEN", str(tmp_path / "seen"))
    monkeypatch.setenv(CODEX_BIN_ENV, sys.executable)  # any executable stands in for codex
    # The fake helper is not the pinned upstream helper; the identity check is
    # not what this test is about.
    monkeypatch.setattr(review_mod, "_require_safe_codex_review_helper", lambda skill: None)
    outcome = review_task(repo, "T1", skill=str(skill), engine="codex")
    assert outcome["stamped"] is True
    printed = capsys.readouterr().out
    assert "runs inside the reviewed worktree, read-only" in printed
    record, brief = _seen(tmp_path)
    argv = record["argv"]
    launcher = Path(argv[argv.index("--codex-bin") + 1])
    worktree = Path(record["cwd"]).resolve()
    # In the control dir, outside the reviewed tree, pointing at exactly the
    # worktree the skill reviewed; the record survives the review folder.
    assert launcher.name in ("codex.cmd", "codex")
    assert launcher.parent == git_control_dir(repo) / "review-launcher" / "T1" / "bin"
    assert not str(launcher.resolve()).startswith(str(worktree))
    script = (tmp_path / "seen" / "launcher.py").read_text(encoding="utf-8")
    assert f"WORKTREE = {str(worktree)!r}" in script or str(worktree) in script
    assert f"REAL = {sys.executable!r}" in script
    assert launcher.exists() and (launcher.parent / "codex_in_worktree.py").exists()
    assert "READ-ONLY" in brief and "not a verdict" in brief


def test_the_run_says_so_when_it_falls_back_to_the_diff_only_bundle(repo, tmp_path, monkeypatch, capsys):
    _built(repo, tmp_path)
    skill = tmp_path / "fake-autoreview.py"
    skill.write_text(FAKE_SKILL, encoding="utf-8")
    monkeypatch.setenv("FAKE_SKILL_SEEN", str(tmp_path / "seen"))
    # Another engine runs where the skill puts it.
    review_task(repo, "T1", skill=str(skill), engine="claude")
    printed = capsys.readouterr().out
    assert "sees only the diff bundle" in printed and "claude engine" in printed
    record, brief = _seen(tmp_path)
    assert "--codex-bin" not in record["argv"]
    assert "no repository access" in brief and "not thereby partial" in brief


def test_the_environment_switch_keeps_the_skill_empty_folder(repo, tmp_path, monkeypatch, capsys):
    _built(repo, tmp_path)
    skill = tmp_path / "fake-autoreview.py"
    skill.write_text(FAKE_SKILL, encoding="utf-8")
    monkeypatch.setenv("FAKE_SKILL_SEEN", str(tmp_path / "seen"))
    monkeypatch.setenv(CODEX_BIN_ENV, sys.executable)
    monkeypatch.setenv(EMPTY_WORKSPACE_ENV, "1")
    monkeypatch.setattr(review_mod, "_require_safe_codex_review_helper", lambda skill: None)
    review_task(repo, "T1", skill=str(skill), engine="codex")
    printed = capsys.readouterr().out
    assert "sees only the diff bundle" in printed and EMPTY_WORKSPACE_ENV in printed
    record, brief = _seen(tmp_path)
    assert "--codex-bin" not in record["argv"]
    assert "no repository access" in brief


def test_the_contract_records_that_the_review_reads_the_tree():
    workflow = (HARNESS / "WORKFLOW.md").read_text(encoding="utf-8")
    assert "INSIDE the reviewed" in workflow and "read-only (0076)" in workflow
    assert list((HARNESS / "docs" / "decisions").glob("0076-*.md"))


def test_an_outdated_helper_is_refused_before_the_run_not_after(repo, tmp_path, monkeypatch, capsys):
    """WF-1A T1 (2026-09-14): the installed helper predated the combined review
    output; the run took an hour and the recorder then refused its 29 findings.
    The helper is checked for the fields the recorder reads before anything
    launches, and the message names the fix."""
    _built(repo, tmp_path)
    old = tmp_path / "old-autoreview.py"
    old.write_text(FAKE_SKILL.replace('"review_status"', '"status"')
                   .replace('"provider_report"', '"provider"'), encoding="utf-8")
    seen = tmp_path / "seen"
    monkeypatch.setenv("FAKE_SKILL_SEEN", str(seen))
    with pytest.raises(SystemExit):
        review_task(repo, "T1", skill=str(old), engine="claude")
    printed = capsys.readouterr().out
    assert "predates the combined review output" in printed
    assert "review_status, provider_report" in printed
    assert "forge doctor --fix" in printed
    assert not seen.exists()  # nothing was launched
