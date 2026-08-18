"""forge init — scaffold a new client repo from the harness."""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path

from factory_lib import dump_json, head_sha, now_iso, repo_root

from .common import fail

COPY_TREES = ["factory", "constitution", "harness"]
HARNESS_OWNED_SKILLS = ("forge",)
COPY_CLAUDE = ("CLAUDE.md", "settings.json")
INIT_COPY_TREES = [
    *COPY_TREES,
    ".codex/agents",
    *(f"{runtime}/skills/{skill}"
      for runtime in (".claude", ".codex")
      for skill in HARNESS_OWNED_SKILLS),
]
# .github/workflows/ is MIXED ownership: only these generic factory workflows
# are harness-owned and vendored. A client repo's own workflows (deployment,
# release, etc.) are project-owned — copied file-by-file so we never clobber or
# leak them (init) and never delete them (upgrade rmtree'd the whole tree).
COPY_WORKFLOWS = [
    ".github/workflows/factory-scaffold.yml",
    ".github/workflows/gardener.yml",
    ".github/workflows/harness-health.yml",
    ".github/workflows/roadmap-gate.yml",
]
COPY_CODEX = ["config.toml", "explore.config.toml", "hooks.json"]  # + agents/ and skills/ dirs
COPY_FILES = ["harness.yaml", ".gitignore", ".gitattributes", ".envrc",
              "WORKFLOW.md", "CLAUDE.md", "forge", "forge.cmd"]
DOC_CONTRACTS = [
    ("docs/product/README.md", "docs/product/README.md"),
    ("docs/architecture/README.md", "docs/architecture/README.md"),
    ("docs/decisions/README.md", "docs/decisions/README.md"),
    ("docs/FACTORY.md", "docs/FACTORY.md"),
    ("docs/QUALITY.md", "docs/QUALITY.md"),
    ("docs/ROLES.md", "docs/ROLES.md"),
    ("docs/harness-philosophy.md", "docs/harness-philosophy.md"),
    ("docs/degraded-mode.md", "docs/degraded-mode.md"),
    ("docs/windows.md", "docs/windows.md"),
    ("docs/context/README.md", "docs/context/README.md"),
    ("docs/specs/README.md", "docs/specs/README.md"),
]

GENERATED_FILES = ["AGENTS.md", "docs/product/BRIEF.md", "docs/product/DISCOVERY.md",
                   "prototype/README.md", ".factory/run.json",
                   "constitution/VENDORED_FROM", "constitution/VENDOR_MANIFEST.json"]
PROJECT_STARTERS = [
    "docs/memory/MEMORY.md",
    "docs/memory/factory-entry-contract.md",
]


def _would_write(root: Path, target: Path) -> list[Path]:
    """Every file cmd_init creates or OVERWRITES. Append/touch destinations
    (README.md, plans/**/.gitkeep) live in APPEND_OR_TOUCH and mkdir-only
    dirs in ENSURED_DIRS — _collisions preflights those too, just with
    existence allowed. Keep in sync with the copy loops in cmd_init."""
    dests: list[Path] = []
    for tree in INIT_COPY_TREES:
        src = root / tree
        if src.exists():
            for f in src.rglob("*"):
                if f.is_file() and "__pycache__" not in f.parts and f.suffix != ".pyc":
                    dests.append(target / f.relative_to(root))
    for rel in [*(f".claude/{n}" for n in COPY_CLAUDE
                  if (root / ".claude" / n).exists()), *COPY_WORKFLOWS,
                *(f".codex/{n}" for n in COPY_CODEX),
                *COPY_FILES, *(dst for _, dst in DOC_CONTRACTS), *GENERATED_FILES,
                *PROJECT_STARTERS]:
        dests.append(target / rel)
    return dests


# Init appends, touches, or creates these only when absent: an existing regular
# file is legal, but a symlink (or symlink/file ancestor) would write outside
# the target or die midway, so they still join the preflight.
APPEND_OR_TOUCH = ["README.md", ".factory/record-origin.json",
                   "plans/active/.gitkeep",
                   "plans/completed/.gitkeep", "plans/debt/.gitkeep"]
