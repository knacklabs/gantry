#!/usr/bin/env python3
"""Dual-runtime linter: enforces the reference-not-duplicate contract between
the shared canon (AGENTS.md, docs/, constitution/, harness/, .agents/) and the
thin runtime adapters (.claude/, .codex/).

All checks are structural — no semantic judgment. Violation messages follow
docs/harness-philosophy.md: file, rule, what to do instead.

Usage: python3 .agents/scripts/check_dual_runtime.py [target-dir]
Exit codes: 0 clean, 1 violations.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

DUP_WINDOW = 10  # consecutive identical non-blank lines that count as duplication
CLAUDE_MD_MAX_LINES = 40

violations: list[str] = []
warnings: list[str] = []


def violation(msg: str) -> None:
    violations.append(f"VIOLATION: {msg}")


def canon_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for pattern in ("constitution/*.md", "docs/**/*.md", "harness/*/conventions/*.md"):
        files.extend(root.glob(pattern))
    return [f for f in files if f.is_file()]


def nonblank_lines(path: Path) -> list[str]:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return []
    return [line for line in text.splitlines() if line.strip()]


def check_canon_exists(root: Path) -> None:
    required = ["AGENTS.md", "docs", ".agents/prompts", ".agents/scripts", "harness.yaml"]
    for rel in required:
        if not (root / rel).exists():
            violation(
                f"{rel} is missing. It is part of the shared canon both runtimes read. "
                "See docs/FACTORY.md."
            )
    constitution = root / "constitution"
    if not constitution.is_dir() or not any(constitution.glob("*.md")):
        violation(
            "constitution/ is missing or empty. Standards must live in-repo; "
            "vendor them from the harness (constitution/README.md explains)."
        )


def runtime_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for runtime in (".claude", ".codex"):
        base = root / runtime
        if base.is_dir():
            files.extend(p for p in base.rglob("*") if p.is_file())
    return files


def check_forbidden_basenames(root: Path) -> None:
    canon_names = {f.name for f in root.glob("constitution/*.md")}
    canon_names |= {f.name for f in root.glob("harness/*/conventions/*.md")}
    for f in runtime_files(root):
        if f.name in canon_names:
            violation(
                f"{f.relative_to(root)} shares a basename with a canonical standards file. "
                "Runtime dirs must reference canon, never mirror it. Delete this file and "
                "use a `<!-- canon: <path> -->` reference instead."
            )


def check_duplication(root: Path) -> None:
    canon_lines = {c: nonblank_lines(c) for c in canon_files(root)}
    canon_bytes = {}
    for c in canon_lines:
        try:
            canon_bytes[c] = c.read_bytes()
        except OSError:
            pass
    for f in runtime_files(root):
        try:
            data = f.read_bytes()
        except OSError:
            continue
        for c, cbytes in canon_bytes.items():
            if data and data == cbytes:
                violation(
                    f"{f.relative_to(root)} is a byte-copy of {c.relative_to(root)}. "
                    "Reference the canonical file instead of copying it."
                )
        flines = nonblank_lines(f)
        if len(flines) < DUP_WINDOW:
            continue
        windows = {
            tuple(flines[i : i + DUP_WINDOW]) for i in range(len(flines) - DUP_WINDOW + 1)
        }
        for c, clines in canon_lines.items():
            if len(clines) < DUP_WINDOW:
                continue
            for i in range(len(clines) - DUP_WINDOW + 1):
                if tuple(clines[i : i + DUP_WINDOW]) in windows:
                    violation(
                        f"{f.relative_to(root)} duplicates >={DUP_WINDOW} consecutive lines "
                        f"from {c.relative_to(root)}. Replace the copied block with "
                        f"`<!-- canon: {c.relative_to(root)} -->`."
                    )
                    break


CANON_MARKER = re.compile(r"<!--\s*canon:\s*([^\s]+)\s*-->")


def check_canon_markers(root: Path) -> None:
    for f in runtime_files(root):
        if f.suffix not in {".md", ".json", ".toml"}:
            continue
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        for match in CANON_MARKER.finditer(text):
            ref = match.group(1)
            if not (root / ref).exists():
                violation(
                    f"{f.relative_to(root)} references canon path '{ref}' which does not exist. "
                    "Fix the path or remove the marker."
                )


FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


DECISION_STATUSES = {"proposed", "accepted", "superseded"}


def _section_has_substance(text: str, heading: str) -> bool:
    match = re.search(rf"^## {heading}\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    if not match:
        return False
    body = re.sub(r"<!--.*?-->", "", match.group(1), flags=re.DOTALL).strip()
    return len(body) >= 20


def check_decision_records(root: Path) -> None:
    decisions = sorted((root / "docs" / "decisions").glob("[0-9][0-9][0-9][0-9]-*.md"))
    stems = {record.stem for record in decisions}
    seen: dict[int, Path] = {}
    for record in decisions:
        number = int(record.name[:4])
        if number in seen:
            violation(
                f"{record.relative_to(root)} reuses decision number {number:04d} "
                f"(already used by {seen[number].relative_to(root)}). Renumber with the "
                "next free integer (forge.py decision new allocates safely)."
            )
        seen[number] = record
        match = FRONTMATTER.match(record.read_text(errors="replace"))
        if not match:
            violation(
                f"{record.relative_to(root)} has no YAML frontmatter. Decision records need "
                "status/confirmed_by/date — recreate via forge.py decision new."
            )
            continue
        fields = dict(
            (k.strip(), v.strip().strip('"').strip("'"))
            for k, _, v in (line.partition(":") for line in match.group(1).splitlines())
            if k.strip()
        )
        status = fields.get("status", "")
        if status not in DECISION_STATUSES:
            violation(
                f"{record.relative_to(root)} has status '{status}' — allowed: "
                f"{', '.join(sorted(DECISION_STATUSES))}. Decisions are never deleted "
                "or hand-flagged; supersede via `forge.py decision new --supersedes <slug>`."
            )
        # Lifecycle cross-references must resolve BOTH ways — a dangling
        # supersede pointer is exactly how a corpus rots into contradiction.
        for field in ("supersedes", "superseded_by"):
            target = fields.get(field)
            if target and target not in stems:
                violation(
                    f"{record.relative_to(root)}: {field}: {target} does not exist "
                    "in docs/decisions/."
                )
        if status == "superseded" and not fields.get("superseded_by"):
            violation(
                f"{record.relative_to(root)} is superseded but names no superseded_by — "
                "history must point at the decision that replaced it."
            )
        text = record.read_text(errors="replace")
        if status == "accepted":
            for heading in ("Context", "Decision", "Consequences"):
                if not _section_has_substance(text, heading):
                    violation(
                        f"{record.relative_to(root)} is accepted but its '{heading}' section "
                        "is empty or template boilerplate. An accepted decision with no "
                        "substance is unreviewable — write it before accepting."
                    )
        if fields.get("status") == "accepted":
            if not fields.get("confirmed_by"):
                violation(
                    f"{record.relative_to(root)} is accepted but confirmed_by is empty. "
                    "A human must be named; agents must not self-confirm decisions "
                    "(an explicit human confirmation in chat authorizes recording)."
                )
            else:
                try:
                    # The trailer belongs on the ACCEPTANCE commit — the one
                    # that first introduced `status: accepted` — not on the
                    # commit that added the record as a proposed draft.
                    shas = subprocess.run(
                        ["git", "log", "--reverse", "-S", "status: accepted",
                         "--format=%H", "--", str(record)],
                        cwd=root, capture_output=True, text=True, check=True,
                    ).stdout.split()
                    if shas:
                        body = subprocess.run(
                            ["git", "show", "-s", "--format=%B", shas[0]],
                            cwd=root, capture_output=True, text=True, check=True,
                        ).stdout
                        if "Confirmed-by:" not in body:
                            warnings.append(
                                f"WARNING: commit {shas[0][:8]} accepting "
                                f"{record.relative_to(root)} lacks a `Confirmed-by:` "
                                "trailer (convention-level check)."
                            )
                    # No match = the acceptance is not committed yet; nothing
                    # to verify until it is.
                except subprocess.CalledProcessError:
                    warnings.append(
                        f"WARNING: git history unavailable for {record.relative_to(root)}; "
                        "skipped Confirmed-by trailer check."
                    )


DECISION_REF = re.compile(r"docs/decisions/(\d{4}-[a-z0-9][a-z0-9-]*\.md)")


def check_plan_decision_refs(root: Path) -> None:
    plans = root / "plans"
    if not plans.is_dir():
        return
    for plan in plans.rglob("*.md"):
        try:
            text = plan.read_text(errors="replace")
        except OSError:
            continue
        for match in DECISION_REF.finditer(text):
            ref = root / "docs" / "decisions" / match.group(1)
            if not ref.exists():
                violation(
                    f"{plan.relative_to(root)} references docs/decisions/{match.group(1)} "
                    "which does not exist. Create it with `forge.py decision new <slug>` "
                    "or fix the reference — plans must not cite phantom decisions."
                )


def check_path_parity(root: Path) -> None:
    root_claude = root / "CLAUDE.md"
    if root_claude.exists():
        text = root_claude.read_text(errors="replace")
        if "@AGENTS.md" not in text:
            violation(
                "CLAUDE.md (root) does not import @AGENTS.md. It is the Claude Code "
                "entrypoint and must import the shared contract, never restate it."
            )
        if len(text.splitlines()) > 10:
            violation(
                "CLAUDE.md (root) exceeds 10 lines. It is an import shim "
                "(@AGENTS.md + @.claude/CLAUDE.md); content belongs in those files."
            )
    else:
        violation(
            "CLAUDE.md (root) is missing. Claude Code auto-loads the root file; add the "
            "import shim (@AGENTS.md + @.claude/CLAUDE.md)."
        )
    claude_md = root / ".claude" / "CLAUDE.md"
    if claude_md.exists():
        if "AGENTS.md" not in claude_md.read_text(errors="replace"):
            violation(
                ".claude/CLAUDE.md does not reference AGENTS.md. The Claude adapter must "
                "point at the shared contract, not restate it."
            )
    else:
        violation(".claude/CLAUDE.md is missing. Both runtimes need an adapter.")

    def check_hook_registration(rel_path: str) -> set[str]:
        """Validate one runtime's hook registration; returns registered events."""
        hooks_file = root / rel_path
        if not hooks_file.exists():
            violation(
                f"{rel_path} is missing. Both runtimes must register the same hooks "
                "(gate parity is enforced, not assumed)."
            )
            return set()
        try:
            hooks = json.loads(hooks_file.read_text())
        except json.JSONDecodeError:
            violation(f"{rel_path} is not valid JSON.")
            return set()
        events: set[str] = set()
        for event, entries in (hooks.get("hooks") or {}).items():
            events.add(event)
            for entry in entries:
                for hook in entry.get("hooks", []):
                    command = hook.get("command", "")
                    scripts = re.findall(r"\.[\w/]*scripts/[\w.]+\.py", command)
                    for script in scripts:
                        if not script.startswith(".agents/scripts/"):
                            violation(
                                f"{rel_path} ({event}) invokes {script}; hook logic "
                                "must live in .agents/scripts/ (thin-adapter rule)."
                            )
                        elif not (root / script).exists():
                            violation(
                                f"{rel_path} ({event}) references {script} which does "
                                "not exist. Fix the path or restore the script."
                            )
        return events

    codex_events = check_hook_registration(".codex/hooks.json")
    claude_events = check_hook_registration(".claude/settings.json")
    # PreCompact exists only in Claude Code — Codex sessions have no
    # compaction event to hook. The scratchpad SNAPSHOT is therefore
    # Claude-only session machinery, not a gate; its counterpart
    # (`forge note`, the facts ledgers) works identically in both runtimes.
    claude_only = {"PreCompact"}
    if codex_events and claude_events and codex_events != claude_events - claude_only:
        violation(
            f"Hook parity broken: .codex/hooks.json registers {sorted(codex_events)} but "
            f".claude/settings.json registers {sorted(claude_events)}. Both runtimes must "
            f"enforce the same GATES (Claude-only session events exempt: "
            f"{sorted(claude_only)})."
        )


