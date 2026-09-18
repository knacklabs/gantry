"""A big diff is reviewed in parallel groups, each retried on its own (0078).

The reviewer tool splits any prompt over 512 KB into chunks and runs them one
after another inside one call. WF-1A T1 (2026-09-14): a 900 KB diff, four
chunks of 20-40 minutes each, over an hour per review round, and one chunk
that came back truncated cost the whole hour. Nothing in that call could be
retried alone, and the lockfile alone was a chunk's worth of noise.

Forge now does the splitting itself, before the call, and only when the tool
would split anyway: the diff's product files are dealt into the fewest groups
whose prompt fits, each group gets its own review worktree and its own
three-lens Codex run, all released together and joined. A group whose result
is refused is re-run alone, up to twice, with the refusal's cause written into
its brief. The group results are merged into the exact shape the tool uses
for its own chunks, so the recorder, the projection and every reader stay
unchanged.

What a group sees. Its bundle is only its files' diff, but its tree is the
whole task tip: the group's base is a synthetic commit with the group's files
put back to the task base and everything else at the tip, so `base...HEAD`
is the group's diff and HEAD is the tree that ships. A verdict on a contract
whose change sits in another group is read from the tree, never guessed
(0076); the worst verdict per contract still wins across groups.

A diff that fits in one prompt is one group: the same single call as before.
`FORGE_REVIEW_SPLIT_BYTES` lowers the split point for probes and tests.
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .common import fail
from .tasks import _git, _require_git

# The reviewer tool's MAX_REVIEW_PROMPT_BYTES is 512,000; forge splits a
# little under it so the tool never has to split what forge already split.
REVIEW_SPLIT_BYTES = 480_000
SPLIT_ENV = "FORGE_REVIEW_SPLIT_BYTES"
# Prompt bytes the tool adds around the brief, dataset and bundle.
PROMPT_SLACK = 8_000
# Files that add bytes to a bundle and nothing to a review. Put back to the
# task base in every review tip; they still ship in the PR and stay in scope.
REVIEW_NOISE_NAMES = frozenset({
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json",
    "Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock",
    "composer.lock", "go.sum", "flake.lock",
})
REVIEW_NOISE_SUFFIXES = (".min.js", ".min.css", ".map", ".snap", ".lock")
REVIEW_NOISE_DIRS = ("__snapshots__/", "generated/", "__generated__/")
MAX_GROUP_RETRIES = 2
LISTED_PATHS = 60


def review_split_bytes() -> int:
    raw = os.environ.get(SPLIT_ENV, "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return REVIEW_SPLIT_BYTES


def is_review_noise(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return (name in REVIEW_NOISE_NAMES
            or name.endswith(REVIEW_NOISE_SUFFIXES)
            or any(f"/{marker}" in f"/{path}" for marker in REVIEW_NOISE_DIRS))


def restore_paths_to_base(worktree: Path, base_sha: str, paths: list[str],
                          message: str) -> str:
    """Put `paths` back to the task base in the detached worktree and commit;
    return the new tip. A path that did not exist at the base is dropped."""
    for rel in paths:
        at_base = _git(worktree, "cat-file", "-e", f"{base_sha}:{rel}").returncode == 0
        if at_base:
            _require_git(worktree, f"restoring {rel} to the task base",
                         "checkout", base_sha, "--", rel)
        else:
            _require_git(worktree, f"dropping {rel} from the review tip",
                         "rm", "-q", "--cached", "--", rel)
            path = worktree / rel
            if path.is_file():
                path.unlink()
    _require_git(worktree, "committing the review tip",
                 "-c", "user.name=forge-review", "-c", "user.email=forge-review@local",
                 "commit", "-q", "--no-verify", "--allow-empty", "-m", message)
    return _require_git(worktree, "resolving the review tip", "rev-parse", "HEAD")


def diff_bytes_by_path(worktree: Path, base_sha: str) -> dict[str, int]:
    """Patch bytes per changed path, base..HEAD, in git's own order."""
    proc = _git(worktree, "-c", "core.pager=cat", "diff", "--no-color",
                "--no-ext-diff", f"{base_sha}..HEAD")
    if proc.returncode != 0:
        fail("listing the review diff failed: " + (proc.stderr.strip() or "git diff"))
    sizes: dict[str, int] = {}
    current = None
    for line in proc.stdout.split("\n"):
        if line.startswith("diff --git "):
            match = re.match(r"diff --git a/(.+?) b/(.+)$", line)
            current = match.group(2) if match else None
            if current is not None:
                sizes.setdefault(current, 0)
        if current is not None:
            sizes[current] += len(line.encode("utf-8", "surrogateescape")) + 1
    return sizes