# mkdir-only destinations with no enumerated leaf file: an existing dir is
# fine, but a file or symlink there would abort init midway.
ENSURED_DIRS = [".factory/reviews"]


def remediate_windows_hook_entry(target: Path) -> None:
    """Repair Windows hook prerequisites after a scaffold flow completes."""
    from .doctor import _platform_name

    if _platform_name() != "windows":
        return

    from .doctor import (
        HOOK_HEALTH_FIX,
        HOOK_SHELL_FIX,
        _existing_hook_shell,
        _python_status,
        _remediate_windows_prerequisites,
        fast_hook_status,
    )

    ok, detail = fast_hook_status(target)
    if ok:
        return

    _remediate_windows_prerequisites(
        install_git=_existing_hook_shell(dict(os.environ)) is None,
        install_python=not _python_status()[0],
    )
    ok, detail = fast_hook_status(target)
    if not ok:
        guidance = HOOK_SHELL_FIX if "sh is not on PATH" in detail else HOOK_HEALTH_FIX
        print(f"[RED] Windows hook check: {detail}")
        print(f"      fix: {guidance}")


def _collisions(root: Path, target: Path) -> list[str]:
    """Paths in target that init would overwrite or write through. A symlink
    component (copy would escape the target) or a file where a directory is
    needed (copy would die midway) is a collision too — checked without
    following symlinks, so dangling links still count."""
    found: set[str] = set()

    def bad_ancestor(rel: Path) -> bool:
        node = target
        for part in rel.parts[:-1]:
            node = node / part
            if node.is_symlink() or (node.exists() and not node.is_dir()):
                found.add(str(node.relative_to(target)))
                return True
        return False

    for dest in _would_write(root, target):
        rel = dest.relative_to(target)
        if not bad_ancestor(rel) and (dest.is_symlink() or dest.exists()):
            found.add(str(rel))
    # Any pre-existing file inside the manifest-covered gate trees would be
    # hashed into constitution/VENDOR_MANIFEST.json by write_manifest and
    # blessed as trusted — refuse them all, colliding or not. Other trees
    # stay per-file: unrelated content there is preserved, never vendored.
    from check_vendor_integrity import GATE_TREES
    for tree in GATE_TREES:
        tdir = target / tree
        if tdir.is_symlink() or (tdir.exists() and not tdir.is_dir()):
            found.add(tree)
        elif tdir.is_dir():
            for f in tdir.rglob("*"):
                if f.is_symlink() or not f.is_dir():
                    found.add(str(f.relative_to(target)))
    for rel_s in APPEND_OR_TOUCH:
        rel = Path(rel_s)
        dest = target / rel
        if not bad_ancestor(rel) and (
            dest.is_symlink() or (dest.exists() and not dest.is_file())
        ):
            found.add(str(rel))
    for rel_s in ENSURED_DIRS:
        rel = Path(rel_s)
        dest = target / rel
        if not bad_ancestor(rel) and (
            dest.is_symlink() or (dest.exists() and not dest.is_dir())
        ):
            found.add(str(rel))
    return sorted(found)


DISCOVERY_TEMPLATE = """# Discovery — {name}

Phase 0a. Lightweight on purpose: no .factory ceremony until client sign-off.

## Problem
<!-- What hurts, for whom, observed where? -->

## Stakeholders
<!-- Client-side names and roles; who signs off? -->

## Client-approved decisions
<!-- Each becomes docs/decisions/NNNN-<slug>.md via: ./forge decision new <slug> -->
- [ ]

## Prototype notes (phase 0b)
<!-- What was shown, what the client said, what changed. -->
"""

PROTOTYPE_README = """# Prototype — preserved reference

The phase-0b prototype that earned client sign-off lives here permanently:
code, screenshots, and walkthrough notes. It is the record of what the client
saw and approved, and the UX reference when the UI/UX evolves later.

Rules:
- **Reference forever, imported never.** Production code must not import,
  link, or build anything from this directory.
- Do not "clean it up" to production standards — its value is fidelity to
  what was approved, not code quality.
- When a future UI/UX change is discussed, start here: what did the client
  originally react to, and which decision records came out of it?
"""

