#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Windows/default-console UTF-8 safety. Python points stdout/stderr at the
# platform's ANSI code page (cp1252 on Windows), so the em-dashes, arrows and
# check marks this tooling prints raise UnicodeEncodeError mid-write and abort
# the command — `forge next` and even `--help` crash on a fresh Windows box.
# Force UTF-8 at import (errors="replace" degrades a stray glyph rather than
# crashing). This is the belt to the `./forge`/`forge.cmd` launchers' exported
# PYTHONUTF8=1: a direct `python factory/scripts/<script>.py` invocation never
# gets that env, and every entrypoint here imports factory_lib.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # replaced/detached stream, or closed
        pass


def repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
        env=clean_git_env(), encoding="utf-8", errors="surrogateescape",
    )
    return Path(out.stdout.strip())


CEREMONY_POINTER_NAME = "ceremony-target"


def ceremony_pointer_path(root: Path) -> Path:
    return root / ".factory" / CEREMONY_POINTER_NAME


def read_ceremony_target(root: Path) -> Path | None:
    """The validated ceremony-target checkout for ``root``, or None.

    `forge ceremony target set` points one session's interactive ceremony
    (AskUserQuestion grill rounds, plan-mode markers) at a sibling worktree so
    a single session can orchestrate a second story there. Fail-open to the
    session checkout: a missing, unreadable, relative, self-pointing or
    non-factory target yields None so evidence is never dropped.
    """
    try:
        raw = ceremony_pointer_path(root).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not raw:
        return None
    target = Path(raw)
    if not target.is_absolute():
        return None
    try:
        resolved = target.resolve()
        session = root.resolve()
    except OSError:
        return None
    if resolved == session:
        return None
    if not (resolved / ".factory").is_dir():
        return None
    if not (resolved / "factory" / "schemas").is_dir():
        # A bare .factory without the harness schemas would make hook-side
        # validation fail and silently DROP evidence — only a full factory
        # checkout qualifies as a ceremony target.
        return None
    return resolved


def vendored_client(root: Path) -> bool:
    """True when this repo VENDORED the harness — factory/ and the vendored
    adapters/canon are infrastructure a `forge upgrade` may rewrite mid-task, not
    the task's product. The source harness repo has no constitution/VENDORED_FROM
    marker; every client that ran forge upgrade/adopt/scaffold gets one."""
    return (root / "constitution" / "VENDORED_FROM").is_file()


def factory_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / ".factory"


def story_dir(root: Path, key: str) -> Path:
    """Return the canonical evidence directory for one story."""
    if not isinstance(key, str) or not key or key in (".", "..") \
            or "/" in key or "\\" in key:
        raise ValueError("story key must be one path component")
    return factory_dir(root) / "stories" / key


def story_uses_scoped_layout(root: Path, key: str) -> bool:
    """Return whether a story is marked for scoped state."""
    return story_dir(root, key).is_dir()


def evidence_path(
    root: Path,
    key: str | None,
    name: str,
    *,
    for_write: bool = False,
) -> Path:
    """Resolve story evidence, retaining legacy live and history reads.

    Intake creates the story directory for the new layout. Its presence is
    therefore also the write-layout marker; an active story without it is a
    legacy story whose live singleton must remain writable.
    """
    relative = Path(name)
    if relative.is_absolute() or not relative.parts or any(
            part in ("", ".", "..") for part in relative.parts):
        raise ValueError("evidence name must be a contained relative path")
    live = factory_dir(root) / relative
    if not key:
        return live

    scoped_dir = story_dir(root, key)
    scoped = scoped_dir / relative
    state = load_json(run_state_path(root), default={})
    active = (state.get("issue_key") or state.get("story")) == key
    if for_write:
        return scoped if story_uses_scoped_layout(root, key) or not active else live
    if scoped.exists():
        return scoped
    if active and live.exists():
        return live

    archived = factory_dir(root) / "history" / key / relative
    if archived.exists():
        return archived
    return scoped


def _active_story_key(root: Path) -> str:
    state = load_json(run_state_path(root), default={})
    key = state.get("issue_key") or state.get("story")
    return key if isinstance(key, str) else ""


_RUN_STATE_ROOTS: dict[Path, Path] = {}


def run_state_path(
    root: Path | None = None,
    key: str | None = None,
    *,
    for_write: bool = False,
) -> Path:
    """Resolve the worktree-local run pointer, with legacy fallback.

    The protected pointer is authoritative for reads. Intake supplies the
    story key for writes, so only a story with the scoped-layout marker writes
    there; a legacy story continues using tracked run.json.
    """
    base = root or repo_root()
    legacy = factory_dir(base) / "run.json"
    try:
        protected = git_control_dir(base) / "run.json"
    except SystemExit:
        if legacy.is_file() and not for_write:
            return legacy
        raise
    if for_write and key:
        path = protected if story_uses_scoped_layout(base, key) else legacy
        if path == protected:
            _RUN_STATE_ROOTS[protected] = base
        return path
    if protected.is_file():
        _RUN_STATE_ROOTS[protected] = base
        return protected
    return legacy


def derive_phase(root: Path, state: dict[str, Any]) -> str:
    """Derive durable lifecycle progress while retaining transient phases."""
    stored = state.get("phase", "")
    key = state.get("issue_key") or state.get("story")
    if not isinstance(key, str) or not key or not story_uses_scoped_layout(root, key):
        return stored if isinstance(stored, str) else ""

    scoped = story_dir(root, key)
    implied = ""
    if (scoped / "decomposition.json").is_file():
        implied = "implementing"
    if (scoped / "tests.json").is_file() or (scoped / "verify.json").is_file():
        implied = "testing"
    if (scoped / "tests.json").is_file() and (scoped / "verify.json").is_file():
        implied = "reviewing"
    reviews = scoped / "reviews"
    if all((reviews / f"{aspect}.json").is_file()
           for aspect in ("quality", "performance", "security")):
        implied = "functional-check"

    order = (
        "discovery", "planning", "decomposing", "awaiting-approval",
        "implementing", "testing", "reviewing", "functional-check",
        "pr-ready", "shipped", "done",
    )
    if stored not in order or implied not in order:
        return stored if isinstance(stored, str) else implied
    return order[max(order.index(stored), order.index(implied))]


def decomposition_state_path(
    root: Path | None = None,
    key: str | None = None,
    *,
    for_write: bool = False,
) -> Path:
    base = root or repo_root()
    story = key or _active_story_key(base)
    return evidence_path(base, story, "decomposition.json", for_write=for_write)


def clean_git_env() -> dict[str, str]:
    return {
        key: value for key, value in os.environ.items()
        if not key.startswith("GIT_")
    }


def verify_state_path(
    root: Path | None = None,
    key: str | None = None,
    *,
    for_write: bool = False,
) -> Path:
    base = root or repo_root()
    story = key or _active_story_key(base)
    return evidence_path(base, story, "verify.json", for_write=for_write)


def tests_state_path(
    root: Path | None = None,
    key: str | None = None,
    *,
    for_write: bool = False,
) -> Path:
    base = root or repo_root()
    story = key or _active_story_key(base)
    return evidence_path(base, story, "tests.json", for_write=for_write)


def review_dir(root: Path | None = None, key: str | None = None) -> Path:
    base = root or repo_root()
    story = key or _active_story_key(base)
    return evidence_path(base, story, "reviews")


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


