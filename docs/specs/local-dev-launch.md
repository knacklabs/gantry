---
slug: local-dev-launch
title: Local development launch and reset
status: confirmed
saved: 2026-09-17T13:16:48+00:00
---

# Local development launch and reset

## Why

The Lite local-development change has already landed in this worktree; the
user approved promoting it to Full Forge on 2026-09-17, with the scope
limited to `package.json`, the CLI index, CLI local, Vite configuration,
CLI local-routing tests, `scripts/architecture-exceptions.json`, plus
documentation and Forge proof. A narrow one-call architecture exception
covers the operator-owned source supervisor; agent/tool execution remains
behind the existing sandbox boundary. Production start and service behavior
stay unchanged.

Approved addition: `npm run dev:stop` / `gantry local stop` stops source
core, Vite, and the verified home-owned managed Postgres container without
deleting data or stopping unrelated Docker containers. Ctrl-C leaves
Postgres warm.

A cold-read spec grill found the original draft under-specified
destructive-operation safety and authority boundaries; the owner resolved
every finding, and this revision states those resolutions as requirements.
A second cold-read grill of the requirements round (re-reading this spec
against current repository reality — the actual `local.ts`, decision 0025,
and decision 0003) found further gaps: the spec checked the wrong settings
authority, proposed an ownership-marker design that would have violated
decision 0003's no-backcompat-adoption rule, missed a crash window between
the database commit and filesystem cleanup, and left the one-time
authorization credential unprotected against non-interactive stdout capture.
The owner resolved all of it; this revision states those resolutions too.

A third cold-read grill of the requirements round found further gaps:
recovery-marker semantics that could refuse forever, a settings-authority
check with no defined behavior on a genuinely fresh (pre-migration) database,
an ordering ambiguity between "no mutation before checks" and the
bootstrap-then-check start it depends on, a missing revision-skew check,
a decision 0006/0162 precedence gap, TTY-safety reachability, a
self-contradictory-looking ownership-marker lifecycle, incomplete
orphan-hardening (Vite, not just core), an architecture-exception claim that
was not yet true on disk, stale mentions of the removed CLI surface
elsewhere in the docs, and a non-falsifiable build-equivalence criterion. The
owner resolved the two genuinely open tradeoffs (recovery-marker UX, and
whether to close the Vite-orphan gap now); every other finding is a spec
clarification or doc-consistency fix, stated below.

## Behaviour

### Commands

- `npm run dev` / `gantry local start`: start source core and Vite with HMR,
  ensuring Postgres is available and all current migrations have completed.
- `npm run reset` / `gantry local reset`: reset both Gantry database schemas,
  remove known Gantry runtime state, migrate, and restart into fresh onboarding.
- `npm run reset:db` / `gantry local reset-db`: reset both schemas, migrate,
  and restart while preserving runtime filesystem state.
- Keep the old core-only source command as `npm run dev:core`.
- `npm run dev:stop` / `gantry local stop`: stop source core, Vite, and the
  verified home-owned managed Postgres container only.
- `gantry local` with no subcommand prints usage and exits; it must not
  start Docker/core/Vite. `gantry local status`/`gantry local doctor` are
  removed — the existing top-level `gantry status`/`gantry doctor` already
  cover this, and a duplicate under `local` is an undocumented, redundant
  CLI surface.

Local dev commands run source directly (`tsx`, no core/web *production*
build and no root `dist/ui`) and stay entirely separate from artifact build
commands (below) and from the production commands `npm run build` / `npm
start`, which this change does not alter. (Every local command still runs
`build:contracts` to produce the typed contracts workspace output the CLI
itself depends on — that workspace build is not what "no build step" means
here.)

### Build commands

Building deployable artifacts is a distinct concern from running source
locally, and stays that way: `npm run dev`/`local start` never builds the
core/web production `dist/`, and building `dist/` never starts a dev server.
Document the existing build commands so the separation and the reuse are
explicit rather than implicit:

- `npm run build:contracts` / `npm run build:sdk` / `npm run build:web`:
  build one workspace's own artifacts. Unchanged.