# Appended to the target's root README by init/adopt/upgrade (append-if-
# missing — the README is project-owned). The heading doubles as the
# idempotency marker. Prompt-first on purpose: devs talk to the agent; they
# never need to memorize commands.
ONBOARDING_HEADING = "## Working in this repo — Symphony Forge"
ONBOARDING_SECTION = f"""
{ONBOARDING_HEADING}

This repo runs on the [Symphony Forge](https://github.com/knacklabs/symphony-forge)
engineering harness: agents do the mechanical work, deterministic gates keep
the evidence honest, and humans make the decisions. Getting started is
conversational — open an agent session (Claude Code or Codex) in the repo
root, then:

- **The session checks your machine every time.** If tools are missing it
  says so on the spot — reply "set up my machine" and approve the installs;
  only logins stay manual.
- **Ask "what now?" whenever you are unsure.** The harness answers with the
  current phase and the exact next step. There is nothing to memorize.
- **Every feature starts with a plan the agent must defend.** Product writes
  require plan mode and an approved plan, or an explicit five-file quickfix;
  planned work then runs stage by stage with a local review
  before every commit, and shipping refuses until the evidence gates pass.
- **The map:** `AGENTS.md` is the contract and read order, `WORKFLOW.md` the
  doctrine, `docs/product/BRIEF.md` what this product is. Standards that are
  law live in `docs/architecture/` and `docs/decisions/`.
- **Humans own** accepting decisions, client sign-off, and merging PRs —
  agents draft and relay, never run those.

The vendored harness machinery (`factory/`, `constitution/`, gate scripts)
is frozen: never edit it here — improvements go to the harness repo and
arrive by re-vendoring.
"""


def ensure_onboarding(target: Path, name: str) -> bool:
    """Append the onboarding section to the target README (create if absent).
    Returns True when something was written — idempotent via the heading."""
    readme = assert_target_destination(target, target / "README.md")
    if not readme.exists():
        readme.write_text(f"# {name}\n{ONBOARDING_SECTION}", encoding="utf-8")
        return True
    if ONBOARDING_HEADING in readme.read_text(encoding="utf-8"):
        return False
    with readme.open("a", encoding="utf-8") as fh:
        fh.write(f"\n{ONBOARDING_SECTION}")
    return True


def ensure_jsonl_attributes(target: Path, harness: Path) -> bool:
    """Add missing harness attribute rules without replacing project rules.

    Only `merge=union` rules ship. These used to be `merge=jsonl-append`, a
    driver registered per clone by the SessionStart hook — so scaffolding wrote
    a rule into a client repo that depended on a hook having run on whatever
    machine merged it. When the driver was absent the rule was inert; when it
    was present it hung, and the merge blocked forever instead of failing.
    The POSIX `forge` launcher is also pinned to LF so Git Bash can execute it
    after a Windows checkout.
    """
    destination = assert_target_file_destination(target, target / ".gitattributes")
    if not destination.exists():
        shutil.copy2(harness / ".gitattributes", destination)
        return True
    current = destination.read_text(encoding="utf-8")
    required = [
        line for line in (harness / ".gitattributes").read_text(encoding="utf-8").splitlines()
        if "merge=union" in line or line == "forge text eol=lf"
    ]
    missing = [line for line in required if line not in current.splitlines()]
    if not missing:
        return False
    with destination.open("a", encoding="utf-8") as handle:
        handle.write("\n" + "\n".join(missing) + "\n")
    return any("merge=union" in line for line in missing)


def record_origin_path(target: Path) -> Path:
    return target / ".factory" / "record-origin.json"


