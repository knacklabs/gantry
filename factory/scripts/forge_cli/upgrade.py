"""forge upgrade — re-vendor harness machinery into an existing client repo.

Run FROM the harness clone, targeting the client repo (mirrors `forge init`).
Replaces machinery the harness owns; never touches project-owned content.
"""
from __future__ import annotations

import argparse
import json
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
    COPY_CLAUDE, COPY_CODEX, COPY_WORKFLOWS, DOC_CONTRACTS,
    HARNESS_OWNED_SKILLS, PROJECT_STARTERS,
    assert_target_destination,
    assert_target_file_destination,
    ensure_jsonl_attributes,
    guarded_copytree,
)

# Harness-owned: replaced wholesale on upgrade.
UPGRADE_TREES = ["factory", "constitution", "harness"]
UPGRADE_FILES = ["forge", "forge.cmd", "CLAUDE.md", "WORKFLOW.md"]
# .claude is MIXED ownership: client repos legitimately carry their own
# skills, agents, launch.json, and settings.local.json (standard Claude Code
# surfaces — see the thin-adapter linter). Upgrade replaces ONLY the paths
# the harness ships and never deletes client additions; retiring a
# harness-shipped path is an explicit upgrade note, not an rmtree side
# effect. Same rule for .codex/agents and .codex/skills below.
CLAUDE_HARNESS_OWNED = [
    *COPY_CLAUDE,
    *(f"skills/{skill}" for skill in HARNESS_OWNED_SKILLS),
]
CODEX_HARNESS_OWNED_SKILLS = tuple(
    f".codex/skills/{skill}" for skill in HARNESS_OWNED_SKILLS
)
# Project-owned: never touched — listed here as the explicit contract.
# .github/workflows/ is project-owned EXCEPT the harness's own COPY_WORKFLOWS,
# which are refreshed file-by-file below — the rest of the tree (deployment,
# release, etc.) is left exactly as the project has it.
PROJECT_OWNED = [
    "harness.yaml", "AGENTS.md", ".factory/", "plans/", "prototype/",
    "docs/product/ (except its README.md doc contract)",
    "docs/decisions/ (except its README.md doc contract)",
    "docs/architecture/ (except its README.md doc contract)",
    "docs/context/ (except its README.md doc contract)",
    "docs/specs/ (except its README.md doc contract)", "docs/memory/",
    ".github/ (except the harness factory workflows)",
    ".claude/ and .codex/ additions the harness does not ship (project skills, agents, launch.json)",
]
# Preserved across the factory replacement (project evolution state).
PRESERVE_IN_AGENTS = ["factory/skills/proposed", "factory/skills/rejected"]
# Ephemeral working state (decision 0025): read from disk in the worktree,
# never from git. Untracked on upgrade — a .gitignore rule alone does nothing
# to an already-tracked file.
EPHEMERAL_UNTRACK = [".factory/briefs/", ".factory/diagnostic-briefs/",
                     ".factory/delegations.jsonl"]
# Must match the marker lines in the harness .gitignore exactly — each is the
# installed-once key for its ignore block below.
EPHEMERAL_MARKER = ("# forge 0025: briefs and the delegation mirror are "
                    "read from disk, never from git")
GSTACK_MARKER = ("# forge gstack: project-local store — projects/ is "
                 "committed, machine noise is not")
GSTACK_RULES = [".gstack/*", "!.gstack/projects/",
                ".gstack/**/brain-cache/", ".gstack/**/timeline.jsonl"]
# Vendoring never ships build or OS noise. .DS_Store is gitignored HERE, so it
# is invisible in this repo while still sitting on disk — and copytree walks
# the filesystem, not the index. It then lands in the client as untracked
# clutter, and inside .claude/ the thin-adapter linter rejects it outright:
# a real upgrade failed check_dual_runtime on a Finder artifact.
VENDOR_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


def _replace_path(target: Path, src: Path, dst: Path) -> None:
    if dst.is_dir() and not dst.is_symlink():
        shutil.rmtree(assert_target_destination(target, dst))
    elif dst.exists() or dst.is_symlink():
        (assert_target_destination(target, dst.parent) / dst.name).unlink()
    assert_target_destination(target, dst.parent).mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        guarded_copytree(target, src, dst, ignore=VENDOR_IGNORE, symlinks=False)
    else:
        shutil.copy2(src, assert_target_file_destination(target, dst))


