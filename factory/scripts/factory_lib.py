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
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def git_control_dir(root: Path) -> Path:
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
        or Path(top.stdout.strip()).resolve() != root.resolve()
    ):
        raise SystemExit(
            "Cannot resolve Git's protected control directory for factory state."
        )
    return Path(proc.stdout.strip()) / "forge"


def protected_decomposition_state_path(root: Path) -> Path:
    return git_control_dir(root) / "decomposition.json"


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
        path = review_dir(root) / f"{aspect}.json"
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


def require_skills(root: Path, name: str, payload: dict) -> None:
    """Feature-type skill enforcement (same trust model as generated_by):
    when the recorded decomposition says user_facing, the artifact must
    ATTEST the phase's mandatory skills in skills_used. Advisory skills are
    listed too when used, but only the required set gates."""
    schema = json.loads(schema_path(root, name).read_text(encoding="utf-8"))
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
    root: Path,
    task_id: str,
    task: dict,
) -> None:
    """Require a passing grill bound to the current grounding inputs."""
    path = factory_dir(root) / "grills" / "tasks" / f"{task_id}.json"
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
    if data.get("input_sha256") != grounding_digest(root, task):
        raise SystemExit(
            f"the {task_id} task grill is STALE — its grounding inputs changed. "
            f"Re-grill and record `{record_command}`; --task-digest was removed "
            "because the digest is derived from the protected contract, approved "
            "plan, and product tree."
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


def product_tree_digest(root: Path) -> str:
    """Hash the deterministic index blob list, excluding workflow-only paths."""
    proc = subprocess.run(
        ["git", "ls-files", "--stage", "-z"],
        cwd=root,
        capture_output=True,
        text=True,
        env=clean_git_env(),
        encoding="utf-8",
        errors="surrogateescape",
    )
    if proc.returncode != 0:
        raise SystemExit(
            "cannot derive the task grounding digest from the Git index: "
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
        blobs.append((path, fields[1]))
    payload = json.dumps(sorted(blobs), separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def grounding_digest(root: Path, task: dict) -> str:
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
            "product_tree_sha256": product_tree_digest(root),
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
    return bool(
        grill.get("verdict") == "pass"
        and grill.get("commit")
        and grill.get("input_sha256") == grounding_digest(root, task)
    )


def task_rows(root: Path) -> list[dict]:
    """Derive every live task row from the same inputs as frontier routing."""
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
    for task in tasks:
        task_id = task.get("id")
        stage = stage_by_id.get(task_id, {})
        grill = load_json(
            factory_dir(root) / "grills" / "tasks" / f"{task_id}.json",
            default={},
        )
        fresh = _task_grill_fresh(root, task, grill) if grill else False
        status = stage.get("status")
        if status == "done":
            state = "done"
        elif status == "active":
            state = "active"
        elif not _task_contract_complete(task):
            state = "skeleton"
        else:
            state = "grilled" if fresh else "ready"

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


def task_frontier_state(root: Path) -> tuple[str, dict] | None:
    """Return the next JIT action and earliest unfinished task, without raising."""
    tasks = load_json(
        protected_decomposition_state_path(root), default={}
    ).get("tasks", [])
    stages = load_json(git_control_dir(root) / "stages.json", default={})
    stage_by_id = {
        stage.get("id"): stage
        for stage in stages.get("stages", [])
        if isinstance(stage, dict)
    }
    frontier = next(
        (
            candidate
            for candidate in tasks
            if stage_by_id.get(candidate.get("id"), {}).get("status") != "done"
        ),
        None,
    )
    if frontier is None:
        return None
    task_id = frontier.get("id")

    if not _task_contract_complete(frontier):
        return "author-contract", frontier

    grill = load_json(
        factory_dir(root) / "grills" / "tasks" / f"{task_id}.json",
        default={},
    )
    if _task_grill_fresh(root, frontier, grill):
        stage = stage_by_id.get(task_id, {})
        state = "delegate" if stage.get("status") == "active" else "stage-start"
        return state, frontier
    return "grill", frontier


def require_ready_task(root: Path, task_id: str) -> dict:
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

    frontier_state = task_frontier_state(root)
    if frontier_state is None or frontier_state[1].get("id") != task_id:
        frontier_id = frontier_state[1].get("id") if frontier_state else "none"
        raise SystemExit(
            f"{task_id} is not the earliest unfinished task ({frontier_id}); "
            "finish tasks in decomposition order."
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

    require_task_grill(root, task_id, task)
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
