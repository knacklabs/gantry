#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
        env=clean_git_env(),
    )
    return Path(out.stdout.strip())


def factory_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / ".factory"


def run_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "run.json"


def decomposition_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "decomposition.json"


def clean_git_env() -> dict[str, str]:
    return {
        key: value for key, value in os.environ.items()
        if not key.startswith("GIT_")
    }


def verify_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "verify.json"


def tests_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "tests.json"


def review_dir(root: Path | None = None) -> Path:
    return factory_dir(root) / "reviews"


FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)
# Substring match, not a YAML parse: these scripts are stdlib-only by design
# (see check_dual_runtime.py's harness.yaml allowlist reader).
# [ \t]* deliberately, NOT \s*: \s crosses newlines, so an empty
# `signoff_record:` would capture the NEXT top-level key as the pin.
SIGNOFF_PIN = re.compile(r"^signoff_record:[ \t]*[\"']?([^\"'\s#]+)", re.MULTILINE)
# "is the key present at top level", as distinct from "does it have a value" —
# a substring test would also match the key inside a comment or an indented
# mapping, which a project-owned harness.yaml may legitimately contain.
SIGNOFF_KEY = re.compile(r"^signoff_record:", re.MULTILINE)
DOC_START = re.compile(r"---(?:[\s#]|\Z)")


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


# A safe slug, deliberately: the pin is read back by the stdlib regex above,
# which stops at whitespace, quotes and `#`, so any other name would read back
# TRUNCATED. `forge decision new <slug>` already slugifies.
CLIENT_SIGNOFF_NAME = re.compile(r"[0-9]{4}-[a-z0-9-]*client-signoff\.md")


def insert_signoff_pin(text: str, relative: str) -> str:
    """Set the top-level signoff_record key, preserving any YAML prologue.

    ponytail: a targeted line edit, not a YAML rewrite — these scripts are
    stdlib-only, so there is no parser to round-trip through. Replacing an
    existing key is a line substitution; ADDING one must land after any
    directives and document marker, since prepending before `---` would turn a
    single mapping into a two-document stream that consumers cannot read.
    """
    updated, count = re.subn(
        r"^signoff_record:.*$", f'signoff_record: "{relative}"', text,
        count=1, flags=re.MULTILINE,
    )
    if count:
        return updated
    lines = text.splitlines(keepends=True)
    cut = 0
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("%") or not stripped or stripped.startswith("#"):
            continue
        # A document-start marker may carry an inline comment after ANY YAML
        # whitespace (`--- # doc`, `---\t# doc`) or none at all. Missing a form
        # inserts the key BEFORE the marker, making a second document.
        if DOC_START.match(stripped):
            cut = index + 1
        break
    return "".join(lines[:cut]) + f'signoff_record: "{relative}"\n' + "".join(lines[cut:])


def canonical_signoff_path(root: Path, relative: str) -> str:
    """The canonical repo-relative path of a valid sign-off record, or ''.

    Returns the CANONICAL form, never the caller's spelling: a value that
    resolves to a valid record can still be absolute (machine-specific, broken
    in every other clone) or carry quotes and newlines that inject YAML when
    written into harness.yaml. Callers must persist what this returns.

    Enforced at the READER, which is authoritative, not only where a path is
    written: auto-discovery can glob a symlink whose target lies outside, and
    the upgrade migration carries a path out of gitignored run.json. Without
    this, any file with `status: accepted` and a `confirmed_by` satisfies every
    sign-off gate. resolve() collapses symlinks and `..` before the check.
    """
    if not relative:
        return ""
    try:
        decisions = (root / "docs" / "decisions").resolve()
        target = (root / relative).resolve()
        if not target.is_file():
            return ""
    except (OSError, RuntimeError):
        # A malformed symlink chain must read as "invalid pin" with the normal
        # actionable message, never a traceback out of a hook or pr_ready.
        # RuntimeError too: non-strict resolve() raises it for a symlink LOOP on
        # Python 3.10-3.12, which is what CI runs.
        return ""
    if target.parent != decisions:
        return ""
    # fullmatch, not match: `$` also matches before a trailing newline, so a
    # file named "0001-client-signoff.md\n" would validate and then write a
    # multi-line pin that the reader truncates.
    if not CLIENT_SIGNOFF_NAME.fullmatch(target.name):
        return ""
    try:
        return target.relative_to(root.resolve()).as_posix()
    except ValueError:
        return ""


def valid_signoff_path(root: Path, relative: str) -> bool:
    """Is `relative` a client-signoff record DIRECTLY under docs/decisions?

    Enforced at the READER, which is authoritative, not only where a path is
    written: auto-discovery can glob a symlink whose target lies outside, and
    the upgrade migration carries a path out of gitignored run.json.
    """
    return bool(canonical_signoff_path(root, relative))


