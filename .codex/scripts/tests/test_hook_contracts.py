from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CODEX_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = CODEX_ROOT.parent
SCRIPTS_DIR = CODEX_ROOT / "scripts"
HOOKS_PATH = CODEX_ROOT / "hooks.json"
RULES_PATH = CODEX_ROOT / "rules" / "default.rules"


def read_text(path: Path) -> str:
    return path.read_text()


def run_hook(
    script_name: str,
    payload: dict[str, object],
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)

    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script_name)],
        cwd=cwd,
        input=json.dumps(payload),
        env=child_env,
        text=True,
        capture_output=True,
        check=False,
    )


class HookContractTests(unittest.TestCase):
    def assert_execpolicy_decision(self, args: list[str], expected: str) -> None:
        codex = shutil.which("codex")
        if codex is None:
            if os.environ.get("FACTORY_REQUIRE_CODEX_EXECPOLICY") == "1":
                self.fail("codex CLI is required to validate native command-policy rules")
            self.skipTest("codex CLI is not available")

        proc = subprocess.run(
            [
                codex,
                "execpolicy",
                "check",
                "--pretty",
                "--rules",
                str(RULES_PATH),
                "--",
                *args,
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload.get("decision", "allow"), expected, proc.stdout)

    def test_hooks_are_lifecycle_plus_silent_pre_tool_safety_only(self) -> None:
        hooks = json.loads(read_text(HOOKS_PATH))["hooks"]

        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"})
        self.assertNotIn("PostToolUse", hooks)

    def test_lifecycle_hooks_have_short_timeouts_and_existing_scripts(self) -> None:
        hooks = json.loads(read_text(HOOKS_PATH))["hooks"]
        expected_limits = {
            "SessionStart": 5,
            "UserPromptSubmit": 5,
            "PreToolUse": 3,
            "Stop": 10,
        }

        for event_name, groups in hooks.items():
            for group in groups:
                for handler in group["hooks"]:
                    self.assertNotIn("statusMessage", handler)
                    self.assertIn("timeout", handler)
                    self.assertLessEqual(handler["timeout"], expected_limits[event_name])

                    match = re.search(r"/\.codex/scripts/([^\" ]+\.py)", handler["command"])
                    self.assertIsNotNone(match, handler["command"])
                    assert match is not None
                    self.assertTrue((SCRIPTS_DIR / match.group(1)).exists())

    def test_no_old_noisy_hook_messages_remain(self) -> None:
        search_paths = [
            HOOKS_PATH,
            SCRIPTS_DIR / "pre_tool_use.py",
            SCRIPTS_DIR / "user_prompt_submit.py",
            SCRIPTS_DIR / "stop_continue.py",
        ]
        combined = "\n".join(read_text(path) for path in search_paths)

        self.assertNotIn("Factory policy check passed", combined)
        self.assertNotIn("Recording tool results", combined)
        self.assertNotIn("Update factory artifacts if this command materially changed verification state or review status", combined)

    def test_native_rules_cover_destructive_commands(self) -> None:
        rules = read_text(RULES_PATH)

        for pattern in [
            'pattern = ["rm", "-rf"]',
            'pattern = ["rm", "-fr"]',
            'pattern = ["rm", ["-r", "-f", "--recursive", "--force"]]',
            'pattern = [["PATH=/usr/bin", "PATH=/bin", "FOO=bar", "GIT_DIR=.git", "GIT_WORK_TREE=."], ["rm", "git", "terraform", "kubectl"]]',
            'pattern = ["git", "reset", "--hard"]',
            'pattern = ["git", "push"]',
            'pattern = ["git", ["-c", "-C", "--git-dir", "--work-tree"]]',
            'pattern = ["git", ["--no-pager", "--git-dir=.git", "--work-tree=.", "--bare"]]',
            'pattern = ["git", "push", "--force"]',
            'pattern = ["git", "push", "-f"]',
            'pattern = ["git", "push", "--force-with-lease"]',
            'pattern = ["sudo"]',
            'pattern = ["env"]',
            'pattern = [["env", "/usr/bin/env"], ["-i", "--ignore-environment"], "rm", ["-rf", "-fr"]]',
            'pattern = ["env", "rm", "-rf"]',
            'pattern = ["env", "git", "reset", "--hard"]',
            'pattern = ["env", "git", "push", "--force-with-lease"]',
            'pattern = ["env", "kubectl", "delete"]',
            'pattern = ["/usr/bin/env"]',
            'pattern = ["/usr/bin/env", "git", "push"]',
            'pattern = ["bash", ["-c", "-lc"]]',
            'pattern = ["sh", "-c"]',
            'pattern = ["zsh", ["-c", "-lc"]]',
            'pattern = [["/bin/bash", "/usr/bin/bash"], ["-c", "-lc"]]',
            'pattern = [["/bin/sh", "/usr/bin/sh"], "-c"]',
            'pattern = [["/bin/zsh", "/usr/bin/zsh"], ["-c", "-lc"]]',
            'pattern = ["command", "rm", ["-rf", "-fr"]]',
            'pattern = ["command", "git", "reset", "--hard"]',
            'pattern = ["command", "git", "push"]',
            'pattern = [["python", "python3", "node", "perl", "ruby"], ["-c", "-e", "--eval"]]',
            'pattern = [["/bin/rm", "/usr/bin/rm"], ["-rf", "-fr"]]',
            'pattern = [["/bin/rm", "/usr/bin/rm"], ["-r", "-f", "--recursive", "--force"]]',
            'pattern = [["/usr/bin/git", "/opt/homebrew/bin/git"], "push"]',
            'pattern = ["terraform", "destroy"]',
            'pattern = ["terraform", "apply"]',
            'pattern = ["kubectl", "delete"]',
        ]:
            self.assertIn(pattern, rules)

        self.assertIn('decision = "forbidden"', rules)
        self.assertIn("match = [", rules)
        self.assertIn("not_match = [", rules)

    def test_native_rules_block_or_prompt_behaviorally(self) -> None:
        cases = [
            (["rm", "-rf", "build"], "forbidden"),
            (["rm", "-r", "-f", "build"], "prompt"),
            (["rm", "--recursive", "--force", "build"], "prompt"),
            (["PATH=/usr/bin", "git", "reset", "--hard"], "prompt"),
            (["FOO=bar", "rm", "-rf", "build"], "prompt"),
            (["git", "reset", "--hard"], "forbidden"),
            (["git", "push", "--force", "origin", "feature"], "forbidden"),
            (["git", "push", "--force-with-lease", "origin", "feature"], "forbidden"),
            (["git", "push", "origin", "feature", "--force-with-lease"], "prompt"),
            (["git", "push", "origin", "feature", "-f"], "prompt"),
            (["git", "--no-pager", "push", "origin", "feature", "--force"], "prompt"),
            (["git", "--git-dir=.git", "push", "origin", "feature", "--force"], "prompt"),
            (["env", "git", "push", "origin", "feature", "--force"], "prompt"),
            (["/usr/bin/env", "git", "push", "origin", "feature", "--force-with-lease"], "prompt"),
            (["env", "-i", "rm", "-rf", "build"], "forbidden"),
            (["/usr/bin/env", "-i", "kubectl", "delete", "namespace", "prod"], "forbidden"),
            (["git", "-C", "/tmp/repo", "push", "origin", "feature", "--force"], "prompt"),
            (["bash", "-lc", "rm -rf build"], "forbidden"),
            (["/bin/bash", "-lc", "rm -rf build"], "forbidden"),
            (["/bin/zsh", "-lc", "terraform destroy"], "forbidden"),
            (["command", "rm", "-rf", "build"], "forbidden"),
            (["command", "rm", "--recursive", "--force", "build"], "prompt"),
            (["command", "git", "reset", "--hard"], "forbidden"),
            (["command", "git", "push", "origin", "feature", "--force-with-lease"], "prompt"),
            (["python3", "-c", "print(1)"], "forbidden"),
            (["/bin/rm", "-rf", "build"], "forbidden"),
            (["/bin/rm", "-r", "-f", "build"], "prompt"),
            (["terraform", "destroy"], "forbidden"),
            (["terraform", "apply", "-destroy", "-auto-approve"], "prompt"),
            (["kubectl", "delete", "namespace", "prod"], "forbidden"),
        ]

        for args, expected in cases:
            with self.subTest(args=args):
                self.assert_execpolicy_decision(args, expected)

    def test_native_rules_allow_non_destructive_baseline_behaviorally(self) -> None:
        cases = [
            ["git", "status"],
            ["rm", "file.txt"],
            ["terraform", "plan"],
            ["kubectl", "get", "pods"],
            ["python3", ".codex/scripts/verify.py", "--print-only"],
        ]

        for args in cases:
            with self.subTest(args=args):
                self.assert_execpolicy_decision(args, "allow")

    def test_obsolete_post_tool_hook_and_history_are_not_referenced(self) -> None:
        tracked_paths = [
            HOOKS_PATH,
            CODEX_ROOT / "AGENTS.md",
            REPO_ROOT / "AGENTS.md",
            REPO_ROOT / ".factory" / "README.md",
            SCRIPTS_DIR / "check_factory_scaffold.py",
        ]
        combined = "\n".join(read_text(path) for path in tracked_paths)

        self.assertNotIn("post_tool_use.py", combined)
        self.assertNotIn("tool-history.jsonl", combined)

    def test_pre_tool_use_blocks_assignment_prefixed_destructive_commands(self) -> None:
        cases = [
            "AWS_PROFILE=prod rm -rf build",
            "X=1 git reset --hard",
            "A=1 terraform destroy",
            "PATH=/usr/bin kubectl delete namespace prod",
        ]

        for command in cases:
            with self.subTest(command=command):
                proc = run_hook(
                    "pre_tool_use.py",
                    {"hook_event_name": "PreToolUse", "tool_input": {"command": command}},
                    REPO_ROOT,
                )
                self.assertEqual(proc.returncode, 0)
                payload = json.loads(proc.stdout)
                output = payload["hookSpecificOutput"]
                self.assertEqual(output["hookEventName"], "PreToolUse")
                self.assertEqual(output["permissionDecision"], "deny")

    def test_pre_tool_use_is_silent_for_allowed_commands(self) -> None:
        proc = run_hook(
            "pre_tool_use.py",
            {"hook_event_name": "PreToolUse", "tool_input": {"command": "npm test"}},
            REPO_ROOT,
        )

        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(proc.stderr, "")

    def test_user_prompt_submit_is_silent_for_casual_prompt_without_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)

            proc = run_hook(
                "user_prompt_submit.py",
                {"prompt": "what is the current state?", "hook_event_name": "UserPromptSubmit"},
                cwd,
            )

        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(proc.stderr, "")

    def test_user_prompt_submit_advises_for_build_prompt_without_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)

            proc = run_hook(
                "user_prompt_submit.py",
                {"prompt": "please implement this", "hook_event_name": "UserPromptSubmit"},
                cwd,
            )

        self.assertEqual(proc.returncode, 0)
        payload = json.loads(proc.stdout)
        self.assertNotEqual(payload.get("decision"), "block")
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("No factory state found. Bootstrap now:", context)

    def test_user_prompt_submit_blocks_missing_run_only_in_strict_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)

            proc = run_hook(
                "user_prompt_submit.py",
                {"prompt": "please implement this", "hook_event_name": "UserPromptSubmit"},
                cwd,
                env={"FACTORY_ENFORCE_INTAKE": "1"},
            )

        self.assertEqual(proc.returncode, 0)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload.get("decision"), "block")
        self.assertIn("No factory state found", payload["reason"])

    def test_user_prompt_submit_does_not_block_unapproved_active_run_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)
            factory_dir = cwd / ".factory"
            factory_dir.mkdir()
            (factory_dir / "run.json").write_text(
                json.dumps(
                    {
                        "issue_key": "ENG-123",
                        "title": "Reduce Codex hook noise",
                        "phase": "planning",
                        "plan_status": "draft",
                        "decomposition_status": "missing",
                    }
                )
            )

            proc = run_hook(
                "user_prompt_submit.py",
                {"prompt": "please implement this", "hook_event_name": "UserPromptSubmit"},
                cwd,
            )

        self.assertEqual(proc.returncode, 0)
        payload = json.loads(proc.stdout)
        self.assertNotEqual(payload.get("decision"), "block")
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(context.strip())

    def test_stop_continue_is_silent_continue_without_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)

            proc = run_hook("stop_continue.py", {"hook_event_name": "Stop"}, cwd)

        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), {"continue": True})

    def test_stop_continue_does_not_enforce_artifacts_during_active_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.run(["git", "init"], cwd=cwd, capture_output=True, text=True, check=True)
            factory_dir = cwd / ".factory"
            factory_dir.mkdir()
            (factory_dir / "run.json").write_text(
                json.dumps(
                    {
                        "issue_key": "ENG-123",
                        "phase": "implementing",
                        "plan_status": "approved",
                        "decomposition_status": "recorded",
                    }
                )
            )

            proc = run_hook("stop_continue.py", {"hook_event_name": "Stop"}, cwd)

        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), {"continue": True})


if __name__ == "__main__":
    unittest.main()
