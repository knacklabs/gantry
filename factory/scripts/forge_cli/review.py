"""forge review <task-id> — release Codex for a task's three-lens review and
record the three artifacts as that task's proof (decisions 0011, 0049).

One command replaces the hand-assembled skill invocation the coordinator used
to get wrong: it pins the task tip in a clean detached worktree (so harness
writes in the main tree cannot abort the run), reviews the WHOLE task diff from
the task's recorded base (branch mode; `--mode commit` would see only the last
commit), runs the autoreview skill once with Codex as the engine, drops findings
on harness bookkeeping paths, derives each lens artifact, parses
the quality verdicts from the reviewer's prose, and records all three through
the existing schema-validated recorder. It always ends by printing the exact
next command.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import uuid
import unicodedata
from pathlib import Path, PurePosixPath

from factory_lib import (
    branch_diff_digest, clean_git_env, head_sha, load_json, product_delta_digest,
    proof_path, protected_decomposition_state_path, repo_root, run_state_path,
    safe_factory_write_bytes, schema_path,
)

from .common import fail
from .review_brief import (
    LEFTOVER_INSTRUCTION, VERDICT_INSTRUCTION, _task_section, cmd_review_brief,
)
# Reuse the task module's git helpers rather than adding another lossless
# capture site: theirs is already reviewed and content-pinned for path output.
from .tasks import _git, _require_git

LENSES = ("quality", "performance", "security")
REVIEW_DATASET_REL = ".factory/review-briefs/all.md"
# Harness bookkeeping is never the subject of a product review.
HARNESS_PREFIXES = (".factory/", "plans/", "docs/decisions/")
# The recorder's contract_verdicts shape: {contract_id, verdict, evidence}.
VERDICT_LINE = re.compile(
    r"^\s*VERDICT\s+(?P<id>[A-Za-z0-9._:-]+)\s*:\s*"
    r"(?P<verdict>implemented|partial|missing)\b\s*(?:[—–-]+\s*(?P<evidence>.*))?$",
    re.IGNORECASE | re.MULTILINE,
)
DEFAULT_SKILL = Path.home() / ".codex" / "skills" / "autoreview" / "scripts" / "autoreview"
CODEX_REVIEW_MODEL = "gpt-5.6-sol"
CODEX_REVIEW_THINKING = "high"
# Terra is retired and this review never asks for it. It cannot be ruled out by
# flag: the helper's --fallback-model is claude-only ("--fallback-model is only
# supported for claude"), and its codex access-retry triggers whenever codex runs
# on the helper's own default model — which IS gpt-5.6-sol, the model pinned
# here. So the retry is reachable only when the account cannot reach Sol, in
# which case the review would otherwise fail outright. What is enforceable, and
# what is enforced, is that no retired model is ever requested.
CODEX_HELPER_FIX = "the review must not request a retired model"

# The reviewer's working folder IS the reviewed worktree, read-only (decision
# 0076): a verdict about code the diff does not show is read, not guessed.
COMMON_PREAMBLE = """\
You are one lens of a three-lens code review. The diff bundle is the subject.
Your working folder is the reviewed repository at the task tip, READ-ONLY; the
skill's note that the sandbox is empty does not apply to this run. Judge the
diff first. When a verdict or a finding depends on code the diff does not show
-- the callee of a changed line, a file a contract names, the other places a
contract covers -- open it (cat, sed -n, rg) and cite the line you read.
"Cannot verify from the diff" is not a verdict and not a finding: a partial or
missing verdict names the line that fails, and a finding about unchanged code
names the line that shows the defect. Read to resolve, not to roam: no finding
on code the diff neither touches nor calls. Report every finding with its
file_path and line. Use ONLY these categories: bug, security, regression,
test_gap, maintainability. Priorities: P0/P1 block the task; P2/P3 must be
resolved or explicitly deferred with a reason before it ships.
"""

# The fallback when the tree cannot be offered (another engine, codex not on
# PATH, or FORGE_REVIEW_EMPTY_WORKSPACE set): the reviewer is told so, and told
# that what it cannot see is not thereby partial.
DIFF_ONLY_PREAMBLE = """\
You are one lens of a three-lens code review. You see ONLY the diff bundle for
this task (no repository access). Judge what the diff shows. What the diff does
not show is not thereby partial or missing: a contract whose evidence lies in
unchanged code, or a call whose callee you cannot open, is verdicted
implemented with the evidence "not in the bundle: <the file you would need>"
so the host checks that line; reserve partial and missing for a line in the
bundle that fails the contract. Report every
finding with its file_path and line. Use ONLY these categories: bug, security,
regression, test_gap, maintainability. Priorities: P0/P1 block the task; P2/P3
must be resolved or explicitly deferred with a reason before it ships.
"""

LENS_FOCUS = {
    "quality": """\
LENS: QUALITY. Correctness, regressions, gaps in the implementer's tests,
API/contract drift, and maintainability. Check approved-deliverable presence and
reachability FIRST: every deliverable a plan contract, acceptance criterion, or
the reviewer focus names must be genuinely implemented AND reachable (registered,
invoked — not merely defined in a file nothing imports); an absent or unreachable
deliverable is a blocking finding even when the rest is clean. Flag
single-responsibility violations and incoherent file/folder organisation against
the reviewer focus (never a mandated layout). Structure-for-growth in shared
infrastructure is NOT over-engineering; reserve that finding for speculative
abstraction. Enforce the minimal-diff discipline (a new dependency where the
stdlib suffices, reimplementing an existing helper, sprawl where a surgical
change would do) — but a diff that drops validation, error handling, security, or
accessibility to look smaller is the OPPOSITE finding. The constitution's coding
standards are law: flag deviations you can see in the diff. Assess cyclomatic
complexity of every changed function; genuinely knotted control flow (roughly
>10 independent paths) is blocking and must name its decomposition.
""",
    "performance": """\
LENS: PERFORMANCE. Hot paths, algorithmic complexity, query fanout (N+1),
I/O amplification, memory churn, concurrency bottlenecks, missing pagination or
bounds, work repeated per request that could be done once. Distinguish measured
evidence from inference and say which each finding is. Use category `bug` for a
performance defect that will bite in production and `maintainability` for a cost
worth reducing.
""",
    "security": """\
LENS: SECURITY. OWASP-style trust boundaries, authentication and authorization
(every new route/handler: who may call it, with what scope), secrets and
credential handling, injection (SQL/command/template), data exposure and
over-broad responses, unsafe defaults, privilege escalation, and abuse paths.
Use category `security` for these findings.
""",
}

QUALITY_VERDICT_FORMAT = """\
CONTRACT VERDICTS (mandatory, machine-parsed). In overall_explanation, emit ONE
line per plan contract listed under "Plan contracts" below, exactly in this form:

VERDICT <contract-id>: implemented|partial|missing — <file:line evidence>

Every listed contract must get a line. Do not rename contract ids.
"""

# A verdict as a finding RECORD: the combined review's summary box is capped at
# 3,000 characters by the helper's schema, and one VERDICT line per contract
# inside it overflowed on WF-1A T1 (3,027 characters, cut mid-word before the
# security end marker; the hour-long run was refused). A record has its own
# 2,000-character body and there is no limit on how many records a pass
# carries, so the box no longer grows with the plan (decision 0077).
VERDICT_RECORD = re.compile(
    r"^VERDICT\s+(?P<id>[A-Za-z0-9._:-]+)\s*:\s*"
    r"(?P<verdict>implemented|partial|missing)\s*$",
    re.IGNORECASE,
)
VERDICT_RECORD_FORMAT = """\
CONTRACT VERDICTS (mandatory, machine-parsed). For EVERY plan contract
listed under the target task's "Plan contracts" in {dataset}, add one finding
RECORD, never a line in overall_explanation:

- title: exactly `[quality] VERDICT <contract-id>: implemented|partial|missing`
- body: the file:line you read and one sentence of evidence (the tree is
  readable; a verdict on code the diff does not show is read, not guessed)
- code_location: that file and line; priority: P3; category: maintainability