# `\r?` before the anchor, matching FRONTMATTER above: multiline `$` sits before
# the `\n` and cannot consume a `\r`, so without it every heading in a CRLF
# document misses and the gate refuses a document whose headings are plainly
# there. `[ \t]+` after the hashes for the same reason a tab is not a typo.
SECTION_HEADING = re.compile(r"^##[ \t]+([^\r\n]+?)[ \t]*\r?$", re.MULTILINE)
# The optional ATX closing run: `## Why ##` names Why, `# #` names nothing.
# Anchored to start-or-whitespace so a hash that belongs to the name survives
# (`## Sharp C#`). Exported because the H1 check needs the same rule — one
# answer to "what is this heading called", or the two drift.
ATX_CLOSING_RUN = re.compile(r"(?:^|[ \t]+)#+[ \t]*\r?$")
# CommonMark's fence rule, as a line test rather than a document-wide regex.
# A backtick opener's info string may not contain a backtick, which is why
# ```` ```json `x` ```` opens nothing.
FENCE_LINE = re.compile(r"^ {0,3}(?P<run>`{3,}|~{3,})(?P<info>[^\r\n]*)$")
# A block-level comment opener. Deliberately not any `<!--`: the substring also
# appears inside inline code (`` `<!--` ``) and prose about comments, and an
# opener taken from there swallows every heading after it.
COMMENT_OPEN = re.compile(r" {0,3}<!--")
# A list marker, because a fence's indentation alone does not say whether it
# belongs to a list item: CommonMark lets a TOP-LEVEL fence indent up to three
# spaces too, and closing that one early hands the example's headings to the
# document.
LIST_ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]")
# The raw HTML blocks that hold their content VERBATIM until a closing tag.
# Deliberately not every block tag: a `<div>` block ends at a blank line, so a
# heading after that blank line really is the document's own, and masking to
# `</div>` would refuse a complete spec.
RAW_BLOCK_OPEN = re.compile(r" {0,3}<(pre|script|style|textarea)[ \t>]", re.I)
# CommonMark's type-6 block tags, verbatim from the spec rather than a list
# someone picked: a hand-chosen subset invites "why not this one too" forever,
# and every answer is an argument. These blocks end at a blank line or the end
# of the document, so a heading after that blank line IS the document's own —
# masking to `</div>` instead would refuse a complete spec.
HTML_BLOCK_TAGS = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|"
    "colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|"
    "footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|"
    "legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|"
    "param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|"
    "track|ul"
)
HTML_BLOCK_OPEN = re.compile(rf" {{0,3}}</?({HTML_BLOCK_TAGS})[ \t>/]", re.I)


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def example_ranges(text: str) -> list[tuple[int, int]]:
    """Character spans holding fenced blocks, HTML comments and raw HTML —
    illustration, not document structure.

    A `## Why` inside an example is an example of a heading, so counting it lets
    a spec satisfy the capture gate without ever stating why. Both constructs
    are line-state machines in the spec and only behave when read as one, so
    this is a SINGLE pass with one state: a fence marker inside a comment and a
    comment marker inside a fence are both just text, and separate passes made
    each construct able to change the other's state. Callers exclude headings
    that START inside a span and still slice bodies from the original text, or
    a section whose content is only an example would read as empty.

    Every ambiguity resolves toward masking LESS, because the two directions
    are not symmetric. Masking too little means an author who wrote their
    sections only inside an example reaches the grill that `spec confirm`
    requires anyway. Masking too much refuses a document whose sections are
    plainly present — the failure this gate exists to remove. That is why an
    unterminated construct masks nothing at all: a stray opener is a typo, and
    reading everything after it as an example is how earlier attempts turned a
    complete spec into a refusal.
    """
    ranges: list[tuple[int, int]] = []
    fence: tuple[str, int, int] | None = None
    # (closing marker, start offset) for the constructs that run verbatim to a
    # marker rather than to a matching fence line: HTML comments and raw blocks.
    verbatim: tuple[str, int] | None = None
    # A container block, which ends at a blank line or the end of the document.
    html_block_at: int | None = None
    opened_at = 0
    offset = 0
    in_list = False
    for line in text.splitlines(keepends=True):
        match = FENCE_LINE.match(line.rstrip("\r\n"))
        if html_block_at is not None and not line.strip():
            ranges.append((html_block_at, offset))
            html_block_at = None
        if fence is not None and line.strip() and _indent(line) < fence[2]:
            # A fence opened inside a list item ends when the item does, so an
            # outdented line closes it. Only fences opened inside a list carry
            # a non-zero guard (see below), so a top-level fence — which may
            # itself be indented up to three spaces — is never closed early.
            ranges.append((opened_at, offset))
            fence = None
        if fence is None and verbatim is None:
            if LIST_ITEM.match(line):
                in_list = True
            elif line.strip() and _indent(line) == 0:
                in_list = False
        if verbatim is not None:
            marker, started = verbatim
            if (closes := line.lower().find(marker)) != -1:
                ranges.append((started, offset + closes + len(marker)))
                verbatim = None
        elif fence is not None:
            # CommonMark allows only spaces and tabs after a closing fence, so
            # `strip()` — which also eats NBSP and every other Unicode space —
            # would close a block the renderer leaves open.
            if (match
                    and match.group("run")[0] == fence[0]
                    and len(match.group("run")) >= fence[1]
                    and not match.group("info").strip(" \t")):
                ranges.append((opened_at, offset + len(line)))
                fence = None
        elif match and (match.group("run")[0] == "~"
                        or "`" not in match.group("info")):
            # The outdent guard is the fence's own indentation ONLY inside a
            # list; at top level it is 0, which no line can undercut.
            fence = (match.group("run")[0], len(match.group("run")),
                     match.start("run") if in_list else 0)
            opened_at = offset
        elif opener := COMMENT_OPEN.match(line):
            verbatim = _verbatim_span(ranges, line, offset, opener.end(), "-->")
        elif opener := RAW_BLOCK_OPEN.match(line):
            verbatim = _verbatim_span(
                ranges, line, offset, opener.end(),
                f"</{opener.group(1).lower()}>",
            )
        elif html_block_at is None and HTML_BLOCK_OPEN.match(line):
            html_block_at = offset
        offset += len(line)
    if html_block_at is not None:
        # End of document terminates a container block — that is the spec, not
        # a deviation, so unlike a stray fence there is nothing unterminated
        # here to be lenient about.
        ranges.append((html_block_at, len(text)))
    return ranges


def _verbatim_span(
    ranges: list[tuple[int, int]], line: str, offset: int, start: int, marker: str
) -> tuple[str, int] | None:
    """Close the span on this line, or report it still open."""
    if (closes := line.lower().find(marker, start)) == -1:
        return marker, offset
    ranges.append((offset, offset + closes + len(marker)))
    return None


def outside_examples(text: str, matches) -> list:
    """The matches that start outside every example span (example_ranges)."""
    ranges = example_ranges(text)
    return [
        match for match in matches
        if not any(start <= match.start() < end for start, end in ranges)
    ]


def ledger_dir(legacy: Path) -> Path:
    """The directory form of a ledger that used to be one .jsonl file."""
    return legacy.with_suffix("")


