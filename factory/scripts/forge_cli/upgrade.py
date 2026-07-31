"""forge upgrade — re-vendor harness machinery into an existing client repo.

Run FROM the harness clone, targeting the client repo (mirrors `forge init`).
Replaces machinery the harness owns; never touches project-owned content.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from factory_lib import (
    SIGNOFF_KEY, canonical_signoff_path, head_sha, insert_signoff_pin,
    load_json, repo_root,
)

from .common import fail
from .scaffold import (
    COPY_CODEX, COPY_WORKFLOWS, DOC_CONTRACTS, PROJECT_STARTERS,
    ensure_jsonl_attributes,
)

# Harness-owned: replaced wholesale on upgrade.
UPGRADE_TREES = ["factory", "constitution", "harness"]
UPGRADE_FILES = ["forge", "CLAUDE.md", "WORKFLOW.md"]
# .claude is MIXED ownership: client repos legitimately carry their own
# skills, agents, launch.json, and settings.local.json (standard Claude Code
# surfaces — see the thin-adapter linter). Upgrade replaces ONLY the paths
# the harness ships and never deletes client additions; retiring a
# harness-shipped path is an explicit upgrade note, not an rmtree side
# effect. Same rule for .codex/agents and .codex/skills below.
CLAUDE_HARNESS_OWNED = ["CLAUDE.md", "settings.json", "skills/forge"]
# Project-owned: never touched — listed here as the explicit contract.
# .github/workflows/ is project-owned EXCEPT the harness's own COPY_WORKFLOWS,
# which are refreshed file-by-file below — the rest of the tree (deployment,
# release, etc.) is left exactly as the project has it.
PROJECT_OWNED = [
    "harness.yaml", "AGENTS.md", ".factory/", "plans/", "prototype/",
    "docs/product/", "docs/decisions/", "docs/architecture/", "docs/context/",
    "docs/specs/", "docs/memory/",
    ".github/ (except the harness factory workflows)",
    ".claude/ and .codex/ additions the harness does not ship (project skills, agents, launch.json)",
]
# Preserved across the factory replacement (project evolution state).
PRESERVE_IN_AGENTS = ["factory/skills/proposed", "factory/skills/rejected"]
# Vendoring never ships build noise.
VENDOR_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc")


def _replace_path(src: Path, dst: Path) -> None:
    if dst.is_dir() and not dst.is_symlink():
        shutil.rmtree(dst)
    elif dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, ignore=VENDOR_IGNORE)
    else:
        shutil.copy2(src, dst)


def cmd_upgrade(args: argparse.Namespace) -> None:
    harness = repo_root()
    target = Path(args.target).resolve()
    if not (target / ".git").exists() or not (target / "AGENTS.md").exists():
        fail(f"{target} does not look like a scaffolded repo (.git + AGENTS.md required)")
    if target == harness:
        fail("run upgrade FROM the harness clone TARGETING a client repo, not itself")
    dirty = subprocess.run(
        ["git", "status", "--porcelain"], cwd=target, capture_output=True, text=True
    ).stdout.strip()
    if dirty and not args.force:
        fail(
            f"{target} has uncommitted changes. Commit or stash first so the upgrade "
            "is a reviewable diff (--force to override)."
        )

    preserved: dict[str, Path] = {}
    keep_root = Path(tempfile.mkdtemp(prefix="forge-upgrade-keep-"))
    # factory/skills is mixed ownership too: the `skills` CLI installs
    # project skills there (skills-lock.json repos like knacklabs-ats carry
    # a dozen). Preserve every child the harness does not ship, plus the
    # evolution dirs (proposed/rejected — client's version always wins).
    client_skill_dirs: list[str] = []
    target_skills = target / "factory" / "skills"
    harness_skill_names = {p.name for p in (harness / "factory" / "skills").iterdir()} \
        if (harness / "factory" / "skills").is_dir() else set()
    if target_skills.is_dir():
        for child in target_skills.iterdir():
            rel = f"factory/skills/{child.name}"
            if child.name not in harness_skill_names and rel not in PRESERVE_IN_AGENTS:
                client_skill_dirs.append(rel)
    for rel in PRESERVE_IN_AGENTS + client_skill_dirs:
        src = target / rel
        if src.exists():
            dest = keep_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)
            preserved[rel] = dest

    for tree in UPGRADE_TREES:
        src = harness / tree
        if not src.exists():
            continue
        dst = target / tree
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=VENDOR_IGNORE)
    # .claude is mixed ownership: replace only harness-shipped paths; the
    # client's own skills/agents/launch.json survive untouched.
    for rel in CLAUDE_HARNESS_OWNED:
        src = harness / ".claude" / rel
        if src.exists():
            _replace_path(src, target / ".claude" / rel)
    # .github/workflows/ is mixed ownership: refresh only the harness's own
    # factory workflows, file-by-file, so the project's other workflows survive.
    for rel in COPY_WORKFLOWS:
        src = harness / rel
        if src.exists():
            dst = target / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    (target / ".codex").mkdir(exist_ok=True)
    for name in COPY_CODEX:
        shutil.copy2(harness / ".codex" / name, target / ".codex" / name)
    # Same mixed-ownership rule: refresh each harness-shipped agent/skill
    # entry; leave client-added ones alone.
    for sub in ("agents", "skills"):
        src = harness / ".codex" / sub
        if src.is_dir():
            for child in src.iterdir():
                _replace_path(child, target / ".codex" / sub / child.name)
    for name in UPGRADE_FILES:
        src = harness / name
        if src.exists():
            shutil.copy2(src, target / name)
    for src_rel, dst_rel in DOC_CONTRACTS:
        src = harness / src_rel
        if src.exists():
            dst = target / dst_rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    for rel, kept in preserved.items():
        dst = target / rel
        if dst.is_dir():
            shutil.rmtree(dst)
        elif dst.exists():
            dst.unlink()
        dst.parent.mkdir(parents=True, exist_ok=True)
        if kept.is_dir():
            shutil.copytree(kept, dst)
        else:
            shutil.copy2(kept, dst)
    shutil.rmtree(keep_root, ignore_errors=True)

    # Newer harness additions that older scaffolds predate: create-if-missing /
    # append-if-missing (never overwrite — projects may extend these files).
    ensured: list[str] = []
    if not (target / ".envrc").exists():
        shutil.copy2(harness / ".envrc", target / ".envrc")
        ensured.append(".envrc (run `direnv allow` in the repo)")
    if ensure_jsonl_attributes(target, harness):
        ensured.append(".gitattributes (missing JSONL merge rules added)")

    # Sign-off moved from a per-worktree run.json flag to a committed
    # harness.yaml pin. A project that signed off under the old scheme keeps
    # its project-owned harness.yaml (no key) and its old run.json, so carry
    # the attestation across rather than silently un-signing the project.
    manifest_yaml = target / "harness.yaml"
    if (manifest_yaml.exists() and not manifest_yaml.is_symlink()
            and not SIGNOFF_KEY.search(manifest_yaml.read_text())):
        legacy = load_json(target / ".factory" / "run.json", default={})
        carried = (legacy.get("client_signoff_record", "")
                   if legacy.get("client_signoff") else "")
        # Persist the CANONICAL path, never run.json's spelling: run.json is
        # gitignored, per-worktree, ungoverned state, and a value there can
        # resolve to a valid record yet be absolute (machine-specific) or carry
        # quotes/newlines that inject YAML into harness.yaml.
        #
        # NO inference from the decision corpus when it is missing: an accepted
        # client-signoff record is not evidence that sign-off HAPPENED (it can
        # be committed before record_signoff.py ever succeeds, and the required
        # grill leaves no committed trace). Absent legacy state stays unsigned,
        # which is exactly what the old scheme did in a fresh clone.
        carried = canonical_signoff_path(target, carried) if carried else ""
        manifest_yaml.write_text(
            insert_signoff_pin(manifest_yaml.read_text(), carried)
        )
        ensured.append(
            "harness.yaml signoff_record pin ("
            + (carried or "EMPTY — pin it with record_signoff.py [--record <path>]")
            + ")"
        )
    from .scaffold import ensure_onboarding
    if ensure_onboarding(target, target.name):
        ensured.append("README.md ('Working in this repo' onboarding section appended)")
    gitignore = target / ".gitignore"
    if gitignore.exists() and ".gstack/sessions/" not in gitignore.read_text():
        with gitignore.open("a") as fh:
            fh.write("\n# Project-local gstack store: projects/ committed, machine noise not\n"
                     ".gstack/sessions/\n.gstack/analytics/\n.gstack/cdp-profile/\n"
                     ".gstack/tmp/\n.gstack/.*\n.gstack/**/brain-cache/\n"
                     ".gstack/**/timeline.jsonl\n.gstack/slug-cache/\n")
        ensured.append(".gitignore (gstack entries appended)")
    for rel in PROJECT_STARTERS:
        destination = target / rel
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(harness / rel, destination)
            ensured.append(rel)

    commit = head_sha(harness) or "unknown"
    (target / "constitution" / "VENDORED_FROM").write_text(
        f"symphony-forge @ {commit}\nUpdate by re-vendoring from the harness repo; do not edit in place.\n"
    )
    # Re-freeze the gate surface at the new vendoring (frozen-gate-integrity).
    from check_vendor_integrity import write_manifest
    write_manifest(target, commit)

    drift = ""
    if (harness / "harness.yaml").read_text() != (target / "harness.yaml").read_text():
        drift = ("\nNOTE: harness.yaml differs from the harness default (project-owned, "
                 "left untouched) — diff manually if the phase contract changed upstream.")
    print(f"Upgraded {target} to symphony-forge @ {commit[:8]}")
    print("Replaced (harness-owned): "
          + ", ".join(UPGRADE_TREES + UPGRADE_FILES + COPY_WORKFLOWS) + ", doc contracts")
    if ensured:
        print("Added (missing on this older scaffold): " + ", ".join(ensured))
    print("Untouched (project-owned): " + ", ".join(PROJECT_OWNED) + drift)
    print("Next: review with `git diff`, run `python3 factory/scripts/check_dual_runtime.py` "
          "and the gate tests, then commit.")