Every listed contract must get a record, in every pass. Do not rename contract
ids. A verdict record is not a defect: it is lifted out of the findings before
they are counted. Keep overall_explanation to the three short assessments.
"""

# What a finding states, and what is not one. On WF-1 T5 eleven of the first
# twenty-five blockers died on a line the reviewer had not read (the callee
# already threw; the DTO never accepted the field), and the fix rounds they
# cost were the bulk of the task's five hours (decision 0075).
FINDING_FORM = """\
FINDING FORM. Every finding, blocking or not, states in its body: the trigger
(the input or state that reaches the line), the behaviour the code shows there,
the contract, decision or rule it breaks, and the concrete risk. A finding
without a file:line that shows the behaviour is not a finding. Before demanding
a change, check the approved decisions, rulings and lessons in the dataset; a
finding that contradicts settled text is rejected on the record. Judge
reachability only where the evidence shows it: missing context is not proof of
absent implementation -- read the tree before calling a deliverable absent,
and name where you looked. A static security finding needs the trust boundary
and the line, not an executed exploit.
"""

SECTION_MARKERS = tuple(
    (lens, f"BEGIN FORGE ASSESSMENT {lens}", f"END FORGE ASSESSMENT {lens}")
    for lens in LENSES
)
LENS_TAGS = tuple(f"[{lens}] " for lens in LENSES)
REPORT_FIELDS = {
    "findings", "overall_correctness", "overall_explanation", "overall_confidence",
}
FINDING_FIELDS = {
    "title", "body", "priority", "confidence", "category", "code_location",
    "source_attribution",
}
REPORT_METADATA_FIELDS = {
    "scope_rejected_findings", "priority_filtered_findings", "attribution_rejected_findings",
    "missing_required_findings", "available_source_records"}
ATTRIBUTION_FIELDS = {"target", "record_id", "source_id", "side", "column", "excerpt"}


def resolve_skill(explicit: str | None) -> Path:
    """The autoreview skill helper: --skill, $AUTOREVIEW, the standard install,
    or PATH — in that order."""
    for candidate in (explicit, os.environ.get("AUTOREVIEW")):
        if candidate:
            path = Path(candidate).expanduser()
            if path.is_file():
                return path
            fail(f"autoreview skill not found at {path}")
    if DEFAULT_SKILL.is_file():
        return DEFAULT_SKILL
    found = shutil.which("autoreview")
    if found:
        return Path(found)
    fail("autoreview skill not found: install it under ~/.codex/skills/autoreview "
         "or set AUTOREVIEW to its scripts/autoreview path")
    raise AssertionError("unreachable")


def _require_safe_codex_review_helper(argv: list[str]) -> None:
    """The review must not request a retired model.

    This used to scan the helper's SOURCE for "gpt-5.6-terra" or its fallback
    constant and refuse the helper outright. The shipped helper carries that
    constant as an access-only retry, so the scan refused every published
    version and blocked the review gate entirely.

    A first attempt to pin --fallback-model was wrong too: that flag is
    claude-only and the helper exits on it for codex. The codex access-retry has
    no CLI lever at all. So the enforceable rule is the honest one — the review
    pins Sol and never requests a retired model.
    """
    if "--model" not in argv:
        fail(f"{CODEX_HELPER_FIX}: the review argv does not pin a model")
    model = argv[argv.index("--model") + 1]
    if model != CODEX_REVIEW_MODEL:
        fail(f"{CODEX_HELPER_FIX}: model is {model!r}, "
             f"expected {CODEX_REVIEW_MODEL!r}")
    if any("terra" in part.lower() for part in argv):
        fail(f"{CODEX_HELPER_FIX}: a retired model appears in the review argv")


# What the recorder reads from a combined run. An installed helper that does
# not write these ran for an hour on WF-1A T1 (2026-09-14) and its 29
# findings were then refused at record time; the coordinator triaged them
# from the log by hand. Refuse before the run instead.
REQUIRED_HELPER_OUTPUT = ("review_status", "provider_report")


def _require_current_review_helper(skill: Path) -> None:
    try:
        source = skill.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return  # an unreadable or absent helper is refused by _helper_identity
    missing = [key for key in REQUIRED_HELPER_OUTPUT if key not in source]
    if missing:
        fail(f"the installed autoreview helper at {skill} predates the combined "
             f"review output the recorder reads (it never writes "
             f"{', '.join(missing)}); a run would finish and then be refused at "
             "record time. Run `./forge doctor --fix` to refresh it, then retry.")


def _helper_identity(skill: Path) -> tuple[dict[str, str], tuple[int, int]]:
    try:
        resolved = skill.resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail(f"autoreview helper is not a regular single-link file: {resolved}")
        body = resolved.read_bytes()
        after = resolved.stat()
    except (OSError, RuntimeError):
        fail(f"could not resolve the autoreview helper as one regular file: {skill}")
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
    ):
        fail("autoreview helper changed while its identity was captured")
    digest = hashlib.sha256(body).hexdigest()
    version = digest
    version_path = resolved.parent.parent / ".upstream-sha"
    try:
        version_info = version_path.lstat()
    except FileNotFoundError:
        pass
    except OSError:
        fail(f"could not read autoreview helper version: {version_path}")
    else:
        if not stat.S_ISREG(version_info.st_mode) or version_info.st_nlink != 1:
            fail(f"autoreview helper version is invalid: {version_path}")
        try:
            version = version_path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            fail(f"could not read autoreview helper version: {version_path}")
        if not re.fullmatch(r"[0-9a-f]{40,64}", version):
            fail(f"autoreview helper version is invalid: {version_path}")
    return ({"path": str(resolved), "version": version, "sha256": digest},
            (info.st_dev, info.st_ino))


def review_excluded_prefixes(base: Path) -> tuple[str, ...]:
    """Paths a product review never judges: harness bookkeeping, the workflow
    ledgers, and — in a VENDORED client — the harness machinery itself
    (`factory/`, `.claude/`, `constitution/`, ...), which `forge upgrade`
    rewrites mid-task and which the stage measure already exempts
    (`workflow_prefixes`). A re-vendor commit on a task branch once put 36
    harness files into a client's review bundle and the quality lens raised
    P1s against harness code the task never touched."""
    # The same set the stage measures and the stamp binds to; one function,
    # so a path is product for every closeout check or for none.
    from factory_lib import product_excluded_prefixes
    return product_excluded_prefixes(base)


def _product_dirty(base: Path) -> list[str]:
    """Dirty product paths, from NUL-separated porcelain with no stripping.

    Stripping the status text ate the leading space of a first ` M path`
    entry, and `line[3:]` then cut the first character of the path itself --
    `plans/roadmap.json` became `lans/roadmap.json`, outside every excluded
    prefix, and a review refused on harness bookkeeping. Both sides of a
    rename count: either path being dirty is a dirty tree.
    """
    excluded = review_excluded_prefixes(base)
    proc = _git(base, "status", "--porcelain", "-z", "--untracked-files=all")
    if proc.returncode != 0:
        fail("reading working tree status failed"
             + (f": {proc.stderr.strip()}" if proc.stderr.strip() else ""))
    entries = proc.stdout.split("\0")
    dirty: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        paths = [path]
        if code[:1] in ("R", "C") and index < len(entries) and entries[index]:
            paths.append(entries[index])  # the rename/copy source follows
            index += 1
        for rel in paths:
            if rel and not rel.startswith(excluded):
                dirty.append(rel)
    return dirty


def _lens_prompt(task: dict, lens: str, base: Path | None = None, *,
                 repo_readable: bool = True) -> bytes:
    preamble = COMMON_PREAMBLE if repo_readable else DIFF_ONLY_PREAMBLE
    lines = [f"# Review brief — {task.get('id', '')} — {lens} lens", "",
             preamble, LENS_FOCUS[lens], LEFTOVER_INSTRUCTION]
    if lens == "quality":
        lines += [QUALITY_VERDICT_FORMAT, VERDICT_INSTRUCTION, ""]
    lines += _task_section(task, None)
    return ("\n".join(lines).rstrip() + "\n").encode()


def _combined_prompt(task: dict, *, repo_readable: bool = True) -> bytes:
    contracts = [
        str(contract.get("id")) for contract in task.get("plan_contracts") or []
        if isinstance(contract, dict) and isinstance(contract.get("id"), str)
    ]
    # The box holds markers and three short assessments only; verdicts are
    # records (VERDICT_RECORD_FORMAT), so this never depends on len(contracts).
    minimum = [
        "BEGIN FORGE ASSESSMENT quality", "quality assessment",
        "END FORGE ASSESSMENT quality",
        "BEGIN FORGE ASSESSMENT performance", "performance assessment",
        "END FORGE ASSESSMENT performance", "BEGIN FORGE ASSESSMENT security",
        "security assessment", "END FORGE ASSESSMENT security",
    ]
    if len("\n".join(minimum)) > 3000:
        fail("combined review boilerplate cannot fit the helper's 3000-character "
             "overall_explanation limit")
    del contracts
    lines = [
        f"# Review brief — {task.get('id', '')} — combined review", "",
        (COMMON_PREAMBLE if repo_readable else DIFF_ONLY_PREAMBLE).replace(
            "one lens of a three-lens", "the three-lens"),
        "The target task's complete Plan contracts and Reviewer focus are supplied "
        f"in `{REVIEW_DATASET_REL}`; use that dataset for task-specific review "
        "requirements.", "",
        "Assess quality, performance, and security in one provider pass. In every "
        "provider pass, overall_explanation must contain these exact full-line "
        "markers once, in this order, with a non-empty assessment between each pair:",
        "", "BEGIN FORGE ASSESSMENT quality", "<quality assessment>",
        "END FORGE ASSESSMENT quality", "BEGIN FORGE ASSESSMENT performance",
        "<performance assessment>", "END FORGE ASSESSMENT performance",
        "BEGIN FORGE ASSESSMENT security", "<security assessment>",
        "END FORGE ASSESSMENT security", "",
        "Keep each assessment short, a few sentences: overall_explanation is capped "
        "at 3000 characters in total and holds ONLY these three assessments. Never "
        "write VERDICT lines in it; a verdict is a finding record.", "",
        "Prefix every finding title with exactly one matching token: [quality] , "
        "[performance] , or [security] .", "", FINDING_FORM, "", LENS_FOCUS["quality"],
        VERDICT_RECORD_FORMAT.format(dataset=REVIEW_DATASET_REL), "",
        LENS_FOCUS["performance"],
        LENS_FOCUS["security"], LEFTOVER_INSTRUCTION, "",
    ]
    return ("\n".join(lines).rstrip() + "\n").encode()


def _pass_sections(report: dict) -> tuple[dict[str, str], list[str]]:
    explanation = report.get("overall_explanation")
    if not isinstance(explanation, str) or len(explanation) > 3000:
        fail("combined review pass needs overall_explanation within 3000 characters")
    lines = explanation.splitlines()
    positions: list[int] = []
    sections: dict[str, str] = {}
    for lens, begin, end in SECTION_MARKERS:
        if lines.count(begin) != 1 or lines.count(end) != 1:
            fail(f"combined review pass needs exact full-line {begin} and {end} markers")
        start, stop = lines.index(begin), lines.index(end)
        if stop <= start + 1:
            fail(f"combined review {lens} assessment is empty")
        body = "\n".join(lines[start + 1:stop]).strip()
        if not body:
            fail(f"combined review {lens} assessment is empty")
        positions.extend((start, stop))
        sections[lens] = body
    if positions != sorted(positions):
        fail("combined review lens sections are not in quality, performance, security order")
    qs, qe, ps, pe, ss, se = positions
    non_quality = (lines[:qs], lines[qe + 1:ps], lines[ps + 1:pe],
                   lines[pe + 1:ss], lines[ss + 1:se], lines[se + 1:])
    if any(VERDICT_LINE.search("\n".join(span)) for span in non_quality):
        fail("combined review VERDICT lines must appear only in the quality assessment")
    if len(set(sections.values())) != len(LENSES):
        fail("combined review copied one lens assessment into another lens")
    return sections, lines


def _valid_confidence(value: object) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and 0 <= value <= 1)


def _normalized_helper_path(value: object) -> str:
    if not isinstance(value, str) or not value:
        fail("combined review finding has invalid file_path")
    normalized = value.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    path = PurePosixPath(normalized)
    result = path.as_posix()
    if (not result or path.is_absolute() or ".." in path.parts
            or re.match(r"^[A-Za-z]:/", result)):
        fail("combined review finding has invalid file_path")
    return result


def _validate_helper_finding(finding: object, *, accepted: bool) -> dict:
    if not isinstance(finding, dict) or set(finding) != FINDING_FIELDS:
        fail("combined review finding has invalid fields")
    if (not isinstance(finding.get("title"), str) or not finding["title"] or
            len(finding["title"]) > 140):
        fail("combined review finding has invalid title")
    if (not isinstance(finding.get("body"), str) or not finding["body"] or
            len(finding["body"]) > 2000):
        fail("combined review finding has invalid body")
    if (not isinstance(finding.get("priority"), str)
            or finding["priority"] not in {"P0", "P1", "P2", "P3"}):
        fail("combined review finding has invalid priority")
    if not _valid_confidence(finding.get("confidence")):
        fail("combined review finding has invalid confidence")
    if (not isinstance(finding.get("category"), str) or finding["category"] not in
            {"bug", "security", "regression", "test_gap", "maintainability"}):
        fail("combined review finding has invalid category")
    location = finding.get("code_location")
    if (not isinstance(location, dict) or set(location) != {"file_path", "line"}
            or not isinstance(location.get("line"), int)
            or isinstance(location["line"], bool) or location["line"] < 1):
        fail("combined review finding has invalid code_location")
    _normalized_helper_path(location.get("file_path"))
    attribution = finding.get("source_attribution")
    if accepted and attribution is not None:
        fail("combined review accepted findings require null source_attribution")
    if attribution is not None and (
            not isinstance(attribution, dict) or set(attribution) != ATTRIBUTION_FIELDS
            or not all(isinstance(attribution.get(field), str)
                       for field in ATTRIBUTION_FIELDS - {"column"})
            or attribution["target"] not in {"index", "working_tree"}
            or attribution["side"] not in {"present", "removed"}
            or not isinstance(attribution.get("column"), int)
            or isinstance(attribution["column"], bool) or attribution["column"] < 1):
        fail("combined review finding has invalid source_attribution")
    return finding


def _validate_provider_report(report: object) -> dict:
    if not isinstance(report, dict) or set(report) != REPORT_FIELDS:
        fail("combined review report has invalid fields")
    if (not isinstance(report.get("overall_correctness"), str) or
            report["overall_correctness"] not in {"patch is correct", "patch is incorrect"}):
        fail("combined review report has invalid overall_correctness")
    explanation = report.get("overall_explanation")
    if not isinstance(explanation, str) or not explanation or len(explanation) > 3000:
        fail("combined review report needs overall_explanation within 3000 characters")
    if not _valid_confidence(report.get("overall_confidence")):
        fail("combined review report has invalid overall_confidence")
    findings = report.get("findings")
    if not isinstance(findings, list):
        fail("combined review report findings must be a list")
    for finding in findings:
        _validate_helper_finding(finding, accepted=False)
    return report


def _validate_processed_report(report: object, required: set[str]) -> dict:
    allowed = REPORT_FIELDS | required | REPORT_METADATA_FIELDS
    if (not isinstance(report, dict) or not REPORT_FIELDS | required <= set(report)
            or set(report) - allowed):
        fail("combined review helper wrapper has invalid fields")
    _validate_provider_report({field: report[field] for field in REPORT_FIELDS})
    if "provider_report" in report:
        _validate_provider_report(report["provider_report"])
    for finding in report["findings"]:
        _validate_helper_finding(finding, accepted=True)
    sample = {"overall_correctness": "patch is correct", "overall_explanation": "ok",
              "overall_confidence": 1}
    for field in ("scope_rejected_findings", "priority_filtered_findings"):
        if field in report:
            _validate_provider_report({**sample, "findings": report[field]})
    if "attribution_rejected_findings" in report:
        rejected = report["attribution_rejected_findings"]
        if not isinstance(rejected, list):
            fail("combined review attribution metadata must be a list")
        if not all(isinstance(finding, dict) and
                   set(finding) == FINDING_FIELDS | {"attribution_rejection_reason"} and
                   isinstance(finding["attribution_rejection_reason"], str) and
                   finding["attribution_rejection_reason"] for finding in rejected):
            fail("combined review attribution metadata is invalid")
        _validate_provider_report({**sample, "findings": [
            {key: value for key, value in finding.items()
             if key != "attribution_rejection_reason"} for finding in rejected]})
    missing = report.get("missing_required_findings")
    if "missing_required_findings" in report and (not isinstance(missing, list) or not all(
            isinstance(item, str) and item for item in missing)):
        fail("combined review missing-required metadata is invalid")
    available = report.get("available_source_records")
    if "available_source_records" in report and (not isinstance(available, list) or not all(
            isinstance(item, str) for item in available)):
        fail("combined review available-source metadata is invalid")
    return report


def _is_verdict_record(finding: object) -> bool:
    """A quality-lens VERDICT record, by its title alone."""
    title = finding.get("title") if isinstance(finding, dict) else None
    tag = "[quality] "
    if not isinstance(title, str) or not title.startswith(tag):
        return False
    return bool(VERDICT_RECORD.match(" ".join(
        unicodedata.normalize("NFC", title[len(tag):]).split())))


def set_aside_verdict_records(report: dict) -> list[dict]:
    """The verdict records the helper set aside as outside its diff scope.

    The helper's scope rule is for defects: a defect must be in the diff it
    was handed. A verdict record is an attestation forge asked for, and the
    reviewer cites the line it read wherever it is (0076): unchanged code in
    one call, another group's file in a split. The helper keeps what it sets
    aside verbatim under scope_rejected_findings and marks the result
    incomplete; forge validates those records itself and counts them. Any
    other set-aside item is a defect the helper would not certify, and the
    result is refused as before (WF-BIO-1 T2, 2026-09-16)."""
    rejected = report.get("scope_rejected_findings")
    if rejected is None:
        return []
    if not isinstance(rejected, list) or not rejected \
            or not all(_is_verdict_record(finding) for finding in rejected):
        fail("combined review helper result is non-certifying")
    return rejected


def _validate_certifying_wrapper(report: dict) -> None:
    set_aside = set_aside_verdict_records(report)
    if (not report["findings"] and not set_aside
            and report["overall_correctness"] == "patch is incorrect") or any(
            field in report for field in (
            "priority_filtered_findings", "attribution_rejected_findings",
            "missing_required_findings")):
        fail("combined review helper result is non-certifying")
    provider = report["provider_report"]
    if any(report[field] != provider[field]
           for field in REPORT_FIELDS - {"findings"}):
        fail("combined review processed result does not match its raw provider report")
    normalized = copy.deepcopy(provider["findings"])
    for finding in normalized:
        finding["code_location"]["file_path"] = _normalized_helper_path(
            finding["code_location"]["file_path"])
    # Kept findings and set-aside verdict records are the raw findings, each
    # once, in the reviewer's order: nothing dropped, nothing invented.
    kept, aside = list(report["findings"]), list(set_aside)
    for finding in normalized:
        if kept and kept[0] == finding:
            kept.pop(0)
        elif aside and aside[0] == finding:
            aside.pop(0)
        else:
            fail("combined review accepted findings do not match its raw provider report")
    if kept or aside:
        fail("combined review accepted findings do not match its raw provider report")


def _validate_review_status(report: dict) -> None:
    status = report.get("review_status")
    statuses = {"incomplete", "findings", "filtered", "incorrect", "scoped-clean"}
    if not isinstance(status, str) or status not in statuses:
        fail("combined review report has invalid review_status")
    incomplete = ("scope_rejected_findings", "missing_required_findings",
                  "attribution_rejected_findings")
    expected = ("incomplete" if any(report.get(field) for field in incomplete)
        else "findings" if report["findings"]
        else "filtered" if report.get("priority_filtered_findings")
        else "incorrect" if report["overall_correctness"] == "patch is incorrect"
        else "scoped-clean")
    if status != expected:
        fail("combined review report has invalid review_status")


def _actual_passes(report: object) -> list[tuple[str, dict]]:
    if not isinstance(report, dict):
        fail("combined review helper wrapper has invalid fields")
    if "pass_reports" not in report:
        processed = _validate_processed_report(report, {"provider_report", "review_status"})
        _validate_provider_report(processed["provider_report"])
        _validate_review_status(processed)
        _validate_certifying_wrapper(processed)
        if processed["review_status"] not in {"findings", "scoped-clean"} and not (
                processed["review_status"] == "incomplete"
                and set_aside_verdict_records(processed)):
            fail("combined review helper result is non-certifying")
        return [("pass 1/1", processed)]
    _validate_processed_report(report, {"pass_reports", "review_status"})
    _validate_review_status(report)
    set_aside_verdict_records(report)  # refuses anything but verdict records
    if any(field in report for field in REPORT_METADATA_FIELDS
           - {"available_source_records", "scope_rejected_findings"}):
        fail("combined review helper result is non-certifying")
    if report["review_status"] not in {"findings", "scoped-clean"} and not (
            report["review_status"] == "incomplete" and report.get("scope_rejected_findings")):
        fail("combined review helper result is non-certifying")
    entries = report.get("pass_reports")
    if not isinstance(entries, list) or not entries:
        fail("combined review pass_reports must be a non-empty list")
    total = len(entries)
    passes: list[tuple[str, dict]] = []
    for index, entry in enumerate(entries, 1):
        expected = f"chunk {index}/{total}"
        if (not isinstance(entry, dict) or set(entry) != {"label", "report"}
                or entry.get("label") != expected or not isinstance(entry.get("report"), dict)):
            fail(f"combined review pass order must be {expected}")
        wrapper = _validate_processed_report(entry["report"], {"provider_report"})
        _validate_provider_report(wrapper["provider_report"])
        _validate_certifying_wrapper(wrapper)
        passes.append((expected, wrapper))
    expected_correctness = ("patch is incorrect" if report["findings"] or any(
        item["overall_correctness"] == "patch is incorrect" for _, item in passes)
        else "patch is correct")
    if report["overall_correctness"] != expected_correctness:
        fail("combined review aggregate correctness does not match its passes")
    return passes


def _helper_bounded_field(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    suffix = "\n\n[truncated]"
    return text[:max(0, limit - len(suffix))] + suffix


def _tagged_finding(finding: dict) -> tuple[
    str, dict, tuple[str, int, int, str], tuple[str, int, str, str]
]:
    if not isinstance(finding, dict):
        fail("combined review findings must be objects")
    if "source_attribution" not in finding or finding["source_attribution"] is not None:
        fail("combined review plain-source findings require null source_attribution")
    title = finding.get("title")
    matches = [lens for lens, tag in zip(LENSES, LENS_TAGS)
               if isinstance(title, str) and title.startswith(tag)]
    if len(matches) != 1:
        fail("every combined review finding needs exactly one lens title tag")
    lens = matches[0]
    clean_title = " ".join(
        unicodedata.normalize("NFC", title[len(f"[{lens}] "):]).split()
    )
    known_tags = {tag.strip().casefold() for tag in LENS_TAGS}
    if not clean_title or any(
            tag in clean_title.casefold() for tag in known_tags):
        fail("every combined review finding needs exactly one lens title tag")
    location = finding.get("code_location")
    if not isinstance(location, dict) or set(location) != {"file_path", "line"}:
        fail("combined review finding needs one exact file_path and line")
    raw_path, line = location.get("file_path"), location.get("line")
    if (not isinstance(raw_path, str) or not raw_path or "\\" in raw_path
            or PurePosixPath(raw_path).is_absolute() or any(
                part in {"", ".."} for part in raw_path.split("/")
            ) or not isinstance(line, int) or isinstance(line, bool) or line < 1):
        fail("combined review finding location must be a repository-relative POSIX path and line")
    normalized_path = unicodedata.normalize("NFC", PurePosixPath(raw_path).as_posix())
    display_title = clean_title
    normalized_title = display_title.casefold()
    tagged_title = " ".join(
        unicodedata.normalize("NFC", title).split()).casefold()
    projected = copy.deepcopy(finding)
    projected["title"] = display_title
    projected["code_location"] = {"file_path": normalized_path, "line": line}
    return (
        lens, projected, (normalized_path, line, line, normalized_title),
        (normalized_path, line, str(finding.get("category")), tagged_title),
    )


def _project_combined_report(
    task: dict, report: dict, scope: list[str], base_sha: str, tip_sha: str,
    skills_used: list[str], all_tasks: list[dict], started: dict[str, str],
    excluded: tuple[str, ...] = HARNESS_PREFIXES,
) -> dict[str, dict]:
    if not isinstance(report, dict):
        fail("combined review result must be a JSON object")
    passes = _actual_passes(report)
    sections = [_pass_sections(provider)[0] for _, provider in passes]
    pass_findings: list[dict[str, list[dict]]] = []
    fingerprint_lenses: dict[tuple[str, int, int, str], str] = {}
    retained: list[tuple[str, dict]] = []
    retained_raw: list[dict] = []
    projected_fingerprints: set[tuple[str, int, int, str]] = set()
    seen_merge_keys: set[tuple[str, int, str, str]] = set()
    verdict_lines: list[str] = []
    for label, provider in passes:
        if not isinstance(provider.get("findings", []), list):
            fail("combined review pass findings must be a list")
        by_lens: dict[str, list[dict]] = {lens: [] for lens in LENSES}
        for finding in provider.get("findings", []):
            lens, clean, fingerprint, merge_key = _tagged_finding(finding)
            prior_lens = fingerprint_lenses.setdefault(fingerprint, lens)
            if prior_lens != lens:
                fail("combined review contains a cross-lens duplicate normalized finding")
            record = VERDICT_RECORD.match(clean["title"])
            if record and lens != "quality":
                fail("a VERDICT record carries the [quality] tag; found one under "
                     f"[{lens}]: {clean['title']}")
            if fingerprint not in projected_fingerprints:
                projected_fingerprints.add(fingerprint)
                if record:
                    # Lifted out of the findings: it feeds contract_verdicts
                    # and is never a defect, whatever priority it carries.
                    where = clean["code_location"]
                    at = f"{where['file_path']}:{where['line']}"
                    body = " ".join(str(clean.get("body", "")).split())
                    verdict_lines.append(
                        f"VERDICT {record['id']}: {record['verdict'].lower()} — "
                        + (body if at in body else f"{at} {body}"))
                else:
                    retained.append((lens, clean))
                    by_lens[lens].append(clean)
            if merge_key not in seen_merge_keys:
                seen_merge_keys.add(merge_key)
                merged = copy.deepcopy(finding)
                if "pass_reports" in report:
                    merged["body"] = _helper_bounded_field(
                        f"{label}:\n\n{merged['body']}", 2000,
                    )
                retained_raw.append(merged)
        for finding in set_aside_verdict_records(provider):
            # A verdict record the helper set aside as outside its diff scope:
            # forge's to count. It is never a finding, so it joins the verdict
            # texts only; the worst verdict per contract still wins.
            lens, clean, fingerprint, _merge_key = _tagged_finding(finding)
            record = VERDICT_RECORD.match(clean["title"])
            if lens != "quality" or not record:
                fail("combined review set aside a finding that is not a verdict record")
            if fingerprint in projected_fingerprints:
                continue
            projected_fingerprints.add(fingerprint)
            where = clean["code_location"]
            at = f"{where['file_path']}:{where['line']}"
            body = " ".join(str(clean.get("body", "")).split())
            verdict_lines.append(
                f"VERDICT {record['id']}: {record['verdict'].lower()} — "
                + (body if at in body else f"{at} {body}"))
        pass_findings.append(by_lens)
    findings = report.get("findings", [])
    if not isinstance(findings, list):
        fail("combined review findings must be a list")
    for finding in findings:
        _tagged_finding(finding)
    if findings != retained_raw:
        fail("combined review merged findings do not match its ordered provider passes")
    projected: dict[str, list[dict]] = {lens: [] for lens in LENSES}
    for lens, clean in retained:
        projected[lens].append(clean)
    artifacts: dict[str, dict] = {}
    for lens in LENSES:
        lens_report = {
            "overall_explanation": "\n\n".join(section[lens] for section in sections),
            "findings": projected[lens],
            "pass_reports": [
                {"label": label, "report": {
                    "overall_explanation": section[lens],
                    "findings": pass_projection[lens],
                }}
                for (label, _provider), section, pass_projection
                in zip(passes, sections, pass_findings)
            ],
        }
        artifacts[lens] = _artifact(
            lens, task, lens_report, scope, base_sha, tip_sha, skills_used,
            all_tasks, started, excluded,
            verdict_texts=[*(section["quality"] for section in sections),
                           *verdict_lines]
            if lens == "quality" else None,
        )
    return artifacts


def rederive_combined_lenses(base: Path, candidate: dict) -> dict[str, dict]:
    """Project a combined candidate again from current authoritative task state."""
    from .stages import load_stages, stage_baseline, task_for

    task_id = str(candidate.get("task_id") or "")
    task = task_for(base, task_id)
    stages = load_stages(base).get("stages") or []
    stage = next((item for item in stages if item.get("id") == task_id), {})
    if not task or not stage:
        fail("combined review generation needs its recorded task and stage")
    tip_sha = str(candidate.get("inspected_commit") or "")
    state = load_json(run_state_path(base), default={})
    base_sha = resolve_review_base(base, stage, state, tip_sha)
    excluded = review_excluded_prefixes(base)
    scope = sorted(
        path for path in _require_git(
            base, "listing the task diff", "diff", "--name-only",
            f"{base_sha}...{tip_sha}",
        ).splitlines()
        if path.strip() and not path.startswith(excluded)
    )
    decomposition = load_json(protected_decomposition_state_path(base), default={})
    all_tasks = [item for item in decomposition.get("tasks") or []
                 if isinstance(item, dict)]
    started = {item.get("id"): item.get("status") for item in stages
               if isinstance(item, dict)}
    skills_used: list[str] = []
    if task.get("user_facing"):
        review_schema = json.loads(schema_path(base, "review").read_text(encoding="utf-8"))
        skills_used = list((review_schema.get("required_skills") or {}).get(
            "user_facing", []))
    raw = base64.b64decode(candidate["raw_result"]["data"], validate=True)
    report = json.loads(raw.decode("utf-8"))
    artifacts = _project_combined_report(
        task, report, scope, base_sha, tip_sha, skills_used, all_tasks, started,
        excluded,
    )
    for artifact in artifacts.values():
        artifact.update({
            "review_run_id": candidate.get("review_run_id"),
            "brief_sha256": candidate.get("brief_sha256"),
            "branch_diff_digest": candidate.get("delta_id"),
            "commit": tip_sha,
        })
    return artifacts


def resolve_review_base(base: Path, stage: dict, state: dict, tip_sha: str) -> str:
    """The commit the task diff is measured from.

    The stage records the trunk commit the task started on. When the trunk is
    merged INTO the task branch later (a harness re-vendor, a sibling task
    landing), everything the trunk gained since that recorded base is reachable
    from HEAD but is not the task's work — reviewing `base...HEAD` then bundles
    the whole trunk delta, chunks the pass, and returns findings on code the
    task never touched (observed 2026-09-04: a per-task review scored 0 on five
    vendored-harness findings and recorded every contract as partial because
    the chunked reviewer never reached the verdict lines). The task's own delta
    is `merge-base(origin/<trunk>, HEAD)...HEAD`. Use that point unless it is
    an ancestor of the recorded base — i.e. no trunk landed in the branch since
    the stage began (the trunk may have moved without being merged; then the
    diff still starts where the task did). The recorded base may itself be a
    branch commit (a story branch that carried planning commits before the
    stage started, then merged the trunk): it is then neither ancestor nor
    descendant of the trunk point, no single commit means "base plus trunk",
    and the trunk point is still the right base — the branch's own commits
    since divergence are the task under the per-task flow, and on a legacy
    story branch they are the story's earlier planning artifacts, which the
    harness-path filter drops."""
    from factory_lib import default_trunk_branch
    trunk = default_trunk_branch(base)
    recorded = stage.get("base_sha") or state.get("base_main_sha")
    base_sha = recorded if isinstance(recorded, str) and recorded else None
    if base_sha is None:
        base_sha = _require_git(base, "resolving the task base", "merge-base",
                                f"origin/{trunk}", "HEAD")
    if _git(base, "merge-base", "--is-ancestor", base_sha, tip_sha).returncode != 0:
        fail(f"task base {base_sha[:12]} is not an ancestor of HEAD")
    merged = _git(base, "merge-base", f"origin/{trunk}", tip_sha)
    trunk_point = merged.stdout.strip() if merged.returncode == 0 else ""
    if (trunk_point and trunk_point != base_sha
            and _git(base, "merge-base", "--is-ancestor", trunk_point, base_sha).returncode != 0):
        print(f"task base advanced {base_sha[:12]} -> {trunk_point[:12]}: the trunk was "
              "merged into this branch after the stage began; only the branch's own "
              "delta since it diverged from the trunk is reviewed")
        return trunk_point
    return base_sha


def _area(path: str) -> str:
    parts = path.split("/")
    return "/".join(parts[:-1]) if len(parts) > 1 else path


def _structured(finding: dict) -> dict:
    location = finding.get("code_location") or {}
    where = f"{location.get('file_path', '?')}:{location.get('line', '?')}"
    body = str(finding.get("body", "")).strip()
    # Chunked runs prefix bodies with "chunk N/M:\n\n"; strip that noise.
    body = re.sub(r"^chunk \d+/\d+:\s*", "", body)
    first = body.split(". ")[0].strip()
    summary = f"{finding.get('title', '').strip()} ({where})"
    if first:
        summary += f": {first.rstrip('.')}."
    return {
        "category": str(finding.get("category", "maintainability")),
        "area": _area(str(location.get("file_path", ""))),
        "summary": summary,
        "file_path": str(location.get("file_path", "")),
        "line": location.get("line"),
        "title": str(finding.get("title", "")).strip(),
    }


def _score(blocking: int, non_blocking: int) -> int:
    # A documented heuristic, not a judgement: each blocking finding costs 3,
    # each non-blocking half a point but never more than two in total, so a
    # review with no blocking finding scores at least 8 — the seal floor. P2
    # findings are follow-ups, not a reason to refuse a task (five of them once
    # sank a clean review to 7 and blocked pr-ready). The recorded findings
    # carry the real content; the human reads those.
    return max(0, int(10 - 3 * blocking - min(2.0, 0.5 * non_blocking)))


def recorded_review_totals(base: Path, story: str, task_id: str,
                           lenses: list[str] | tuple[str, ...]) -> tuple[int, int, dict]:
    """Counts from the one selected immutable generation."""
    from factory_lib import read_selected_review_generation
    generation, _selection, problems = read_selected_review_generation(
        base, story, task_id,
    )
    recorded = (
        {lens: generation["lenses"].get(lens, {}) for lens in lenses}
        if isinstance(generation, dict) and not problems else
        {lens: {} for lens in lenses}
    )
    blocking = sum(len(a.get("blocking_findings") or []) for a in recorded.values())
    caveats = sum(len(a.get("non_blocking_findings") or []) for a in recorded.values())
    return blocking, caveats, recorded


def _next_hint(task_id: str, stage_status: str, blocking: int, caveats: int) -> str:
    """The one instruction after a review. Blocking findings go back to Codex;
    a clean run has already stamped the stage, and `task close` takes it from
    there -- re-reviewing only if the diff moves again, reopening a done stage
    itself, then measuring, closing and sealing."""
    # These are instructions, not options. A coordinator that turns a review
    # finding into a menu for the human ("fix now / ship and defer / fix it
    # myself") is asking them to arbitrate something the harness has already
    # decided: fixing a finding the review just raised is the work, and it goes
    # to Codex like every other write.
    if blocking:
        return (f"NEXT: {blocking} blocking finding(s) -- triage them yourself "
                "BEFORE any fix round. For each: open the cited line and the code "
                "it calls, and decide real or not with a file:line you read; for a "
                "real one, search the repo for every other place the same contract "
                f"applies. Record it: `./forge review {task_id} --triage \"<text>\" "
                "--lens <l> --real --evidence <file:line> --instance <file:line> "
                "[--instance ...] [--keep \"<what must not change>\"] --by <agent>`, "
                "or `--not-a-defect --evidence <file:line> --reason \"...\"`. Then "
                f"delegate the fixes to Codex (`./forge delegate {task_id}`): the "
                "brief carries your triage beside each finding and warns on any "
                f"you skipped. Commit, then `./forge task close {task_id}`: it "
                "reviews the whole task delta again, and a done stage reopens "
                "itself for the fix. Loop until no lens blocks. Do this WITHOUT "
                "asking the human "
                "to choose: a blocking finding cannot be deferred or shipped past "
                "(the seal refuses it). A finding that contradicts an accepted "
                "contract is `--reject` with `--cite`, which ledgers the contract "
                "as a lesson (`./forge lesson add` carries anything else the next "
                "round must know). Host-side fixing is the single exception, and "
                "only when the defect cannot be reproduced or fixed inside the "
                "Codex sandbox -- then open a ledgered degraded window and say why.")
    seal = f"`./forge task close {task_id}` measures, closes and seals it"
    if caveats:
        return (f"NEXT: no blocking finding; {caveats} non-blocking finding(s) "
                "recorded as follow-ups. The stage is stamped -- " + seal + ". Fix a "
                "follow-up in this task only when it is cheap and in scope; "
                "otherwise `./forge defer` it with a revisit trigger.")
    return "NEXT: all lenses clean; the stage is stamped -- " + seal + "."

def _recommendation(blocking: int, non_blocking: int) -> str:
    if blocking:
        return "request-changes"
    return "approve-with-caveats" if non_blocking else "approve"


_VERDICT_SEVERITY = {"implemented": 0, "partial": 1, "missing": 2}


def _parse_verdicts(texts: list[str]) -> dict[str, tuple[str, str]]:
    """One verdict per contract across every text; when a contract is verdicted
    more than once (a chunked review emits one VERDICT line per pass) the WORST
    verdict wins — missing over partial over implemented — so a pass that saw
    a defect is never outvoted by a pass that only saw the files exist."""
    verdicts: dict[str, tuple[str, str]] = {}
    for text in texts:
        for match in VERDICT_LINE.finditer(text or ""):
            cid = match.group("id").strip()
            found = (match.group("verdict").lower(),
                     (match.group("evidence") or "").strip() or "reviewer verdict")
            current = verdicts.get(cid)
            if current is None or (_VERDICT_SEVERITY[found[0]]
                                   > _VERDICT_SEVERITY[current[0]]):
                verdicts[cid] = found
    return verdicts


def _verdict_texts(reviewed: dict) -> list[str]:
    """The merged explanation and findings, PLUS every preserved pass report: a
    chunked autoreview keeps the reviewer's conclusions (and its VERDICT lines)
    per pass and replaces the top-level explanation with a summary line."""
    texts = [reviewed.get("overall_explanation", "")]
    texts += [f.get("body", "") for f in reviewed.get("findings", []) or []]
    for entry in reviewed.get("pass_reports", []) or []:
        report = entry.get("report") if isinstance(entry, dict) else None
        if not isinstance(report, dict):
            continue
        texts.append(report.get("overall_explanation", ""))
        texts += [f.get("body", "") for f in report.get("findings", []) or []]
    return texts


def _contract_verdicts(
    task: dict, reviewed: dict, all_tasks: list[dict], started: dict[str, str],
    *, verdict_texts: list[str] | None = None,
) -> list[dict]:
    """Verdicts for the reviewed task come from the reviewer; contracts of other
    tasks already done are attested as shipped at their own seal; contracts of
    tasks that have not started are not required (recorder, decision 0049)."""
    out: list[dict] = []
    parsed = _parse_verdicts(
        verdict_texts if verdict_texts is not None else _verdict_texts(reviewed)
    )
    for contract in task.get("plan_contracts") or []:
        cid = contract.get("id")
        if not isinstance(cid, str):
            continue
        if cid in parsed:
            verdict, evidence = parsed[cid]
        else:
            verdict, evidence = "partial", (
                "the reviewer emitted no VERDICT line for this contract; "
                "recorded as partial (fail-closed) — re-review or verdict it")
        out.append({"contract_id": cid, "verdict": verdict, "evidence": evidence})
    for other in all_tasks:
        oid = other.get("id")
        if oid == task.get("id") or started.get(oid) != "done":
            continue
        for contract in other.get("plan_contracts") or []:
            cid = contract.get("id")
            if isinstance(cid, str):
                out.append({
                    "contract_id": cid, "verdict": "implemented",
                    "evidence": f"shipped under {oid} at its own per-task seal "
                                "(stage done); unchanged by this task's diff",
                })
    return out


def _artifact(
    lens: str, task: dict, report: dict, scope: list[str], base_sha: str,
    tip_sha: str, skills_used: list[str], all_tasks: list[dict],
    started: dict[str, str], excluded: tuple[str, ...] = HARNESS_PREFIXES,
    *, verdict_texts: list[str] | None = None,
) -> dict:
    findings = [
        f for f in report.get("findings", [])
        if isinstance(f, dict) and not str(
            (f.get("code_location") or {}).get("file_path", "")
        ).startswith(excluded)
    ]
    blocking = [_structured(f) for f in findings if f.get("priority") in ("P0", "P1")]
    non_blocking = [_structured(f) for f in findings if f.get("priority") not in ("P0", "P1")]
    verdicts: list[dict] = []
    if lens == "quality":
        verdicts = _contract_verdicts(
            task, report, all_tasks, started, verdict_texts=verdict_texts)
        # A partial or missing verdict on one of THIS task's contracts is a
        # blocking finding, fail-closed. The per-aspect recorder always made
        # it one; the combined generation (0069) counted only the reviewer's
        # findings, so a stage was stamped clean over a partial contract and
        # `task close` sealed it (found by the 0078 group run, 2026-09-15).
        own = {c.get("id"): c for c in task.get("plan_contracts") or []
               if isinstance(c, dict)}
        blocking += [_contract_blocker(own[v["contract_id"]], v) for v in verdicts
                     if v["verdict"] in ("partial", "missing") and v["contract_id"] in own]
    explanation = re.sub(r"^Chunked review complete\.\s*", "",
                         str(report.get("overall_explanation", "")).strip())
    summary = (
        f"{lens} lens over {task.get('id')} ({len(scope)} product path(s), "
        f"{base_sha[:7]}..{tip_sha[:7]}, Codex via the autoreview skill): "
        f"{len(blocking)} blocking, {len(non_blocking)} "
        f"non-blocking. {explanation}"
    ).strip()[:3000]
    artifact = {
        "generated_by": "autoreview",
        "task_id": task.get("id"),
        "score": _score(len(blocking), len(non_blocking)),
        "summary": summary,
        "blocking_findings": blocking,
        "non_blocking_findings": non_blocking,
        "recommendation": _recommendation(len(blocking), len(non_blocking)),
        "reviewed_scope": scope,
        "skills_used": skills_used,
    }
    if lens == "quality":
        artifact["contract_verdicts"] = verdicts
    return artifact


def _contract_blocker(contract: dict, verdict: dict) -> dict:
    """The blocking finding a partial or missing contract verdict IS, in the
    same shape as a structured reviewer finding so triage, the fix brief and
    rejection handle it like any other."""
    evidence = " ".join(str(verdict.get("evidence") or "").split())
    at = re.match(r"^(?P<path>[^\s:]+):(?P<line>\d+)\b", evidence)
    path = at.group("path") if at else ""
    cid = str(verdict.get("contract_id"))
    return {
        "category": f"plan-contract-{verdict['verdict']}",
        "area": str(contract.get("source") or _area(path)),
        "summary": f"{cid}: {contract.get('statement', '')} — {verdict['verdict']}: "
                   f"{evidence}",
        "file_path": path,
        "line": int(at.group("line")) if at else None,
        "title": f"VERDICT {cid}: {verdict['verdict']}",
    }


def product_only_tip(worktree: Path, base_sha: str) -> str:
    """Commit a review tip in the detached worktree with every harness
    bookkeeping path (`.factory/`, `plans/`, `docs/decisions/`, the context
    ledger) put back to the task base, and return its sha.

    The scope list already drops those paths, but the autoreview skill builds
    its own bundle from `base..HEAD`, so a story branch carrying hundreds of
    planning artifacts handed the reviewer a >1 MB bundle: chunked into several
    passes, the reviewer never reached the contract VERDICT lines, every
    contract was recorded `partial` (fail-closed -> blocking), and the task-proof
    gate refused a task whose product review was clean (observed 2026-09-04,
    issue #171). With the bookkeeping at the base, the bundle is the product
    delta only. The base is untouched and stays an ancestor of the new tip."""
    prefixes = review_excluded_prefixes(worktree)
    changed = [
        p for p in _require_git(worktree, "listing the review diff", "diff",
                                "--name-only", f"{base_sha}..HEAD").splitlines()
        if p.strip() and p.startswith(prefixes)
    ]
    if not changed:
        return _require_git(worktree, "resolving the review tip", "rev-parse", "HEAD")
    for rel in changed:
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
                 "commit", "-q", "--no-verify", "-m",
                 f"review tip: harness bookkeeping at task base {base_sha[:12]}")
    print(f"review tip excludes {len(changed)} harness bookkeeping path(s); the "
          "bundle is the product delta only")
    return _require_git(worktree, "resolving the review tip", "rev-parse", "HEAD")


def codex_runs_path(root: Path) -> Path:
    """Advisory ledger of Codex releases that are not delegations.

    The delegation ledger is gate authority and has a schema to match; a review
    is neither, so it gets its own append-only file rather than smuggling rows
    into an artifact that `stage done` reads.
    """
    from factory_lib import git_control_dir
    return git_control_dir(root) / "codex_runs.jsonl"


# One file, appended by every lens launch. The launches happen in this
# process, so a lock here is what keeps three concurrent lenses from
# interleaving half-lines into it.
_CODEX_RUN_LOCK = threading.Lock()


def _append_codex_run(root: Path, record: dict) -> None:
    try:
        path = codex_runs_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with _CODEX_RUN_LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except (OSError, SystemExit):
        return  # advisory: never fail a review because bookkeeping failed


def _record_codex_run(root: Path, label: str, argv: list) -> str:
    from factory_lib import now_iso
    run_id = f"review-{uuid.uuid4().hex[:12]}"
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review", "label": label,
        "status": "starting", "at": now_iso(), "argv0": argv[0] if argv else "",
    })
    return run_id


def _stamp_codex_run(root: Path, run_id: str, *, pid: int) -> None:
    from factory_lib import now_iso
    identity = ""
    try:
        from .delegate import _process_start_identity
        identity = str(_process_start_identity(pid) or "")
    except (Exception, SystemExit):
        identity = ""
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review", "status": "running",
        "pid": pid, "pid_started": identity, "at": now_iso(),
    })


def _close_codex_run(root: Path, run_id: str, returncode) -> None:
    from factory_lib import now_iso
    _append_codex_run(root, {
        "run_id": run_id, "kind": "review",
        "status": "finished" if returncode in (0, 1) else "failed",
        "exit_code": returncode, "at": now_iso(),
    })


def _skill_argv(skill: Path, base_sha: str, prompt_rel: str, json_out: Path,
                engine: str, max_priority: str,
                codex_bin: str | None = None) -> list[str]:
    argv = [
        sys.executable, str(skill), "--mode", "branch", "--base", base_sha,
        "--engine", engine, "--max-priority", max_priority,
        "--prompt-file", prompt_rel, "--dataset", REVIEW_DATASET_REL,
        "--json-output", str(json_out),
    ]
    if engine == "codex":
        argv.extend([
            "--model", CODEX_REVIEW_MODEL, "--thinking", CODEX_REVIEW_THINKING,
        ])
        _require_safe_codex_review_helper(argv)
    if codex_bin:
        # The launcher that starts Codex inside the reviewed worktree instead
        # of the skill's empty folder (review_launcher, decision 0076).
        argv += ["--codex-bin", codex_bin]
    return argv


def _run_skill(skill: Path, worktree: Path, base_sha: str, prompt_rel: str,
               json_out: Path, engine: str, max_priority: str,
               ledger_root: Path | None = None, *, return_raw: bool = False,
               codex_bin: str | None = None):
    argv = _skill_argv(skill, base_sha, prompt_rel, json_out, engine, max_priority,
                       codex_bin)
    # The ledger goes to the REPO's control dir: the review worktree is removed
    # when the review ends and its control dir pruned with it, so rows written
    # there never reach `forge codex status`.
    ledger = ledger_root or worktree
    # Inherit stdio: the skill's heartbeat ("review still running ...") and any
    # streamed engine output are how the coordinator WATCHES this Codex release.
    #
    # Ledger the pid before waiting. This command BLOCKS, so a crash of the
    # review itself already surfaces as a non-zero exit -- but if this launcher
    # is killed uncatchably (a job-object teardown, TerminateProcess, SIGKILL)
    # no handler runs, and without a recorded pid nothing afterwards can say a
    # review was ever in flight. A delegation is covered by its own ledger; a
    # review was the blind spot, and it is the release the coordinator is told
    # to watch every time.
    started = _record_codex_run(ledger, prompt_rel, argv)
    process = subprocess.Popen(argv, cwd=worktree,
                               env={**os.environ, "PYTHONUTF8": "1"})
    _stamp_codex_run(ledger, started, pid=process.pid)
    try:
        returncode = process.wait()
    finally:
        _close_codex_run(ledger, started, getattr(process, "returncode", None))
    if returncode not in (0, 1, 2):  # 1: findings; 2: incomplete, judged below
        fail(f"autoreview exited {returncode} for {prompt_rel}; see its output above")
    if not json_out.is_file():
        fail(f"autoreview produced no JSON for {prompt_rel} (the run aborted?)")
    raw = json_out.read_bytes()
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"autoreview produced invalid UTF-8 JSON for {prompt_rel}: {exc}")
    return (parsed, raw) if return_raw else parsed


def reject_finding(base: Path, task_id: str, lens: str, match: str, *,
                   reason: str, cite: str = "", by: str, evidence: str = "") -> dict:
    """Move a recorded blocking finding that contradicts an accepted contract
    out of the blocking list, ledger the contract as a lesson so the next
    round's brief carries it, and stamp the stage if no lens blocks any more.

    Rejection is for contradictions of settled decisions, never for taste:
    `cite` names the decision, plan line or sealed contract. The other ground
    is `evidence`: a file:line in this worktree that shows the finding is
    factually wrong -- the callee the reviewer did not open. On WF-1 T5 eleven
    of the first twenty-five blockers died on such a line (`request()` already
    threw on a non-2xx; the write DTOs accepted no siteId), and with no way to
    record that, each refutation went through the lessons ledger instead
    (decision 0075). It is recorded as the citation `evidence <file:line>`, so
    the generation format is unchanged. The finding stays in the artifact
    under `rejected_findings` with the reason, so the record shows what was
    raised and why it did not block."""
    from factory_lib import (
        effective_review_base, now_iso, product_delta_digest,
        publish_review_generation, read_selected_review_generation,
        review_finding_fingerprint,
    )

    if lens not in LENSES:
        fail(f"--lens must be one of {', '.join(LENSES)}")
    for name, value in (("--reason", reason), ("--by", by)):
        if not (value or "").strip():
            fail(f"{name} must be non-empty: a rejection says why, and who")
    if bool((cite or "").strip()) == bool((evidence or "").strip()):
        fail("--cite or --evidence must be non-empty (one of them): a rejection "
             "names the accepted contract it rests on, or the file:line in this "
             "worktree that shows the finding is wrong")
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        fail("review reject requires an active story")
    proof = (verify_evidence_line(base, evidence, flag="--evidence")
             if (evidence or "").strip() else "")
    if proof:
        cite = f"evidence {proof}"
        resolved, settled_text = cite, ""
    else:
        cite = cite.strip()
        resolved, settled_text = _cite_resolves(base, story, cite, task_id)
    if not resolved:
        fail(f"--cite {cite!r} names nothing settled. A rejection cites a decision "
             "record (its NNNN id under docs/decisions/), a plan contract id of a "
             "task whose stage is DONE (never this task's own or a pending task's), "
             "or a `## ` section of the story plan; a finding no settled text "
             "contradicts is a defect to fix, not to reject.")
    delta_id = product_delta_digest(base, effective_review_base(base, task_id))
    generation, selection, problems = read_selected_review_generation(
        base, story, task_id, expected_delta_id=delta_id,
    )
    if problems or not isinstance(generation, dict) or not isinstance(selection, dict):
        fail("cannot reject from selected proof: " + "; ".join(
            problems or ["no selected complete review generation"]
        ))
    if generation.get("origin") not in {"combined", "rejection"}:
        fail("review rejection requires the selected combined or rejection generation")
    artifact = generation["lenses"][lens]
    needle = match.strip().lower()
    hits = [f for f in artifact.get("blocking_findings") or []
            if needle in json.dumps(f).lower()]
    if not hits:
        fail(f"no blocking {lens} finding matches {match!r}")
    if len(hits) > 1:
        fail(f"{len(hits)} blocking {lens} findings match {match!r}; narrow it")
    finding = hits[0]
    shared = _shared_terms(finding, settled_text) if settled_text else []
    if settled_text and not shared:
        fail(f"--cite {cite!r} resolves to {resolved}, but that text shares no "
             "substantive term with the finding; a citation must be ABOUT the "
             "finding it sets aside. Cite the decision, contract or section that "
             "actually contradicts it, or fix the finding.")
    at = now_iso()
    candidate = copy.deepcopy(generation)
    candidate.pop("generation_id")
    area = str(finding.get("area", "")).strip() if isinstance(finding, dict) else ""
    if not area:
        applies_to = ["**"]
    elif "." in area.rsplit("/", 1)[-1]:
        applies_to = [area]
    else:
        applies_to = [f"{area}/**"]
    summary = (str(finding.get("summary", ""))[:160] if isinstance(finding, dict)
               else str(finding)[:160])
    lesson = {
        "topic": f"rejected-review-finding-{lens}",
        "lesson": f"Not a defect ({cite.strip()}): {reason.strip()} — raised as "
                  f"\"{summary}\"",
        "source": f"review reject {task_id} {lens}",
        "applies_to": applies_to,
        "severity": "medium",
        "generated_by": by.strip(),
    }
    lesson_body = (json.dumps(
        lesson, indent=2, sort_keys=True, ensure_ascii=False,
    ) + "\n").encode("utf-8")
    lesson_sha = hashlib.sha256(lesson_body).hexdigest()
    lesson_rel = f"plans/lessons/review-rejection-{lesson_sha}.json"
    history = copy.deepcopy((generation.get("rejection") or {}).get("history") or [])
    history.append({
        "finding_fingerprint": review_finding_fingerprint(finding),
        "reason": reason.strip(), "citation": cite.strip(), "actor": by.strip(),
        "lesson_path": lesson_rel, "lesson_sha256": lesson_sha,
    })
    candidate.pop("rejection", None)
    candidate.pop("upgrade", None)
    candidate["origin"] = "rejection"
    candidate["recorded_at"] = at
    candidate["rejection"] = {
        "source_generation_id": generation["generation_id"],
        "source_generation_sha256": selection["generation_sha256"],
        "root_generation_id": (generation.get("rejection") or {}).get(
            "root_generation_id", generation["generation_id"]),
        "history": history,
    }
    updated = candidate["lenses"][lens]
    updated["blocking_findings"] = [
        f for f in updated["blocking_findings"] if f != finding]
    updated.setdefault("rejected_findings", []).append({
        "finding": finding, "reason": reason.strip(), "cite": cite.strip(),
        "rejected_at": at, "rejected_by": by.strip(), "task_id": task_id,
    })
    blocking = len(updated["blocking_findings"])
    non_blocking = len(updated.get("non_blocking_findings") or [])
    updated["score"] = _score(blocking, non_blocking)
    updated["recommendation"] = _recommendation(blocking, non_blocking)
    publish_review_generation(
        base, story, task_id, candidate,
        expected_source_id=generation["generation_id"], update_stamp=True,
        lesson_records=[(lesson_rel, lesson_body)],
    )
    ground = (f"proof: {proof}" if proof
              else f"cite: {resolved} (shared terms: {', '.join(shared[:4])})")
    print(f"Rejected {lens} finding: {summary}\n  reason: {reason.strip()}\n  "
          f"{ground}\n  ledgered as a lesson for {', '.join(applies_to)}")
    if blocking:
        print(f"No stamp: {blocking} blocking {lens} finding(s) remain")
    else:
        problem = _review_set_problem(base, story, task_id)
        if problem:
            print(f"No stamp: {problem}")
        else:
            from .stages import load_stages
            stage = next((item for item in load_stages(base).get("stages", [])
                          if item.get("id") == task_id), {})
            print(f"No lens blocks any more; stage {task_id} review stamp recorded. "
                  + ("`./forge stage done` then " if stage.get("status") == "active" else "")
                  + f"`./forge task pr-ready {task_id}`.")
    return updated


def _line_count(path: Path) -> int:
    try:
        with path.open("rb") as handle:
            return sum(1 for _ in handle)
    except OSError:
        return -1


def verify_evidence_line(base: Path, ref: str, *, flag: str) -> str:
    """A `file:line` that exists in this worktree, normalised. A triage rests
    on a line someone opened; a file that is not there, or a line past the
    end, is a claim, not a proof."""
    text = (ref or "").strip().strip("`'\"")
    match = re.fullmatch(r"(.+?):(\d+)", text)
    if not match:
        fail(f"{flag} must be <file>:<line> (a line you opened), got {ref!r}")
    rel = match.group(1).replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    line = int(match.group(2))
    path = base / rel
    if not path.is_file():
        fail(f"{flag} {rel}:{line} names a file that does not exist in this worktree")
    total = _line_count(path)
    if line < 1 or line > total:
        fail(f"{flag} {rel}:{line} is past the end of the file ({total} line(s))")
    return f"{rel}:{line}"


def triage_path(base: Path, story: str, task_id: str, *, for_write: bool = False) -> Path:
    """Beside the task's review generations, never inside them: the
    generations are immutable and validated field by field."""
    from factory_lib import task_evidence_path
    return task_evidence_path(base, story, task_id, "review-triage.json",
                              for_write=for_write)


def triage_records(base: Path, story: str, task_id: str) -> list[dict]:
    data = load_json(triage_path(base, story, task_id), default={})
    records = data.get("findings") if isinstance(data, dict) else None
    return [r for r in records or [] if isinstance(r, dict)]


def _finding_key(finding) -> str:
    return (json.dumps(finding, sort_keys=True) if isinstance(finding, dict)
            else str(finding))


def triage_for(records: list[dict], lens: str, finding, delta_id: str = "") -> dict | None:
    """The triage recorded against THIS finding of THIS review: same lens, same
    finding text, and the same product delta, so a triage of last round's
    finding never dresses this round's. A rejection republishes the same delta
    under a new generation, so the other findings' triage survives it."""
    key = _finding_key(finding)
    for record in records:
        if record.get("lens") != lens or _finding_key(record.get("finding")) != key:
            continue
        if delta_id and record.get("delta_id") not in (None, "", delta_id):
            continue
        return record
    return None


def selected_generation(base: Path, story: str, task_id: str) -> dict | None:
    """The selected complete review generation, or None when there is none
    that reads back whole."""
    from factory_lib import read_selected_review_generation
    generation, _selection, problems = read_selected_review_generation(
        base, story, task_id)
    if problems or not isinstance(generation, dict):
        return None
    return generation


def blocking_with_triage(base: Path, story: str, task_id: str, *,
                         generation: dict | None = None
                         ) -> list[tuple[str, dict, dict | None]]:
    """(lens, finding, triage-or-None) for every blocking finding of the
    selected generation (or the one given)."""
    if generation is None:
        generation = selected_generation(base, story, task_id)
    if not isinstance(generation, dict):
        return []
    records = triage_records(base, story, task_id)
    delta_id = str(generation.get("delta_id") or "")
    out: list[tuple[str, dict, dict | None]] = []
    for lens in LENSES:
        artifact = (generation.get("lenses") or {}).get(lens, {})
        if not isinstance(artifact, dict):
            continue
        for finding in artifact.get("blocking_findings") or []:
            if isinstance(finding, dict):
                out.append((lens, finding, triage_for(records, lens, finding, delta_id)))
    return out


def untriaged_blocking(base: Path, story: str, task_id: str) -> tuple[int, int]:
    """(untriaged, total) blocking findings recorded for the task."""
    rows = blocking_with_triage(base, story, task_id)
    return sum(1 for _, _, triage in rows if triage is None), len(rows)


def triage_finding(base: Path, task_id: str, lens: str, match: str, *, real: bool,
                   evidence: str, instances: list[str], keep: str, reason: str,
                   by: str) -> dict:
    """Record the host's verdict on one recorded blocking finding BEFORE the
    fix round: real, with the line that proves it and every place the same
    contract still fails; or not a defect, with the line that refutes it.

    WF-1 T5 (2026-09-12/13) took six reviews and eight fix rounds. Eleven of
    the first twenty-five blockers were wrong and died only when someone
    opened the callee; the real ones were relayed to the worker one file at a
    time, so the same class of defect came back from the next file in each of
    four consecutive rounds. The coordinator had the whole repo and the time.
    This is that check as a recorded step between review and delegate: the
    fix brief carries the triage beside each finding, and `forge delegate`
    warns on any finding left without one (decision 0075)."""
    from factory_lib import (
        dump_json, effective_review_base, now_iso, product_delta_digest,
        read_selected_review_generation,
    )
    if lens not in LENSES:
        fail(f"--lens must be one of {', '.join(LENSES)}")
    if not (by or "").strip():
        fail("--by must name who triaged it")
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        fail("review triage requires an active story")
    if not real:
        if not (reason or "").strip():
            fail("--not-a-defect needs --reason: what the line at --evidence shows "
                 "that the finding missed")
        return reject_finding(base, task_id, lens, match, reason=reason, cite="",
                              evidence=evidence, by=by)
    delta_id = product_delta_digest(base, effective_review_base(base, task_id))
    generation, _selection, problems = read_selected_review_generation(
        base, story, task_id, expected_delta_id=delta_id,
    )
    if problems or not isinstance(generation, dict):
        fail("cannot triage from selected proof: " + "; ".join(
            problems or ["no selected complete review generation"]
        ) + f"; run `forge review {task_id}` on this tree, then triage what it raises")
    artifact = (generation.get("lenses") or {}).get(lens) or {}
    needle = match.strip().lower()
    hits = [f for f in artifact.get("blocking_findings") or []
            if needle in json.dumps(f).lower()]
    if not hits:
        fail(f"no blocking {lens} finding matches {match!r}")
    if len(hits) > 1:
        fail(f"{len(hits)} blocking {lens} findings match {match!r}; narrow it")
    finding = hits[0]
    proof = verify_evidence_line(base, evidence, flag="--evidence")
    where = [verify_evidence_line(base, item, flag="--instance")
             for item in instances or []]
    if not where:
        fail("--real needs at least one --instance <file:line>: every place the "
             "same contract applies and still fails, so the fix round closes the "
             "class and not the one file the review cited. If the cited line is "
             "the only place, pass it as the instance.")
    at = now_iso()
    record = {
        "lens": lens, "finding": finding, "verdict": "real", "evidence": proof,
        "instances": where, "keep": (keep or "").strip(),
        "reason": (reason or "").strip(), "triaged_by": by.strip(),
        "triaged_at": at, "delta_id": str(generation.get("delta_id") or ""),
        "generation_id": str(generation.get("generation_id") or ""),
        "task_id": task_id,
    }
    data = load_json(triage_path(base, story, task_id), default={})
    if not isinstance(data, dict):
        data = {}
    key = _finding_key(finding)
    kept = [r for r in data.get("findings") or [] if isinstance(r, dict)
            and not (r.get("lens") == lens and _finding_key(r.get("finding")) == key)]
    data["findings"] = kept + [record]
    dump_json(triage_path(base, story, task_id, for_write=True), data)
    summary = (str(finding.get("summary", ""))[:160] if isinstance(finding, dict)
               else str(finding)[:160])
    left, total = untriaged_blocking(base, story, task_id)
    tail = ("`./forge delegate` carries the triage beside each finding" if not left
            else f"{left} still untriaged")
    print(f"Triaged {lens} finding as REAL: {summary}\n  proof: {proof}\n  "
          f"fix at every one of: {', '.join(where)}"
          + (f"\n  keep: {record['keep']}" if record["keep"] else "")
          + f"\n  {total - left} of {total} blocking finding(s) triaged; {tail}")
    return record


def rejected_findings_report(base: Path, story: str, task_id: str) -> str:
    """Markdown for the PR body: every finding the task's review rejected on a
    citation, so the human merging sees what was set aside and why. A
    rejection is the coordinator's call; this is where a person checks it."""
    from factory_lib import read_selected_review_generation
    generation, _selection, problems = read_selected_review_generation(base, story, task_id)
    if problems or not isinstance(generation, dict):
        return ""
    lines: list[str] = []
    for lens in LENSES:
        recorded = generation["lenses"].get(lens, {})
        for entry in recorded.get("rejected_findings") or []:
            if not isinstance(entry, dict):
                continue
            finding = entry.get("finding") or {}
            summary = (str(finding.get("summary", "")) if isinstance(finding, dict)
                       else str(finding)).strip()
            lines.append(f"- **{lens}**: {summary}\n  - rejected because: "
                         f"{str(entry.get('reason', '')).strip()}\n  - cites: "
                         f"{str(entry.get('cite', '')).strip()}")
    if not lines:
        return ""
    return ("## Review findings rejected on a citation\n\n"
            "The reviewer raised these as blocking; the coordinator set them aside "
            "as contradicting settled text, or as wrong on a line the reviewer did "
            "not open (cited as `evidence <file:line>`). Check the citation or the "
            "line before merging.\n\n"
            + "\n".join(lines) + "\n")


def _review_set_problem(base: Path, story: str, task_id: str) -> str:
    """Why the selected generation cannot seal this task; empty when clean."""
    from factory_lib import (
        effective_review_base, product_delta_digest, selected_review_problems,
    )
    problems = selected_review_problems(
        base, story, task_id,
        product_delta_digest(base, effective_review_base(base, task_id)),
    )
    return problems[0] if problems else ""


def _cite_resolves(base: Path, story: str, cite: str, task_id: str = "") -> tuple[str, str]:
    """(label, settled text) a rejection rests on, or ('', '') when nothing matches.

    Accepted forms, any token of `cite` split on `;`, `,` or whitespace:
    a decision id (`0154`, `decision 0154`) with a record under docs/decisions/;
    a plan contract id of a task whose stage is DONE (`T3b-AC3`) — never the
    task under review's own contract nor a pending task's, which are not
    settled; a `## ` section header of the story plan (`S4`, `Decisions`),
    matched as a whole word inside the header."""
    from .stages import load_stages
    tokens = [t.strip("`'\"() ") for t in re.split(r"[;,\s]+", cite or "") if t.strip()]
    decisions = base / "docs" / "decisions"
    decomposition = load_json(protected_decomposition_state_path(base), default={})
    sealed = {s.get("id") for s in load_stages(base).get("stages", [])
              if isinstance(s, dict) and s.get("status") == "done"}
    contract_ids = {
        str(c.get("id")): str(c.get("statement", ""))
        for t in decomposition.get("tasks") or [] if isinstance(t, dict)
        if t.get("id") in sealed and t.get("id") != task_id
        for c in t.get("plan_contracts") or [] if isinstance(c, dict)
    }
    from .review_brief import _plan_section_bodies
    sections: list[tuple[str, str]] = []
    for plan in sorted((base / "plans" / "active").glob(f"{story}-*.md"))[:1]:
        sections = _plan_section_bodies(_read_text(plan), ("",))
    # Scaffolding headers every plan carries name nothing settled; a citation
    # of "Risks" or "Problem" is not a contract.
    generic = {"problem", "context", "scope / non-goals", "scope", "risks",
               "verify plan", "surface impact", "technical approach",
               "task decomposition", "grill provenance", "acceptance criteria",
               "manual verification", "workflow"}
    for token in tokens:
        if re.fullmatch(r"\d{4}", token):
            record = next(iter(sorted(decisions.glob(f"{token}-*.md"))), None)
            if record is not None:
                return f"decision {token}", _read_text(record)
        if token in contract_ids:
            return f"contract {token}", contract_ids[token]
        if len(token) < 2 or (len(token) < 3 and not re.fullmatch(r"[A-Z]\d+", token)):
            continue
        for header, body in sections:
            if header.strip().lower() in generic:
                continue
            if re.search(rf"(?<![\w-]){re.escape(token)}(?![\w-])", header, re.I):
                return f"plan section '{header}'", f"{header}\n{body}"
    return "", ""


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


_STOPWORDS = {"about", "after", "before", "should", "would", "could", "their",
              "there", "these", "those", "which", "while", "where", "being",
              "every", "never", "always", "still", "other", "under", "against",
              "within", "without", "review", "finding", "blocking", "task"}


def _shared_terms(finding: dict | str, source: str) -> list[str]:
    """Substantive words (5+ letters, not stopwords) the finding and the cited
    settled text have in common. A citation that shares none is not about
    this finding, whatever it resolves to."""
    def terms(text: str) -> set[str]:
        return {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z_]{4,}", text)
                if w.lower() not in _STOPWORDS}
    finding_text = json.dumps(finding) if isinstance(finding, dict) else str(finding)
    return sorted(terms(finding_text) & terms(source))