def assert_target_destination(target: Path, dst: Path) -> Path:
    """Return dst when it resolves inside target; refuse every other path.

    Containment uses resolve(strict=False), which follows symlinks and `..`
    through dst's existing prefix — a `..` inside a missing tail can still land
    back on a real in-target symlink, so a purely lexical check is unsafe. A
    symlink LOOP is caught separately: resolve(strict=False) stopped raising on
    loops in 3.13+, so the deepest ancestor that IS on disk is resolved STRICTLY,
    which still raises on a loop or unreadable link on every Python version.
    """
    resolved_target = target.resolve()
    base = dst
    while True:
        try:
            base.lstat()  # a real dir-entry (incl. a symlink) stops the walk;
            break          # lstat does not follow the final component itself
        except OSError:
            if base == base.parent:
                break
            base = base.parent
    loop = False
    try:
        base.resolve(strict=True)  # raises on a symlink loop / unreadable link
    except FileNotFoundError:
        # A dangling symlink's referent is simply missing — that is NOT a loop,
        # and it may resolve inside the target (a legal config symlink whose file
        # copy2 will create). resolve(strict=False) below judges its containment.
        pass
    except (OSError, RuntimeError):
        loop = True  # ELOOP or an unreadable link
    if loop:
        resolved_dst = None
    else:
        try:
            resolved_dst = dst.resolve(strict=False)
        except (OSError, RuntimeError):
            resolved_dst = None
    if resolved_dst is None:
        fail(f"refusing destination with an unresolvable symlink: {dst}")
    elif not resolved_dst.is_relative_to(resolved_target):
        fail(f"refusing destination outside the target: {dst}")
    return dst


def assert_target_file_destination(target: Path, dst: Path) -> Path:
    """assert_target_destination for a destination a FILE is written to.

    Also refuses an existing NON-FILE (a directory or special file), because
    shutil.copy2 treats a directory dst as a CONTAINER — it writes dst/<src
    name>, so a crafted directory holding an outward symlink there escapes even
    though dst itself resolves inside. A symlink dst is judged by where it
    RESOLVES: assert_target_destination already refuses one pointing outside,
    while an in-target symlink to an in-target file is legal (copy2 follows it
    and writes inside the target — a real config-symlink upgrade path).

    Scope (decision 0028): this closes the SYMLINK path-boundary class — a
    destination or ancestor symlink, a `..` traversal, or a crafted directory
    that resolves or writes outside the target. Two DEEPER classes are
    deliberately out of scope and deferred to a follow-up story, not defended
    here (they are pre-existing and need a different I/O model, not a path check):
      - HARD LINK inode-aliasing: a regular file hard-linked to an inode outside
        the target — no path escapes, but copy2 truncates the shared inode.
      - TOCTOU races: a concurrent writer swapping a validated path for an
        outward symlink between this check and the write. Closing either needs
        unlink-before-write / descriptor-relative (openat, O_NOFOLLOW) I/O across
        all three commands, replacing shutil's path-based copytree/copy2.
    """
    assert_target_destination(target, dst)
    if dst.exists() and not dst.is_file():
        fail(f"refusing a file destination that is a directory or special file: {dst}")
    return dst


def check_record_origin_writable(target: Path) -> None:
    """Reject a marker path that would write outside the target or is not a
    regular file. Called in a caller's preflight so an adopt/init never fails
    HALFWAY on a bad path — and never lands another repo's history boundary
    through a symlinked `.factory` (the repository-escape class, D-0003)."""
    marker = record_origin_path(target)
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        fail(f"refusing invalid record-origin path: {marker}")
    assert_target_destination(target, marker)


