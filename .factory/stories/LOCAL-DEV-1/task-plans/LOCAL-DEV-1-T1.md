# LOCAL-DEV-1-T1 — Full local source-dev supervisor closeout

## Objective

Close the destructive-safety, authority, recovery, TTY-safety, and
orphan-hardening gaps the spec/requirements/plan grills found in the
already-landed Lite `gantry local` implementation, add the narrow
architecture exception, and land PR-ready proof — as one bounded
backend/CLI task, per `plans/active/LOCAL-DEV-1-source-local-gantry-development.md`.

## Workflow

The end-to-end flow this task hardens is `gantry local <start|reset|reset-db|stop>`,
coordinated entirely by `apps/core/src/cli/local.ts`, with direct Postgres
inspection/reset calls moved into the new `apps/core/src/cli/local-postgres.ts`
(the bounded decision-0001 deviation). No new service layer, no new process.

```mermaid
flowchart TD
    A[gantry local start/reset/reset-db] --> B{Runtime home exists?}
    B -- no, fresh --> C[Bootstrap: create home, .env,\nownership marker (local-postgres.ts)]
    B -- yes --> D[Load existing home]
    C --> E[Reversible bootstrap-then-check:\nstart verified owned container]
    D --> E
    E --> F{Read latest settings revision\n(local-postgres.ts, min_reader_version fence)}
    F -- no revision, fresh DB --> G[Fall back to settings.yaml]
    F -- revision exists --> H[Validate storage + auth authority\nfrom SAME revision]
    G --> I{Authority checks pass?}
    H --> I
    I -- no --> J[Stop only a container THIS invocation started;\nleave existing state untouched; refuse]
    I -- yes --> K{Command is reset/reset-db?}
    K -- yes --> L[Write reset-in-progress marker\n(names variant)]
    L --> M[Write settings.yaml recovery copy\nfrom validated revision]
    M --> N[Stop already-running children\n(only now, after all checks)]
    N --> O[Drop/recreate gantry + pgboss schemas]
    O --> P[Clear reset-in-progress marker]
    K -- no (start) --> Q[Run migrations]
    P --> Q
    Q --> R[Start core + Vite, write PID file]
    R --> S[Wait for proxied /healthz]
    S --> T[Issue auth link in-process\n(TTY-gated, mandatory-attempt/fail-open)]
    T --> U[Print stable UI URL]

    V[gantry local stop] --> W[Stop core + Vite via PID file\n(detects orphaned Vite too)]
    W --> X{pg_stat_activity: any\nother active client?}
    X -- yes --> Y[Refuse to stop Postgres; report orphan]
    X -- no --> Z[Stop managed Postgres container]

    J -.->|stale marker on next run| AA[Refuse: name interrupted variant;\nrequire --after-manual-recovery]
```

## Scope

Write scope (existing files unless marked new):
`package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`,
`apps/core/src/cli/local-postgres.ts` (new), `apps/web/vite.config.ts`,
`apps/core/test/unit/cli/index-local-routing.test.ts`,
`apps/core/test/unit/cli/local-postgres.test.ts` (new),
`scripts/architecture-exceptions.json`, `README.md`,
`docs/architecture/overview.md`, `docs/SPEC.md`,
`apps/core/src/adapters/storage/postgres/storage-readiness.ts`,
`plans/roadmap.json`.

No other new source files. `apps/core/src/cli/auth.ts` is deliberately NOT in
scope — the TTY-gated link is issued by calling the same in-process
authorization-issuance function `auth.ts` already uses, not by modifying it.

Size budget: target ceiling 2,000 added lines across the product-code/test
files above (README/docs/Forge evidence excluded); a run over that but under
4,000 lines is a NOTE at `stage done`, not a refusal; over 4,000 refuses and
pauses for a human scope decision.

## Key contract points (see the approved story plan for full detail)

- Ownership marker (`<home>/.gantry-owned`): written ONLY at first bootstrap
  of a genuinely new home; a full `reset` rewrites it only on an
  already-marked home; an unmarked home is refused with manual remediation.
- Database reset ownership: `ownedPostgres` (now in `local-postgres.ts`)
  called unconditionally before any reset, extended to verify the container's
  actual published host/port endpoint; a non-default `GANTRY_DATABASE_URL` is
  refused outright for reset.