def signoff_pin(root: Path) -> str:
    """The decision record harness.yaml pins as THE project sign-off, or ''."""
    manifest = root / "harness.yaml"
    # A symlinked manifest would let reads (and record_signoff's write) escape
    # the repo, so the committed, clone-stable answer would not be committed at
    # all. is_file() follows links; is_symlink() is the check that matters.
    if manifest.is_symlink() or not manifest.is_file():
        return ""
    match = SIGNOFF_PIN.search(manifest.read_text())
    return match.group(1) if match else ""


def client_signoff(root: Path) -> tuple[bool, str]:
    """Is the project signed off, and if not, why not?

    DERIVED, never recorded. The pin lives in committed harness.yaml and the
    proof lives in the committed decision record, so a fresh worktree reads the
    same answer as every other: there is no per-worktree state to re-establish,
    and no later record can displace the pinned one. Sign-off is ONE gate for
    the project (WORKFLOW.md), not one per task — the per-task human gate is
    plan approval, which is grilled and enforced against the same issue.
    """
    pinned = signoff_pin(root)
    if not pinned:
        return False, (
            "Client sign-off required first. Get docs/decisions/NNNN-client-signoff.md "
            "accepted (non-empty confirmed_by), then run "
            "`python3 factory/scripts/record_signoff.py` to pin it in harness.yaml."
        )
    # Require the pin to BE canonical, not merely to resolve: the recovery path
    # is a hand edit to harness.yaml, and an absolute path would resolve here
    # while failing in every differently-located clone — exactly the
    # same-answer-everywhere guarantee this pin exists to provide.
    if canonical_signoff_path(root, pinned) != pinned:
        return False, (
            f"harness.yaml pins signoff_record: {pinned}, which is not a readable "
            "client sign-off record directly under docs/decisions/ "
            "(NNNN-<slug>client-signoff.md, no symlink out of the directory). "
            "Re-pin harness.yaml to the accepted record."
        )
    record = root / pinned
    fields = parse_frontmatter(record.read_text())
    if fields.get("status") != "accepted" or not fields.get("confirmed_by"):
        return False, (
            f"{pinned} is pinned as the project sign-off but is not an accepted, "
            "human-confirmed record (needs status: accepted and a non-empty confirmed_by)."
        )
    return True, ""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def git_control_dir(root: Path) -> Path:
    proc = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(),
    )
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(),
    )
    if (
        proc.returncode != 0
        or top.returncode != 0
        or not proc.stdout.strip()
        or Path(top.stdout.strip()).resolve() != root.resolve()
    ):
        raise SystemExit(
            "Cannot resolve Git's protected control directory for factory state."
        )
    return Path(proc.stdout.strip()) / "forge"


def protected_decomposition_state_path(root: Path) -> Path:
    return git_control_dir(root) / "decomposition.json"