def plan_groups(sizes: dict[str, int], capacity: int) -> list[list[str]]:
    """Deal paths into the fewest groups whose patch bytes fit `capacity`,
    keeping git's order so neighbouring files stay together. A single path
    larger than the capacity is a group of its own (the tool chunks it)."""
    capacity = max(capacity, 1)
    groups: list[list[str]] = []
    current: list[str] = []
    used = 0
    for path, size in sizes.items():
        if current and used + size > capacity:
            groups.append(current)
            current, used = [], 0
        current.append(path)
        used += size
    if current:
        groups.append(current)
    return groups


def group_commits(worktree: Path, base_sha: str, review_tip: str,
                  group_paths: list[str], index_file: Path) -> tuple[str, str]:
    """Two commits for one group: a base whose tree is the review tip with the
    group's files put back to the task base, and a tip carrying the review
    tip's whole tree on top of it. `base...tip` is exactly the group's diff;
    the tree at the tip is the whole task, as it ships."""
    from factory_lib import clean_git_env
    env = {**clean_git_env(), "GIT_INDEX_FILE": str(index_file),
           "GIT_AUTHOR_NAME": "forge-review", "GIT_AUTHOR_EMAIL": "forge-review@local",
           "GIT_COMMITTER_NAME": "forge-review",
           "GIT_COMMITTER_EMAIL": "forge-review@local"}

    def run(description: str, *args: str) -> str:
        proc = subprocess.run(["git", *args], cwd=worktree, capture_output=True,
                              text=True, env=env, encoding="utf-8")
        if proc.returncode != 0:
            fail(f"{description} failed: {proc.stderr.strip() or proc.stdout.strip()}")
        return proc.stdout.strip()

    run("reading the review tip", "read-tree", review_tip)
    for rel in group_paths:
        entry = _git(worktree, "ls-tree", base_sha, "--", rel).stdout.strip()
        if entry:
            mode, _kind, sha = entry.split("\t", 1)[0].split()
            run(f"putting {rel} at the task base", "update-index", "--add",
                "--cacheinfo", f"{mode},{sha},{rel}")
        else:
            run(f"dropping {rel} from the group base", "update-index",
                "--force-remove", "--", rel)
    tree = run("writing the group base tree", "write-tree")
    group_base = run("committing the group base", "commit-tree", tree, "-p", base_sha,
                     "-m", f"review group base: {len(group_paths)} path(s) at task "
                           f"base {base_sha[:12]}")
    group_tip = run("committing the group tip", "commit-tree", f"{review_tip}^{{tree}}",
                    "-p", group_base, "-m", "review group tip: the whole task tree")
    return group_base, group_tip