- Settings authority: reversible bootstrap-then-check reads the latest
  revision with the canonical parser and `min_reader_version` fence (falling
  back to `settings.yaml` only when `settings_revisions` does not exist yet);
  storage AND authentication authority come from the SAME revision object.
- Reset-db/reset recovery copy: write the validated revision out as
  `settings.yaml` before the destructive schema step.
- Reset-in-progress marker: names the interrupted variant; cleared only by
  an explicit `--after-manual-recovery` flag, never a blind retry.
- TTY-gated, in-process auth-link issuance: raw URL only on an interactive
  TTY; otherwise the stable UI URL plus a `--runtime-home`-inclusive retry
  command; issuance is mandatory-attempt, fail-open.
- Orphan hardening: `pg_stat_activity` check (any active client, not just
  core) for `stop`'s Postgres refusal, plus a PID file for core+Vite so a
  leftover orphaned Vite process is detected and terminated even after a
  supervisor crash.
- CLI surface: remove `local status`/`local doctor`; bare `gantry local`
  prints usage; fix stale mentions of these removed commands in
  `docs/architecture/overview.md`, `docs/SPEC.md`, the recovery message in
  `storage-readiness.ts`, and the `plans/roadmap.json` session/link criterion.
- Architecture exception already on disk: `scripts/architecture-exceptions.json`
  already carries a count-exact, time-bounded `direct_risky_execution` entry
  for `local.ts`'s direct `spawn` calls (`maxViolations: 1`), landed with the
  prior Lite work — `check_architecture.py` currently passes. Confirm it
  still holds as this task lands; adjust only if a genuinely new
  risky-execution call site is introduced in `local.ts` itself (the
  `local-postgres.ts` extraction does not touch this — it moves persistence
  calls, not the `execFileSync('docker', ...)` spawn).
- `build:core` extracted from `build:runtime` per the plan; `README.md`
  documents the full build-command set.

## Required Tests

See the recorded decomposition's `required_tests` for the executable proof
list (20 vitest cases across `index-local-routing.test.ts` and the new
`local-postgres.test.ts`, covering CLI-surface reduction, ownership-marker
and database-reset refusals, preflight ordering, authority refusals, the
reset-in-progress marker and its `--after-manual-recovery` flag, the
recovery-copy write, orphan-core and orphan-Vite handling, TTY gating,
issuance-failure non-fatality, IPv6 normalization, and the `local-postgres.ts`
helpers themselves).

## Manual Verification

1. Use a disposable `--runtime-home` under a freshly created temporary
   directory and a disposable loopback Postgres target only; never touch
   real developer or production runtime data.
2. Start with the repo-built CLI (`npm run build:core` then the built
   binary, or `tsx` against the source entrypoint) against that temp home;
   confirm health, the stable UI URL, and that the authorization link
   prints only after readiness. Redact the URL in notes.
3. Redeem the first link in a browser, confirm the UI session works,
   restart, and confirm a new link is printed while the existing session
   remains valid.
4. Redeem the old link again (or after a new one issues) and confirm
   single-use behavior; record only pass/fail, never the token.
5. Run `gantry local stop`; confirm core/Vite stop and only the verified
   home-owned managed Postgres container stops. Repeat with a custom DB and
   confirm it is left running.
6. Run `gantry local reset-db` then `gantry local reset` against disposable
   state; confirm `.env`/`postgres/`/unknown files are preserved, the
   ownership marker survives `reset-db` and is rewritten fresh by `reset`,
   and `settings.yaml` reflects the validated revision after each.
7. Point `--runtime-home`/`GANTRY_DATABASE_URL` at a reachable custom
   loopback Postgres named `gantry` that is NOT the managed container;
   confirm `local reset` refuses it.
8. Set a conflicting `storage.postgres.schema`; confirm the database-target-
   authority refusal names the conflict before any destructive step.
   Separately, start core directly against the disposable DB (bypassing the
   supervisor) and confirm `local stop` refuses to stop Postgres, reporting
   the orphaned connection.
9. Kill only the Vite child via its recorded PID, then run `local stop` and
   confirm it detects and terminates the leftover process via the PID file.
10. Redirect a disposable authorization retry to a non-TTY sink and confirm
    the raw URL never appears there — only the stable UI URL and retry
    command.
11. Kill the process mid-`local reset` right after its database step
    (deterministic `kill -TERM` on disposable state, repo-built CLI, fresh
    temp parent directory); confirm the next command refuses, names the
    interrupted variant, that a blind rerun still refuses, and that
    `--after-manual-recovery` clears it and lets the same command proceed.

