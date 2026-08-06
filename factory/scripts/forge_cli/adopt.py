"""forge adopt — vendor the harness into an EXISTING repo (migration path).

Run FROM the harness clone, targeting a repo that predates the harness (a
prototype built with agents, an early client repo). Harness-owned machinery
is copied in; project content is never destroyed: the target must be clean so
every overwrite is a reviewable git diff, pre-existing AGENTS.md/CLAUDE.md
are preserved into docs/context/ for harvest, and project-owned files are
created only where missing. Content mapping (what is prototype, what is
context, what becomes the BRIEF) is judgment — the knacklabs-migrate-project skill
drives that afterwards.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path

from factory_lib import dump_json, head_sha, now_iso, repo_root

from .common import fail
from .scaffold import (
    COPY_CODEX,
    COPY_WORKFLOWS,
    DISCOVERY_TEMPLATE,
    DOC_CONTRACTS,
    PROJECT_STARTERS,
    PROTOTYPE_README,
    assert_target_destination,
    assert_target_file_destination,
    check_record_origin_writable,
    ensure_jsonl_attributes,
    ensure_record_origin,
)
from .upgrade import UPGRADE_TREES

# Harness-owned files: replaced outright (visible in the diff).
OWNED_FILES = ["forge", "WORKFLOW.md"]
# Files an agent-built repo often already has: existing content is saved to
# docs/context/migrated-<name> (harvest picks it up), then the harness
# version is written.
MERGE_FILES = ["AGENTS.md", "CLAUDE.md"]


def _vendor_tree_files(src: Path):
    """Yield the files a merged tree vendor dereferences and copies."""
    for current, dirnames, filenames in os.walk(src, followlinks=True):
        dirnames[:] = [name for name in dirnames if name != "__pycache__"]
        for name in filenames:
            path = Path(current) / name
            if path.suffix != ".pyc" and path.is_file():
                yield path


def _preflight_adopt(harness: Path, target: Path, name: str) -> None:
    """Validate every possible destination before adopt's first mutation."""
    def directory(dst: Path) -> None:
        assert_target_destination(target, dst)

    def file(dst: Path) -> None:
        assert_target_destination(target, dst.parent)
        assert_target_file_destination(target, dst)

    def vendor_tree(rel: str) -> None:
        src = harness / rel
        if not src.exists():
            return
        directory(target / rel)
        for path in _vendor_tree_files(src):
            file(target / path.relative_to(harness))

    for tree in UPGRADE_TREES + [".claude"]:
        vendor_tree(tree)
    for rel in COPY_WORKFLOWS:
        file(target / rel)
    for rel in COPY_CODEX:
        file(target / ".codex" / rel)
    for sub in ("agents", "skills"):
        vendor_tree(f".codex/{sub}")
    for rel in OWNED_FILES:
        file(target / rel)
    for src_rel, dst_rel in DOC_CONTRACTS:
        if (harness / src_rel).exists():
            file(target / dst_rel)

    context_dir = target / "docs" / "context"
    for rel in MERGE_FILES:
        dst = target / rel
        src_text = (harness / rel).read_text()
        if rel == "AGENTS.md":
            src_text = src_text.replace("Symphony Forge", name, 1)
        variant = next(
            (path for path in target.iterdir()
             if path.is_file() and path.name.lower() == rel.lower()
             and path.name != rel),
            None,
        )
        # Mirror the adoption sequence so every destination it will touch is
        # validated BEFORE the first mutation. A variant without a canonical is
        # renamed to dst, so dst's effective content becomes the variant's — the
        # `migrated-{rel}` backup then depends on the variant, not on dst, which
        # does not exist yet at preflight time.
        effective = dst
        if variant is not None:
            file(variant)
            canonical_exists = any(path.name == rel for path in target.iterdir())
            if canonical_exists:
                directory(context_dir)
                file(context_dir / f"migrated-{variant.name}")
            else:
                file(dst)
                effective = variant
        if effective.exists() and effective.read_text() != src_text:
            directory(context_dir)
            file(context_dir / f"migrated-{rel}")
        file(dst)

    file(target / "constitution" / "VENDORED_FROM")
    file(target / "constitution" / "VENDOR_MANIFEST.json")

    def ensure(rel: str) -> None:
        dst = target / rel
        if not dst.exists():
            file(dst)

    ensure("harness.yaml")
    gitignore = target / ".gitignore"
    if (not gitignore.exists()
            or ".gstack/sessions/" not in gitignore.read_text()):
        file(gitignore)
    envrc = target / ".envrc"
    if not envrc.exists() or "GSTACK_HOME" not in envrc.read_text():
        file(envrc)
    # The helper decides whether content is missing, so treat its destination
    # as a possible append and validate it before any earlier write can occur.
    file(target / ".gitattributes")
    brief = target / "docs" / "product" / "BRIEF.md"
    if (harness / "harness" / "nestjs-react" / "BRIEF_TEMPLATE.md").exists() \
            and not brief.exists():
        directory(brief.parent)
        file(brief)
    ensure("docs/product/DISCOVERY.md")
    ensure("prototype/README.md")
    for rel in PROJECT_STARTERS:
        ensure(rel)
    file(target / "README.md")
    for sub in ("active", "completed", "debt"):
        plan_dir = target / "plans" / sub
        if not plan_dir.exists():
            directory(plan_dir)
            file(plan_dir / ".gitkeep")
    for rel in ("docs/decisions", "docs/architecture", "docs/context",
                "docs/specs", "docs/memory"):
        directory(target / rel)
    run_json = target / ".factory" / "run.json"
    if not run_json.exists():
        directory(target / ".factory" / "reviews")
        file(run_json)
    check_record_origin_writable(target)


