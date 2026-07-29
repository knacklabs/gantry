#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True)
    return Path(out.stdout.strip())


def factory_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / ".factory"


def run_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "run.json"


def decomposition_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "decomposition.json"


def verify_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "verify.json"


def tests_state_path(root: Path | None = None) -> Path:
    return factory_dir(root) / "tests.json"


def review_dir(root: Path | None = None) -> Path:
    return factory_dir(root) / "reviews"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


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
    if signoff and not state.get("client_signoff"):
        raise SystemExit(
            "Client sign-off required first. Get docs/decisions/NNNN-client-signoff.md "
            "accepted (non-empty confirmed_by), then run "
            "`python3 .agents/scripts/record_signoff.py`."
        )
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
            or not decomposition_state_path(root).exists()
        ):
            raise SystemExit(
                "Recorded decomposition is required first "
                "(record_decomposition_from_json.py after plan approval)."
            )
    return state


SCHEMA_TYPES = {"str": str, "int": int, "bool": bool, "list": list, "dict": dict}


def schema_path(root: Path, name: str) -> Path:
    return root / ".agents" / "schemas" / f"{name}.json"


def validate_payload(root: Path, name: str, payload: dict) -> None:
    """The determinism contract's front door: refuse any externally-authored
    artifact that does not match its .agents/schemas/ spec, including a
    generated_by value outside the pinned allowlist. Extra keys are allowed."""
    path = schema_path(root, name)
    schema = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise SystemExit(
            f"REFUSED by .agents/schemas/{path.name}:\n- payload must be a JSON object, "
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
            f"REFUSED by .agents/schemas/{path.name}:\n- " + "\n- ".join(problems)
        )


def head_sha(root: Path | None = None) -> str | None:
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root or repo_root(),
        capture_output=True, text=True,
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
            f"contradictions per .agents/prompts/griller.md, resolve findings, then record "
            f"`python3 .agents/scripts/record_grill_from_json.py --gate {gate}`."
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