def cmd_review(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if getattr(args, "triage", None):
        real = bool(getattr(args, "real", False))
        wrong = bool(getattr(args, "not_a_defect", False))
        if real == wrong:
            fail("--triage takes exactly one of --real or --not-a-defect")
        triage_finding(base, args.id, getattr(args, "lens", None) or "",
                       args.triage, real=real,
                       evidence=getattr(args, "evidence", "") or "",
                       instances=list(getattr(args, "instance", None) or []),
                       keep=getattr(args, "keep", "") or "",
                       reason=getattr(args, "reason", "") or "",
                       by=getattr(args, "by", "") or "")
        return
    if getattr(args, "reject", None):
        reject_finding(base, args.id, getattr(args, "lens", None) or "",
                       args.reject, reason=getattr(args, "reason", "") or "",
                       cite=getattr(args, "cite", "") or "",
                       evidence=getattr(args, "evidence", "") or "",
                       by=getattr(args, "by", "") or "")
        return
    outcome = review_task(
        base, args.id, lens=getattr(args, "lens", None),
        engine=getattr(args, "engine", "codex"),
        max_priority=getattr(args, "max_priority", "P3"),
        skill=getattr(args, "skill", None),
    )
    print(_next_hint(args.id, outcome["stage_status"], outcome["blocking"],
                     outcome["caveats"]))


def _write_detached(worktree: Path, detached_writes: list[tuple[str, bytes]]) -> None:
    """The dataset and brief go into the detached worktree without following
    anything the checkout may have planted on the way (symlinks, hard links)."""
    for rel, _body in detached_writes:
        target = worktree / rel
        for index, path in enumerate((worktree / Path(*Path(rel).parts[:part]))
                                     for part in range(1, len(Path(rel).parts) + 1)):
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                fail(f"unsafe detached review destination: {target}")
            leaf = index == len(Path(rel).parts) - 1
            if ((leaf and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1))
                    or (not leaf and not stat.S_ISDIR(info.st_mode))):
                fail(f"unsafe detached review destination: {target}")
    for rel, body in detached_writes:
        factory_rel = Path(rel).relative_to(".factory").as_posix()
        if not safe_factory_write_bytes(worktree, factory_rel, body):
            fail(f"unsafe detached review destination: {worktree / rel}")