def _keep_path(keep_root: Path, src: Path, dst: Path) -> None:
    """Copy project-owned state into the temporary preservation tree.

    Symlinks are preserved AS symlinks. Dereferencing would copy the referent's
    bytes into the repo under the link's name — and since retirement then
    deletes the original, a link pointing outside the repo would be silently
    replaced by its target's content."""
    assert_target_destination(keep_root, dst.parent).mkdir(parents=True, exist_ok=True)
    if src.is_dir() and not src.is_symlink():
        guarded_copytree(keep_root, src, dst, dirs_exist_ok=True, symlinks=True)
    else:
        shutil.copy2(
            src, assert_target_file_destination(keep_root, dst),
            follow_symlinks=False,
        )


def _check_legacy_retirable(target: Path, harness: Path) -> None:
    """Refuse BEFORE anything is written, or the repair cannot be run.

    Validation used to sit next to the delete, after the trees were replaced —
    so refusing left a clean repo dirty, and the "delete it and re-run" the
    message asks for was then rejected by the dirty-target gate above. The
    counterparts are knowable in advance: they are the harness's own factory/
    tree, plus everything under skills/, which survives either because the
    harness ships it or because it is preserved out of .agents/skills/ (the
    one exception, a client skill whose name the harness has since taken, is
    deferred as D-0002)."""
    legacy = target / ".agents"
    # Refuse a symlinked ROOT, do not just decline to retire it: every later
    # step reaches through it. `.agents/skills` resolves past the link, so
    # iterdir() would walk an external directory and copy its contents into
    # factory/skills — importing files from outside the repository entirely.
    if legacy.is_symlink():
        fail(
            ".agents is a symlink. The upgrade would migrate skills by reading "
            "through it, pulling content from outside the repository into "
            "factory/skills, and retiring it would drop the link rather than the "
            "machinery. Replace it with a real directory (or remove it) and "
            "re-run. Nothing was written."
        )
    assert_target_destination(target, legacy)
    if not legacy.is_dir():
        return
    # The whole skills/ subtree is exempt from the counterpart check below
    # because a real directory there is either shipped or preserved. Anything
    # ELSE at that path is neither: a symlink cannot be traversed (iterdir()
    # would walk the referent) and a regular file is never preserved at all,
    # so retirement would delete tracked client content that nothing checked.
    # Refuse the topology before any write rather than exempting it.
    skills_root = legacy / "skills"
    if skills_root.is_symlink() or (
            skills_root.exists() and not skills_root.is_dir()):
        fail(
            ".agents/skills is not a directory. The upgrade preserves client "
            "skills only from a real directory there, so retiring .agents/ would "
            "delete this without it ever being checked — and a symlink would be "
            "migrated by reading through it. Replace it with a real directory "
            "(or move it out of .agents/) and re-run. Nothing was written."
        )
    # A legacy skills entry whose name the harness also ships is treated as the
    # machinery being replaced. That cannot be decided from the paths: an older
    # harness's copy of a skill differs from the current one exactly the way a
    # client's would, and the harness ships factory/skills/forge.md, so
    # refusing every collision would refuse every upgrade. It is not silent
    # either — upgrade refuses a dirty tree, so the replacement lands as a
    # reviewed deletion in the upgrade diff. Conflict policy is D-0002.
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", ".agents"],
        cwd=target, capture_output=True)
    tracked = {
        raw.decode("utf-8", errors="surrogateescape")
        for raw in listing.stdout.split(b"\0") if raw
    }
    missing = []
    for path in sorted(legacy.rglob("*")):
        if not (path.is_file() or path.is_symlink()):
            continue
        rel = path.relative_to(legacy)
        # Vendoring never shipped build noise (VENDOR_IGNORE), so an UNTRACKED
        # .pyc has no counterpart by construction — counting it would abort the
        # upgrade on every real pre-rename repo, which all carry __pycache__
        # from having actually run the machinery. A TRACKED .pyc is committed
        # content, not a build artifact, and gets checked like anything else:
        # exempting by suffix alone would delete it on nothing but its name.
        if path.suffix == ".pyc" and f".agents/{rel.as_posix()}" not in tracked:
            continue
        if rel.parts and rel.parts[0] == "skills":
            continue
        counterpart = harness / "factory" / rel
        if not (counterpart.is_file() or counterpart.is_symlink()):
            missing.append(f".agents/{rel.as_posix()}")
    if missing:
        listing = "\n  ".join(missing[:10])
        more = f"\n  ... and {len(missing) - 10} more" if len(missing) > 10 else ""
        fail(
            f"legacy .agents/ holds {len(missing)} path(s) with no counterpart in the "
            f"vendored factory/ tree, so they cannot be shown to be the machinery "
            f"being replaced:\n  {listing}{more}\n"
            "Nothing was written and nothing under .agents/ was deleted. If this is "
            "retired machinery, delete it and re-run; if it is yours, move it "
            "somewhere the harness does not own."
        )