def _safe_factory_fd(root: Path, name: str, flags: int) -> int | None:
    """Open one direct .factory diagnostic file without following links.

    Workers own the workspace, so these mirrors are never authoritative. The
    orchestrator still must not follow a swapped file or parent directory when
    publishing a diagnostic copy.
    """
    if Path(name).name != name:
        raise ValueError("factory diagnostic name must be one path component")
    directory = factory_dir(root)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        directory_fd = os.open(
            directory,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError:
        return None
    try:
        descriptor = os.open(
            name,
            flags | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_fd,
        )
    except OSError:
        os.close(directory_fd)
        return None
    os.close(directory_fd)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(descriptor)
        return None
    return descriptor


def safe_factory_append(root: Path, name: str, line: bytes) -> bool:
    descriptor = _safe_factory_fd(
        root, name, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    if descriptor is None:
        return False
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)
    return True


def safe_factory_write_json(root: Path, name: str, data: Any) -> bool:
    descriptor = _safe_factory_fd(root, name, os.O_WRONLY | os.O_CREAT)
    if descriptor is None:
        return False
    body = (json.dumps(data, indent=2) + "\n").encode()
    try:
        os.ftruncate(descriptor, 0)
        os.write(descriptor, body)
    finally:
        os.close(descriptor)
    return True


def safe_factory_write_bytes(root: Path, relative: str, body: bytes) -> bool:
    """Write a nested diagnostic file without following workspace symlinks."""
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or any(
            part in {"", ".", ".."} for part in rel.parts):
        return False
    directory = factory_dir(root)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        parent_fd = os.open(
            directory,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError:
        return False
    try:
        for part in rel.parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
            child_fd = os.open(
                part,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent_fd,
            )
            os.close(parent_fd)
            parent_fd = child_fd
        descriptor = os.open(
            rel.parts[-1],
            os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_fd,
        )
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(descriptor)
            return False
        try:
            os.ftruncate(descriptor, 0)
            os.write(descriptor, body)
        finally:
            os.close(descriptor)
        return True
    except OSError:
        return False
    finally:
        os.close(parent_fd)


def gate(
    root: Path,
    *,
    signoff: bool = False,
    approved_plan: bool = False,
    decomposition: bool = False,
) -> dict[str, Any]:
    """The factory precondition matrix, in one place.

    Every artifact-writing script calls this with the preconditions its phase
    requires. Missing run state always fails — no gate is skippable by
    deleting .factory/run.json.
    """
    state = load_json(run_state_path(root), default={})
    if not state:
        raise SystemExit("Missing .factory/run.json. Run intake first.")
    if signoff:
        ok, why = client_signoff(root)
        if not ok:
            raise SystemExit(why)
    issue = state.get("issue_key", "")
    if approved_plan:
        plan_files = list((root / "plans" / "active").glob(f"{issue}-*.md")) if issue else []
        if state.get("plan_status") != "approved" or not plan_files:
            raise SystemExit(
                "An approved, saved plan is required first "
                f"(plans/active/{issue or '<issue>'}-*.md via `forge.py plan save`)."
            )
    if decomposition:
        if (
            state.get("decomposition_status") != "recorded"
            or not protected_decomposition_state_path(root).exists()
        ):
            raise SystemExit(
                "Recorded decomposition is required first "
                "(record_decomposition_from_json.py after plan approval)."
            )
    return state


SCHEMA_TYPES = {"str": str, "int": int, "bool": bool, "list": list, "dict": dict}


def schema_path(root: Path, name: str) -> Path:
    return root / "factory" / "schemas" / f"{name}.json"


def validate_payload(root: Path, name: str, payload: dict) -> None:
    """The determinism contract's front door: refuse any externally-authored
    artifact that does not match its factory/schemas/ spec, including a
    generated_by value outside the pinned allowlist. Extra keys are allowed."""
    path = schema_path(root, name)
    schema = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise SystemExit(
            f"REFUSED by factory/schemas/{path.name}:\n- payload must be a JSON object, "
            f"got {type(payload).__name__}"
        )
    problems: list[str] = []

    def check(field: str, kind: str, value: Any) -> None:
        ok = isinstance(value, SCHEMA_TYPES[kind])
        if kind != "bool" and isinstance(value, bool):
            ok = False
        if not ok:
            problems.append(f"'{field}' must be {kind}")

    for field, kind in schema.get("required", {}).items():
        if field not in payload:
            problems.append(f"missing required '{field}' ({kind})")
        else:
            check(field, kind, payload[field])
    for field, kind in schema.get("optional", {}).items():
        if field in payload:
            check(field, kind, payload[field])
    for field, bounds in (schema.get("ranges") or {}).items():
        value = payload.get(field)
        if isinstance(value, int) and not isinstance(value, bool):
            low, high = bounds
            if not (low <= value <= high):
                problems.append(f"'{field}' must be within {low}..{high} (got {value})")
    allowed = schema.get("generated_by", [])
    generator = payload.get("generated_by")
    if allowed and generator is not None and generator not in allowed:
        problems.append(
            f"generated_by {generator!r} is not pinned for this artifact — allowed: "
            f"{', '.join(allowed)}. Adopting a new tool is a harness PR "
            f"(harness.yaml + the schema file), never a local choice."
        )
    if problems:
        raise SystemExit(
            f"REFUSED by factory/schemas/{path.name}:\n- " + "\n- ".join(problems)
        )


def head_sha(root: Path | None = None) -> str | None:
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root or repo_root(),
        capture_output=True, text=True, env=clean_git_env(),
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def require_skills(root: Path, name: str, payload: dict) -> None:
    """Feature-type skill enforcement (same trust model as generated_by):
    when the recorded decomposition says user_facing, the artifact must
    ATTEST the phase's mandatory skills in skills_used. Advisory skills are
    listed too when used, but only the required set gates."""
    schema = json.loads(schema_path(root, name).read_text())
    required = schema.get("required_skills", {})
    if not required:
        return
    decomposition = load_json(decomposition_state_path(root), default={})
    if not decomposition.get("user_facing"):
        return
    used = payload.get("skills_used") or []
    missing = [s for s in required.get("user_facing", []) if s not in used]
    if missing:
        raise SystemExit(
            f"user-facing task: this artifact must attest the mandatory design skills "
            f"in skills_used — missing: {', '.join(missing)}. Load them, do the work "
            "with them, and list them (pinned in harness.yaml; installed by doctor)."
        )


def sha256_of(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _grill_exempt(rel: str, ignore_names: tuple[str, ...]) -> bool:
    # Expected exhaust is DECISION RECORDS only — a product doc whose name
    # merely contains an ignore token must still stale the grill.
    return rel.startswith("docs/decisions/") and any(
        token in Path(rel).name for token in ignore_names
    )


def require_grill(
    root: Path,
    gate: str,
    prefixes: tuple[str, ...],
    ignore_names: tuple[str, ...] = (),
    expect_digest_of: Path | None = None,
) -> None:
    """Handover gates call this: a fresh, passing grill or no passage.

    `ignore_names` filters expected exhaust (decision records created AFTER
    the grill) from staleness. `expect_digest_of` binds the grill to the
    exact artifact being gated: the recorded input_sha256 must match that
    file, so grilling proposal A never approves proposal B."""
    path = factory_dir(root) / "grills" / f"{gate}.json"
    data = load_json(path, default={})
    if not data:
        raise SystemExit(
            f"Handover grill required first: interrogate the handover for gaps and "
            f"contradictions per factory/prompts/griller.md, resolve findings, then record "
            f"`python3 factory/scripts/record_grill_from_json.py --gate {gate}`."
        )
    if data.get("verdict") != "pass":
        raise SystemExit(
            f".factory/grills/{gate}.json verdict is {data.get('verdict')!r} — resolve the "
            "recorded findings and re-grill; this gate needs a pass."
        )
    if not data.get("commit") and head_sha(root):
        raise SystemExit(
            f".factory/grills/{gate}.json has no commit stamp — re-record with current tooling."
        )
    if expect_digest_of is not None:
        actual = sha256_of(expect_digest_of)
        if data.get("input_sha256") != actual:
            raise SystemExit(
                f"the {gate} grill was not recorded against THIS input "
                f"({expect_digest_of.name}) — re-grill the current version and record with "
                f"`record_grill_from_json.py --gate {gate} --input-digest {expect_digest_of}`."
            )
    stale = [
        f for f in changed_since(root, data.get("commit") or "", prefixes)
        if not _grill_exempt(f, ignore_names)
    ]
    # Freshness includes the WORKING TREE: uncommitted edits to guarded docs
    # must stale the grill just like committed ones.
    proc = subprocess.run(["git", "status", "--porcelain"], cwd=root,
                          capture_output=True, text=True)
    if proc.returncode == 0:
        for line in proc.stdout.splitlines():
            rel = line[3:].split(" -> ")[-1].strip().strip('"')
            if rel.startswith(prefixes) and not _grill_exempt(rel, ignore_names):
                stale.append(f"{rel} (uncommitted)")
    if stale:
        raise SystemExit(
            f"the {gate} grill is STALE — handover docs changed since it ran: "
            f"{', '.join(stale[:5])}. Re-run the grill against the current docs."
        )


def changed_since(root: Path, stamp: str, prefixes: tuple[str, ...]) -> list[str]:
    """Committed files under `prefixes` changed between `stamp` and HEAD.

    Returns ["<unknown commit>"] when the stamp is not in this repo's history,
    so callers treat an unverifiable stamp as stale rather than fresh."""
    head = head_sha(root)
    if not head or not stamp or stamp == head:
        return []
    proc = subprocess.run(
        ["git", "diff", "--name-only", f"{stamp}..{head}"],
        cwd=root, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return [f"<commit {stamp[:8]} unknown to this repo>"]
    return [f for f in proc.stdout.splitlines() if f.startswith(prefixes)]


def read_hook_input() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def branch_name(root: Path | None = None) -> str:
    out = subprocess.run(["git", "branch", "--show-current"], cwd=root or repo_root(), check=True, capture_output=True, text=True)
    return out.stdout.strip()


def infer_issue_key(value: str) -> str | None:
    match = re.search(r"([A-Z][A-Z0-9]+-\d+)", value)
    return match.group(1) if match else None


def ensure_issue_key(explicit: str | None = None, root: Path | None = None) -> str:
    # An explicitly passed key is accepted as-is (GitHub issue numbers, Jira,
    # plain slugs) as long as it is filesystem/branch-safe.
    if explicit and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", explicit.strip()):
        return explicit.strip()
    candidates = [explicit or "", os.environ.get("LINEAR_ISSUE_KEY", ""), branch_name(root)]
    for candidate in candidates:
        key = infer_issue_key(candidate)
        if key:
            return key
    raise SystemExit(
        "Unable to determine an issue key. Pass --issue <key> (e.g. ENG-123, GH-42, 42), "
        "set LINEAR_ISSUE_KEY, or use a branch like feat/ENG-123-slug."
    )


def slugify(text: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip()).strip("-").lower()
    return value or "task"


def run_cmd(command: str, cwd: Path | None = None) -> dict[str, Any]:
    proc = subprocess.run(command, cwd=cwd or repo_root(), shell=True, capture_output=True, text=True)
    return {
        "command": command,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