def ensure_record_origin(target: Path) -> bool:
    """Record where Forge's committed project history begins, once.

    Only when there is no Forge record yet. A repo adopted by an earlier Forge
    version already has committed events but no marker: stamping one now at HEAD
    would count that Forge history as "preceding the record" — the board would
    claim the record begins after work it can already display. The origin is
    then unknowable, so the honest act is to leave it unclaimed, not to invent
    a boundary that contradicts the timeline.
    """
    marker = record_origin_path(target)
    check_record_origin_writable(target)
    if marker.exists():
        return False
    events = target / ".factory" / "events.jsonl"
    if events.is_file() and events.read_text(encoding="utf-8").strip():
        return False  # a Forge record already exists; its origin predates now
    # A shallow clone counts only its local commits, so rev-list would report a
    # truncated number the marker then claims forever. An honest boundary must
    # not persist a count it cannot trust: record null (unknown) instead, and
    # the board omits the count rather than stating a false one.
    shallow = subprocess.run(
        ["git", "rev-parse", "--is-shallow-repository"],
        cwd=target, capture_output=True, text=True, encoding="utf-8",
    )
    is_shallow = shallow.returncode == 0 and shallow.stdout.strip() == "true"
    count = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=target, capture_output=True, text=True, encoding="utf-8",
    )
    # Shallow: count is truncated and unknowable -> null. A repo with no commit
    # yet (rev-list has no HEAD) genuinely has zero preceding -> 0, honest.
    if is_shallow:
        preceding = None
    elif count.returncode == 0:
        preceding = int(count.stdout.strip())
    else:
        preceding = 0
    dump_json(marker, {
        "date": now_iso(),
        "commit": head_sha(target),
        "preceding_commits": preceding,
    })
    return True


def _preflight_copytree(target: Path, src: Path, dst: Path,
                        follow: bool = True) -> None:
    """Validate a merging copy's root and every entry before it can mutate.

    A source FILE's destination is validated as a file destination: copytree's
    own copy2 would treat a crafted directory there as a container and follow a
    symlink out, so a plain boundary check on the nominal path is not enough.
    `follow` MUST match copytree's traversal: True for the dereferencing default
    (symlinks=False), False when source links are preserved (symlinks=True), so
    the walk enumerates exactly the destinations the copy will create.
    """
    assert_target_destination(target, dst)
    for current, dirnames, filenames in os.walk(src, followlinks=follow):
        dirnames[:] = [
            name for name in dirnames
            if name != "__pycache__" and name != ".DS_Store"
            and not name.endswith(".pyc")
        ]
        filenames = [
            name for name in filenames
            if name != ".DS_Store" and not name.endswith(".pyc")
        ]
        relative = Path(current).relative_to(src)
        for name in dirnames:
            assert_target_destination(target, dst / relative / name)
        for name in filenames:
            assert_target_file_destination(target, dst / relative / name)


def guarded_copytree(target: Path, src: Path, dst: Path, *,
                     symlinks: bool = False, **kwargs) -> None:
    """The single audited directory-tree copy: validate every destination entry
    against the boundary (matching copytree's own traversal), then copy. Every
    copytree call routes through here so the anti-reopen scan can REQUIRE it — a
    raw shutil.copytree anywhere else is the regression the scan refuses, because
    its root wrapper alone would not prove the leaves were validated."""
    _preflight_copytree(target, src, dst, follow=not symlinks)
    shutil.copytree(src, assert_target_destination(target, dst),
                    symlinks=symlinks, **kwargs)


def _preflight_init(root: Path, target: Path) -> None:
    """Validate every init destination before the first filesystem mutation."""
    assert_target_destination(target, target)

    for tree in INIT_COPY_TREES:
        src = root / tree
        if src.exists():
            _preflight_copytree(target, src, target / tree)
    for rel in COPY_WORKFLOWS:
        if (root / rel).exists():
            dst = target / rel
            assert_target_destination(target, dst.parent)
            assert_target_file_destination(target, dst)

    # cmd_init creates target/.claude unconditionally; validate that directory
    # destination here, before the first mutation, even if no optional Claude
    # file is present to validate it indirectly.
    assert_target_destination(target, target / ".claude")
    for name in COPY_CLAUDE:
        if (root / ".claude" / name).exists():
            assert_target_file_destination(target, target / ".claude" / name)

    codex = target / ".codex"
    assert_target_destination(target, codex)
    for name in COPY_CODEX:
        assert_target_file_destination(target, codex / name)

    for name in COPY_FILES:
        if (root / name).exists():
            assert_target_file_destination(target, target / name)
    for src_rel, dst_rel in DOC_CONTRACTS:
        if (root / src_rel).exists():
            dst = target / dst_rel
            assert_target_destination(target, dst.parent)
            assert_target_file_destination(target, dst)
    for rel in PROJECT_STARTERS:
        if (root / rel).exists():
            dst = target / rel
            assert_target_destination(target, dst.parent)
            assert_target_file_destination(target, dst)

    for rel in (
        "harness.yaml",
        "constitution/VENDORED_FROM",
        "constitution/VENDOR_MANIFEST.json",
        "docs/product/DISCOVERY.md",
        "prototype/README.md",
        ".factory/run.json",
        "AGENTS.md",
        "README.md",
    ):
        assert_target_file_destination(target, target / rel)

    brief_dst = target / "docs" / "product" / "BRIEF.md"
    assert_target_destination(target, brief_dst.parent)
    if (root / "harness" / "nestjs-react" / "BRIEF_TEMPLATE.md").exists():
        assert_target_file_destination(target, brief_dst)
    for rel in (
        "docs/decisions",
        "docs/architecture",
        "docs/specs",
        "prototype",
        "plans/active",
        "plans/completed",
        "plans/debt",
        ".factory/reviews",
    ):
        assert_target_destination(target, target / rel)
    for sub in ("active", "completed", "debt"):
        assert_target_file_destination(target, target / "plans" / sub / ".gitkeep")

    git_dir = target / ".git"
    if not git_dir.exists():
        assert_target_destination(target, git_dir)
    check_record_origin_writable(target)