def _review_in_groups(base: Path, tmp: Path, worktree: Path, base_sha: str,
                      review_tip: str, groups: list[list[str]], sizes: dict[str, int],
                      detached_writes: list[tuple[str, bytes]], readable: bool,
                      launcher_root: Path, skill: Path, engine: str,
                      max_priority: str, prompt_rel: str, estimate: int,
                      split_at: int, would_record) -> tuple[dict, bytes]:
    """One three-lens Codex run per group, all released together; a refused
    group re-runs alone with the cause in its brief; the results merge into
    the tool's own chunk shape (decision 0078, review_groups)."""
    from .review_groups import (
        flatten_passes, group_commits, group_note, merge_group_reports, run_groups,
    )
    from .review_launcher import write_launcher

    every = [path for group in groups for path in group]
    print(f"review split into {len(groups)} groups: the prompt would be about "
          f"{estimate // 1000} KB against the tool's {split_at // 1000} KB limit; "
          "each group is one three-lens Codex run over its files, with the whole "
          "task tree readable, all released together (0078)", flush=True)
    briefs = launcher_root / "groups"
    briefs.mkdir(parents=True, exist_ok=True)
    specs: list[dict] = []
    for index, paths in enumerate(groups, 1):
        label = f"group-{index}"
        group_dir = tmp / label
        group_base, group_tip = group_commits(
            worktree, base_sha, review_tip, paths, tmp / f"{label}.index")
        _require_git(base, f"creating the {label} worktree", "worktree", "add",
                     "--detach", str(group_dir), group_tip)
        _write_detached(group_dir, detached_writes)
        note = group_note(index, len(groups), paths,
                          [path for path in every if path not in paths], readable)
        (briefs / f"{label}.brief.txt").write_text(note, encoding="utf-8")
        specs.append({
            "label": label, "worktree": group_dir, "base": group_base, "paths": paths,
            "codex_bin": str(write_launcher(launcher_root / label, group_dir))
            if readable else None, "note": note,
        })
        print(f"  {label}: {len(paths)} path(s), {sum(sizes[p] for p in paths) // 1000} KB "
              f"of diff ({group_base[:7]}..{group_tip[:7]})", flush=True)

    def argv_for(group: dict, json_out: Path, extra: str | None) -> list[str]:
        argv = _skill_argv(skill, group["base"], prompt_rel, json_out, engine,
                           max_priority,
                           **({"codex_bin": group["codex_bin"]} if group["codex_bin"] else {}))
        argv += ["--prompt", group["note"]]
        if extra:
            argv += ["--prompt", extra]
        return argv

    done = run_groups(groups=specs, prompt_rel=prompt_rel, log_dir=briefs,
                      ledger_root=base, argv_for=argv_for, validate=would_record)
    merged = merge_group_reports(
        [wrapper for group in done for wrapper in flatten_passes(group["report"])])
    return merged, (json.dumps(merged, indent=2) + "\n").encode("utf-8")