def append_ledger_record(legacy: Path, record: dict, record_id: str) -> Path:
    """Write one record as its own file (decision 0022).

    Many writers appending to ONE file is the only reason these ledgers ever
    conflicted, and every mechanism built to manage that — a per-clone merge
    driver, .gitattributes rules, scaffold wiring — existed to paper over it.
    Distinct files do not conflict, so there is nothing to merge, nothing to
    order, and no driver to register.
    """
    directory = ledger_dir(legacy)
    directory.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", record_id)[:120] or "record"
    # A microsecond suffix, because two records of the same ledger can be
    # written inside one second — `quickfix start` then `done` on a fast
    # machine — and filenames that tie put the ledger in ALPHABETICAL order,
    # which is how "done" came to precede "open". Filenames are not the
    # ordering (that is each record's timestamp), but they must not fight it.
    path = directory / f"{safe}-{datetime.now(timezone.utc):%H%M%S%f}.json"
    dump_json(path, record)
    return path


def read_ledger_records(legacy: Path) -> list[dict]:
    """Every record: the directory form plus any legacy .jsonl still present.

    Reading both is what lets a repo adopt the directory form without a
    migration — history stays readable and nothing is rewritten. Order comes
    from each record's own timestamp, never from file position, because
    position was never information and a merge rewrote it anyway.
    """
    records: list[dict] = []
    directory = ledger_dir(legacy)
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            entry = load_json(path, default=None)
            if isinstance(entry, dict):
                records.append(entry)
    if legacy.is_file():
        for lineno, line in enumerate(legacy.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                # LOUD, never skipped: a malformed line is a merge artifact or
                # a hand edit, and a silently-dropped record is the knowledge
                # this ledger exists to keep, lost quietly.
                raise SystemExit(
                    f"{legacy.name} line {lineno} is not valid JSON (merge "
                    f"artifact or hand edit?): {line[:80]!r} — repair it; "
                    "records are managed by the forge commands."
                )
            if not isinstance(entry, dict):
                raise SystemExit(f"{legacy.name} line {lineno} must be a JSON object")
            records.append(entry)
    seen: set[str] = set()
    unique: list[dict] = []
    for entry in records:
        key = json.dumps(entry, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(entry)
    return sorted(unique, key=_ledger_order)


def _ledger_order(record: dict) -> tuple:
    """Chronological where a record says when it happened, stable otherwise."""
    for field in ("at", "ts", "timestamp", "started_at", "recorded_at"):
        value = record.get(field)
        if isinstance(value, str) and value:
            return (0, value)
    return (1, json.dumps(record, sort_keys=True))


def parse_sections(text: str) -> dict[str, str]:
    """Map level-two Markdown heading names to their stripped bodies.

    The single answer to "does this document have this section, with content".
    Sign-off, spec confirmation and doctor all ask it; when they each decided
    separately, they disagreed — `##  Why` was a section to one and a section
    named " Why" to another, so a lookup missed and a gate refused a document
    that was complete.
    """
    headings = outside_examples(text, SECTION_HEADING.finditer(text))
    return {
        ATX_CLOSING_RUN.sub("", heading.group(1)).strip(): text[
            heading.end():headings[index + 1].start()
            if index + 1 < len(headings) else len(text)
        ].strip()
        for index, heading in enumerate(headings)
    }


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
    match = SIGNOFF_PIN.search(manifest.read_text(encoding="utf-8"))
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
    fields = parse_frontmatter(record.read_text(encoding="utf-8"))
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
    data = json.loads(path.read_text(encoding="utf-8"))
    run_root = _RUN_STATE_ROOTS.get(path)
    if run_root is not None and isinstance(data, dict):
        data = {**data, "phase": derive_phase(run_root, data)}
    return data


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


# Git's control dir is constant for a worktree over a process's lifetime, but
# resolving it shells out to git twice. The board resolves it ~100× per poll
# (once per run_state_path / evidence_path call), which turned a single request
# into ~16s of subprocess churn on Windows. Memoise per resolved root so a
# request costs two git calls, not two hundred. Only successful results are
# cached; a failure re-runs so a transient git error is not pinned for the
# process's life.
_GIT_CONTROL_DIR_CACHE: dict[Path, Path] = {}


def git_control_dir(root: Path) -> Path:
    resolved = root.resolve()
    cached = _GIT_CONTROL_DIR_CACHE.get(resolved)
    if cached is not None:
        return cached
    proc = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(), encoding="utf-8", errors="surrogateescape",
    )
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(), encoding="utf-8", errors="surrogateescape",
    )
    if (
        proc.returncode != 0
        or top.returncode != 0
        or not proc.stdout.strip()
        or Path(top.stdout.strip()).resolve() != resolved
    ):
        raise SystemExit(
            "Cannot resolve Git's protected control directory for factory state."
        )
    result = Path(proc.stdout.strip()) / "forge"
    _GIT_CONTROL_DIR_CACHE[resolved] = result
    return result


def protected_decomposition_state_path(root: Path) -> Path:
    return git_control_dir(root) / "decomposition.json"


def task_marker_path(key: str, task_id: str) -> Path:
    """Return the committed marker shared by task start and task closeout."""
    for label, value in (("story key", key), ("task id", task_id)):
        if (
            not isinstance(value, str) or not value
            or value in {".", ".."} or Path(value).name != value
            or "\\" in value
        ):
            raise ValueError(f"{label} must be one path component")
    return Path(".factory") / "stories" / key / "tasks" / task_id / "pr-ready.json"


def default_trunk_branch(root: Path) -> str:
    """The repo's integration trunk — origin's default branch, not a hardcoded
    'main'. Task markers, the task-start base, and the branch-review diff all
    live on whatever ``origin/HEAD`` points at (main / develop / trunk / …), so
    deriving it keeps the harness correct on every repo instead of only on
    main-trunk ones. Falls back to 'main' when the default cannot be resolved,
    which preserves prior behaviour for main-trunk repos (zero regression)."""
    # Branch/ref names are UTF-8 (unlike arbitrary file paths), so strict UTF-8
    # decoding is correct here and needs no lossless surrogateescape.
    ref = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        cwd=root, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8",
    )
    if ref.returncode == 0 and ref.stdout.strip():
        return ref.stdout.strip().rsplit("/", 1)[-1]
    # origin/HEAD not set locally — ask the remote once, then fall back to main.
    show = subprocess.run(
        ["git", "remote", "show", "origin"],
        cwd=root, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8",
    )
    for line in show.stdout.splitlines():
        if "HEAD branch:" in line:
            name = line.split("HEAD branch:", 1)[1].strip()
            if name and name != "(unknown)":
                return name
    return "main"