def _retire_legacy_agents(target: Path) -> bool:
    """Delete only. _check_legacy_retirable already refused anything unknown,
    before the first write."""
    legacy = target / ".agents"
    if not legacy.is_dir() or legacy.is_symlink():
        return False
    shutil.rmtree(assert_target_destination(target, legacy))
    return True


def _preflight_upgrade(
    harness: Path, target: Path, preserved: dict[str, Path],
) -> None:
    """Validate every target destination before upgrade's first mutation."""

    def directory(dst: Path) -> None:
        assert_target_destination(target, dst)

    def file(dst: Path) -> None:
        assert_target_destination(target, dst.parent)
        assert_target_file_destination(target, dst)

    def replacement(_src: Path, dst: Path) -> None:
        # _replace_path removes any existing dst (dir, file, or symlink), then
        # copies fresh — so only the root boundary matters here. A per-leaf or
        # file-type check against the PRE-removal state would falsely reject a
        # legal dir<->file type change, or a stale symlink the removal deletes.
        assert_target_destination(target, dst.parent)
        assert_target_destination(target, dst)

    directory(target)
    for tree in UPGRADE_TREES:
        if (harness / tree).exists():
            # Replacement tree: rmtree'd then copied fresh, so validate the root
            # boundary, not the pre-removal leaves (same reason as replacement()).
            directory(target / tree)
    for rel in CLAUDE_HARNESS_OWNED:
        src = harness / ".claude" / rel
        if src.exists():
            replacement(src, target / ".claude" / rel)
    for rel in COPY_WORKFLOWS:
        if (harness / rel).exists():
            file(target / rel)
    directory(target / ".codex")
    for name in COPY_CODEX:
        file(target / ".codex" / name)
    agents = harness / ".codex" / "agents"
    if agents.is_dir():
        for child in agents.iterdir():
            replacement(child, target / ".codex" / "agents" / child.name)
    for rel in CODEX_HARNESS_OWNED_SKILLS:
        src = harness / rel
        if src.exists():
            replacement(src, target / rel)
    for name in UPGRADE_FILES:
        if (harness / name).exists():
            file(target / name)
    for src_rel, dst_rel in DOC_CONTRACTS:
        if (harness / src_rel).exists():
            file(target / dst_rel)

    # These project-owned entries are deliberately preserved as symlinks.
    # Their leaf is removed by the factory root replacement before restoration,
    # so validate the surviving parent boundary here; the restored leaf itself
    # is routed through the helper once that replacement has made it absent.
    for rel in preserved:
        directory((target / rel).parent)

    for rel in (".gitattributes", "README.md", ".gitignore"):
        file(target / rel)
    # .envrc is create-if-missing: an existing one (even a symlink to a valid
    # external file) is left untouched, so only preflight the write case.
    if not (target / ".envrc").exists():
        file(target / ".envrc")
    # harness.yaml is rewritten only when it is a regular non-symlink file; the
    # mutation skips a symlink, so the preflight must not reject one either.
    manifest_yaml = target / "harness.yaml"
    if manifest_yaml.exists() and not manifest_yaml.is_symlink():
        file(manifest_yaml)
    for rel in PROJECT_STARTERS:
        if not (target / rel).exists():
            file(target / rel)
    file(target / "constitution" / "VENDORED_FROM")
    file(target / "constitution" / "VENDOR_MANIFEST.json")