This manual pass against a real disposable Docker Postgres container
satisfies the repository's DB-backed-change verification requirement
(`docs/architecture/current-verification-commands.md`) without a new
automated integration-test lane, per the requirements grill's resolution:
the behavior under test is CLI/process lifecycle, not application-layer
database queries.

## Reviewer Focus

See the recorded decomposition's `reviewer_focus` field for the full list.
Highlights: the architecture exception must be count-exact and
operator-local only; the ownership marker must never be written to a
pre-existing unmarked home (decision 0003); `local-postgres.ts` must never be
imported by agent/tool/job code; every destructive step must be genuinely
preceded by its precondition checks, not merely reordered in appearance; no
raw authorization token may appear in any artifact; confirm the task diff
against the size budget.

## Design skills

This task is `user_facing: true` because its acceptance path includes a real
browser-session redemption, even though it ships no React component, style,
or motion change (only Vite proxy wiring). `emil-design-eng` and
`frontend-design` are loaded and attested in `skills_used` as
reviewed-with-no-visual-changes.

<!-- forge:contract -->
## Contract (recorded)

Rendered by the harness from the recorded decomposition; edit the decomposition, not this block. It is excluded from the plan's approval and grill digests, so a re-render never stales either.

**Objective.** Finish the promoted Full Forge local-dev story as a single backend/CLI tooling task: close the destructive-safety, authority, recovery, TTY-safety, and orphan-hardening gaps found by the spec/requirements/plan grills while preserving the already-landed Lite start/stop/dev behavior, and land the narrow architecture exception plus PR-ready proof.

**Acceptance criteria**