ALLOWED_CLAUDE = {"CLAUDE.md", "settings.json", "settings.local.json", "launch.json"}


def check_thin_adapter(root: Path) -> None:
    claude = root / ".claude"
    if claude.is_dir():
        for f in claude.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(claude)
            # Standard Claude Code project surfaces are allowed: skills may be
            # MULTI-FILE (skills/<name>/ plus reference files/scripts — the
            # documented skill layout), agents/*.md are custom subagents, and
            # launch.json is run config. The rule guards against CANON living
            # in the adapter (policy docs, constitution copies), not against
            # a client repo using Claude Code normally; the duplication checks
            # still keep skills/agents honest about referencing canon.
            is_skill_file = len(rel.parts) >= 3 and rel.parts[0] == "skills"
            is_agent = (
                len(rel.parts) == 2 and rel.parts[0] == "agents" and f.suffix == ".md"
            )
            if f.name not in ALLOWED_CLAUDE and not is_skill_file and not is_agent:
                violation(
                    f"{f.relative_to(root)} is not an adapter file. .claude/ may contain only "
                    f"{sorted(ALLOWED_CLAUDE)}, skills/<name>/**, and agents/*.md; move "
                    "substance to .agents/ or docs/."
                )
        claude_md = claude / "CLAUDE.md"
        if claude_md.exists():
            lines = len(claude_md.read_text(errors="replace").splitlines())
            if lines > CLAUDE_MD_MAX_LINES:
                violation(
                    f".claude/CLAUDE.md is {lines} lines (max {CLAUDE_MD_MAX_LINES}). It is a "
                    "pointer, not a policy document; move content to AGENTS.md or docs/."
                )
    codex = root / ".codex"
    if codex.is_dir():
        for f in codex.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(codex)
            ok = (
                rel.as_posix() in {"config.toml", "hooks.json"}
                # Overlay profiles (e.g. explore.config.toml) are config, not substance.
                or (len(rel.parts) == 1 and rel.name.endswith(".config.toml"))
                or (rel.parts[0] == "agents" and f.suffix == ".toml")
                or (
                    len(rel.parts) == 3
                    and rel.parts[0] == "skills"
                    and rel.parts[2] == "SKILL.md"
                )
            )
            if not ok:
                violation(
                    f"{f.relative_to(root)} is not an adapter file. .codex/ may contain only "
                    "config.toml, hooks.json, agents/*.toml, and skills/<name>/SKILL.md; "
                    "scripts, prompts, and skill bodies live in .agents/."
                )