- `npm run build:core`: build only the backend runtime artifacts (contracts,
  SDK, the core `tsc` output, migrations copy, CLI executable bit) with no
  web build or copy step — the artifact-build counterpart to `npm run
  dev:core`. New: extracted out of `build:runtime` so backend-only artifacts
  can be built independently of the web bundle, reusing the exact same
  underlying steps.
- `npm run build:runtime`: `build:core` plus `build:web` plus copying the
  web build into `dist/ui`. Behaviorally identical to today — restated as a
  composition of `build:core` and `build:web` instead of its own inlined
  step list.
- `npm run build`: `build:runtime` plus the SDK example build. Unchanged.
- `npm start`: `db:migrate` then run the built `dist/index.js`. Unchanged —
  production startup is untouched by this change.

### Environment and lifecycle

Source development defaults to gitignored `<repo>/.gantry`, with explicit
`--runtime-home` and exported `GANTRY_HOME` taking precedence. Create missing
local defaults in its `.env` with private permissions, preserving existing
values. Generate an encryption key. Use process environment before file values
for that generated bootstrap `.env` only; existing `.env` values are never
silently overwritten. Derive public host and port from `GANTRY_CONTROL_HOST`
and `GANTRY_CONTROL_PORT`, defaulting to loopback port 3939, under the narrow
decision 0006 exception recorded in decision 0162: these two bind-time keys
may live in `.env`, and process environment may override them there
specifically (0162 §precedence) — no other non-secret configuration moves
into `.env`, and once a settings revision exists it remains authoritative for
every other value per decision 0025. Fresh authentication configuration must
match this origin; existing conflicts fail with remediation.

Reuse the configured reachable loopback database. Start Compose only for the
managed default database, binding its storage to `<GANTRY_HOME>/postgres`.
Never silently replace an unavailable custom database or adopt a foreign
container by its name. Validate Node 24 and source-checkout prerequisites.

Before any destructive or mutating step (database reset, filesystem reset,
migration, container start), complete every precondition check: home safety,
Node version, database-target authority (below), and authentication-mode
authority (below). A precondition failure must leave existing state
untouched and exit before anything is deleted, migrated, or started.

Decision 0025 makes the Postgres `settings_revisions` table authoritative
over `settings.yaml`, but reading it requires Postgres to be reachable, and
authority must be confirmed before anything destructive runs. Resolve this
with a reversible bootstrap-then-check: start (or confirm running) only the
verified home-owned managed container as a preflight bootstrap step, read
and validate the latest settings revision against local-mode defaults, then
either continue into migrations/core/Vite or stop that container again
before returning a precondition failure. No migration, filesystem deletion,
or application child process runs until this check passes.

"No mutation before checks" governs destructive/mutating steps against
*existing* state (schema drop, filesystem delete, migration, starting
application children); it does not forbid the reversible bootstrap-then-check
start above, which is itself part of the check. For a genuinely fresh home,
creating the home directory, the ownership marker, the default `.env`, and
(if needed) the managed container/volume are additive bootstrap steps, not
destructive ones — they are safe to leave in place if a later check fails.
On a failed check, stop only a container this invocation itself started
(tracked for the duration of the command; an already-running container found
at start is never stopped as a side effect of a failed check), and leave any
newly created home directory, marker, `.env`, or volume in place: an
unfinished bootstrap is inert, and rerunning the same command is safe and
idempotent. Distinguish "the `settings_revisions` table does not exist yet"
(a genuinely fresh database with no revision — fall back to `settings.yaml`
authority) from any other query failure (a real error — refuse). When a
revision exists, enforce the same `min_reader_version` skew rejection normal
startup already enforces (`apps/core/src/app/bootstrap/startup.ts`) before
treating it as authoritative for a destructive step.

Run migrations before core, start core on a private loopback port, and expose
Vite on the public origin. Proxy browser authentication and API traffic to core.
Print the stable resolved UI URL when healthy. Ctrl-C stops children and leaves
Postgres warm. A child failure stops its sibling and exits nonzero. Development
must not fall back to built UI assets.

### Database-target authority