def _is_harness_owned(rel: str, harness: Path) -> bool:
    def within(root: str) -> bool:
        return rel == root or rel.startswith(root + "/")

    if any(within(root) for root in UPGRADE_TREES + [".agents"]):
        return True
    if rel in UPGRADE_FILES or rel in COPY_WORKFLOWS:
        return True
    if rel in {dst for _, dst in DOC_CONTRACTS}:
        return True
    if any(within(f".claude/{path}") for path in CLAUDE_HARNESS_OWNED):
        return True
    if rel in {f".codex/{name}" for name in COPY_CODEX}:
        return True
    for sub in ("agents", "skills"):
        shipped = harness / ".codex" / sub
        if shipped.is_dir() and any(
            within(f".codex/{sub}/{child.name}") for child in shipped.iterdir()
        ):
            return True
    return False


def _indexed_symlinks_naming_legacy(target: Path) -> list[str]:
    """Symlinks whose target names the retired tree.

    `git grep` skips symlink entries, but a symlink's blob IS its target text —
    and a link into .agents/ breaks exactly like a mention of it does. Read the
    blob from the index rather than the working tree, so no link is ever
    followed and no ancestor can redirect the read out of the repository.
    """
    listing = subprocess.run(
        ["git", "ls-files", "-s", "-z"], cwd=target, capture_output=True)
    if listing.returncode != 0:
        return []
    found = []
    for raw in listing.stdout.split(b"\0"):
        metadata, _, rel = raw.partition(b"\t")
        fields = metadata.split()
        if not rel or len(fields) < 2 or fields[0] != b"120000":
            continue
        blob = subprocess.run(
            ["git", "cat-file", "blob", fields[1].decode()],
            cwd=target, capture_output=True)
        if blob.returncode != 0:
            continue
        link = blob.stdout.decode("utf-8", errors="surrogateescape")
        # Whole path component: `legacy-tools -> .agents` has no trailing slash.
        if ".agents" in link.split("/"):
            found.append(rel.decode("utf-8", errors="surrogateescape"))
    return found


def _stale_agents_references(
    target: Path, harness: Path, migrated: list[str] | None = None,
    from_legacy: set[str] | None = None,
) -> list[str]:
    """Project-owned files that still name the retired tree.

    Searched in the INDEX, never through the working tree. Git streams blob
    content and resolves paths itself, so this cannot follow a symlink (at the
    leaf or at any ancestor) out of the repository, cannot wander into an
    ignored node_modules/ or dist/, and cannot allocate a whole large file to
    look for a short marker. A symlink's blob is its target text, so a link
    that merely NAMES .agents is matched like any other content.
    """
    # `.agents/` WITH the separator. A bare `.agents` is a substring of any
    # identifier that merely starts that way — a real target reports
    # `com.agentstats.push` and `day.agents` as stale machinery references,
    # which is noise the human then has to re-triage by hand. A symlink whose
    # target IS the bare root is caught by component match below, so the
    # slashless form buys nothing here.
    search = subprocess.run(
        ["git", "grep", "-l", "--cached", "-I", "-z", "-F", "-e", ".agents/", "--"],
        cwd=target, capture_output=True,
    )
    # 0 = matches, 1 = none. Anything else is a real failure, but this report
    # is advisory and runs after the migration; it must never abort the upgrade.
    if search.returncode not in (0, 1):
        return []
    hits = [
        raw.decode("utf-8", errors="surrogateescape")
        for raw in search.stdout.split(b"\0") if raw
    ]
    hits.extend(_indexed_symlinks_naming_legacy(target))
    # Client skills carried out of .agents/skills/ land at factory/skills/<name>,
    # untracked until the human stages the upgrade. Their INDEXED source is the
    # .agents/skills/ path, so translate the hit to where the file now lives
    # rather than walking the freshly copied tree.
    # ONLY names actually carried out of the legacy tree. A name preserved from
    # the CURRENT location had its legacy twin deliberately skipped (the
    # current location wins), so translating that discarded copy's hits would
    # name a current file that has no stale reference — or none at all.
    carried = from_legacy or set()
    # A client skill ALREADY at factory/skills/<name> is preserved, not
    # replaced — so it is project-owned even though _is_harness_owned sees it
    # inside an UPGRADE_TREES entry and would otherwise discard it. Match the
    # path itself as well as its descendants: a skill can be a single file
    # (factory/skills/client.md) or a symlink, preserved at that exact path.
    owned = set(migrated or [])
    preserved = tuple(f"{rel}/" for rel in owned)
    stale = set()
    for rel in hits:
        if rel.startswith(".factory/history/"):
            continue
        parts = rel.split("/")
        if parts[0] == ".agents":
            # A bare `.agents` path is a regular file or link at that name, not
            # the machinery directory — retirement leaves it in place, so it is
            # surviving project-owned content and belongs in the report.
            if len(parts) == 1:
                stale.add(rel)
                continue
            if len(parts) > 2 and parts[1] == "skills" and parts[2] in carried:
                stale.add("factory/skills/" + "/".join(parts[2:]))
            continue
        if rel not in owned and not rel.startswith(preserved) \
                and _is_harness_owned(rel, harness):
            continue
        stale.add(rel)
    return sorted(stale)


