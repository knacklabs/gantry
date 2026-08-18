---
name: knacklabs-new-project
description: >-
  Bootstrap a new KnackLabs client project from the Symphony Forge harness:
  update the harness clone, verify machine prerequisites (doctor), scaffold
  the repo (forge init), push it to its own GitHub origin, and hand off to
  the project's /forge skill. Invoke when the user says "new KnackLabs
  project", "set up a client project", "create a new app", "build a new
  application with the harness", "scaffold <name>", or
  "/knacklabs-new-project" — INCLUDING when the session is open inside the
  symphony-forge clone itself.
---

# New KnackLabs Project

You are bootstrapping a client repo from the harness. Everything below is
runnable by you — the user should only have to answer questions.

**The model (relay it if the user seems unsure):** the harness is a vendored
dependency, not an ancestor. The clone you may be sitting in is only the
GENERATOR — the app is born as its own `git init` repo with zero git
relation to the harness, gets its own GitHub origin, and is upgraded later
by `forge upgrade` (machinery-only), never by fork merges. Being invoked
from inside the symphony-forge clone is the normal case, not a mistake —
the app just must not be built here.

## Steps

1. **Locate or fetch the harness.** `./setup` stamped the clone location below
   at install time; fall back to asking the user, then cloning where they say.
   ```bash
   HARNESS="{{HARNESS_PATH}}"
   [ -d "$HARNESS/.git" ] && git -C "$HARNESS" pull --ff-only \
     || git clone git@github.com:knacklabs/symphony-forge.git "$HARNESS"
   ```

2. **Doctor.** Run `python3 "$HARNESS/factory/scripts/forge.py" doctor`.
   If it reports misses, rerun with `--fix` (user approves) — that installs
   everything installable: Codex CLI, codex-plugin-cc, ponytail, gstack,
   autoreview, all from their canonical GitHub sources. Only logins remain
   (`codex login`) — give the user that command and wait. Do not proceed with
   required tools missing.

3. **Ask** (one question, three parts): project name; target directory if
   not `~/Workdir/<name>`; and the GitHub home for the new repo —
   `<org>/<repo>` (offer `knacklabs/<name>` as the default) or "local only
   for now".

4. **Scaffold.**
   ```bash
   python3 "$HARNESS/factory/scripts/forge.py" init --name <name> --target <dir>
   ```
   Never pass `--force` without explicit user confirmation — it overwrites.

5. **Give the app its own origin** (skip only if the user chose local-only;
   remind them it is pending). From `<dir>`:
   ```bash
   git add -A && git commit -m "chore: scaffold from symphony-forge"
   gh repo create <org>/<repo> --private --source . --push
   # or, when the repo already exists / gh is unavailable:
   # git remote add origin git@github.com:<org>/<repo>.git && git push -u origin main
   ```
   NEVER `gh repo create --template` and NEVER fork the harness for this —
   a template copy has no upgrade path, a fork turns every future harness
   upgrade into a merge against app code. `forge init` + its own origin is
   the only supported shape.

6. **Enable the project-local gstack store.** In `<dir>`, run
   `direnv allow` — this activates `.envrc` (GSTACK_HOME pinned to the
   repo's `.gstack/`), so office-hours design docs, decisions, and learnings
   are committed and shared instead of stranded in `~/.gstack`.

7. **Hand off.** In `<dir>`, run `python3 factory/scripts/forge.py next`,
   relay its output, and tell the user: open future sessions IN `<dir>` —
   this repo's own `/forge` skill (and `forge.py next`) drives every phase
   from here, discovery first. If the current session is still sitting in
   the harness clone, say so explicitly and name the new path.

## Rules

- The generated repo is the system of record; the harness clone is only the
  template source. Never do project work inside the harness clone — all app
  code, plans, decisions, and evidence belong to the new repo.
- Never fork the harness, never use GitHub's template feature for client
  projects. Later harness updates flow via
  `./forge upgrade --target <dir>` (run from the harness clone) — a
  machinery-only diff the app repo reviews like any PR.
- If doctor and init both pass but `next` errors, report verbatim — do not
  improvise around a broken scaffold.
