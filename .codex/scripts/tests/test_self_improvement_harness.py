from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / ".codex" / "scripts"
RECORD_SCRIPT = SCRIPTS_DIR / "record_lesson.py"
SELECT_SCRIPT = SCRIPTS_DIR / "select_relevant_lessons.py"
CHECK_SCRIPT = SCRIPTS_DIR / "check_task_completion.py"


def run_script(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=cwd or REPO_ROOT,
        capture_output=True,
        text=True,
    )


class SelfImprovementHarnessTests(unittest.TestCase):
    def test_record_lesson_appends_valid_lesson(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lessons = Path(tmp) / "lessons.jsonl"
            result = run_script(
                [
                    str(RECORD_SCRIPT),
                    "--topic",
                    "permission safety",
                    "--lesson",
                    "Permission decisions must fail closed.",
                    "--source",
                    "unit test",
                    "--applies-to",
                    "apps/core/src/runtime/**",
                    "--severity",
                    "high",
                    "--lessons",
                    str(lessons),
                ]
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            rows = [json.loads(line) for line in lessons.read_text().splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["topic"], "permission safety")
            self.assertEqual(rows[0]["appliesTo"], ["apps/core/src/runtime/**"])

    def test_record_lesson_rejects_invalid_severity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lessons = Path(tmp) / "lessons.jsonl"
            result = run_script(
                [
                    str(RECORD_SCRIPT),
                    "--topic",
                    "schema",
                    "--lesson",
                    "Bad severity should not record.",
                    "--source",
                    "unit test",
                    "--applies-to",
                    "apps/core/src/adapters/storage/postgres/**",
                    "--severity",
                    "critical",
                    "--lessons",
                    str(lessons),
                ]
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(lessons.exists())

    def test_record_lesson_rejects_invalid_existing_lesson_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lessons = Path(tmp) / "lessons.jsonl"
            lessons.write_text(json.dumps({"topic": "schema"}) + "\n")
            result = run_script(
                [
                    str(RECORD_SCRIPT),
                    "--topic",
                    "schema",
                    "--lesson",
                    "Existing malformed lessons should block append.",
                    "--source",
                    "unit test",
                    "--applies-to",
                    "apps/core/src/adapters/storage/postgres/**",
                    "--severity",
                    "medium",
                    "--lessons",
                    str(lessons),
                ]
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing required fields", result.stderr)

    def test_record_lesson_rejects_duplicate_lesson_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lessons = Path(tmp) / "lessons.jsonl"
            base_args = [
                str(RECORD_SCRIPT),
                "--topic",
                "provider adapter",
                "--lesson",
                "Provider SDK types must stay in adapters.",
                "--source",
                "unit test",
                "--applies-to",
                "apps/core/src/adapters/**",
                "--severity",
                "high",
                "--lessons",
                str(lessons),
            ]
            first = run_script(base_args)
            second = run_script(base_args)

            self.assertEqual(first.returncode, 0, msg=first.stderr)
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("duplicate lesson text", second.stderr)
            self.assertEqual(len(lessons.read_text().splitlines()), 1)

    def test_select_relevant_lessons_matches_topic_prompt_path_and_glob(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lessons = Path(tmp) / "lessons.jsonl"
            lessons.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "topic": "schema storage",
                                "lesson": "Schema changes need repository tests.",
                                "source": "docs",
                                "addedAt": "2026-04-26T00:00:00Z",
                                "appliesTo": ["apps/core/src/adapters/storage/postgres/**"],
                                "severity": "medium",
                            }
                        ),
                        json.dumps(
                            {
                                "topic": "permission safety",
                                "lesson": "Tool access must be deterministic.",
                                "source": "docs",
                                "addedAt": "2026-04-26T00:00:00Z",
                                "appliesTo": ["permission"],
                                "severity": "high",
                            }
                        ),
                    ]
                )
                + "\n"
            )

            result = run_script(
                [
                    str(SELECT_SCRIPT),
                    "--json",
                    "--prompt",
                    "update permission handling",
                    "--changed-file",
                    "apps/core/src/adapters/storage/postgres/schema/schema.ts",
                    "--lessons",
                    str(lessons),
                ]
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            selected = json.loads(result.stdout)
            topics = {item["topic"] for item in selected}
            self.assertEqual(topics, {"schema storage", "permission safety"})

    def test_completion_check_warns_for_schema_without_repository_tests(self) -> None:
        result = run_script(
            [
                str(CHECK_SCRIPT),
                "--no-architecture",
                "--json",
                "--changed-file",
                "apps/core/src/adapters/storage/postgres/schema/schema.ts",
            ]
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn(
            "Postgres schema/repository files changed without repository/storage/schema tests.",
            payload["warnings"],
        )

    def test_completion_check_warns_for_permission_browser_provider_without_tests(self) -> None:
        result = run_script(
            [
                str(CHECK_SCRIPT),
                "--no-architecture",
                "--json",
                "--changed-file",
                "apps/core/src/adapters/browser/session.ts",
            ]
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn(
            "Permission/tool/browser/sandbox files changed without permission or sandbox/browser tests.",
            payload["warnings"],
        )
        self.assertIn(
            "Provider adapter/session files changed without provider-session or resume tests.",
            payload["warnings"],
        )

    def test_completion_check_warns_for_channel_without_message_persistence_tests(self) -> None:
        result = run_script(
            [
                str(CHECK_SCRIPT),
                "--no-architecture",
                "--json",
                "--changed-file",
                "apps/core/src/channels/slack/channel.ts",
            ]
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn(
            "Channel adapter files changed without message persistence or channel wiring tests.",
            payload["warnings"],
        )

    def test_completion_check_accepts_matching_tests(self) -> None:
        result = run_script(
            [
                str(CHECK_SCRIPT),
                "--no-architecture",
                "--json",
                "--changed-file",
                "apps/core/src/channels/slack/channel.ts",
                "--changed-file",
                "apps/core/test/unit/bootstrap/channel-wiring.test.ts",
            ]
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertNotIn(
            "Channel adapter files changed without message persistence or channel wiring tests.",
            payload["warnings"],
        )

    def test_completion_check_runs_architecture_check_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, capture_output=True, text=True, check=True)
            script = root / ".codex" / "scripts" / "check_architecture.py"
            script.parent.mkdir(parents=True)
            script.write_text("#!/usr/bin/env python3\nprint('fake architecture passed')\n")

            result = run_script(
                [
                    str(CHECK_SCRIPT),
                    "--json",
                    "--changed-file",
                    "apps/core/src/domain/value.ts",
                ],
                cwd=root,
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["architecture"]["status"], "passed")
            self.assertIn("fake architecture passed", payload["architecture"]["stdout"])


if __name__ == "__main__":
    unittest.main()