def cmd_upgrade(args: argparse.Namespace) -> None:
    harness = repo_root()
    target = Path(args.target).resolve()
    if not (target / ".git").exists() or not (target / "AGENTS.md").exists():
        fail(f"{target} does not look like a scaffolded repo (.git + AGENTS.md required)")
    if target == harness:
        fail("run upgrade FROM the harness clone TARGETING a client repo, not itself")
    # Refuse before writing: the sign-off carry below reads run.json AFTER the
    # machinery replacement, and a parse crash there leaves a half-upgraded
    # target. Unreadable state must stop the upgrade while it is untouched.
    legacy_run = target / ".factory" / "run.json"
    if legacy_run.exists() or legacy_run.is_symlink():
        try:
            if not isinstance(json.loads(legacy_run.read_text(encoding="utf-8")), dict):
                fail(f"{legacy_run} is not a JSON object; fix or delete it, then rerun")
        except json.JSONDecodeError as exc:
            fail(f"{legacy_run} is unreadable JSON ({exc}); fix or delete it, then rerun")
        except OSError as exc:
            fail(f"{legacy_run} is not a readable file ({exc}); fix or delete it, then rerun")
    dirty = subprocess.run(
        ["git", "status", "--porcelain"], cwd=target, capture_output=True,
        text=True, encoding="utf-8", errors="surrogateescape",
    ).stdout.strip()
    if dirty and not args.force:
        fail(
            f"{target} has uncommitted changes. Commit or stash first so the upgrade "
            "is a reviewable diff (--force to override)."
        )
    _check_legacy_retirable(target, harness)

    # factory/skills is mixed ownership too: the `skills` CLI installs
    # project skills there (skills-lock.json repos like knacklabs-ats carry
    # a dozen). Preserve every child the harness does not ship, plus the
    # evolution dirs (proposed/rejected — client's version always wins).
    client_skill_dirs: list[str] = []
    carried_from_legacy: set[str] = set()
    preserve_sources: dict[str, Path] = {}
    target_skills = target / "factory" / "skills"
    legacy_skills = target / ".agents" / "skills"
    harness_skill_names = {p.name for p in (harness / "factory" / "skills").iterdir()} \
        if (harness / "factory" / "skills").is_dir() else set()
    if target_skills.is_dir():
        for child in target_skills.iterdir():
            rel = f"factory/skills/{child.name}"
            if child.name not in harness_skill_names and rel not in PRESERVE_IN_AGENTS:
                client_skill_dirs.append(rel)
    for rel in PRESERVE_IN_AGENTS + client_skill_dirs:
        src = target / rel
        # exists() is False for a DANGLING symlink, and a client skill can
        # legitimately be one. Without the is_symlink() arm it is never
        # preserved, so replacing factory/ deletes project-owned content.
        if src.exists() or src.is_symlink():
            preserve_sources[rel] = src
    # `is_dir()` follows symlinks: a symlinked skills root would have iterdir()
    # walk an external directory and copy its contents into factory/skills.
    if legacy_skills.is_dir() and not legacy_skills.is_symlink():
        for child in legacy_skills.iterdir():
            rel = f"factory/skills/{child.name}"
            # The current location wins when a name exists in BOTH. Copying the
            # legacy one on top would merge into whatever the first copy left
            # at that destination — and if that was a symlink, through it.
            if rel in preserve_sources:
                continue
            if child.name not in harness_skill_names or rel in PRESERVE_IN_AGENTS:
                preserve_sources[rel] = child
                carried_from_legacy.add(child.name)

    _preflight_upgrade(harness, target, preserve_sources)

    keep_root = Path(tempfile.mkdtemp(prefix="forge-upgrade-keep-"))
    preserved: dict[str, Path] = {}
    for rel, src in preserve_sources.items():
        dest = keep_root / rel
        _keep_path(keep_root, src, dest)
        preserved[rel] = dest

    for tree in UPGRADE_TREES:
        src = harness / tree
        if not src.exists():
            continue
        dst = target / tree
        if dst.exists():
            shutil.rmtree(assert_target_destination(target, dst))
        guarded_copytree(target, src, dst, ignore=VENDOR_IGNORE, symlinks=False)
    # .claude is mixed ownership: replace only harness-shipped paths; the
    # client's own skills/agents/launch.json survive untouched.
    for rel in CLAUDE_HARNESS_OWNED:
        src = harness / ".claude" / rel
        if src.exists():
            _replace_path(target, src, target / ".claude" / rel)
    # .github/workflows/ is mixed ownership: refresh only the harness's own
    # factory workflows, file-by-file, so the project's other workflows survive.
    for rel in COPY_WORKFLOWS:
        src = harness / rel
        if src.exists():
            dst = target / rel
            assert_target_destination(target, dst.parent).mkdir(
                parents=True, exist_ok=True)
            shutil.copy2(src, assert_target_file_destination(target, dst))
    assert_target_destination(target, target / ".codex").mkdir(exist_ok=True)
    for name in COPY_CODEX:
        shutil.copy2(
            harness / ".codex" / name,
            assert_target_file_destination(target, target / ".codex" / name),
        )
    # Same mixed-ownership rule: refresh each harness-shipped agent and each
    # allowlisted harness skill; leave client-added entries alone.
    agents = harness / ".codex" / "agents"
    if agents.is_dir():
        for child in agents.iterdir():
            _replace_path(
                target, child, target / ".codex" / "agents" / child.name)
    for rel in CODEX_HARNESS_OWNED_SKILLS:
        src = harness / rel
        if src.exists():
            _replace_path(target, src, target / rel)
    for name in UPGRADE_FILES:
        src = harness / name
        if src.exists():
            shutil.copy2(
                src, assert_target_file_destination(target, target / name))
    replaced_doc_contracts: list[str] = []
    diverged_doc_contracts: list[str] = []
    for src_rel, dst_rel in DOC_CONTRACTS:
        src = harness / src_rel
        if src.exists():
            dst = target / dst_rel
            replaced_doc_contracts.append(dst_rel)
            if (not dst.is_symlink() and dst.is_file()
                    and dst.read_bytes() != src.read_bytes()):
                diverged_doc_contracts.append(dst_rel)
            assert_target_destination(target, dst.parent).mkdir(
                parents=True, exist_ok=True)
            shutil.copy2(src, assert_target_file_destination(target, dst))

    for rel, kept in preserved.items():
        dst = target / rel
        if dst.is_dir() and not dst.is_symlink():
            shutil.rmtree(assert_target_destination(target, dst))
        elif dst.exists() or dst.is_symlink():
            (assert_target_destination(target, dst.parent) / dst.name).unlink()
        assert_target_destination(target, dst.parent).mkdir(
            parents=True, exist_ok=True)
        # Same symlink rule as _keep_path: a link kept as a link must come back
        # as a link, or the round trip quietly materializes its referent.
        if kept.is_dir() and not kept.is_symlink():
            guarded_copytree(target, kept, dst, symlinks=True)
        else:
            shutil.copy2(
                kept, assert_target_file_destination(target, dst),
                follow_symlinks=False,
            )
    shutil.rmtree(
        assert_target_destination(keep_root, keep_root), ignore_errors=True)

    retired_legacy = _retire_legacy_agents(target)

    # Newer harness additions that older scaffolds predate: create-if-missing /
    # append-if-missing (never overwrite — projects may extend these files).
    ensured: list[str] = []
    if not (target / ".envrc").exists():
        shutil.copy2(
            harness / ".envrc",
            assert_target_file_destination(target, target / ".envrc"),
        )
        ensured.append(".envrc (run `direnv allow` in the repo)")
    if ensure_jsonl_attributes(target, harness):
        ensured.append(".gitattributes (missing JSONL merge rules added)")

    # Sign-off moved from a per-worktree run.json flag to a committed
    # harness.yaml pin. A project that signed off under the old scheme keeps
    # its project-owned harness.yaml (no key) and its old run.json, so carry
    # the attestation across rather than silently un-signing the project.
    manifest_yaml = target / "harness.yaml"
    if (manifest_yaml.exists() and not manifest_yaml.is_symlink()
            and not SIGNOFF_KEY.search(manifest_yaml.read_text(encoding="utf-8"))):
        manifest_yaml = assert_target_file_destination(target, manifest_yaml)
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
            insert_signoff_pin(manifest_yaml.read_text(encoding="utf-8"), carried), encoding="utf-8"
        )
        ensured.append(
            "harness.yaml signoff_record pin ("
            + (carried or "EMPTY — pin it with record_signoff.py [--record <path>]")
            + ")"
        )
    from .scaffold import ensure_onboarding
    if ensure_onboarding(target, target.name):
        ensured.append("README.md ('Working in this repo' onboarding section appended)")
    gitignore = assert_target_file_destination(target, target / ".gitignore")
    # The old blanket `.gstack/` rule hid the COMMITTED projects/ store
    # (WORKFLOW.md: design docs, decisions, learnings) — and git cannot
    # re-include inside an excluded directory, so the corrected block below
    # only takes effect once the blanket line is gone.
    if gitignore.exists():
        kept = [line for line in gitignore.read_text(encoding="utf-8").splitlines(keepends=True)
                if line.strip() != ".gstack/"]
        if "".join(kept) != gitignore.read_text(encoding="utf-8"):
            gitignore.write_text("".join(kept), encoding="utf-8")
            ensured.append(".gitignore (blanket .gstack/ rule removed — it hid "
                           "the committed projects/ store)")
    gstack_text = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    # Exact LINE matches everywhere a marker is consulted: marker text quoted
    # inside a longer comment must not count as an installed block.
    if GSTACK_MARKER not in (line.strip() for line in gstack_text.splitlines()):
        with gitignore.open("a", encoding="utf-8") as fh:
            fh.write(("\n" if gstack_text else "")
                     + GSTACK_MARKER + "\n"
                     + "".join(f"{rule}\n" for rule in GSTACK_RULES))
        ensured.append(".gitignore (gstack block appended)")
    # Decision 0025: briefs and the delegation mirror stay on disk (a running
    # task keeps reading them) but leave the tracked tree. --cached only, so
    # nothing is deleted; the staged untracking rides the client's next commit.
    # Keyed on the marker line, not on rule detection: probing (substring or
    # `git check-ignore`) kept mis-answering — comments, later `!` negations,
    # and machine-local ignore sources (global excludes, .git/info/exclude)
    # all look like installed rules while committing nothing for teammates.
    # The marker exists only where this block was installed (scaffold ships it
    # in .gitignore; upgrade appends it once, creating the file if absent).
    # Appended at the END: a directory rule there is total — git cannot
    # re-include files inside an excluded directory. A client who edits rules
    # under an existing marker has deliberately opted out, and upgrade
    # respects that — including in the untracking below, which touches ONLY
    # paths the committed rules actually ignore. Untracking an opted-back-in
    # path would delete teammates' copies of it on their next pull.
    ignore_text = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    ignore_lines = [line.strip() for line in ignore_text.splitlines()]
    if EPHEMERAL_MARKER not in ignore_lines:
        with gitignore.open("a", encoding="utf-8") as fh:
            fh.write(("\n" if ignore_text else "")
                     + EPHEMERAL_MARKER + "\n"
                     + "".join(f"{rel}\n" for rel in EPHEMERAL_UNTRACK))
        ensured.append(".gitignore (0025 ephemeral paths appended)")
        ignore_lines = [line.strip()
                        for line in gitignore.read_text(encoding="utf-8").splitlines()]
    # Only the marker-owned tail governs, last mention wins: a duplicate
    # positive rule elsewhere in the file must not override an opt-out made
    # under the marker (removing the rule, or negating it below the block).
    marker_tail = ignore_lines[ignore_lines.index(EPHEMERAL_MARKER) + 1:]

    # Exact-path spellings normalized (leading `!`/`/`, trailing `/`) — glob
    # spellings of these paths are outside the opt-out contract.
    def _opted_out(rel: str) -> bool:
        state = True
        for line in marker_tail:
            if line.lstrip("!").strip("/") == rel.strip("/"):
                state = line.startswith("!")
        return state

    to_untrack = [rel for rel in EPHEMERAL_UNTRACK if not _opted_out(rel)]
    untracked = subprocess.run(
        ["git", "-C", str(target), "rm", "-r", "--cached", "--ignore-unmatch",
         "--"] + to_untrack,
        capture_output=True, text=True,
        encoding="utf-8", errors="surrogateescape",
    ) if to_untrack else None
    if untracked and untracked.returncode != 0:
        raise SystemExit("could not untrack ephemeral .factory paths:\n"
                         + untracked.stderr)
    if untracked and untracked.stdout.strip():
        count = len(untracked.stdout.strip().splitlines())
        ensured.append(f"{count} ephemeral .factory file(s) untracked "
                       "(0025 — still on disk HERE, commit the staged removal; "
                       "TEAMMATES' pulls delete their clean local copies — a dev "
                       "mid-task recomposes the brief by re-running "
                       "./forge delegate <task-id>)")
    for rel in PROJECT_STARTERS:
        destination = target / rel
        if not destination.exists():
            assert_target_destination(target, destination.parent).mkdir(
                parents=True, exist_ok=True)
            shutil.copy2(
                harness / rel,
                assert_target_file_destination(target, destination),
            )
            ensured.append(rel)

    commit = head_sha(harness) or "unknown"
    assert_target_file_destination(
        target, target / "constitution" / "VENDORED_FROM").write_text(
        f"symphony-forge @ {commit}\nUpdate by re-vendoring from the harness repo; do not edit in place.\n", encoding="utf-8"
    )
    # Re-freeze the gate surface at the new vendoring (frozen-gate-integrity).
    from check_vendor_integrity import write_manifest
    write_manifest(target, commit)

    drift = ""
    # harness.yaml is PROJECT-owned, so an older scaffold may not have one at
    # all — which is the normal state of the legacy repos this command exists
    # to upgrade. Reading it unconditionally turned "you have no harness.yaml"
    # into a traceback at the very end of a successful upgrade.
    target_harness = target / "harness.yaml"
    if not target_harness.is_file():
        drift = ("\nNOTE: no harness.yaml in this repo — the phase contract falls "
                 "back to the harness default. Copy the harness's harness.yaml if "
                 "this project needs to own it.")
    elif (harness / "harness.yaml").read_text(encoding="utf-8") != target_harness.read_text(encoding="utf-8"):
        drift = ("\nNOTE: harness.yaml differs from the harness default (project-owned, "
                 "left untouched) — diff manually if the phase contract changed upstream.")
    print(f"Upgraded {target} to symphony-forge @ {commit[:8]}")
    print("Replaced (harness-owned): "
          + ", ".join(UPGRADE_TREES + UPGRADE_FILES + COPY_WORKFLOWS))
    print("Replaced doc contracts: " + ", ".join(replaced_doc_contracts))
    if diverged_doc_contracts:
        paths = " ".join(diverged_doc_contracts)
        print("WARNING: replaced doc contracts differed from the new template: "
              + ", ".join(diverged_doc_contracts)
              + f". Review the upgrade with git diff -- {paths}")
    if ensured:
        print("Added (missing on this older scaffold): " + ", ".join(ensured))
    print("Untouched (project-owned): " + ", ".join(PROJECT_OWNED) + drift)
    if retired_legacy:
        print("Retired legacy machinery: .agents/")
    stale_references = _stale_agents_references(
        target, harness, sorted(preserved), carried_from_legacy)
    # The scan reads the index, which equals the working tree only because the
    # dirty-target gate held. --force bypasses that gate, so uncommitted edits
    # and untracked files are outside what was searched — say so rather than
    # printing a definitive answer the scan cannot support.
    caveat = " (index only — --force skipped the clean-tree check, so uncommitted " \
             "and untracked files were not searched)" if args.force else ""
    if stale_references:
        print(f"Project-owned files still referencing .agents/{caveat}:")
        for rel in stale_references:
            print(f"  {rel}")
    else:
        print(f"Project-owned files still referencing .agents/: none{caveat}")
    print("Next: review with `git diff`, run `python3 factory/scripts/check_dual_runtime.py` "
          "and the gate tests, then commit.")
    from .scaffold import remediate_windows_hook_entry
    remediate_windows_hook_entry(target)