The database the local supervisor migrates and resets must be the same
database core will actually use at runtime, and that determination follows
decision 0025: the latest Postgres settings revision is authoritative when
one exists (read during the reversible bootstrap-then-check above), and the
runtime-home `settings.yaml` is authoritative only for a genuinely fresh
home with no revision yet. If the authoritative settings declare a
non-default `storage.postgres.url_env` (the actual settings key; not
`urlEnv`) or `storage.postgres.schema`, or if `GANTRY_SETTINGS_POSTGRES_SCHEMA`,
a `schema=` query parameter, or `GANTRY_DB_SCHEMA` would redirect migrations
to a different schema than core will use, source-local startup must refuse
before touching the database or filesystem, naming the conflicting setting
and how to align it, rather than silently operating on
`GANTRY_DATABASE_URL`/`gantry` while core would use something else.

### Reset ownership

Reset must not act on a database or directory tree it cannot show it owns.

- **Filesystem reset ownership.** Gantry writes a marker at the moment it
  bootstraps a genuinely new runtime home (a home directory that did not
  exist before this command created it) — never at any later point, and
  never onto a home that already existed. `local reset` refuses to touch
  `LOCAL_RESET_PATHS` under any home lacking that marker; there is no
  automatic or retroactive way to mark an existing, unmarked home, because
  treating an unrecognized directory as reset-authorized after the fact is
  exactly the compatibility/adoption path decision 0003 forbids. An unmarked
  home is refused with a manual remediation (move or delete the old home, or
  point `--runtime-home` at a new path, so a fresh, marked home is
  bootstrapped by `local start`). The marker is written atomically (temp file
  plus rename) at `<home>/.gantry-owned`, holding the creation timestamp. It
  survives `reset-db`. A full `reset` rewrites it fresh only on a home that
  already carried one — this is re-affirming ownership Gantry already held,
  not the retroactive first-time marking decision 0003 forbids; a `reset`
  target with no existing marker is refused exactly like `local reset` above.
  This marker and the reset-in-progress marker below are local runtime-home
  bootstrap/operator-tooling state, outside the Postgres-first durable-state
  boundary (`docs/architecture/durable-state-boundary.md`), which governs
  canonical application/domain state, not local CLI bootstrap files under the
  operator's own runtime home — the same category as `.env`.
- **Database reset ownership.** `local reset` and `local reset-db` may only
  run against the exact verified home-owned managed Postgres container: the
  same ownership check `local stop` already performs, run unconditionally
  before reset regardless of whether the target was already reachable, and
  bound to the specific container's published connection endpoint — not
  merely "a reachable loopback database named `gantry`". A reachable custom
  database that matches the name coincidentally is refused, not reset, and a
  non-default `GANTRY_DATABASE_URL` is refused for reset outright since its
  ownership cannot be verified.
- **Preflight-then-destroy ordering.** Every check above, and every stop of
  already-running local children, completes before the schema is dropped or
  any file is removed — reset must not stop the running supervisor and then
  discover a precondition failure with children already stopped.

### Reset crash recovery

A crash between the database schema commit and filesystem cleanup finishing
must be observable and refused, not silently treated as a clean reset target
on the next run. Write a durable reset-in-progress marker (`<home>/.gantry-
reset-in-progress`, recording which variant — `reset` or `reset-db` — is
running and when it started) immediately before the destructive database
step, and remove it only after filesystem cleanup (for a full reset) or after
the schema recreation completes (for `reset-db`) — whichever is that
variant's last destructive step.

A subsequent `start`/`reset`/`reset-db` that finds a stale marker refuses
with a clear "a previous reset did not finish cleanly" message naming the
interrupted variant. Because the underlying cause (an interrupted destructive
step) cannot be distinguished from "still genuinely broken" by rerunning the
identical command, the refusal is not lifted by retrying it: the remediation
names an explicit operator-acknowledgment flag,
`--after-manual-recovery`, that the operator passes only after manually
inspecting the disposable local state; passing it clears the stale marker and
lets the same command proceed. This is a durable flag and a refusal, not a
cross-process lock — the deferred mutual-exclusion lock (tracked separately)
is about concurrent reset attempts, not crash recovery.

### Orphan and stale-state recovery

`local stop` must not stop the managed Postgres container while a Gantry
core process it does not control is still using it. Core binds its own
loopback port privately behind Vite, so a public-origin health probe cannot
see an orphaned core process if Vite or the supervisor died — the check must
use the database itself: reuse the existing active-connection check (already
used by `resetLocalDatabase` via `pg_stat_activity`) after the managed
children this `stop` invocation controls have been shut down, and refuse to
stop Postgres while any other connection remains, reporting the orphaned
state with a remediation to locate and stop those processes directly.