def group_note(index: int, total: int, paths: list[str], others: list[str],
               repo_readable: bool) -> str:
    def listed(items: list[str]) -> str:
        shown = "\n".join(f"- {item}" for item in items[:LISTED_PATHS])
        more = len(items) - LISTED_PATHS
        return shown + (f"\n- ... and {more} more" if more > 0 else "")

    lines = [
        f"REVIEW GROUP {index} OF {total}. The task's diff was too large for one "
        "pass, so this bundle carries only these changed files:", listed(paths), "",
    ]
    if repo_readable:
        lines += [
            f"The task's other changed files ({len(others)}) are reviewed by the "
            "other groups. They ARE in the tree at HEAD, your working folder, "
            "exactly as they will ship:", listed(others), "",
            "Review the bundle's files through all three lenses; raise findings "
            "only on the bundle's files and the code they call, located in the "
            "bundle. Record a verdict for every contract you can prove from a line "
            "you read, with that line as its location, wherever the line is; a "
            "verdict record located outside this bundle is set aside by the "
            "review tool and counted by the harness. A contract you cannot prove "
            "from what you read is left for the group that holds its code: write "
            "no record for it.",
        ]
    else:
        lines += [
            f"The task's other changed files ({len(others)}) are reviewed by the "
            "other groups and are not visible to you:", listed(others), "",
            "Review the bundle's files through all three lenses; raise findings "
            "only on the bundle's files. Record a verdict only for a contract "
            "whose evidence is in this bundle; the others are recorded by the "
            "groups that hold their code.",
        ]
    lines += ["", "Every group's result is merged: your findings are kept, the "
              "worst verdict per contract wins, and a contract no group records "
              "is partial, fail-closed."]
    return "\n".join(lines)


def diagnose_refusal(problem: str, parsed: dict | None = None,
                     paths: list[str] | None = None) -> str:
    """Turn a refusal into the one instruction the retry needs."""
    text = problem.lower()
    quoted = problem.strip().rstrip(".")
    rejected = parsed.get("scope_rejected_findings") if isinstance(parsed, dict) else None
    from .review import _is_verdict_record
    # Set-aside verdict records are counted, not a refusal; only a set-aside
    # DEFECT is what the reviewer must move or drop.
    if isinstance(rejected, list) and any(not _is_verdict_record(f) for f in rejected):
        named = [
            f"{finding.get('title', '?')} @ "
            f"{(finding.get('code_location') or {}).get('file_path', '?')}"
            for finding in rejected if isinstance(finding, dict)]
        return (f"Your previous pass was refused: the review tool set aside "
                f"{len(rejected)} finding(s) located outside this bundle and at least "
                "one is not a verdict record: " + "; ".join(named[:6]) + ". A defect "
                "finding must be located in one of this bundle's files: "
                + ", ".join(paths or []) + ". Move it there or drop it.")
    if "within 3000 characters" in text:
        return ("Your previous pass overflowed overall_explanation (the tool caps it "
                "at 3000 characters). Keep each of the three assessments to a few "
                "sentences; verdicts are finding records, never lines in "
                "overall_explanation.")
    if "marker" in text or "assessment is empty" in text or "order" in text \
            or "copied one lens" in text:
        return (f"Your previous pass was refused: {quoted}. Write the six marker "
                "lines exactly once each, in the order quality, performance, "
                "security, each pair with its own non-empty assessment between "
                "them, and no VERDICT line in overall_explanation.")
    if "verdict" in text:
        return (f"Your previous pass was refused: {quoted}. Every plan contract "
                "needs exactly one finding titled `[quality] VERDICT <id>: "
                "implemented|partial|missing`; no VERDICT under any other lens tag "
                "and none in overall_explanation.")
    if "lens title tag" in text or "invalid" in text or "duplicate" in text:
        return (f"Your previous pass was refused: {quoted}. Every finding needs "
                "exactly one of [quality] , [performance] , [security] at the start "
                "of its title, a file_path and line, one of the five categories, a "
                "P0-P3 priority and null source_attribution.")
    if "json" in text or "exited" in text:
        return (f"Your previous pass produced no usable result ({quoted}). Return "
                "exactly one JSON object matching the schema and nothing else.")
    return f"Your previous pass was refused: {quoted}. Correct exactly that."