def cmd_init(args: argparse.Namespace) -> None:
    root = repo_root()
    target = Path(args.target or args.name).resolve()
    if target.exists() and any(target.iterdir()) and not args.force:
        collisions = _collisions(root, target)
        if collisions:
            listing = "\n  ".join(collisions[:10])
            more = f"\n  ... and {len(collisions) - 10} more" if len(collisions) > 10 else ""
            fail(
                f"target {target} already contains {len(collisions)} path(s) forge init "
                f"would overwrite or write through:\n  {listing}{more}\n"
                "use --force to overwrite them."
            )
    _preflight_init(root, target)
    assert_target_destination(target, target).mkdir(parents=True, exist_ok=True)

    # Same rule as upgrade's VENDOR_IGNORE: build and OS noise never vendors.
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")
    for tree in INIT_COPY_TREES:
        src = root / tree
        if src.exists():
            # Default symlinks=False MATERIALIZES the trusted source content
            # guarded_copytree dereferences trusted source content into the
            # boundary-checked destination and validates every leaf; symlinks=True
            # would recreate an outward source link as an escape (0028).
            guarded_copytree(target, src, target / tree,
                             dirs_exist_ok=True, ignore=ignore)
    assert_target_destination(target, target / ".claude").mkdir(exist_ok=True)
    for name in COPY_CLAUDE:
        src = root / ".claude" / name
        if src.exists():  # a source without an optional harness file is legal
            dst = target / ".claude" / name
            shutil.copy2(src, assert_target_file_destination(target, dst))
    for rel in COPY_WORKFLOWS:
        src = root / rel
        if src.exists():
            dst = target / rel
            assert_target_destination(target, dst.parent).mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, assert_target_file_destination(target, dst))
    assert_target_destination(target, target / ".codex").mkdir(exist_ok=True)
    for name in COPY_CODEX:
        dst = target / ".codex" / name
        shutil.copy2(root / ".codex" / name, assert_target_file_destination(target, dst))
    for name in COPY_FILES:
        src = root / name
        if src.exists():
            shutil.copy2(src, assert_target_file_destination(target, target / name))
    for src_rel, dst_rel in DOC_CONTRACTS:
        src = root / src_rel
        if src.exists():
            dst = target / dst_rel
            assert_target_destination(target, dst.parent).mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, assert_target_file_destination(target, dst))
    for rel in PROJECT_STARTERS:
        src = root / rel
        if src.exists():
            dst = target / rel
            assert_target_destination(target, dst.parent).mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, assert_target_file_destination(target, dst))

    # A new client has signed nothing off: clear the harness's own sign-off pin
    # so a scaffold cannot inherit THIS project's gate. (harness.yaml is
    # project-owned and deliberately OUTSIDE the frozen-gate manifest, which
    # covers factory/{scripts,schemas,prompts} + forge + .claude/settings.json,
    # so signing off later never shows up as gate drift.)
    manifest_yaml = target / "harness.yaml"
    if manifest_yaml.exists():
        assert_target_destination(target, manifest_yaml).write_text(
            re.sub(r"^signoff_record:.*$", 'signoff_record: ""',
                   manifest_yaml.read_text(encoding="utf-8"), count=1, flags=re.MULTILINE), encoding="utf-8"
        )

    # Pin the vendored constitution to its source commit.
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True, encoding="utf-8"
        ).stdout.strip()
    except subprocess.CalledProcessError:
        commit = "unknown"
    assert_target_destination(target, target / "constitution" / "VENDORED_FROM").write_text(
        f"symphony-forge @ {commit}\nUpdate by re-vendoring from the harness repo; do not edit in place.\n", encoding="utf-8"
    )
    # Freeze the gate surface from birth (frozen-gate-integrity): the manifest
    # is what check_vendor_integrity.py compares against until the next vendoring.
    from check_vendor_integrity import write_manifest
    assert_target_destination(target, target / "constitution" / "VENDOR_MANIFEST.json")
    write_manifest(target, commit)

    brief_src = root / "harness" / "nestjs-react" / "BRIEF_TEMPLATE.md"
    brief_dst = target / "docs" / "product" / "BRIEF.md"
    assert_target_destination(target, brief_dst.parent).mkdir(parents=True, exist_ok=True)
    if brief_src.exists():
        shutil.copy2(brief_src, assert_target_file_destination(target, brief_dst))
    assert_target_destination(target, target / "docs" / "product" / "DISCOVERY.md").write_text(
        DISCOVERY_TEMPLATE.format(name=args.name), encoding="utf-8"
    )
    assert_target_destination(
        target, target / "docs" / "decisions"
    ).mkdir(parents=True, exist_ok=True)
    assert_target_destination(
        target, target / "docs" / "architecture"
    ).mkdir(parents=True, exist_ok=True)
    assert_target_destination(target, target / "docs" / "specs").mkdir(parents=True, exist_ok=True)
    assert_target_destination(target, target / "prototype").mkdir(parents=True, exist_ok=True)
    assert_target_destination(
        target, target / "prototype" / "README.md"
    ).write_text(PROTOTYPE_README, encoding="utf-8")
    for sub in ("active", "completed", "debt"):
        plan_dir = target / "plans" / sub
        assert_target_destination(target, plan_dir).mkdir(parents=True, exist_ok=True)
        assert_target_destination(target, plan_dir / ".gitkeep").touch()
    assert_target_destination(
        target, target / ".factory" / "reviews"
    ).mkdir(parents=True, exist_ok=True)
    dump_json(
        assert_target_destination(target, target / ".factory" / "run.json"),
        {"project": args.name, "created_at": now_iso()},
    )

    agents_md = (root / "AGENTS.md").read_text(encoding="utf-8").replace("Symphony Forge", args.name, 1)
    assert_target_destination(target, target / "AGENTS.md").write_text(agents_md, encoding="utf-8")
    ensure_onboarding(target, args.name)

    if not (target / ".git").exists():
        assert_target_destination(target, target / ".git")
        subprocess.run(["git", "init", "-q"],
                       cwd=assert_target_destination(target, target), check=True)
    ensure_record_origin(target)

    print(f"Scaffolded {args.name} at {target}")
    print("Next steps:")
    print("  0. cd in and run `direnv allow` (once per machine) — pins gstack "
         "output into the repo's .gstack/, not ~/.gstack")
    print("  1. Fill docs/product/DISCOVERY.md (phase 0a) and BRIEF.md")
    print("  2. Prototype; save and confirm specs, then derive the roadmap")
    print("  3. Grill sign-off, accept `client-signoff --by <name>`, then: "
          "python3 factory/scripts/record_signoff.py")
    print(f"  4. Generate the {args.stack} workspace via harness/{args.stack}/SCAFFOLD_PROMPT.md")
    remediate_windows_hook_entry(target)
