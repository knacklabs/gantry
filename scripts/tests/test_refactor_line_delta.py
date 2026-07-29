from __future__ import annotations

import importlib.util
import io
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "check_refactor_line_delta.py"
SPEC = importlib.util.spec_from_file_location("check_refactor_line_delta", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class RefactorLineDeltaTests(unittest.TestCase):
    def test_count_source_lines_buckets_immediate_children(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "apps" / "core" / "src" / "runtime"
            source.mkdir(parents=True)
            (source / "agent.ts").write_text("one\n\ntwo\n", encoding="utf-8")
            (source / "ignored.md").write_text("not counted\n", encoding="utf-8")

            counts = module.count_source_lines(["apps/core/src"], root)

        self.assertEqual(
            counts,
            {"apps/core/src/runtime": {"files": 1, "lines": 3, "nonblank": 2}},
        )

    def test_bucket_for_root_file(self) -> None:
        bucket = module.bucket_for(Path("apps/core/src/index.ts"), "apps/core/src")

        self.assertEqual(bucket, "apps/core/src")

    def test_parse_numstat_delta_filters_to_source_extensions(self) -> None:
        additions, deletions = module.parse_numstat_delta(
            "10\t3\tapps/core/src/a.ts\n"
            "-\t-\tapps/core/src/blob.bin\n"
            "5\t0\tapps/core/src/readme.md\n"
            "2\t9\tapps/core/src/b.ts\n",
        )

        self.assertEqual((additions, deletions), (12, 12))

    def test_committed_line_delta_parses_git_numstat(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["git"],
            returncode=0,
            stdout=(
                "10\t3\tapps/core/src/a.ts\n"
                "-\t-\tapps/core/src/blob.bin\n"
                "5\t0\tapps/core/src/readme.md\n"
                "2\t9\tapps/core/src/b.ts\n"
            ),
            stderr="",
        )
        with patch.object(module, "run_git", return_value=completed):
            additions, deletions = module.committed_line_delta(
                "origin/main",
                ["apps/core/src"],
                Path("/repo"),
            )

        self.assertEqual((additions, deletions), (12, 12))

    def test_parse_numstat_delta_counts_renamed_source_target(self) -> None:
        additions, deletions = module.parse_numstat_delta(
            "1\t2\tapps/core/src/{old.js => new.ts}\n"
            "3\t4\tapps/core/src/{old.ts => note.md}\n",
        )

        self.assertEqual((additions, deletions), (1, 2))

    def test_tracked_worktree_line_delta_uses_head_scope(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["git"],
            returncode=0,
            stdout="4\t1\tapps/core/src/worktree.ts\n",
            stderr="",
        )
        with patch.object(module, "run_git", return_value=completed) as run_git:
            additions, deletions = module.tracked_worktree_line_delta(
                ["apps/core/src"],
                Path("/repo"),
            )

        self.assertEqual((additions, deletions), (4, 1))
        run_git.assert_called_once_with(
            ["diff", "--numstat", "HEAD", "--", "apps/core/src"],
            Path("/repo"),
        )

    def test_untracked_source_line_additions_counts_source_files(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "apps" / "core" / "src"
            source.mkdir(parents=True)
            (source / "new.ts").write_text("one\n\ntwo\n", encoding="utf-8")
            (source / "new.md").write_text("ignored\n", encoding="utf-8")
            completed = subprocess.CompletedProcess(
                args=["git"],
                returncode=0,
                stdout="apps/core/src/new.ts\napps/core/src/new.md\n",
                stderr="",
            )

            with patch.object(module, "run_git", return_value=completed):
                additions = module.untracked_source_line_additions(
                    ["apps/core/src"],
                    root,
                )

        self.assertEqual(additions, 3)

    def test_read_baseline_commit_from_markdown(self) -> None:
        with TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "refactor-baseline.md"
            baseline.write_text(
                "# Baseline\n\n- Commit: `d18ba5f08a6496c462d27edf36773cb8a88cc4fe`\n",
                encoding="utf-8",
            )

            commit = module.read_baseline_commit(baseline)

        self.assertEqual(commit, "d18ba5f08a6496c462d27edf36773cb8a88cc4fe")

    def test_read_baseline_commit_fails_without_revision(self) -> None:
        with TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "refactor-baseline.md"
            baseline.write_text("# Baseline\n", encoding="utf-8")

            with self.assertRaises(ValueError):
                module.read_baseline_commit(baseline)

    def test_check_diff_fails_on_positive_delta(self) -> None:
        stderr = io.StringIO()
        with (
            patch.object(module, "committed_line_delta", return_value=(3, 1)),
            patch.object(module, "tracked_worktree_line_delta", return_value=(0, 0)),
            patch.object(module, "untracked_source_line_additions", return_value=0),
        ):
            with redirect_stderr(stderr):
                result = module.check_diff(
                    "origin/main",
                    ["apps/core/src"],
                    Path("/repo"),
                    "branch base",
                )

        self.assertEqual(result, 1)

    def test_check_diff_allows_non_positive_delta(self) -> None:
        with (
            patch.object(module, "committed_line_delta", return_value=(2, 2)),
            patch.object(module, "tracked_worktree_line_delta", return_value=(0, 0)),
            patch.object(module, "untracked_source_line_additions", return_value=0),
        ):
            result = module.check_diff(
                "origin/main",
                ["apps/core/src"],
                Path("/repo"),
                "branch base",
            )

        self.assertEqual(result, 0)

    def test_check_diff_output_labels_base_kind(self) -> None:
        output = io.StringIO()
        with (
            patch.object(module, "committed_line_delta", return_value=(1, 3)),
            patch.object(module, "tracked_worktree_line_delta", return_value=(0, 0)),
            patch.object(module, "untracked_source_line_additions", return_value=0),
        ):
            with redirect_stdout(output):
                result = module.check_diff(
                    "d18ba5f",
                    ["apps/core/src"],
                    Path("/repo"),
                    "phase baseline",
                )

        self.assertEqual(result, 0)
        self.assertIn("against phase baseline d18ba5f", output.getvalue())

    def test_check_diff_includes_worktree_and_untracked_by_default(self) -> None:
        output = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(module, "committed_line_delta", return_value=(1, 4)),
            patch.object(module, "tracked_worktree_line_delta", return_value=(2, 1)),
            patch.object(module, "untracked_source_line_additions", return_value=3),
        ):
            with redirect_stdout(output), redirect_stderr(stderr):
                result = module.check_diff(
                    "d18ba5f",
                    ["apps/core/src"],
                    Path("/repo"),
                    "phase baseline",
                )

        self.assertEqual(result, 1)
        self.assertIn("committed + working tree", output.getvalue())
        self.assertIn("committed: +1 -4", output.getvalue())
        self.assertIn("tracked working tree: +2 -1", output.getvalue())
        self.assertIn("untracked source files: +3 -0", output.getvalue())
        self.assertIn("+6 -5 = 1", output.getvalue())

    def test_check_diff_committed_only_excludes_worktree_and_untracked(self) -> None:
        output = io.StringIO()
        with (
            patch.object(module, "committed_line_delta", return_value=(1, 4)),
            patch.object(module, "tracked_worktree_line_delta") as tracked,
            patch.object(module, "untracked_source_line_additions") as untracked,
        ):
            with redirect_stdout(output):
                result = module.check_diff(
                    "d18ba5f",
                    ["apps/core/src"],
                    Path("/repo"),
                    "phase baseline",
                    committed_only=True,
                )

        self.assertEqual(result, 0)
        tracked.assert_not_called()
        untracked.assert_not_called()
        self.assertIn("committed only", output.getvalue())
        self.assertIn("committed: +1 -4", output.getvalue())
        self.assertNotIn("tracked working tree", output.getvalue())


if __name__ == "__main__":
    unittest.main()
