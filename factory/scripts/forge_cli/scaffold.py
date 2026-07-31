"""forge init — scaffold a new client repo from the harness."""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
from pathlib import Path

from factory_lib import dump_json, now_iso, repo_root

from .common import fail

COPY_TREES = ["factory", ".claude", "constitution", "harness"]
# .github/workflows/ is MIXED ownership: only these generic factory workflows
# are harness-owned and vendored. A client repo's own workflows (deployment,
# release, etc.) are project-owned — copied file-by-file so we never clobber or
# leak them (init) and never delete them (upgrade rmtree'd the whole tree).
COPY_WORKFLOWS = [
    ".github/workflows/factory-scaffold.yml",
    ".github/workflows/gardener.yml",
    ".github/workflows/harness-health.yml",
]
COPY_CODEX = ["config.toml", "explore.config.toml", "hooks.json"]  # + agents/ and skills/ dirs
COPY_FILES = ["harness.yaml", ".gitignore", ".gitattributes", ".envrc",
              "WORKFLOW.md", "CLAUDE.md", "forge"]
DOC_CONTRACTS = [
    ("docs/product/README.md", "docs/product/README.md"),
    ("docs/architecture/README.md", "docs/architecture/README.md"),
    ("docs/decisions/README.md", "docs/decisions/README.md"),
    ("docs/FACTORY.md", "docs/FACTORY.md"),
    ("docs/QUALITY.md", "docs/QUALITY.md"),
    ("docs/ROLES.md", "docs/ROLES.md"),
    ("docs/harness-philosophy.md", "docs/harness-philosophy.md"),
    ("docs/degraded-mode.md", "docs/degraded-mode.md"),
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
    trees = [*COPY_TREES, ".codex/agents", ".codex/skills"]
    for tree in trees:
        src = root / tree
        if src.exists():
            for f in src.rglob("*"):
                if f.is_file() and "__pycache__" not in f.parts and f.suffix != ".pyc":
                    dests.append(target / f.relative_to(root))
    for rel in [*COPY_WORKFLOWS, *(f".codex/{n}" for n in COPY_CODEX),
                *COPY_FILES, *(dst for _, dst in DOC_CONTRACTS), *GENERATED_FILES,
                *PROJECT_STARTERS]:
        dests.append(target / rel)
    return dests


# init appends/touches these rather than overwriting: an existing regular file
# is legal, but a symlink (or symlink/file ancestor) would write outside the
# target or die midway, so they still join the preflight.
APPEND_OR_TOUCH = ["README.md", "plans/active/.gitkeep",
                   "plans/completed/.gitkeep", "plans/debt/.gitkeep"]
# mkdir-only destinations with no enumerated leaf file: an existing dir is
# fine, but a file or symlink there would abort init midway.
ENSURED_DIRS = [".factory/reviews"]


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
    readme = target / "README.md"
    if not readme.exists():
        readme.write_text(f"# {name}\n{ONBOARDING_SECTION}")
        return True
    if ONBOARDING_HEADING in readme.read_text():
        return False
    with readme.open("a") as fh:
        fh.write(f"\n{ONBOARDING_SECTION}")
    return True


def ensure_jsonl_attributes(target: Path, harness: Path) -> bool:
    """Add missing harness JSONL merge rules without replacing project rules."""
    destination = target / ".gitattributes"
    if not destination.exists():
        shutil.copy2(harness / ".gitattributes", destination)
        return True
    current = destination.read_text()
    required = [
        line for line in (harness / ".gitattributes").read_text().splitlines()
        if "merge=jsonl-append" in line
    ]
    missing = [line for line in required if line not in current.splitlines()]
    if not missing:
        return False
    with destination.open("a") as handle:
        handle.write("\n" + "\n".join(missing) + "\n")
    return True


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
    target.mkdir(parents=True, exist_ok=True)

    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    for tree in COPY_TREES:
        src = root / tree
        if src.exists():
            shutil.copytree(src, target / tree, dirs_exist_ok=True, ignore=ignore)
    for rel in COPY_WORKFLOWS:
        src = root / rel
        if src.exists():
            dst = target / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    (target / ".codex").mkdir(exist_ok=True)
    for name in COPY_CODEX:
        shutil.copy2(root / ".codex" / name, target / ".codex" / name)
    shutil.copytree(root / ".codex" / "agents", target / ".codex" / "agents", dirs_exist_ok=True, ignore=ignore)
    if (root / ".codex" / "skills").is_dir():
        shutil.copytree(root / ".codex" / "skills", target / ".codex" / "skills", dirs_exist_ok=True, ignore=ignore)
    for name in COPY_FILES:
        src = root / name
        if src.exists():
            shutil.copy2(src, target / name)
    for src_rel, dst_rel in DOC_CONTRACTS:
        src = root / src_rel
        if src.exists():
            dst = target / dst_rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    for rel in PROJECT_STARTERS:
        src = root / rel
        if src.exists():
            dst = target / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    # A new client has signed nothing off: clear the harness's own sign-off pin
    # so a scaffold cannot inherit THIS project's gate. (harness.yaml is
    # project-owned and deliberately OUTSIDE the frozen-gate manifest, which
    # covers factory/{scripts,schemas,prompts} + forge + .claude/settings.json,
    # so signing off later never shows up as gate drift.)
    manifest_yaml = target / "harness.yaml"
    if manifest_yaml.exists():
        manifest_yaml.write_text(
            re.sub(r"^signoff_record:.*$", 'signoff_record: ""',
                   manifest_yaml.read_text(), count=1, flags=re.MULTILINE)
        )

    # Pin the vendored constitution to its source commit.
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
        ).stdout.strip()
    except subprocess.CalledProcessError:
        commit = "unknown"
    (target / "constitution" / "VENDORED_FROM").write_text(
        f"symphony-forge @ {commit}\nUpdate by re-vendoring from the harness repo; do not edit in place.\n"
    )
    # Freeze the gate surface from birth (frozen-gate-integrity): the manifest
    # is what check_vendor_integrity.py compares against until the next vendoring.
    from check_vendor_integrity import write_manifest
    write_manifest(target, commit)

    brief_src = root / "harness" / "nestjs-react" / "BRIEF_TEMPLATE.md"
    brief_dst = target / "docs" / "product" / "BRIEF.md"
    brief_dst.parent.mkdir(parents=True, exist_ok=True)
    if brief_src.exists():
        shutil.copy2(brief_src, brief_dst)
    (target / "docs" / "product" / "DISCOVERY.md").write_text(
        DISCOVERY_TEMPLATE.format(name=args.name)
    )
    (target / "docs" / "decisions").mkdir(parents=True, exist_ok=True)
    (target / "docs" / "architecture").mkdir(parents=True, exist_ok=True)
    (target / "docs" / "specs").mkdir(parents=True, exist_ok=True)
    (target / "prototype").mkdir(parents=True, exist_ok=True)
    (target / "prototype" / "README.md").write_text(PROTOTYPE_README)
    for sub in ("active", "completed", "debt"):
        plan_dir = target / "plans" / sub
        plan_dir.mkdir(parents=True, exist_ok=True)
        (plan_dir / ".gitkeep").touch()
    (target / ".factory" / "reviews").mkdir(parents=True, exist_ok=True)
    dump_json(
        target / ".factory" / "run.json",
        {"project": args.name, "created_at": now_iso()},
    )

    agents_md = (root / "AGENTS.md").read_text().replace("Symphony Forge", args.name, 1)
    (target / "AGENTS.md").write_text(agents_md)
    ensure_onboarding(target, args.name)

    if not (target / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=target, check=True)

    print(f"Scaffolded {args.name} at {target}")
    print("Next steps:")
    print("  0. cd in and run `direnv allow` (once per machine) — pins gstack "
         "output into the repo's .gstack/, not ~/.gstack")
    print("  1. Fill docs/product/DISCOVERY.md (phase 0a) and BRIEF.md")
    print("  2. Prototype; save and confirm specs, then derive the roadmap")
    print("  3. Grill sign-off, accept `client-signoff --by <name>`, then: "
          "python3 factory/scripts/record_signoff.py")
    print(f"  4. Generate the {args.stack} workspace via harness/{args.stack}/SCAFFOLD_PROMPT.md")