def review_task(base: Path, task_id: str, *, lens: str | None = None,
                engine: str = "codex", max_priority: str = "P3",
                skill: str | None = None) -> dict:
    """Release the three-lens review for one task and record its proof.

    Returns {"blocking", "caveats", "stamped", "stage_status"}. `cmd_review`
    prints the next-step hint; `task close` reads the numbers and decides.
    """
    from .stages import load_stages, task_for

    class _Args:  # the body below reads these as it always did
        pass
    args = _Args()
    args.id = task_id
    args.lens = lens
    args.engine = engine
    args.max_priority = max_priority
    args.skill = skill

    task = task_for(base, args.id)
    if not task:
        fail(f"task {args.id} is not in the recorded decomposition")
    stages = load_stages(base).get("stages") or []
    started = {s.get("id"): s.get("status") for s in stages if isinstance(s, dict)}
    stage = next((s for s in stages if s.get("id") == args.id), {})
    if started.get(args.id) not in ("active", "done"):
        fail(f"task {args.id} has not started (stage '{started.get(args.id)}'); "
             "review runs once implementation is complete and verified")
    dirty = _product_dirty(base)
    if dirty:
        fail(f"commit the task's work first — uncommitted product paths: "
             f"{', '.join(dirty[:6])}{' …' if len(dirty) > 6 else ''}")

    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story")
    if not isinstance(story, str) or not story:
        fail("review requires an active story")
    for artifact in ("verify.json", "tests.json"):
        if not proof_path(base, story, artifact, task_id=args.id).is_file():
            fail(f"{artifact} is not recorded for task {args.id}; review runs after "
                 "`python3 factory/scripts/verify.py` and "
                 "`record_test_from_json.py --kind automated`")

    tip_sha = _require_git(base, "resolving HEAD", "rev-parse", "--verify", "HEAD^{commit}")
    base_sha = resolve_review_base(base, stage, state, tip_sha)
    excluded = review_excluded_prefixes(base)
    scope = sorted(
        p for p in _require_git(base, "listing the task diff", "diff",
                                "--name-only", f"{base_sha}...HEAD").splitlines()
        if p.strip() and not p.startswith(excluded)
    )
    if not scope:
        fail(f"no product paths changed between {base_sha[:12]} and HEAD — nothing to review")

    skill = resolve_skill(getattr(args, "skill", None))
    engine = getattr(args, "engine", "codex")
    # The Terra check now inspects the argv each lens is launched with, in
    # _skill_argv, where the fallback is pinned. Checking it here would only
    # re-read the helper's source, which is what blocked every published
    # version of it.
    from .review_launcher import repo_readable, write_launcher
    readable, why_not = repo_readable(engine)
    if not args.lens and args.max_priority != "P3":
        fail("complete three-lens review requires --max-priority P3")

    # Mint the branch review run the recorder binds every artifact to.
    cmd_review_brief(argparse.Namespace(
        id=None, all=True, repo=str(base), review_task=args.id,
    ))
    dataset_body = (base / REVIEW_DATASET_REL).read_bytes()
    token = load_json(base / ".factory" / "stories" / story / "review-run.json", default={})
    if token.get("task_id") != args.id:
        fail("review-run token does not match the reviewed task")

    decomposition = load_json(protected_decomposition_state_path(base), default={})
    all_tasks = [t for t in decomposition.get("tasks") or [] if isinstance(t, dict)]
    skills_used: list[str] = []
    if task.get("user_facing"):
        schema = json.loads(schema_path(base, "review").read_text(encoding="utf-8"))
        skills_used = list((schema.get("required_skills") or {}).get("user_facing", []))

    lenses = [args.lens] if getattr(args, "lens", None) else list(LENSES)
    prompts: dict[str, tuple[str, bytes]] = {}
    prompt_names = lenses if args.lens else ["combined"]
    for name in prompt_names:
        rel = f"review-briefs/{args.id}.{name}.md"
        body = (_lens_prompt(task, name, base, repo_readable=readable) if args.lens
                else _combined_prompt(task, repo_readable=readable))
        if not safe_factory_write_bytes(base, rel, body):
            fail(f"could not write .factory/{rel}")
        prompts[name] = (f".factory/{rel}", body)

    tmp = Path(tempfile.mkdtemp(prefix="forge-review-"))
    worktree = tmp / "wt"
    reviewed: dict = {}
    raw_result = b""
    helper_before: dict[str, str] = {}
    helper_file_before: tuple[int, int] = (0, 0)
    try:
        # A clean detached checkout at the task tip: the skill refuses to finish
        # if the reviewed tree changes mid-run, and the main tree is exactly
        # where the harness keeps writing. Reviewing here also keeps the run
        # scoped to the committed task diff.
        _require_git(base, "creating the review worktree", "worktree", "add",
                     "--detach", str(worktree), tip_sha)
        review_tip = product_only_tip(worktree, base_sha)
        from .review_groups import (
            PROMPT_SLACK, diff_bytes_by_path, is_review_noise, plan_groups,
            restore_paths_to_base, review_split_bytes,
        )
        noise = [path for path in scope if is_review_noise(path)]
        if noise:
            # Lockfiles and generated files add bytes and nothing to judge; on
            # WF-1A T1 the lockfile alone was a chunk's worth. They ship, and
            # they stay in scope and in the stamp; their bytes are not sent.
            review_tip = restore_paths_to_base(
                worktree, base_sha, noise,
                f"review tip: {len(noise)} lock/generated path(s) at task base "
                f"{base_sha[:12]}")
            print(f"review tip excludes {len(noise)} lock/generated path(s); they "
                  "ship and stay in scope, their bytes are not reviewed: "
                  f"{', '.join(noise[:4])}{' ...' if len(noise) > 4 else ''}",
                  flush=True)
        detached_writes = [(REVIEW_DATASET_REL, dataset_body), *prompts.values()]
        _write_detached(worktree, detached_writes)
        name = prompt_names[0]
        codex_bin = None
        from factory_lib import git_control_dir
        launcher_root = git_control_dir(base) / "review-launcher" / args.id
        if readable:
            # The launcher lives in the control dir, never in the reviewed tree
            # (the skill refuses an in-repo binary), and its launch.log stays
            # after the review folder is removed.
            codex_bin = str(write_launcher(launcher_root, worktree))
            print("review runs inside the reviewed worktree, read-only: a verdict "
                  "on unchanged code is read, not guessed (0076)", flush=True)
        else:
            print(f"review sees only the diff bundle ({why_not}); the brief tells "
                  "it not to mark unseen code partial", flush=True)
        # Split only a diff the tool would chunk anyway (decision 0078): the
        # tool's limit is on the whole prompt, brief and dataset included.
        sizes = diff_bytes_by_path(worktree, base_sha)
        split_at = review_split_bytes()
        fixed = len(dataset_body) + len(prompts[name][1]) + PROMPT_SLACK
        estimate = fixed + sum(sizes.values())
        groups = ([list(sizes)] if args.lens or estimate <= split_at
                  else plan_groups(sizes, split_at - fixed))
        print(f"== {name} review: releasing Codex over {len(scope)} path(s) "
              f"({base_sha[:7]}..{review_tip[:7]}, task tip {tip_sha[:7]}) ==",
              flush=True)
        if not args.lens:
            _require_current_review_helper(skill)
        helper_before, helper_file_before = _helper_identity(skill)
        if len(groups) > 1:
            def _would_record(parsed: dict) -> None:
                _project_combined_report(task, parsed, scope, base_sha, tip_sha,
                                         skills_used, all_tasks, started, excluded)
            reviewed, raw_result = _review_in_groups(
                base, tmp, worktree, base_sha, review_tip, groups, sizes,
                detached_writes, readable, launcher_root, skill, engine,
                args.max_priority, prompts[name][0], estimate, split_at,
                _would_record)
        else:
            # The launcher travels only when there is one, so a runner that
            # knows nothing of it (a test double, an older override) keeps
            # working.
            result = _run_skill(
                skill, worktree, base_sha, prompts[name][0], tmp / f"{name}.json",
                engine, args.max_priority, ledger_root=base, return_raw=not args.lens,
                **({"codex_bin": codex_bin} if codex_bin else {}),
            )
            if args.lens:
                reviewed = result
            else:
                reviewed, raw_result = result
        helper_after, helper_file_after = _helper_identity(skill)
        if helper_after != helper_before or helper_file_after != helper_file_before:
            fail("autoreview helper identity changed during the review; nothing published")
        if head_sha(base) != tip_sha or _product_dirty(base) \
                or product_delta_digest(base, base_sha) \
                != token.get("branch_diff_digest"):
            fail("task product changed during the review; nothing published")
    finally:
        _git(base, "worktree", "remove", "--force", str(worktree))
        for group_dir in sorted(tmp.glob("group-*")):
            if group_dir.is_dir():
                _git(base, "worktree", "remove", "--force", str(group_dir))
        _git(base, "worktree", "prune")

    recorder = base / "factory" / "scripts" / "record_review_from_json.py"
    if args.lens:
        artifact = _artifact(
            args.lens, task, reviewed, scope, base_sha, tip_sha, skills_used,
            all_tasks, started, excluded,
        )
        payload = tmp / f"{args.lens}.artifact.json"
        payload.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(recorder), "--aspect", args.lens, "--task", args.id,
             "--input", str(payload)], cwd=base, capture_output=True, text=True,
            encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"},
        )
        if proc.returncode != 0:
            fail(f"recording the diagnostic {args.lens} artifact failed:\n"
                 f"{proc.stdout.strip()}\n{proc.stderr.strip()}")
        recorded = {args.lens: artifact}
    else:
        from factory_lib import now_iso
        from .stages import stage_baseline
        artifacts = _project_combined_report(
            task, reviewed, scope, base_sha, tip_sha, skills_used, all_tasks,
            started, excluded,
        )
        for artifact in artifacts.values():
            artifact.update({
                "review_run_id": token.get("review_run_id"),
                "brief_sha256": token.get("brief_sha256"),
                "branch_diff_digest": token.get("branch_diff_digest"),
                "commit": tip_sha,
            })
        prompt_body = prompts["combined"][1]
        candidate = {
            "format": "forge-review-generation/v1", "origin": "combined",
            "generated_by": "autoreview", "story": story, "task_id": args.id,
            "review_run_id": token.get("review_run_id"),
            "brief_sha256": token.get("brief_sha256"),
            "inspected_commit": tip_sha,
            "delta_id": token.get("branch_diff_digest"),
            "helper": helper_before,
            "input": {"sha256": hashlib.sha256(prompt_body).hexdigest(),
                      "bytes": len(prompt_body)},
            "raw_result": {"encoding": "base64",
                           "sha256": hashlib.sha256(raw_result).hexdigest(),
                           "bytes": len(raw_result),
                           "data": base64.b64encode(raw_result).decode("ascii")},
            "lenses": artifacts, "recorded_at": now_iso(),
        }
        payload = tmp / "combined.generation.json"
        payload.write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(recorder), "--set", "--task", args.id,
             "--input", str(payload)], cwd=base, capture_output=True, text=True,
            encoding="utf-8", env={
                **os.environ, "PYTHONUTF8": "1", "AUTOREVIEW": str(skill.resolve()),
            },
        )
        if proc.returncode != 0:
            fail(f"recording the combined review generation failed:\n"
                 f"{proc.stdout.strip()}\n{proc.stderr.strip()}")
        # Count what was RECORDED and selected, the same generation close
        # and the board read, so the outcome printed here is the one the
        # next step acts on.
        _blocking, _caveats, recorded = recorded_review_totals(base, story, args.id, LENSES)
    shutil.rmtree(tmp, ignore_errors=True)

    blocking_total = sum(len(a.get("blocking_findings") or []) for a in recorded.values())
    caveats_total = sum(len(a.get("non_blocking_findings") or []) for a in recorded.values())
    for lens, artifact in recorded.items():
        print(f"{lens:<12} score {str(artifact.get('score', '?')):>2}  "
              f"{str(artifact.get('recommendation', '')):<21}"
              f" blocking={len(artifact.get('blocking_findings') or [])} "
              f"non-blocking={len(artifact.get('non_blocking_findings') or [])}")
    if args.lens:
        print(f"Recorded one diagnostic {args.lens} artifact for {args.id}; selected "
              "proof and its stamp are unchanged.")
    else:
        print(f"Published one complete review generation for {args.id}; selected.json "
              "was replaced after generation readback.")
    return {
        "blocking": blocking_total,
        "caveats": caveats_total,
        "stamped": bool(not args.lens and not blocking_total),
        "stage_status": str(started.get(args.id)),
    }