def task_marker_on_main(root: Path, key: str, task_id: str) -> bool:
    """Refresh the trunk and report whether its tree contains the task marker.

    'main' in the name is historical: the branch queried is the resolved trunk
    (``default_trunk_branch``), so a develop/trunk repo finds its markers too.
    """
    marker = task_marker_path(key, task_id)
    trunk = default_trunk_branch(root)
    fetch = subprocess.run(
        ["git", "fetch", "origin", trunk], cwd=root, capture_output=True,
        text=True, env=clean_git_env(), encoding="utf-8", errors="surrogateescape",
    )
    if fetch.returncode != 0:
        detail = fetch.stderr.strip() or fetch.stdout.strip()
        raise SystemExit(
            f"fetching origin/{trunk} failed" + (f": {detail}" if detail else "")
        )
    present = subprocess.run(
        ["git", "cat-file", "-e", f"origin/{trunk}:{marker.as_posix()}"],
        cwd=root, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    return present.returncode == 0


def _windows_reparse_point(path: Path) -> bool:
    info = os.lstat(path)
    return bool(
        hasattr(info, "st_file_attributes")
        and info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _safe_factory_nt_open(
        directory: Path, parts: tuple[str, ...], flags: int) -> int | None:
    """Open a factory leaf after refusing Windows reparse points.

    Windows lacks dir_fd, so this lstat-based walk has a narrower TOCTOU window
    than the POSIX fd walk. That matches the deferred hard-link/TOCTOU hardening
    backlog; the post-open regular-file and link-count check remains mandatory.
    """
    try:
        directory.mkdir(parents=True, exist_ok=True)
        if _windows_reparse_point(directory):
            return None
        parent = directory
        for part in parts[:-1]:
            parent = parent / part
            parent.mkdir(exist_ok=True)
            if _windows_reparse_point(parent):
                return None
        leaf = parent / parts[-1]
        if os.path.lexists(leaf) and _windows_reparse_point(leaf):
            return None
        return os.open(leaf, flags, 0o600)
    except OSError:
        return None


def _safe_factory_fd(root: Path, name: str, flags: int) -> int | None:
    """Open one direct .factory diagnostic file without following links.

    Workers own the workspace, so these mirrors are never authoritative. The
    orchestrator still must not follow a swapped file or parent directory when
    publishing a diagnostic copy.
    """
    if Path(name).name != name:
        raise ValueError("factory diagnostic name must be one path component")
    directory = factory_dir(root)
    if os.name == "nt":
        descriptor = _safe_factory_nt_open(directory, (name,), flags)
        if descriptor is None:
            return None
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(descriptor)
            return None
        return descriptor
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
    if os.name == "nt":
        descriptor = _safe_factory_nt_open(
            directory, rel.parts, os.O_WRONLY | os.O_CREAT)
        if descriptor is None:
            return False
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
    lite_window_ok: bool = False,
) -> dict[str, Any]:
    """The factory precondition matrix, in one place.

    Every artifact-writing script calls this with the preconditions its phase
    requires. Missing run state always fails — no gate is skippable by
    deleting .factory/run.json.
    """
    state = load_json(run_state_path(root), default={})
    if not state:
        raise SystemExit("Missing .factory/run.json. Run intake first.")
    active_window = load_json(factory_dir(root) / "quickfix.json", default={})
    lite_open = lite_window_ok and active_window.get("profile") == "lite"
    if signoff:
        ok, why = client_signoff(root)
        if not ok:
            raise SystemExit(why)
    issue = state.get("issue_key", "")
    if approved_plan and not lite_open:
        plan_files = list((root / "plans" / "active").glob(f"{issue}-*.md")) if issue else []
        if state.get("plan_status") != "approved" or not plan_files:
            raise SystemExit(
                "An approved, saved plan is required first "
                f"(plans/active/{issue or '<issue>'}-*.md via `forge.py plan save`)."
            )
    if decomposition and not lite_open:
        if (
            state.get("decomposition_status") != "recorded"
            or not protected_decomposition_state_path(root).exists()
        ):
            raise SystemExit(
                "Recorded decomposition is required first "
                "(record_decomposition_from_json.py after plan approval)."
            )
    return state


def load_review_artifacts(
    root: Path,
    *,
    require_head: bool = False,
    blockers_only: bool = False,
) -> tuple[dict[str, dict], list[str]]:
    """Load the three review artifacts and return any close-gate problems."""
    from forge_cli.readiness import review_passed

    reviews: dict[str, dict] = {}
    problems: list[str] = []
    head = head_sha(root) if require_head else None
    for aspect in ("quality", "performance", "security"):
        path = evidence_path(root, _active_story_key(root), f"reviews/{aspect}.json")
        data = load_json(path, default={})
        if not data:
            problems.append(str(path.relative_to(root)))
            continue
        reviews[aspect] = data
        if data.get("blocking_findings") or (
            not blockers_only and not review_passed(data)
        ):
            requirement = "have no blockers" if blockers_only else "be >= 8 with no blockers"
            problems.append(f"{aspect} review must {requirement}")
        if require_head and data.get("commit") != head:
            stamp = data.get("commit")
            shown = stamp[:8] if isinstance(stamp, str) and stamp else "missing"
            expected = head[:8] if head else "missing"
            problems.append(
                f"{aspect} review must be stamped at HEAD {expected} (got {shown})"
            )
    return reviews, problems


def branch_diff_digest(root: Path) -> str:
    """Hash the committed product diff from the trunk to the current HEAD."""
    from forge_cli.stages import WORKFLOW_PATHS, committed_paths

    trunk = default_trunk_branch(root)
    merge_base = subprocess.run(
        ["git", "merge-base", f"origin/{trunk}", "HEAD"],
        cwd=root, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    if merge_base.returncode != 0 or not merge_base.stdout.strip():
        raise SystemExit(
            f"Cannot bind the branch review: origin/{trunk} has no merge base with HEAD."
        )
    base_sha = merge_base.stdout.strip()
    current_head = head_sha(root)
    paths = sorted(
        path for path in committed_paths(root, base_sha, current_head)
        if not path.startswith(WORKFLOW_PATHS)
    )
    if not paths:
        return hashlib.sha256(b"").hexdigest()
    diff = subprocess.run(
        ["git", "diff", "--binary", "--no-ext-diff", base_sha, current_head,
         "--", *paths],
        cwd=root, capture_output=True, env=clean_git_env(),
    )
    if diff.returncode != 0:
        raise SystemExit("Cannot bind the branch review: git diff failed.")
    return hashlib.sha256(diff.stdout).hexdigest()


def require_coherent_review_run(root: Path, reviews: dict[str, dict]) -> list[str]:
    """Return close-gate problems for a split or stale three-lens review run."""
    aspects = ("quality", "performance", "security")
    if any(aspect not in reviews for aspect in aspects):
        return []
    fields = ("review_run_id", "brief_sha256", "branch_diff_digest")
    bindings = [tuple(reviews[aspect].get(field) for field in fields)
                for aspect in aspects]
    if any(not isinstance(value, str) or not value for binding in bindings
           for value in binding):
        return [
            "quality, performance, and security reviews must echo one "
            "review_run_id, brief_sha256, and branch_diff_digest from "
            "`./forge review-brief --all`"
        ]
    if len(set(bindings)) != 1:
        return [
            "quality, performance, and security reviews must share one "
            "review_run_id, brief_sha256, and branch_diff_digest"
        ]
    review_run_id, brief_sha256, recorded_digest = bindings[0]
    expected_run_id = hashlib.sha256(
        (brief_sha256 + recorded_digest).encode()
    ).hexdigest()
    if review_run_id != expected_run_id:
        return [
            "review_run_id must equal sha256(brief_sha256 + branch_diff_digest)"
        ]
    current_digest = branch_diff_digest(root)
    if recorded_digest != current_digest:
        return [
            "branch review is stale: branch_diff_digest does not match the "
            "current committed product diff; rerun `./forge review-brief --all` "
            "and all three lenses"
        ]
    return []


def require_all_stages_done(root: Path) -> list[str]:
    """Return decomposition task ids whose execution stage is not done."""
    from forge_cli.stages import load_stages

    decomposition = load_json(protected_decomposition_state_path(root), default={})
    stages = {
        stage.get("id"): stage
        for stage in load_stages(root).get("stages", [])
        if isinstance(stage, dict)
    }
    return [
        task["id"]
        for task in decomposition.get("tasks", [])
        if isinstance(task, dict)
        and isinstance(task.get("id"), str)
        and stages.get(task["id"], {}).get("status") != "done"
    ]


def require_closeout_order(root: Path) -> list[str]:
    """Return closeout problems in their required prerequisite order."""
    from forge_cli.outcome import load_outcome
    from forge_cli.readiness import tests_passed

    problems: list[str] = []
    head = head_sha(root)
    expected = head[:8] if head else "missing"

    open_stages = require_all_stages_done(root)
    if open_stages:
        problems.append(
            f"stage completion: {', '.join(open_stages)} not done — work each "
            "stage (forge stage start → local autoreview until clean → commit → "
            "forge stage done; WORKFLOW.md Stage Loop)"
        )

    verify = load_json(verify_state_path(root), default={})
    if not verify or not verify.get("ok"):
        problems.append("successful .factory/verify.json")
    elif verify.get("commit") != head:
        stamp = verify.get("commit")
        shown = stamp[:8] if isinstance(stamp, str) and stamp else "missing"
        problems.append(
            f"verify must be stamped at HEAD {expected} (got {shown})"
        )

    reviews, review_problems = load_review_artifacts(root, require_head=True)
    problems.extend(review_problems)
    problems.extend(require_coherent_review_run(root, reviews))

    decomposition = load_json(protected_decomposition_state_path(root), default={})
    if bool(decomposition.get("user_facing", True)):
        tests = load_json(tests_state_path(root), default={})
        functional = tests.get("functional", {}) if tests else {}
        if not functional:
            problems.append(".factory/tests.json:functional")
        elif not tests_passed(functional, functional=True):
            problems.append(
                "functional testing must have no blockers, no failed status and score >= 8"
            )
        if functional and tests.get("commit") != head:
            stamp = tests.get("commit")
            shown = stamp[:8] if isinstance(stamp, str) and stamp else "missing"
            problems.append(
                f"functional testing must be stamped at HEAD {expected} (got {shown})"
            )

    outcome = load_outcome(root) or {}
    if not outcome.get("outcome"):
        problems.append(
            "the shipped outcome — `forge.py outcome set \"<what changed and what "
            "someone can now do>\"` (one paragraph, in a reader's language)"
        )
    elif outcome.get("commit") != head:
        stamp = outcome.get("commit")
        shown = stamp[:8] if isinstance(stamp, str) and stamp else "missing"
        problems.append(
            f"outcome must be stamped at HEAD {expected} (got {shown}) — rerun "
            "`forge.py outcome set`"
        )
    return problems


SCHEMA_TYPES = {"str": str, "int": int, "bool": bool, "list": list, "dict": dict}


def schema_path(root: Path, name: str) -> Path:
    return root / "factory" / "schemas" / f"{name}.json"


def validate_payload(root: Path, name: str, payload: dict) -> None:
    """The determinism contract's front door: refuse any externally-authored
    artifact that does not match its factory/schemas/ spec, including a
    generated_by value outside the pinned allowlist. Extra keys are allowed."""
    path = schema_path(root, name)
    schema = json.loads(path.read_text(encoding="utf-8"))
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
        capture_output=True, text=True, env=clean_git_env(), encoding="utf-8",
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def active_task_user_facing(root: Path) -> bool:
    """Design-skill enforcement is PER TASK, not per story. A user_facing story
    (e.g. one whose web app is a later task) still contains backend tasks with
    no UI; forcing those to attest UI design skills is the bug this resolves.
    Resolve the active stage's task and read ITS OWN user_facing flag, defaulting
    to False when the task does not declare one — the planner marks UI tasks
    user_facing: true, and the task grill enforces that a user_facing story does
    so for the task(s) that build UI."""
    stages = load_json(git_control_dir(root) / "stages.json", default={})
    active = next((s for s in stages.get("stages", [])
                   if isinstance(s, dict) and s.get("status") == "active"), None)
    if not active:
        return False
    decomposition = load_json(
        protected_decomposition_state_path(root), default={})
    task = next((t for t in decomposition.get("tasks", [])
                 if isinstance(t, dict) and t.get("id") == active.get("id")), {})
    return bool(task.get("user_facing"))


def require_skills(root: Path, name: str, payload: dict) -> None:
    """Feature-type skill enforcement (same trust model as generated_by):
    when the ACTIVE TASK is user_facing, the artifact must ATTEST the phase's
    mandatory skills in skills_used. Advisory skills are listed too when used,
    but only the required set gates."""
    schema = json.loads(schema_path(root, name).read_text(encoding="utf-8"))
    required = schema.get("required_skills", {})
    if not required:
        return
    if not active_task_user_facing(root):
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
    key = _active_story_key(root) if gate == "plan" else ""
    path = evidence_path(root, key, f"grills/{gate}.json")
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
        actual = (
            plan_digest_without_assumptions(expect_digest_of)
            if gate == "plan"
            else sha256_of(expect_digest_of)
        )
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
                          capture_output=True, text=True,
                          encoding="utf-8", errors="surrogateescape")
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


def require_task_grill(
    root: Path, task_id: str, task: dict, *, treeish: str = "",
) -> None:
    """Require a passing grill bound to the current grounding inputs."""
    key = _active_story_key(root)
    path = evidence_path(root, key, f"grills/tasks/{task_id}.json")
    data = load_json(path, default={})
    record_command = (
        "python3 factory/scripts/record_grill_from_json.py --gate task "
        f"--task {task_id}"
    )
    if not data:
        raise SystemExit(
            f"Task grill required first: grill {task_id}, resolve findings, then record "
            f"`{record_command}`."
        )
    if data.get("verdict") != "pass":
        raise SystemExit(
            f".factory/grills/tasks/{task_id}.json verdict is "
            f"{data.get('verdict')!r} — resolve the recorded findings, re-grill, then "
            f"record `{record_command}`; this gate needs a pass."
        )
    if not data.get("commit"):
        raise SystemExit(
            f".factory/grills/tasks/{task_id}.json has no commit stamp — re-record "
            f"with current tooling using `{record_command}`."
        )
    if data.get("input_sha256") != grounding_digest(root, task, treeish=treeish):
        raise SystemExit(
            f"the {task_id} task grill is STALE — its grounding inputs changed. "
            f"Re-grill and record `{record_command}`; --task-digest was removed "
            "because the digest is derived from the protected contract, approved "
            "plan, and product tree. Tip: record the task grill LAST, immediately "
            "before `task approve`/`stage start` — committing any tracked file "
            "outside .factory/ and plans/ (docs/, factory/scripts/, source) between "
            "grilling and approving changes the product tree and re-stales it."
        )


def task_digest(task: dict) -> str:
    """Return the unchanged four-field stage measurement digest."""
    payload = json.dumps(
        {
            key: task.get(key)
            for key in (
                "write_scope",
                "required_tests",
                "verify_commands",
                "acceptance_criteria",
            )
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def plan_digest_without_assumptions(path: Path) -> str:
    """Hash the approved plan while excluding implementation-time appendices."""
    text = path.read_text(encoding="utf-8")
    approved_text = text.partition("\n## Implementation Assumptions")[0]
    return hashlib.sha256(approved_text.encode()).hexdigest()


def plan_body_digest(path: Path) -> str:
    """Hash the authored plan body, excluding harness-managed content.

    Line endings are normalised to LF before hashing so the digest is stable
    across platforms and Git's autocrlf. The plan-mode marker's ``sha256_body``
    is computed here from the plan-mode source, while ``require_plan_mode_marker``
    recomputes it from the saved/committed task plan. Without normalisation a plan
    saved by ``write_text()`` on Windows (LF -> CRLF), or checked out on another
    machine under ``core.autocrlf``, would hash differently from its marker and
    ``task approve`` would demand a spurious re-grill. Both callers run through
    this function, so normalising here keeps create and check symmetric on every OS.
    """
    raw = path.read_bytes()
    normalised = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    frontmatter = re.match(br"\A---\n.*?\n---\n", normalised, re.DOTALL)
    body = normalised[frontmatter.end():] if frontmatter else normalised
    approved_body = body.partition(b"\n## Implementation Assumptions")[0]
    return hashlib.sha256(approved_body).hexdigest()


def require_plan_mode_marker(root: Path, plan: Path) -> None:
    """Require plan-mode provenance for the current plan body."""
    story_directory = evidence_path(root, _active_story_key(root), "plan-mode")
    root_directory = evidence_path(root, None, "plan-mode")
    digest = plan_body_digest(plan)
    for directory in dict.fromkeys((story_directory, root_directory)):
        markers = sorted(directory.glob("*.json")) if directory.is_dir() else ()
        for marker_path in markers:
            marker = load_json(marker_path, default={})
            if marker.get("sha256_body") == digest:
                return
    raise SystemExit(
        f"plan-mode marker required for {plan.name}: enter plan mode, edit or save "
        "this exact plan file there, then retry without changing its body."
    )


def approved_plan_digest(
    root: Path, state: dict[str, Any], plan: Path,
) -> str | None:
    """Return the approval-time digest, backfilling legacy approved runs once."""
    digest = state.get("approved_plan_sha256")
    if isinstance(digest, str) and digest:
        return digest
    if "approved_plan_sha256" in state or state.get("plan_status") != "approved":
        return None
    digest = plan_digest_without_assumptions(plan)
    state["approved_plan_sha256"] = digest
    dump_json(run_state_path(root), state)
    return digest


def require_approved_plan_digest(root: Path) -> str:
    """Return the live approved-plan digest or require a fresh approval."""
    state = load_json(run_state_path(root), default={})
    plan_file = state.get("plan_file")
    plan = root / plan_file if isinstance(plan_file, str) else None
    approved = (
        approved_plan_digest(root, state, plan)
        if plan is not None and plan.is_file()
        else None
    )
    if (
        not isinstance(approved, str)
        or not approved
        or plan is None
        or not plan.is_file()
        or plan_digest_without_assumptions(plan) != approved
    ):
        raise SystemExit(
            "approved plan binding is missing or no longer matches the live plan. "
            "Re-grill the current plan and re-approve it."
        )
    return approved


def product_tree_digest(root: Path, treeish: str = "") -> str:
    """Hash product blobs from the index, or from a named historical tree."""
    git_args = (["ls-tree", "-r", "-z", treeish]
                if treeish else ["ls-files", "--stage", "-z"])
    proc = subprocess.run(
        ["git", *git_args],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(),
        encoding="utf-8",
        errors="surrogateescape",
    )
    if proc.returncode != 0:
        raise SystemExit(
            "cannot derive the task grounding digest from Git: "
            + proc.stderr.strip()
        )
    blobs: list[tuple[str, str]] = []
    for entry in proc.stdout.split("\0"):
        if not entry:
            continue
        metadata, path = entry.split("\t", 1)
        if path.startswith((".factory/", "plans/")):
            continue
        fields = metadata.split()
        blobs.append((path, fields[2] if treeish else fields[1]))
    payload = json.dumps(sorted(blobs), separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def requirements_digest(root: Path, spec_path: Path) -> str:
    """Bind a confirmed spec body to the current product tree."""
    raw = spec_path.read_bytes()
    frontmatter = re.match(br"\A---\r?\n.*?\r?\n---\r?\n", raw, re.DOTALL)
    body = raw[frontmatter.end():] if frontmatter else raw
    payload = body + b"\x00" + product_tree_digest(root).encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def grounding_digest(root: Path, task: dict, *, treeish: str = "") -> str:
    """Bind a task grill to its full contract, approved plan, and product tree."""
    decomposition = load_json(protected_decomposition_state_path(root), default={})
    plan_file = decomposition.get("plan_file")
    if not isinstance(plan_file, str) or not plan_file.strip():
        plan_file = load_json(run_state_path(root), default={}).get("plan_file")
    if not isinstance(plan_file, str) or not plan_file.strip():
        raise SystemExit(
            "cannot derive the task grounding digest: the protected decomposition "
            "does not name its approved plan"
        )
    plan = (root / plan_file).resolve()
    try:
        plan.relative_to(root.resolve())
    except ValueError:
        raise SystemExit(
            f"cannot derive the task grounding digest: plan path escapes the repo: "
            f"{plan_file!r}"
        )
    if not plan.is_file():
        raise SystemExit(
            f"cannot derive the task grounding digest: approved plan {plan_file!r} "
            "does not exist"
        )
    payload = json.dumps(
        {
            "contract": task,
            "plan_sha256": plan_digest_without_assumptions(plan),
            "product_tree_sha256": product_tree_digest(root, treeish),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


_TASK_CONTRACT_FIELDS = (
    "write_scope",
    "required_tests",
    "verify_commands",
    "reviewer_focus",
)


def _task_contract_complete(task: dict) -> bool:
    return all(
        value and (not isinstance(value, str) or value.strip())
        for value in (task.get(field) for field in _TASK_CONTRACT_FIELDS)
    )


def _task_grill_fresh(root: Path, task: dict, grill: dict) -> bool:
    task_id = task.get("id")
    plan = evidence_path(
        root, _active_story_key(root), f"task-plans/{task_id}.md",
    )
    if not plan.is_file():
        return False
    plan_provenance_ok = (
        grill.get("task_plan_sha256") == plan_digest_without_assumptions(plan)
    )
    try:
        grounding = grounding_digest(root, task)
    except SystemExit:
        # The approved story plan is gone — e.g. a shipped or archived story
        # whose plan moved out of plans/active/. A grill cannot be "fresh"
        # against a plan that no longer exists, and read-only callers (the
        # board's /api/state, `forge next`) must degrade, not crash. Gate
        # callers that require the plan call grounding_digest directly and
        # still raise.
        return False
    return bool(
        grill.get("verdict") == "pass"
        and grill.get("commit")
        and grill.get("input_sha256") == grounding
        and plan_provenance_ok
    )


def _task_plan_state(root: Path, task: dict, grill: dict) -> str:
    """Derive the post-grill task-plan state without storing a status."""
    task_id = task.get("id")
    key = _active_story_key(root)
    plan = evidence_path(root, key, f"task-plans/{task_id}.md")
    if not plan.is_file():
        return "author-task-plan"
    approved = (
        isinstance(grill.get("approved_by"), str)
        and bool(grill["approved_by"].strip())
        and isinstance(grill.get("approved_at"), str)
        and bool(grill["approved_at"].strip())
        and grill.get("approved_task_plan_sha256")
        == plan_digest_without_assumptions(plan)
    )
    return "approved" if approved else "await-approval"


def task_rows(root: Path) -> list[dict]:
    """Derive every live task row from the same inputs as frontier routing."""
    run_state = load_json(run_state_path(root), default={})
    is_task_level = bool(run_state.get("base_main_sha"))
    tasks = load_json(
        protected_decomposition_state_path(root), default={}
    ).get("tasks", [])
    stages = load_json(git_control_dir(root) / "stages.json", default={})
    stage_by_id = {
        stage.get("id"): stage
        for stage in stages.get("stages", [])
        if isinstance(stage, dict)
    }
    rows = []
    key = _active_story_key(root)
    for task in tasks:
        task_id = task.get("id")
        stage = stage_by_id.get(task_id, {})
        grill_path = evidence_path(root, key, f"grills/tasks/{task_id}.json")
        grill = load_json(grill_path, default={})
        fresh = _task_grill_fresh(root, task, grill) if grill else False
        status = stage.get("status")
        marker_present = (
            task_marker_on_main(root, key, task_id) if is_task_level else False
        )
        if marker_present or (not is_task_level and status == "done"):
            state = "done"
        elif is_task_level and status == "done":
            state = "await-merge"
        elif status == "active":
            state = "active"
        elif not _task_contract_complete(task):
            state = "skeleton"
        else:
            plan_state = _task_plan_state(root, task, grill)
            if plan_state == "author-task-plan":
                state = plan_state
            elif not fresh:
                state = "ready"
            else:
                state = "grilled" if plan_state == "approved" else plan_state

        budget = None
        if state == "active":
            from forge_cli.stages import (
                WORKFLOW_PATHS, _changed_line_count, changed_paths,
                review_budget, stage_baseline,
            )

            max_files, max_lines, _reason = review_budget(task)
            base_sha = stage_baseline(root, stage)
            product = [
                path for path in changed_paths(
                    root, base_sha, stage.get("dirty_at_start", {})
                )
                if not path.startswith(WORKFLOW_PATHS)
            ] if base_sha else []
            budget = {
                "used": {
                    "files": len(product),
                    "lines": _changed_line_count(root, base_sha, product)
                    if base_sha else 0,
                },
                "limit": {"files": max_files, "lines": max_lines},
            }
        rows.append({
            "id": task_id,
            "state": state,
            "grill_freshness": (
                "fresh" if fresh else "stale" if grill else "missing"
            ),
            "budget": budget,
        })
    return rows


def _task_schedule(root: Path) -> tuple[list[dict], dict[str, dict], set[str]]:
    """Tasks in declaration order, their stages, and the ids already done."""
    run_state = load_json(run_state_path(root), default={})
    is_task_level = bool(run_state.get("base_main_sha"))
    tasks = load_json(
        protected_decomposition_state_path(root), default={}
    ).get("tasks", [])
    stages = load_json(git_control_dir(root) / "stages.json", default={})
    stage_by_id = {
        stage.get("id"): stage
        for stage in stages.get("stages", [])
        if isinstance(stage, dict)
    }
    key = _active_story_key(root)
    done = {
        candidate.get("id")
        for candidate in tasks
        if (
            task_marker_on_main(root, key, candidate.get("id"))
            if is_task_level else
            stage_by_id.get(candidate.get("id"), {}).get("status") == "done"
        )
    }
    return tasks, stage_by_id, done


def task_dependencies(tasks: list[dict], task_id: str) -> list[str]:
    """A task's effective dependencies: its explicit list, else its predecessor.

    The recorder validates `dependencies` as backward-only (acyclic). A task
    that declares none depends on its immediate predecessor, so a decomposition
    without explicit dependencies keeps today's list order; only tasks with
    explicit dependencies opt into DAG order (symphony-forge #145).
    """
    previous: str | None = None
    for candidate in tasks:
        if candidate.get("id") == task_id:
            explicit = candidate.get("dependencies")
            if isinstance(explicit, list) and explicit:
                return [str(dependency) for dependency in explicit]
            return [previous] if previous else []
        previous = candidate.get("id")
    return []


def ready_task_ids(tasks: list[dict], done: set[str]) -> list[str]:
    """Pending tasks whose every effective dependency is done, in order."""
    return [
        candidate.get("id")
        for candidate in tasks
        if candidate.get("id") not in done
        and all(
            dependency in done
            for dependency in task_dependencies(tasks, candidate.get("id"))
        )
    ]


def task_ready_ids(root: Path) -> list[str]:
    """Pending tasks of the protected decomposition whose dependencies are done."""
    tasks, _stage_by_id, done = _task_schedule(root)
    return ready_task_ids(tasks, done)


def task_frontier_state(root: Path) -> tuple[str, dict] | None:
    """Return the next JIT action and the task to act on, without raising.

    Prefers a stage that is already active; otherwise the earliest READY task
    (dependencies done), falling back to the earliest unfinished task.
    """
    tasks, stage_by_id, done = _task_schedule(root)
    ready = set(task_ready_ids(root))
    frontier = next(
        (
            candidate for candidate in tasks
            if candidate.get("id") not in done
            and stage_by_id.get(candidate.get("id"), {}).get("status") == "active"
        ),
        None,
    ) or next(
        (candidate for candidate in tasks if candidate.get("id") in ready),
        None,
    ) or next(
        (candidate for candidate in tasks if candidate.get("id") not in done),
        None,
    )
    if frontier is None:
        return None
    run_state = load_json(run_state_path(root), default={})
    is_task_level = bool(run_state.get("base_main_sha"))
    key = _active_story_key(root)
    task_id = frontier.get("id")
    stage = stage_by_id.get(task_id, {})

    if is_task_level and stage.get("status") == "done":
        return "await-merge", frontier

    if not _task_contract_complete(frontier):
        return "author-contract", frontier

    grill_path = evidence_path(root, key, f"grills/tasks/{task_id}.json")
    grill = load_json(grill_path, default={})
    plan_state = _task_plan_state(root, frontier, grill)
    if plan_state == "author-task-plan":
        return plan_state, frontier
    if not _task_grill_fresh(root, frontier, grill):
        return "grill", frontier
    if plan_state != "approved":
        return plan_state, frontier
    state = "delegate" if stage.get("status") == "active" else "stage-start"
    return state, frontier


def require_task_worktree(root: Path, *, allow_completed: bool = False) -> None:
    """Bind task-level actions to the worktree recorded by `task start`."""
    state = load_json(run_state_path(root), default={})
    task_id = state.get("task_id")
    # task_id is the task-level marker `forge task start` sets; a story-level run
    # carries `branch` (from intake) but no task_id and must not be gated here.
    if not (isinstance(task_id, str) and task_id):
        return
    branch = state.get("branch")
    if not (isinstance(branch, str) and branch):
        raise SystemExit(
            "task worktree pointer names a task_id without a branch — "
            "re-run `./forge task start`"
        )
    proc = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=root, capture_output=True, text=True, env=clean_git_env(),
        encoding="utf-8", errors="surrogateescape",
    )
    current_branch = proc.stdout.strip() if proc.returncode == 0 else ""
    frontier = task_frontier_state(root)
    frontier_id = frontier[1].get("id") if frontier else None
    stage = next((stage for stage in load_json(
        git_control_dir(root) / "stages.json", default={}
    ).get("stages", []) if stage.get("id") == task_id), {})
    completed = stage.get("status") == "done"
    task_matches = frontier_id == task_id or (allow_completed and completed)
    if current_branch != branch or not task_matches:
        raise SystemExit(
            "task worktree required: expected "
            f"branch {branch!r} at frontier {task_id!r}, found "
            f"branch {current_branch or '<detached>'!r} at frontier "
            f"{frontier_id or 'none'!r}"
        )


def require_ready_task(
    root: Path, task_id: str, *, require_approval: bool = True,
    allow_completed: bool = False, require_grill: bool = True,
) -> dict:
    """Require the JIT execution contract and its fresh, passing grill."""
    tasks = load_json(
        protected_decomposition_state_path(root), default={}
    ).get("tasks", [])
    task = next(
        (candidate for candidate in tasks if candidate.get("id") == task_id),
        None,
    )
    if task is None:
        raise SystemExit(
            f"{task_id!r} is not a task in the protected decomposition."
        )

    tasks_all, stage_by_id, done = _task_schedule(root)
    stage = stage_by_id.get(task_id, {})
    completed = stage.get("status") == "done"
    if not (allow_completed and completed):
        other_active = next(
            (
                other_id for other_id, other in stage_by_id.items()
                if other_id != task_id and other.get("status") == "active"
            ),
            None,
        )
        if other_active is not None:
            raise SystemExit(
                f"{task_id} cannot start while {other_active} is active; "
                "one task runs at a time — finish it "
                f"(`./forge stage done {other_active}`) first."
            )
        if task_id not in ready_task_ids(tasks_all, done):
            waiting = [
                d for d in task_dependencies(tasks_all, task_id) if d not in done
            ]
            raise SystemExit(
                f"{task_id} is not ready: waiting on "
                f"{', '.join(waiting) or 'nothing'}; tasks start only once their "
                "dependencies are done (a task without explicit dependencies "
                "follows its predecessor)."
            )

    for field in _TASK_CONTRACT_FIELDS:
        value = task.get(field)
        if not value or (isinstance(value, str) and not value.strip()):
            raise SystemExit(
                f"{task_id} task contract is incomplete: {field} is empty. "
                "Author the JIT contract and re-record it with "
                "`python3 factory/scripts/record_decomposition_from_json.py "
                f"--input <json>`. `forge delegate {task_id} --read-only` "
                "remains available for exploration only."
            )

    treeish = ""
    if allow_completed and completed:
        from forge_cli.stages import stage_baseline
        treeish = stage_baseline(root, stage)
    key = _active_story_key(root)
    grill = load_json(
        evidence_path(root, key, f"grills/tasks/{task_id}.json"), default={},
    )
    if require_approval and _task_plan_state(root, task, grill) == "author-task-plan":
        raise SystemExit(
            f"Task plan required first: author {task_id} in plan mode, then run "
            f"`./forge task plan save {task_id} --from <path>`."
        )
    if require_grill:
        require_task_grill(root, task_id, task, treeish=treeish)
    if require_approval:
        plan_state = _task_plan_state(root, task, grill)
        if plan_state == "await-approval":
            raise SystemExit(
                f"Task plan approval required: a human must approve the current "
                f"{task_id} plan with `./forge task approve {task_id} --by \"<name>\"`."
            )
    return task


def task_seal_shared_problems(root: Path, issue_key: str) -> list[str]:
    """Predicates shared by task sealing and story closeout readiness."""
    from forge_cli.assumptions import blocking_for_issue
    from forge_cli.quickfix import _lite_product_files, load_active, profile_of
    from forge_cli.signal import open_signals
    from forge_cli.stages import product_tree_snapshot

    problems: list[str] = []
    signals = open_signals(root)
    if signals:
        ids = ", ".join(f"{signal['id']} ({signal['kind']})" for signal in signals)
        problems.append(
            f"resolution of {len(signals)} open worker signal(s): {ids} — "
            "`forge.py signal resolve <id> --notes ...`"
        )
    window = load_active(root)
    if window:
        profile = profile_of(window)
        closer = "quickfix done" if profile == "quickfix" else "mode done"
        problems.append(
            f"closure of {profile} window {window['id']} ({window['reason']}) — "
            f"`forge.py {closer}`"
        )
    assumptions = blocking_for_issue(root, issue_key) if issue_key else []
    if assumptions:
        ids = ", ".join(f"{row['id']} ({row['status']})" for row in assumptions)
        problems.append(
            f"orchestrator guidance on {len(assumptions)} assumption(s): {ids} — "
            "resolve via `forge.py assumptions resolve <id> "
            "--status confirmed|promoted --notes ...`"
        )
    dirty_product = _lite_product_files(
        root, list(product_tree_snapshot(root).get("dirty", {})),
    )
    if dirty_product:
        problems.append(
            "clean product worktree and index: staged or unstaged product changes "
            f"remain ({', '.join(dirty_product[:5])})"
        )
    return problems


def require_task_sealed(root: Path, task_id: str) -> dict:
    """Require the approved, reviewed, committed seal for one completed task."""
    from forge_cli.stages import _require_reviewed_commit, load_stages

    state = load_json(run_state_path(root), default={})
    bound_task = state.get("task_id")
    if bound_task:
        # `forge task start` mode: the worktree is bound to a specific task_id;
        # enforce that binding and the worktree pointer.
        if bound_task != task_id:
            raise SystemExit(
                f"task worktree required: this worktree is bound to "
                f"{bound_task!r}, not {task_id!r}"
            )
        require_task_worktree(root, allow_completed=True)
    # Stage-based mode (no task_id in the run pointer, e.g. the task ran via
    # `forge stage start` on the story branch): there is no task-bound worktree,
    # so the seal is proven by the done stage + reviewed commit gate below
    # rather than a worktree pointer.
    task = require_ready_task(root, task_id, allow_completed=True)
    stage = next(
        (candidate for candidate in load_stages(root).get("stages", [])
         if candidate.get("id") == task_id),
        None,
    )
    if not stage or stage.get("status") != "done":
        raise SystemExit(f"task {task_id} is not sealed: stage status must be done")
    _require_reviewed_commit(root, stage, task)
    issue_key = state.get("issue_key") or state.get("story") or ""
    problems = task_seal_shared_problems(root, issue_key)
    if problems:
        raise SystemExit("Task not PR ready:\n- " + "\n- ".join(problems))
    return task


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
        encoding="utf-8", errors="surrogateescape",
    )
    if proc.returncode != 0:
        return [f"<commit {stamp[:8]} unknown to this repo>"]
    return [f for f in proc.stdout.splitlines() if f.startswith(prefixes)]


def read_hook_input() -> dict[str, Any]:
    raw = read_stdin_utf8().strip()
    if not raw:
        return {}
    return json.loads(raw)


def read_stdin_utf8() -> str:
    """Read process input as strict UTF-8, independent of the host locale."""
    stream = getattr(sys, "stdin")
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        # Imported/test hosts may supply an already-decoded StringIO. There
        # are no bytes left whose encoding this helper could choose.
        return stream.read()
    wrapper = io.TextIOWrapper(buffer, encoding="utf-8", errors="strict")
    try:
        return wrapper.read()
    finally:
        wrapper.detach()


def branch_name(root: Path | None = None) -> str:
    out = subprocess.run(["git", "branch", "--show-current"], cwd=root or repo_root(), check=True, capture_output=True, text=True, encoding="utf-8")
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
    # Decode captured child output as UTF-8 explicitly, matching the UTF-8 the
    # factory scripts now force on their own stdout/stderr. Without this the
    # parent falls back to the ANSI code page (cp1252 on Windows) when invoked
    # directly without PYTHONUTF8, so a check that emits a non-Latin-1 glyph or
    # a non-ASCII repo filename decodes to mojibake — or raises UnicodeDecodeError
    # on a byte cp1252 leaves undefined — aborting verify before evidence lands.
    # errors="replace" degrades a stray byte instead of crashing.
    proc = subprocess.run(command, cwd=cwd or repo_root(), shell=True,
                          capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    return {
        "command": command,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
