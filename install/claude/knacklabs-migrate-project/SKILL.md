---
name: knacklabs-migrate-project
description: >-
  Migrate an EXISTING repo — a prototype or early project built with agents
  before the harness — into the Symphony Forge harness: vendor the machinery
  (forge adopt), sort existing content into prototype/ and docs/context/,
  harvest it into DISCOVERY/BRIEF and decision records, and hand off to the
  factory loop. Invoke when the user says "migrate this repo", "adopt the
  harness", "make this repo symphony-forge ready", "make this project
  harness ready", "bring this project into symphony forge", "harness-ify
  this repo", or "/knacklabs-migrate-project" — INCLUDING when the session
  is open inside the symphony-forge clone itself.
---

# Migrate an Existing Repo into the Harness

You are migrating a repo that predates the harness. The mechanical part is
one deterministic command; your judgment is only for sorting the existing
content. Never delete existing work — everything moves, nothing vanishes.

**The model (relay it if the user seems unsure):** same as new projects —
the harness is a vendored dependency, not an ancestor. Adoption COPIES the
machinery into the existing repo; the repo keeps its own git history and its
own GitHub origin (never repoint it at the harness, never merge harness
history in). Later harness improvements arrive via `forge upgrade`
(machinery-only), reviewed like any PR.

**Find the target first.** If this session is open in the harness clone,
ask which repo to migrate (a path) — the harness clone itself is never the
target. If the session is open in some other repo, that repo is the target;
confirm it in one breath with the prototype-or-production question below.

## Steps

1. **Locate or fetch the harness** (stamped at install time):
   ```bash
   HARNESS="{{HARNESS_PATH}}"
   [ -d "$HARNESS/.git" ] && git -C "$HARNESS" pull --ff-only \
     || git clone git@github.com:knacklabs/symphony-forge.git "$HARNESS"
   ```

2. **Doctor.** `python3 "$HARNESS/factory/scripts/forge.py" doctor` — rerun
   with `--fix` (user approves) on misses; only logins stay manual.

3. **Precondition the target repo.** It must be a git repo with a CLEAN tree
   (commit or stash with the user). Create a migration branch:
   ```bash
   git checkout -b chore/adopt-harness
   ```

4. **Adopt (deterministic).**
   ```bash
   python3 "$HARNESS/factory/scripts/forge.py" adopt --target <repo> --name <project>
   ```
   This vendors the machinery, preserves any pre-existing `AGENTS.md` /
   `CLAUDE.md` into `docs/context/migrated-*`, and creates project-owned
   files only where missing. It refuses a dirty tree and refuses repos that
   already carry the harness (use `forge upgrade` there).

5. **Review the diff with the user.** Walk the "Overwrote ..." list from the
   adopt output. If the repo had its own `.gitignore` or CI workflows, merge
   the harness entries instead of losing theirs.

   Adopt also appended a "Working in this repo — Symphony Forge" onboarding
   section to the README — the first thing a dev who clones the repo reads.
   Do not leave it as a bolted-on tail: weave it with the repo's existing
   orientation (project-specific doc links stay on top, the harness section
   explains HOW work happens here), and delete any old "how to contribute /
   run" prose the harness flow now supersedes — stale start instructions
   next to correct ones is how people start wrong.

5b. **Activate the project-local gstack store and pull in personal history.**
   ```bash
   direnv allow
   python3 "$HARNESS/factory/scripts/forge.py" gstack migrate --repo <repo>
   ```
   From now on gstack writes into `<repo>/.gstack/` (committed, shared);
   `gstack migrate` union-merges whatever this dev already accumulated in
   `~/.gstack/projects/<slug>/` — run it on EVERY machine that holds history
   (JSONL stores merge, nothing is clobbered).

6. **Sort the existing content** — ask the user ONE question first: *is this
   repo the prototype itself, or does it carry production-intent code?*
   - **Prototype repo**: move the app code under `prototype/` (reference
     forever, imported never — production gets scaffolded fresh at the
     workspace step). Screenshots/demos/walkthroughs go there too.
   - **Production-intent repo**: leave the code in place; move only prototype
     artifacts (mockups, spikes, demo assets) into `prototype/`.
   - Everything unstructured — notes, transcripts, chat exports, old README
     lore, the `migrated-*` files — belongs in `docs/context/`. Then:
   ```bash
   ./forge context scan
   ```

7. **Harvest** (`factory/prompts/harvester.md`): distill
   `docs/product/DISCOVERY.md` and `BRIEF.md` from the context; propose a
   `./forge decision new <slug>` record for every client decision already
   made. The HUMAN decides acceptance (`./forge decision accept`) — an explicit
   chat confirmation lets you run it with their name; otherwise relay,
   never run. Mark harvested files with `./forge context mark`.

7b. **Rehome the existing standards — replacement is NOT disposal.** The
   `migrated-*` files usually carry hard-won project standards (component
   patterns, coding rules, data rules, behavioral guidelines). Triage
   EVERY rule into exactly one destination, and record the mapping in the
   context ledger (`context mark --outputs --notes`):
   - **Project standard** (design systems, component canon, coding
     conventions, page structure) → `docs/architecture/<topic>-standards.md`
     — project-owned, upgrade-proof — plus a decision record naming it LAW
     and pointers from AGENTS.md/README where devs already look.
   - **Gotcha born from a repeated mistake** → `./forge lesson add` with
     `applies_to` globs, so it resurfaces before the same paths are touched.
   - **Covered by vendored canon** (e.g. Karpathy-style conduct →
     `constitution/09-agent-conduct.md`; logging/migration mandates already
     captured as decisions) → drop it, citing exactly what supersedes it.
   A rule left only in `docs/context/` is homeless — agents will never
   reload it, and the standard silently dies. Also normalize file case:
   the contract files are `AGENTS.md`/`CLAUDE.md` in CAPS (adopt handles
   this; verify with `git ls-files`).

7c. **Name capability gaps; never invent the missing content.** Check whether
   the migration still lacks capability specs, epics, or a roadmap. Capture
   real capabilities with `forge spec save` and `forge spec confirm`, then
   author the backlog with `forge roadmap derive` or `forge roadmap epic add`
   plus `forge roadmap add`. Never fabricate specs, epics, or stories to make
   a gate green. `forge project audit` now names these gaps and the commands
   that resolve them.

8. **If the client already signed off historically**, formalize it now:
   `client-signoff` decision → human accept → `record_signoff.py`. Otherwise
   the repo correctly sits pre-sign-off.

9. **Verify and land.** Run `python3 factory/scripts/check_dual_runtime.py`,
   `check_factory_scaffold.py`, and the gate tests; commit the branch and
   open the PR for review.

10. **Hand off.** Run `python3 factory/scripts/forge.py next`, relay the
    output — from here the repo's own `/forge` skill drives every phase
    (roadmap next, if features are already known). Tell the user what
    adoption armed, in their words: every feature now starts with a grilled
    plan (plan mode is hook-forced), work runs stage by stage with a local
    review before every commit, review findings are clustered across tasks
    so recurring classes become refactor stories instead of repeat fixes,
    repeated failures become ledgered lessons, and shipping refuses until
    the evidence gates pass.

## Rules

- Nothing is deleted; content is MOVED and the diff stays reviewable.
- The repo keeps its own origin and history. Never fork the harness into
  it, never merge harness branches, never repoint its remote — `forge
  adopt` now, `forge upgrade` later, is the only supported relationship.
- Recorders and gates apply from the moment of adoption — no evidence enters
  `.factory/` except through the schema-validated scripts.
- Human-only actions stay human: decision accepts, sign-off confirmation.