def _bounded(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    suffix = "\n\n[truncated]"
    return text[:max(0, limit - len(suffix))] + suffix


def flatten_passes(report: dict) -> list[dict]:
    """The chunk wrappers inside one group result: the group's single pass,
    or, when the tool chunked the group internally, each of its passes. Each
    carries the report fields plus provider_report, as `_actual_passes`
    expects of a chunk."""
    if "pass_reports" in report:
        return [copy.deepcopy(entry["report"]) for entry in report["pass_reports"]]
    return [{key: copy.deepcopy(value) for key, value in report.items()
             if key != "review_status"}]


def merge_group_reports(wrappers: list[dict]) -> dict:
    """Merge chunk wrappers the way the reviewer tool merges its own chunks
    (merge_chunk_reports): one finding per (path, line, category, title), its
    body prefixed with the chunk label, aggregate correctness, the minimum
    confidence, every pass preserved under pass_reports."""
    labelled = [(f"chunk {index}/{len(wrappers)}", wrapper)
                for index, wrapper in enumerate(wrappers, 1)]
    findings: list[dict] = []
    seen: set[tuple[str, int, str, str]] = set()
    for label, wrapper in labelled:
        for finding in wrapper["findings"]:
            location = finding["code_location"]
            key = (location["file_path"], location["line"], finding["category"],
                   " ".join(finding["title"].lower().split()))
            if key in seen:
                continue
            seen.add(key)
            merged = copy.deepcopy(finding)
            merged["body"] = _bounded(f"{label}:\n\n{merged['body']}", 2000)
            findings.append(merged)
    summary = ", ".join(f"{label}: {len(wrapper['findings'])} finding(s)"
                        for label, wrapper in labelled)
    incorrect = bool(findings) or any(
        wrapper["overall_correctness"] == "patch is incorrect" for _, wrapper in labelled)
    report = {
        "findings": findings,
        "overall_correctness": "patch is incorrect" if incorrect else "patch is correct",
        "overall_explanation": _bounded(
            f"Review passes returned. {summary}. See preserved pass reports for "
            "provider conclusions.", 3000),
        "overall_confidence": min(wrapper["overall_confidence"] for _, wrapper in labelled),
        "pass_reports": [{"label": label, "report": copy.deepcopy(wrapper)}
                         for label, wrapper in labelled],
    }
    if len(labelled) == 1:
        report.update(copy.deepcopy(labelled[0][1]))
        report["findings"] = findings
    for field in ("scope_rejected_findings", "priority_filtered_findings",
                  "attribution_rejected_findings"):
        retained = [copy.deepcopy(finding) for _, wrapper in labelled
                    for finding in wrapper.get(field) or []]
        if retained:
            report[field] = retained
    incomplete = any(report.get(field) for field in (
        "scope_rejected_findings", "missing_required_findings",
        "attribution_rejected_findings"))
    report["review_status"] = (
        "incomplete" if incomplete else "findings" if findings
        else "filtered" if report.get("priority_filtered_findings")
        else "incorrect" if report["overall_correctness"] == "patch is incorrect"
        else "scoped-clean")
    return report


def run_groups(*, groups: list[dict], prompt_rel: str, log_dir: Path,
               ledger_root: Path, argv_for, validate,
               heartbeat_every: float = 60.0) -> list[dict]:
    """Release one three-lens run per group, all together; join them; re-run
    alone every group whose result is refused, with the cause in its brief.

    `groups` entries carry `label` and `worktree`. `argv_for(group, json_out,
    extra_prompt)` builds the argv. `validate(parsed)` raises SystemExit (via
    `fail`, which prints the reason) when the result would be refused at
    record time. Each group returns with `report`, `raw`, `attempts` and
    `seconds`. Every attempt's output and JSON stay under `log_dir`.
    """
    from .review import _close_codex_run, _record_codex_run, _stamp_codex_run

    log_dir.mkdir(parents=True, exist_ok=True)
    pending = list(groups)
    for group in groups:
        group.update({"attempts": 0, "extra_prompt": None, "seconds": 0})
    started_all = time.monotonic()
    while pending:
        launched: dict[str, dict] = {}
        try:
            for group in pending:
                group["attempts"] += 1
                stem = f"{group['label']}.attempt{group['attempts']}"
                json_out = log_dir / f"{stem}.json"
                json_out.unlink(missing_ok=True)
                argv = argv_for(group, json_out, group["extra_prompt"])
                log = (log_dir / f"{stem}.log").open("wb")
                run_id = _record_codex_run(ledger_root, f"{prompt_rel} [{group['label']}]", argv)
                process = subprocess.Popen(
                    argv, cwd=group["worktree"], stdout=log, stderr=subprocess.STDOUT,
                    env={**os.environ, "PYTHONUTF8": "1"})
                _stamp_codex_run(ledger_root, run_id, pid=process.pid)
                launched[group["label"]] = {
                    "group": group, "process": process, "run_id": run_id, "log": log,
                    "json": json_out, "started": time.monotonic(), "returncode": None}
            print(f"review groups released together: {', '.join(launched)} (pids "
                  f"{', '.join(str(item['process'].pid) for item in launched.values())}); "
                  f"each group's output is {log_dir.as_posix()}/<group>.attemptN.log",
                  flush=True)
            last_beat = time.monotonic()
            while any(item["returncode"] is None for item in launched.values()):
                for label, item in launched.items():
                    if item["returncode"] is not None:
                        continue
                    code = item["process"].poll()
                    if code is None:
                        continue
                    item["returncode"] = code
                    _close_codex_run(ledger_root, item["run_id"], code)
                    item["log"].close()
                    took = int(time.monotonic() - item["started"])
                    item["group"]["seconds"] += took
                    print(f"== {label} finished (exit {code}, {took}s) ==", flush=True)
                now = time.monotonic()
                if now - last_beat >= heartbeat_every:
                    last_beat = now
                    running = " · ".join(
                        f"{label} {int(now - item['started'])}s"
                        for label, item in launched.items() if item["returncode"] is None)
                    print(f"review still running: {running}", flush=True)
                time.sleep(0.25)
        finally:
            for item in launched.values():
                if item["returncode"] is None:
                    try:
                        item["process"].terminate()
                    except OSError:
                        pass
                    _close_codex_run(ledger_root, item["run_id"], None)
                try:
                    item["log"].close()
                except OSError:
                    pass

        still: list[dict] = []
        for label, item in launched.items():
            group = item["group"]
            problem = ""
            parsed = None
            raw = b""
            if item["returncode"] not in (0, 1, 2):  # 2: incomplete, judged by the validators
                problem = f"the review tool exited {item['returncode']}"
            elif not item["json"].is_file():
                problem = "the review tool produced no JSON"
            else:
                raw = item["json"].read_bytes()
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    problem = f"the review tool produced invalid JSON: {exc}"
            if parsed is not None and not problem:
                problem = _refusal(validate, parsed)
            if not problem:
                group["report"], group["raw"] = parsed, raw
                continue
            if group["attempts"] > MAX_GROUP_RETRIES:
                fail(f"{label} was refused {group['attempts']} times; last cause: "
                     f"{problem}. Its attempts are kept under {log_dir.as_posix()} "
                     f"({label}.attempt*.log and .json); read them, fix the cause, "
                     "rerun the review.")
            group["extra_prompt"] = (f"RETRY {group['attempts'] + 1}: "
                                     + diagnose_refusal(problem, parsed, group.get("paths") or []))
            print(f"== {label} refused ({problem}); retrying it alone with the cause "
                  f"in its brief (attempt {group['attempts'] + 1}) ==", flush=True)
            still.append(group)
        pending = still
    total = int(time.monotonic() - started_all)
    timing = ", ".join(f"{group['label']} {group['seconds']}s"
                       + (f" x{group['attempts']}" if group["attempts"] > 1 else "")
                       for group in groups)
    print(f"review groups done in {total}s wall ({timing})", flush=True)
    return groups


def _refusal(validate, parsed: dict) -> str:
    """The reason `validate` refuses `parsed`, or '' when it accepts it.
    `fail` prints `ERROR: <reason>` and exits; the reason is captured here so
    it can be handed back to the reviewer."""
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            validate(copy.deepcopy(parsed))
    except SystemExit as exc:
        reason = captured.getvalue().strip()
        reason = reason.split("ERROR: ", 1)[-1].strip() if reason else ""
        return reason or (str(exc.code) if not isinstance(exc.code, int) else "refused")
    return ""