The active-connection check covers an orphaned core process (it holds a DB
connection) but not an orphaned Vite process, which is detached and holds no
DB connection, so it can keep squatting the UI port after a supervisor crash
even while the check above reports no orphaned core and `stop` proceeds.
Close this: `local start` writes core's and Vite's PIDs to a small file under
the runtime home (e.g. `<home>/.gantry-local-pids`) as they are spawned, and
`local stop` (and the next `local start`'s preflight) reads it, checks
whether each recorded PID is still alive and still Gantry's process, and
terminates a leftover one before proceeding; the file is removed once both
children are confirmed stopped.

### Approved automatic local authorization addition

On every successful source-local start, including ordinary restarts and both
reset variants, attempt to print a fresh short-lived (thirty-minute), single-use
authorization link after health readiness — health meaning the public Vite
origin's proxied `/healthz` responds healthy, not the deeper `/readyz`
onboarding-readiness check, since fresh onboarding can legitimately leave
`/readyz` red. This is a mandatory-attempt, fail-open step: it always runs
after readiness, but its failure (for any reason, including an inability to
safely construct a TTY-gated printable link) is logged and never fails the
command or stops the dev stack — "optional" describes the failure mode, not
whether the attempt happens.

Issue this through the same underlying authorization-issuance path
`gantry ui authorize` uses, called in-process so the local supervisor
receives the URL as a value and fully controls whether and how it is
printed — it must not merely inherit stdio from a spawned `gantry ui
authorize` subprocess, which would print the raw URL itself before the
supervisor's TTY gate could apply. This requires no change to `apps/core/src/
cli/auth.ts`; both entry points call the same underlying issuance function.
Before starting any child process, require `authentication.mode` to be
`local` — the only mode this path can ever serve — and a loopback public
origin (decision 0132); refuse with remediation before startup if not,
rather than starting a healthy stack and then failing authorization on every
retry.

The raw authorization URL is a thirty-minute administrator credential. Print it
in full only when stdout is an interactive terminal (a TTY); when stdout is
not a TTY (redirected to a file, captured by an IDE task runner, or CI),
keep the healthy development stack running and print only the stable UI URL
plus the resolved manual retry command (`gantry ui authorize
--runtime-home <home>`) — never the raw token — so non-interactive capture
can never persist the credential. Keep the stable UI URL available for
browsers with valid sessions regardless; issuing a new link must not revoke
those sessions. Do not persist plaintext authorization URLs in runtime
files. If link issuance fails for a reason other than an unsupported mode,
keep the healthy development stack running and print an actionable retry
command that includes the resolved `--runtime-home` flag, so retrying
targets the same home instead of a different default.

Existing browser sessions remain valid after ordinary restarts and after a
new link is issued without a reset. `reset` and `reset-db` both drop and
recreate the `gantry` schema, which holds session state, so no session can
survive either reset variant — the requirement is scoped to restart/relaunch
without a reset, not to reset itself.

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Issues an optional link after each healthy launch; preflights mode/origin/database authority first via a reversible bootstrap-then-check. |
| settings.yaml | Changed | Source-local startup creates it when missing, and full reset deletes and recreates it; the file is authoritative only for a genuinely fresh home with no settings revision yet — otherwise the latest Postgres settings revision (decision 0025) governs, and startup's existing bootstrap imports the file as that revision when none exists. |
| Postgres/runtime projection | Changed | Local reset recreates `gantry`/`pgboss` only against the verified home-owned managed container, guarded by a reset-in-progress marker; auth link issuance inserts hashed single-use authorization state through existing storage. |
| Control API | Unchanged by design | Existing authorization and redemption paths are reused. |
| SDK/contracts | Unchanged by design | No client-contract change. |
| CLI | Changed | Local supervisor invokes the existing UI authorization issuance path in-process; `local status`/`local doctor` are removed as duplicates of top-level commands; build commands gain a documented `build:core` composition; direct Postgres calls move into the new local-operator-only `local-postgres.ts`, covered by a count-exact architecture exception for the coordinator's `spawn` calls. |
| MCP/admin tools | Unchanged by design | No new administration operations. |
| Channel/provider adapters | Unchanged by design | Browser login does not alter adapters. |
| Docs/prompts | Changed | Describe automatic links, database/auth-mode authority, reset crash recovery, and build commands. |
| Audit/events | Unchanged by design | Existing authorization flow owns its events. |
| Tests/verification | Changed | Check readiness ordering, resolved environment, ownership/authority refusals, preflight ordering, orphan-stop refusal, reset-crash-marker refusal, TTY-gated token output, and issuance failure. |

Search README for obsolete explicit-only authorization guidance.

### Reset boundaries

Both commands run every precondition check (home safety, Node version,
database-target authority, authentication-mode authority) and stop verified
local children before any destructive step. They print the resolved home
and redacted database target. Refuse unsafe home paths, non-loopback
databases, databases not named `gantry`, and any database/home that fails
the ownership checks above. Recreate only `gantry` and `pgboss` under a
reset-in-progress marker, then run the complete current migration chain.
Full reset additionally removes known settings, onboarding, agents, data,
store, logs, artifacts, and runtime projection paths. Preserve `.env`,
`postgres/`, unknown files, unrelated processes, and user runtime data
during verification.

Both `reset` and `reset-db` drop and recreate `settings_revisions`, so the
just-validated authoritative revision they preflighted against would
otherwise be gone on restart, leaving only a "genuinely fresh home" fallback
to stale/default `settings.yaml`. Before that destructive schema step, write
the validated revision's content out as `settings.yaml` — a matching
recovery copy of the desired configuration — so a post-reset restart imports
that same desired state as its first revision instead of stale defaults.

### Deferred

Docker-only startup on a dedicated port is explicitly deferred to a
follow-up (D-0092); this change retains reachable configured loopback
database reuse. A cross-process, DB-scoped mutual-exclusion lock for
concurrent reset attempts is explicitly deferred (D-0093) — preflight-then-
destroy ordering, ownership verification, and the reset-in-progress marker
are in scope; a new distributed-locking mechanism is not. No additional
dependencies or SDK/API schema changes are authorized.

### Architecture boundary

`scripts/architecture-exceptions.json` already carries a count-exact,
time-bounded `direct_risky_execution` entry for `apps/core/src/cli/local.ts`
(`maxViolations: 1`), landed with the prior Lite work; `python3
scripts/check_architecture.py` currently passes. (An earlier grill round read
the repository before that entry landed and reported it missing; this is
corrected against the current file rather than repeated.) This task confirms
that entry still holds as the remaining safety work lands and adjusts it only
if a genuinely new risky-execution call site is introduced in `local.ts`
itself. Separately, decision 0001 forbids CLI adapters
from directly mutating persistence; the settings-revision read, the
`pg_stat_activity` check, and `ownedPostgres` are direct Postgres access from
CLI code. This task takes a bounded, file-scoped deviation rather than a
silent violation or a full application/port seam: those calls move into one
new file, `apps/core/src/cli/local-postgres.ts`, documented as
local-operator-only tooling that must not be imported by agent/tool/job code
paths — narrower than a service layer, but naming and containing the
deviation instead of spreading raw persistence access through the
coordinator.

### Documentation and roadmap consistency

Removing `local status`/`local doctor` and changing the authorization-link
guarantee to a mandatory-attempt/fail-open step must not leave other repo
surfaces contradicting the new behavior: update any mention of `local
status`/`local doctor` in `docs/architecture/overview.md` and `docs/SPEC.md`,
any runtime recovery/guidance message that still names them (including in
`apps/core/src/adapters/storage/postgres/storage-readiness.ts`), and the
`plans/roadmap.json` entry for this story so it states the mandatory-attempt/
fail-open link behavior and the reset/session-survival exception rather than
an unconditional guarantee.

## Acceptance criteria

- `npm run dev` / `gantry local start` runs migrations before starting source
  core and Vite together, and production startup (`npm start`) is unchanged.
- `npm run dev:core` remains available as the old core-only source command.
- `npm run build:core` builds backend artifacts only (no web build/copy),
  composed from the same steps `build:runtime` already uses; `npm run
  build:runtime` and `npm run build` produce the same `dist/` output as
  today — falsifiable as: on a clean tree, the sorted relative file-path
  listing under `dist/` (`find dist -type f | sort`) is identical whether
  produced by the pre-change or post-change `build:runtime`/`build` scripts,
  and both exit zero with no new errors/warnings.
- `gantry local` with no subcommand prints usage and does not start
  anything; `gantry local status`/`gantry local doctor` no longer exist as
  duplicates of the top-level commands.
- Every destructive or mutating step is preceded by home safety, Node
  version, database-target authority (checked against the authoritative
  Postgres settings revision when one exists, via a reversible
  bootstrap-then-check), and authentication-mode authority checks; a failed
  check leaves existing state untouched, with local children stopped only
  after every check passes.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at
  the moment of its first bootstrap; filesystem reset refuses on any home
  without one, with no retroactive marking path. Database reset refuses
  unless the target is the exact verified home-owned managed Postgres
  container's endpoint, never merely "a reachable loopback database named
  `gantry`", and refuses outright for a non-default `GANTRY_DATABASE_URL`.
- Source-local startup refuses, before touching the database or filesystem,
  when the authoritative settings (the latest Postgres revision, or
  `settings.yaml` for a genuinely fresh home) declare a non-default
  `storage.postgres.url_env`/`schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`
  / a URL `schema=` parameter / `GANTRY_DB_SCHEMA` would redirect migrations
  to a different schema than core will use — naming the conflict and how to
  align it.
- A reset that crashes after the database schema commit but before
  filesystem cleanup finishes leaves a durable marker naming the interrupted
  variant; the next start/reset/reset-db refuses with a clear message instead
  of starting against mixed old/new state, and proceeds only once the
  operator passes `--after-manual-recovery` after inspecting local state.
- `reset`/`reset-db` write the just-validated authoritative settings revision
  out to `settings.yaml` before the destructive schema step, so a post-reset
  restart imports that same desired configuration instead of stale/default
  YAML.
- `npm run dev:stop` / `gantry local stop` stops source core, Vite, and the
  verified home-owned managed Postgres container only, without deleting data
  or stopping unrelated Docker containers, and refuses to stop that
  container while an orphaned core process still holds an active database
  connection after this invocation's own children have been shut down; it
  also detects and terminates a leftover orphaned Vite process via the
  recorded PID file even when the supervisor itself previously crashed.
  Ctrl-C leaves Postgres warm.
- Reset commands stop verified local children only after every precondition
  passes, refuse unsafe home paths, non-loopback databases, databases not
  named `gantry`, and any home/database that fails ownership verification,
  recreate only `gantry` and `pgboss`, preserve `.env`, `postgres/`, unknown
  files, and unrelated processes, then restart through the same
  healthy-start path.
- Every successful start or reset first confirms `authentication.mode` is
  `local` and the public origin is loopback, then prints a fresh
  short-lived, single-use browser authorization link after health readiness
  (proxied `/healthz`, not `/readyz`) via `gantry ui authorize` — the raw
  link only when stdout is an interactive TTY, otherwise the stable UI URL
  plus a retry command that includes the resolved `--runtime-home`, never
  the raw token. A failed issuance for any other reason keeps the healthy
  dev stack running.
- Existing sessions remain valid after a restart or a freshly issued link
  without a reset; `reset` and `reset-db` both end all existing sessions by
  design, since they recreate the `gantry` schema. Manual verification
  proves session survival on restart without storing raw URLs or tokens in
  artifacts.
- Source development resolves the runtime home with precedence
  `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing
  private `.env` defaults while preserving existing values, and validates
  Node 24 and source-checkout prerequisites.
- Verification covers home/env precedence, bootstrap preservation, database
  reuse/startup, migration ordering, origin/proxy wiring, signal/child
  cleanup, reset deletion/ownership boundaries, unsafe-target refusal,
  database/auth-mode authority refusal, reset-crash-marker refusal,
  orphan-stop refusal, TTY-gated token output, and restart, using disposable
  state only — including at least one manual pass against a real disposable
  Docker Postgres container, satisfying the repository's DB-backed-change
  verification requirement without a new automated integration-test lane.