def cmd_adopt(args: argparse.Namespace) -> None:
    harness = repo_root()
    target = Path(args.target).resolve()
    if not (target / ".git").exists():
        fail(f"{target} is not a git repo — adopt needs history so overwrites are reviewable")
    if target == harness:
        fail("run adopt FROM the harness clone TARGETING the existing repo, not itself")
    if (target / "factory" / "scripts" / "forge.py").exists():
        fail(f"{target} already carries the harness — use `./forge upgrade --target {target}`")
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=target, capture_output=True, text=True
    )
    if status.returncode != 0:
        fail(f"`git status` failed in {target} ({status.stderr.strip() or 'unknown error'}) — "
             "adopt needs a healthy repo so overwrites are recoverable.")
    if status.stdout.strip():
        fail(
            f"{target} has uncommitted changes. Commit everything first — adopt "
            "overwrites harness-owned paths and the diff must be reviewable."
        )
    name = args.name or target.name
    _preflight_adopt(harness, target, name)

    overwritten: list[str] = []

    def vendor_file(src: Path, dst: Path) -> None:
        dst = assert_target_file_destination(target, dst)
        if dst.exists():
            overwritten.append(str(dst.relative_to(target)))
        assert_target_destination(target, dst.parent).mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    def vendor_tree(rel: str) -> None:
        src = harness / rel
        if not src.exists():
            return
        assert_target_destination(target, target / rel)
        for path in _vendor_tree_files(src):
            vendor_file(path, target / path.relative_to(harness))

    # Machinery trees are MERGED per file, not replaced wholesale — an existing
    # repo's own .claude/skills/ must survive. (.claude is not in
    # UPGRADE_TREES anymore — upgrade replaces it surgically — but adopt's
    # per-file vendor is merge-safe, so the whole tree is fine here.)
    for tree in UPGRADE_TREES + [".claude"]:
        vendor_tree(tree)
    # .github is not a machinery tree (mixed ownership): vendor only the harness
    # factory workflows, so the repo's own workflows (CI, deployment) survive.
    for rel in COPY_WORKFLOWS:
        vendor_file(harness / rel, target / rel)
    for rel in COPY_CODEX:
        vendor_file(harness / ".codex" / rel, target / ".codex" / rel)
    for sub in ("agents", "skills"):
        vendor_tree(f".codex/{sub}")
    for rel in OWNED_FILES:
        vendor_file(harness / rel, target / rel)
    for src_rel, dst_rel in DOC_CONTRACTS:
        if (harness / src_rel).exists():
            vendor_file(harness / src_rel, target / dst_rel)

    # Pre-existing agent instructions are context, not garbage: preserve them
    # where the harvester will find them, then install the harness versions.
    preserved: list[str] = []
    context_dir = target / "docs" / "context"
    for rel in MERGE_FILES:
        dst = target / rel
        # Repos often carry a case-variant (agents.md, claude.md). Normalize
        # to the canonical name FIRST — writing through the variant leaves
        # the contract invisible on case-sensitive systems (found on the
        # knacklabs-ats migration). On case-insensitive filesystems the
        # rename is the same file changing case; on case-sensitive ones a
        # coexisting variant is preserved to context and removed.
        variant = next(
            (p for p in target.iterdir()
             if p.is_file() and p.name.lower() == rel.lower() and p.name != rel),
            None,
        )
        if variant is not None:
            canonical_exists = any(p.name == rel for p in target.iterdir())
            if canonical_exists:
                assert_target_destination(target, context_dir).mkdir(
                    parents=True, exist_ok=True)
                keep = assert_target_file_destination(
                    target, context_dir / f"migrated-{variant.name}")
                shutil.copy2(variant, keep)
                preserved.append(str(keep.relative_to(target)))
                assert_target_file_destination(target, variant).unlink()
            else:
                assert_target_file_destination(target, variant).rename(
                    assert_target_file_destination(target, dst))
        src_text = (harness / rel).read_text()
        if rel == "AGENTS.md":
            src_text = src_text.replace("Symphony Forge", name, 1)
        if dst.exists() and dst.read_text() != src_text:
            assert_target_destination(target, context_dir).mkdir(
                parents=True, exist_ok=True)
            keep = assert_target_file_destination(
                target, context_dir / f"migrated-{rel}")
            shutil.copy2(dst, keep)
            preserved.append(str(keep.relative_to(target)))
        assert_target_file_destination(target, dst).write_text(src_text)

    commit = head_sha(harness) or "unknown"
    assert_target_file_destination(
        target, target / "constitution" / "VENDORED_FROM").write_text(
        f"symphony-forge @ {commit}\nUpdate by re-vendoring from the harness repo; do not edit in place.\n"
    )
    # Freeze the gate surface: the manifest is what check_vendor_integrity.py
    # (and the pr_ready gate) compare against until the next vendoring.
    from check_vendor_integrity import write_manifest
    assert_target_file_destination(
        target, target / "constitution" / "VENDOR_MANIFEST.json")
    write_manifest(target, commit)

    # Project-owned: created only where missing, never overwritten.
    created: list[str] = []

    def ensure(rel: str, text: str) -> None:
        dst = target / rel
        if not dst.exists():
            assert_target_destination(target, dst.parent).mkdir(
                parents=True, exist_ok=True)
            assert_target_file_destination(target, dst).write_text(text)
            created.append(rel)

    if not (target / "harness.yaml").exists():
        # Blank the sign-off pin: the adopting project has signed nothing off,
        # and must not inherit the harness repo's own gate.
        assert_target_file_destination(target, target / "harness.yaml").write_text(
            re.sub(r"^signoff_record:.*$", 'signoff_record: ""',
                   (harness / "harness.yaml").read_text(), count=1, flags=re.MULTILINE)
        )
        created.append("harness.yaml")
    if not (target / ".gitignore").exists():
        shutil.copy2(
            harness / ".gitignore",
            assert_target_file_destination(target, target / ".gitignore"),
        )
        created.append(".gitignore")
    elif ".gstack/sessions/" not in (target / ".gitignore").read_text():
        with assert_target_file_destination(
                target, target / ".gitignore").open("a") as fh:
            fh.write("\n# Project-local gstack store: projects/ committed, machine noise not\n"
                     ".gstack/sessions/\n.gstack/analytics/\n.gstack/cdp-profile/\n"
                     ".gstack/tmp/\n.gstack/.*\n.gstack/**/brain-cache/\n"
                     ".gstack/**/timeline.jsonl\n.gstack/slug-cache/\n")
        created.append(".gitignore (gstack entries appended)")
    envrc = target / ".envrc"
    if not envrc.exists():
        shutil.copy2(harness / ".envrc", assert_target_file_destination(target, envrc))
        created.append(".envrc (run `direnv allow` in the repo)")
    elif "GSTACK_HOME" not in envrc.read_text():
        # Existing repos commonly carry their own .envrc — append, don't skip,
        # or gstack keeps writing to ~/.gstack despite the documented setup.
        with assert_target_file_destination(target, envrc).open("a") as fh:
            fh.write('\n# symphony-forge: project-local gstack store\n'
                     'export GSTACK_HOME="$PWD/.gstack"\n')
        created.append(".envrc (GSTACK_HOME appended; re-run `direnv allow`)")
    assert_target_file_destination(target, target / ".gitattributes")
    if ensure_jsonl_attributes(target, harness):
        created.append(".gitattributes (missing JSONL merge rules added)")
    brief_src = harness / "harness" / "nestjs-react" / "BRIEF_TEMPLATE.md"
    if brief_src.exists() and not (target / "docs" / "product" / "BRIEF.md").exists():
        brief_dir = assert_target_destination(target, target / "docs" / "product")
        brief_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            brief_src,
            assert_target_file_destination(target, brief_dir / "BRIEF.md"),
        )
        created.append("docs/product/BRIEF.md")
    ensure("docs/product/DISCOVERY.md", DISCOVERY_TEMPLATE.format(name=name))
    ensure("prototype/README.md", PROTOTYPE_README)
    for rel in PROJECT_STARTERS:
        ensure(rel, (harness / rel).read_text())
    # Devs land on the README first: tell them the repo is harness-run and
    # that starting is conversational — append, never rewrite (project-owned).
    from .scaffold import ensure_onboarding
    assert_target_file_destination(target, target / "README.md")
    if ensure_onboarding(target, name):
        created.append("README.md ('Working in this repo — Symphony Forge' section appended)")
    for sub in ("active", "completed", "debt"):
        plan_dir = target / "plans" / sub
        if not plan_dir.exists():
            assert_target_destination(target, plan_dir).mkdir(
                parents=True, exist_ok=True)
            assert_target_file_destination(target, plan_dir / ".gitkeep").touch()
    for rel in ("docs/decisions", "docs/architecture", "docs/context",
                "docs/specs", "docs/memory"):
        assert_target_destination(target, target / rel).mkdir(
            parents=True, exist_ok=True)
    if not (target / ".factory" / "run.json").exists():
        assert_target_destination(target, target / ".factory" / "reviews").mkdir(
            parents=True, exist_ok=True)
        dump_json(
            assert_target_file_destination(target, target / ".factory" / "run.json"),
            {"project": name, "created_at": now_iso()},
        )
        created.append(".factory/run.json")
    if ensure_record_origin(target):
        created.append(".factory/record-origin.json")

    print(f"Adopted the harness into {target} (symphony-forge @ {commit[:8]})")
    if overwritten:
        head = ", ".join(sorted(overwritten)[:8])
        more = f" (+{len(overwritten) - 8} more)" if len(overwritten) > 8 else ""
        print(f"Overwrote {len(overwritten)} pre-existing file(s): {head}{more} — review with git diff")
    if preserved:
        print("Preserved for harvest: " + ", ".join(preserved))
        print("  ^ these carry the project's EXISTING STANDARDS — replacement is not "
              "disposal. Every rule in them must be REHOMED, not archived: "
              "project standards -> docs/architecture/<topic>-standards.md (+ a "
              "decision naming them law), gotchas -> forge lesson add, rules the "
              "vendored constitution now covers -> dropped WITH a citation. The "
              "context ledger records where each rule went.")
    if created:
        print("Created (project-owned): " + ", ".join(created))
    print("Next (the knacklabs-migrate-project skill walks all of this):")
    print("  1. git diff — review every overwrite; merge old .gitignore/CI entries if needed")
    print("  2. Sort existing content: prototype work -> prototype/, raw notes -> docs/context/")
    print("  3. ./forge context scan, then harvest into DISCOVERY.md/BRIEF.md and decisions")
    print("  4. REHOME the migrated-* standards (see above) — no rule may end up homeless")
    print("  5. Linters + gate tests, commit, then: ./forge next")