- `npm run dev` builds contracts and routes to `gantry local start`; `npm run dev:stop`, `npm run reset`, and `npm run reset:db` route to their local CLI commands; `npm run dev:core` remains the core-only source command.
- `npm run build:core` builds backend artifacts only (contracts, SDK, core `tsc`, migrations copy, CLI executable bit), composed from the same steps `build:runtime` already uses; `npm run build:runtime` and `npm run build` produce the same `dist/` output as today.
- `README.md` documents the full build-command set (`build:contracts`/`build:sdk`/`build:web`/`build:core`/`build:runtime`/`build`) and its separation from the dev/local commands, and drops any obsolete explicit-only authorization guidance — resolving the `plan-contract-partial` recurring-finding class for this story's documentation surface.
- `gantry local start|reset|reset-db|stop` are visible in top-level CLI help and dispatch through `apps/core/src/cli/local.ts` without forcing normal settings parsing before local bootstrap; `gantry local` with no subcommand prints usage and starts nothing; `local status`/`local doctor` no longer exist as duplicates of the top-level commands.
- Source-local startup validates Node 24 and source checkout, resolves runtime home with precedence `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing private `.env` defaults, and preserves existing values.
- Every destructive or mutating step (database reset, filesystem reset, migration, container start) is preceded by home safety, Node version, database-target authority (via a reversible bootstrap-then-check against the authoritative Postgres settings revision per decision 0025), and authentication-mode authority checks; a failed check leaves existing state and running children untouched — no partial reset, no stopped/started children.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at the moment of first bootstrap, never retroactively; filesystem reset refuses on any home without one, with a manual remediation, not an automatic adoption path. Database reset refuses unless the target is the exact verified home-owned managed Postgres container's endpoint (the same check `local stop` already performs), never merely "a reachable loopback database named `gantry`", and refuses a non-default `GANTRY_DATABASE_URL` for reset outright.
- Source-local startup refuses, before touching the database or filesystem, when the authoritative settings (latest Postgres revision, or `settings.yaml` for a genuinely fresh home) declare a non-default `storage.postgres.url_env` or `.schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`/a URL `schema=` param/`GANTRY_DB_SCHEMA` would redirect migrations elsewhere, naming the conflict and how to align it.
- A reset that crashes after the database schema commit but before filesystem cleanup finishes leaves a durable marker naming the interrupted variant; the next start/reset/reset-db refuses with a clear message instead of starting against mixed old/new state, lifted only by an explicit `--after-manual-recovery` flag after the operator inspects local state.
- Local startup validates a loopback control origin, creates or verifies authentication `canonicalOrigin`, runs migrations before starting source core and Vite, proxies browser auth/API traffic through Vite, and prints the stable UI URL only after health is ready (the proxied `/healthz`, not `/readyz`).
- Local DB handling reuses a reachable loopback DB, starts Compose only for the verified home-owned default Postgres container, refuses unreachable custom DBs, and refuses foreign `gantry-postgres` containers.
- `gantry local stop` stops source core and Vite through the local supervisor socket and stops only the verified home-owned managed Postgres container; custom Postgres is left alone; stop refuses to stop that container while an orphaned core process still holds an active database connection after this invocation's own children are shut down.
- Reset commands run every precondition before stopping any verified local children, refuse unsafe homes, non-loopback/non-`gantry` reset targets, and any home/database that fails ownership verification, recreate only `gantry` and `pgboss` under the reset-in-progress marker, preserve `.env`, `postgres/`, unknown files, and unrelated processes, then restart through the same healthy-start path.
- `reset-db` writes the just-validated authoritative settings revision out to `settings.yaml` (the matching recovery copy) before dropping `settings_revisions`, so a post-reset restart reflects the same desired configuration instead of stale/default YAML.
- Every successful start/reset first confirms `authentication.mode` is `local` and the public origin is loopback, then attempts (mandatory-attempt, fail-open) a fresh one-time authorization link via the same in-process issuance path `gantry ui authorize` uses after readiness — the raw URL only on an interactive TTY, otherwise the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token; a failed issuance for any reason leaves the healthy dev stack running.
- `gantry local stop` (and the next `local start`'s preflight) detects and terminates a leftover orphaned Vite process via a recorded PID file, even after the supervisor itself previously crashed.
- Existing sessions remain valid after a restart or a freshly issued link without a reset; `reset`/`reset-db` end all sessions by design. Manual verification proves restart-session-survival without storing raw URLs or tokens in artifacts.
- `python3 scripts/check_architecture.py` passes because `scripts/architecture-exceptions.json` contains a single, time-bounded `direct_risky_execution` exception for `apps/core/src/cli/local.ts`, capped to the current direct spawn count only.
- Full Forge closeout runs required focused tests, deterministic verify, one autoreview pass across quality/performance/security, records evidence, and raises the PR.

**Write scope** (what `stage done` measures the diff against)

- package.json
- apps/core/src/cli/index.ts
- apps/core/src/cli/local.ts
- apps/core/src/cli/local-postgres.ts
- apps/web/vite.config.ts
- apps/core/test/unit/cli/index-local-routing.test.ts
- apps/core/test/unit/cli/local-postgres.test.ts
- scripts/architecture-exceptions.json
- README.md
- docs/architecture/overview.md
- docs/SPEC.md
- apps/core/src/adapters/storage/postgres/storage-readiness.ts
- plans/roadmap.json

**Required tests** (run by `stage done`)

- `bare gantry local prints usage and starts nothing` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `local status and local doctor no longer exist as duplicate commands` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `filesystem reset refuses a runtime home with no ownership marker` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `full reset rewrites the ownership marker only on an already-marked home` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a non-default GANTRY_DATABASE_URL outright` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a reachable custom database coincidentally named gantry` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset preconditions run before any already-running child is stopped` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database-target authority refuses a conflicting storage.postgres.schema before any destructive step` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authentication-mode authority refuses before any child process starts` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker refuses and names the interrupted variant` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker is cleared only by --after-manual-recovery` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset-db writes the validated settings revision to settings.yaml before dropping settings_revisions` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop refuses to stop Postgres while an orphaned core connection remains` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop detects and terminates a leftover orphaned Vite process via the recorded PID file` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization link prints the raw URL only on an interactive TTY` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization issuance failure leaves the healthy dev stack running` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `IPv6 bracketed control host is normalized before binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `ownedPostgres verifies the container's published host and port binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `ownedPostgres is called unconditionally before any reset` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `pg_stat_activity check reports any active database client, not only core` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)

**Verify commands**

- `npm run test:unit -- apps/core/test/unit/cli/index-local-routing.test.ts apps/core/test/unit/cli/local-postgres.test.ts`
- `npm run format:check`
- `npm run format:check:web`
- `npm run typecheck`
- `npm run build:core`
- `npm run build`
- `python3 scripts/check_architecture.py`
- `python3 factory/scripts/verify.py`
<!-- /forge:contract -->