CODE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".vue", ".svelte"}
PROTOTYPE_IMPORT = re.compile(
    r"""(?:from|import|require)\s*\(?\s*['"][^'"]*(?:^|/)?prototype/""",
)


def check_prototype_isolation(root: Path) -> None:
    """prototype/ is 'reference forever, imported never' — enforce the never.

    Any import/require path reaching into prototype/ from production code
    turns the preserved reference into a load-bearing dependency."""
    proc = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        return
    for rel in proc.stdout.splitlines():
        if rel.startswith(("prototype/", ".agents/", ".claude/", ".codex/")):
            continue
        if Path(rel).suffix not in CODE_SUFFIXES:
            continue
        path = root / rel
        if not path.is_file():
            continue
        for lineno, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if PROTOTYPE_IMPORT.search(line):
                violation(
                    f"{rel}:{lineno} imports from prototype/ — the prototype is a "
                    "preserved reference, never a dependency. Reimplement the piece "
                    "in production code."
                )


def check_schemas(root: Path) -> None:
    """Schemas and the harness.yaml allowlist must not silently diverge:
    every pinned generator in .agents/schemas/*.json must appear in
    harness.yaml (substring — no YAML parser in a stdlib-only linter)."""
    schemas_dir = root / ".agents" / "schemas"
    manifest_path = root / "harness.yaml"
    manifest = manifest_path.read_text() if manifest_path.is_file() else ""
    for path in sorted(schemas_dir.glob("*.json")) if schemas_dir.is_dir() else []:
        rel = path.relative_to(root)
        try:
            schema = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            violation(f"{rel}: invalid JSON ({exc}). Schemas are recorder contracts.")
            continue
        generators = schema.get("generated_by")
        if not isinstance(generators, list) or not generators:
            violation(
                f"{rel}: missing or empty generated_by allowlist. Every artifact "
                "schema must pin its permitted generators."
            )
            continue
        for name in generators:
            if name not in manifest:
                violation(
                    f"{rel}: generator '{name}' is not mentioned in harness.yaml. "
                    "Pin it there (the allowlist) or remove it from the schema."
                )
        for condition, skills in (schema.get("required_skills") or {}).items():
            for skill in skills:
                if skill not in manifest:
                    violation(
                        f"{rel}: required skill '{skill}' ({condition}) is not "
                        "mentioned in harness.yaml. Pin it there or remove it."
                    )


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    if root is None:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
        )
        root = Path(out.stdout.strip())
    check_canon_exists(root)
    check_forbidden_basenames(root)
    check_duplication(root)
    check_canon_markers(root)
    check_decision_records(root)
    check_plan_decision_refs(root)
    check_path_parity(root)
    check_thin_adapter(root)
    check_schemas(root)
    check_prototype_isolation(root)
    for warning in warnings:
        print(warning)
    if violations:
        print("\n".join(violations))
        print(f"\ncheck_dual_runtime: {len(violations)} violation(s).")
        return 1
    print("check_dual_runtime: clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
