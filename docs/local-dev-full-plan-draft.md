---
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
  - 0133-gantry-tool-correlation-response-meta
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0138-agents-are-service-kind-persons
  - 0142-third-console-role-approver
  - 0143-browser-write-only-secret-ingest
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
  - 0153-learned-decisions-project-into-job-grants
  - 0154-human-decision-memory-generic-scope
  - 0155-default-allow-gantry-tools-interactive-auto
  - 0156-ai-employee-console-resumable-deployment
  - 0157-jobs-use-the-chat-permission-ladder
  - 0158-provider-session-context-ceiling
  - 0159-adapter-session-release-port
  - 0160-physical-column-naming-is-snake-case
  - 0161-granted-capabilities-must-be-discoverable
---

## Problem

The Lite local-development change has already landed in this worktree, but the user has promoted the story back to Full Forge. The remaining planning problem is to make that existing implementation PR-ready without broadening the feature: `npm run dev` / `gantry local start` should run the source core and Vite together, keep the managed local database reusable, emit a fresh single-use browser authorization link after every healthy start, and keep production `npm start` / packaged runtime behavior unchanged.

The current implementation also trips `python3 scripts/check_architecture.py` because `apps/core/src/cli/local.ts` directly spawns long-lived child processes. That is intentional for a trusted operator local supervisor, but the architecture ratchet needs a narrow, count-exact exception so this does not become permission-bypass precedent for agent/tool execution.

A cold-read spec grill (recorded, `.factory/grills/spec.json`) found the Lite implementation has real destructive-safety and authority gaps that a Full Forge closeout must not paper over: `local reset` can destroy a database or directory it never verified it owns, the supervisor can reset one database while core actually runs against another, and startup can try to issue a browser-authorization link in an authentication mode that can never support it. A second cold-read grill of the requirements round (recorded, `.factory/grills/requirements.json`) re-read the spec against actual repository state and decision 0025/0003, and found the settings-authority check named the wrong source of truth, the ownership-marker design as first drafted would have violated decision 0003's no-backcompat-adoption rule (an earlier version of this plan actually proposed the forbidden retroactive-marking shim — removed below), there was no observable recovery for a crash between the database commit and filesystem cleanup, and the one-time authorization credential had no protection against non-interactive stdout capture. The owner resolved every finding in both rounds (`docs/specs/local-dev-launch.md`); this plan implements all of those resolutions. The owner also asked, mid-story, for the existing build commands to be documented and for a `build:core` command extracted from `build:runtime`, reusing existing scripts rather than adding new build machinery, and separately asked to commit in small, verified patches rather than one large commit.

## Scope / Non-goals

In scope:

- `package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`, `apps/web/vite.config.ts`, `apps/core/test/unit/cli/index-local-routing.test.ts`, `scripts/architecture-exceptions.json`, `README.md`, and Forge proof/docs artifacts. No new source files.
- Preserve the already implemented Lite behavior unless a focused test proves it wrong, or the spec-grill resolutions below require a change.
- Add exactly one architecture exception for the one direct `spawn` call in `apps/core/src/cli/local.ts`, with a reason that limits it to the trusted operator-owned source supervisor.
- Reset and stop ownership: write a Gantry-created ownership marker ONLY at the moment a genuinely new runtime home is first bootstrapped (never retroactively onto an existing unmarked home — decision 0003 forbids that adoption path); require the marker before filesystem reset, refusing an unmarked home with a manual remediation instead. Require `local reset`/`local reset-db` to target only the verified home-owned managed Postgres container's exact endpoint (reusing the existing `ownedPostgres` check `local stop` already has, run unconditionally before reset), refusing a reachable custom database even if it is loopback and named `gantry`, and refusing a non-default `GANTRY_DATABASE_URL` for reset outright.
- Preflight-then-destroy ordering: run every precondition (home safety, Node version, database-target authority, authentication-mode authority) before any destructive or mutating step, including before stopping already-running local children for a reset; a failed precondition leaves existing state and running children untouched.
- Database-target authority: per decision 0025, the latest Postgres settings revision is authoritative when one exists; a reversible bootstrap-then-check starts only the verified home-owned container to read it, then stops it again on failure. Refuse before any destructive step if the authoritative settings declare a non-default `storage.postgres.url_env` (correct key name) or `.schema`, or if `GANTRY_SETTINGS_POSTGRES_SCHEMA` / a URL `schema=` param / `GANTRY_DB_SCHEMA` would redirect migrations to a different schema than core will use.
- Reset crash recovery: write a durable reset-in-progress marker before the destructive database step, clear it only after that reset variant's last destructive step completes; a subsequent command finding a stale marker refuses with a clear message and a rerun remediation rather than starting against mixed old/new state. This is a durable flag and a refusal, not a new lock.
- Authentication-mode authority: refuse before starting any child process if `authentication.mode` is not `local` or the public origin is not loopback, instead of starting a healthy stack and then failing authorization forever.
- Token-output safety: print the raw one-time authorization URL only when stdout is an interactive TTY; for non-TTY stdout, print only the stable UI URL and a `--runtime-home`-inclusive retry command, never the raw token.
- Orphan-stop refusal: `local stop` refuses to stop the managed Postgres container if, after this invocation's own managed children are shut down, the database still shows an active connection from an orphaned core process (reusing the existing `pg_stat_activity` check already used by reset) — not a public health probe, since core's port is private behind Vite and would falsely read as "nothing running" if only Vite died.
- CLI surface: remove the undocumented, duplicate `local status`/`local doctor` (top-level `gantry status`/`gantry doctor` already cover this); bare `gantry local` prints usage and does not start anything.
- One small IPv6 fix: `GANTRY_CONTROL_HOST`'s literal bracketed form is normalized before being handed to a bind-style API (URL construction still needs the brackets).
- Session-preservation criterion is narrowed to restart/relaunch without a reset; `reset` and `reset-db` both recreate the `gantry` schema and end all sessions by design.
- `settings.yaml`'s Surface Impact is `Changed`, matching what the code already does (creates it, deletes/recreates it on full reset); it is authoritative only for a genuinely fresh home with no settings revision yet, per decision 0025.
- Build commands: extract `build:core` (backend-only artifacts, no web) out of `build:runtime`, keeping `build:runtime`'s and `build`'s effective output identical; document the full build-command set and its separation from the dev/local commands in `README.md` and the spec.
- Deferred items are registered on the ledger, not merely stated in prose: D-0092 (Docker-only startup) and D-0093 (cross-process reset lock), both via `./forge defer add`.
- Commit in small, focused, individually-verified patches as the implementation proceeds, rather than one commit at stage close; keep Forge evidence commits separate from product-code commits where the split is clean.
- Keep `npm run dev:core` as the old core-only source command.
- Keep `npm start` as the built, core-only production command.
- Keep source-local dev on reachable loopback DB reuse; start Compose only for the verified home-owned default Postgres container.
- Issue a fresh short-lived, single-use UI authorization link after every successful `local start`, `local reset`, and `local reset-db` readiness check.
- Preserve existing browser sessions; a new link must not revoke already valid sessions.
- Record proof through Forge-approved scripts only.

Out of scope / deferred:

- Docker-only startup on a dedicated public port is deferred to a follow-up (D-0092); reopen when local source mode needs a containerized full stack instead of source core plus Vite.
- A new cross-process, DB-scoped mutual-exclusion lock for concurrent reset attempts is deferred (D-0093); preflight-then-destroy ordering, ownership verification, and the reset-in-progress marker are in scope, a new distributed-locking mechanism is not.
- Extending browser-authorization issuance to non-`local` authentication modes is out of scope; source-local dev requires `authentication.mode=local`.
- React page, component, styling, or route edits are out of scope.
- API/SDK schema changes are out of scope.
- Database schema changes and migration-hash repairs are out of scope.
- Reworking agent/tool command execution, sandbox policy, or `approved-command-runner` is out of scope.
- Adding a real (non-mocked) Postgres/Docker integration test lane is out of scope; focused mocked unit tests plus manual disposable-home verification is the agreed bar for this PR.
- Resetting real developer or production data during verification is forbidden; use disposable runtime homes and disposable databases only.
- Authorization tokens/URLs must not be copied into proof artifacts, PR bodies, or logs captured as evidence.

## Acceptance Criteria

- `npm run dev` builds contracts and routes to `gantry local start`; `npm run dev:stop`, `npm run reset`, and `npm run reset:db` route to their local CLI commands; `npm run dev:core` remains the core-only source command.
- `npm run build:core` builds backend artifacts only (contracts, SDK, core `tsc`, migrations copy, CLI executable bit), composed from the same steps `build:runtime` already uses; `npm run build:runtime` and `npm run build` produce the same `dist/` output as today.
- `gantry local start|reset|reset-db|stop` are visible in top-level CLI help and dispatch through `apps/core/src/cli/local.ts` without forcing normal settings parsing before local bootstrap; `gantry local` with no subcommand prints usage and starts nothing; `local status`/`local doctor` no longer exist as duplicates of the top-level commands.
- Source-local startup validates Node 24 and source checkout, resolves runtime home with precedence `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing private `.env` defaults, and preserves existing values.
- Every destructive or mutating step (database reset, filesystem reset, migration, container start) is preceded by home safety, Node version, database-target authority (via a reversible bootstrap-then-check against the authoritative Postgres settings revision per decision 0025), and authentication-mode authority checks; a failed check leaves existing state and running children untouched — no partial reset, no stopped/started children.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at the moment of first bootstrap, never retroactively; filesystem reset refuses on any home without one, with a manual remediation, not an automatic adoption path. Database reset refuses unless the target is the exact verified home-owned managed Postgres container's endpoint (the same check `local stop` already performs), never merely "a reachable loopback database named `gantry`", and refuses a non-default `GANTRY_DATABASE_URL` for reset outright.
- Source-local startup refuses, before touching the database or filesystem, when the authoritative settings (latest Postgres revision, or `settings.yaml` for a genuinely fresh home) declare a non-default `storage.postgres.url_env` or `.schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`/a URL `schema=` param/`GANTRY_DB_SCHEMA` would redirect migrations elsewhere, naming the conflict and how to align it.
- A reset that crashes after the database schema commit but before filesystem cleanup finishes leaves a durable marker; the next start/reset refuses with a clear message and a rerun remediation instead of starting against mixed old/new state.
- Local startup validates a loopback control origin, creates or verifies authentication `canonicalOrigin`, runs migrations before starting source core and Vite, proxies browser auth/API traffic through Vite, and prints the stable UI URL only after health is ready (the proxied `/healthz`, not `/readyz`).
- Local DB handling reuses a reachable loopback DB, starts Compose only for the verified home-owned default Postgres container, refuses unreachable custom DBs, and refuses foreign `gantry-postgres` containers.
- `gantry local stop` stops source core and Vite through the local supervisor socket and stops only the verified home-owned managed Postgres container; custom Postgres is left alone; stop refuses to stop that container while an orphaned core process still holds an active database connection after this invocation's own children are shut down.
- Reset commands run every precondition before stopping any verified local children, refuse unsafe homes, non-loopback/non-`gantry` reset targets, and any home/database that fails ownership verification, recreate only `gantry` and `pgboss` under the reset-in-progress marker, preserve `.env`, `postgres/`, unknown files, and unrelated processes, then restart through the same healthy-start path.
- Every successful start/reset first confirms `authentication.mode` is `local` and the public origin is loopback, then emits a fresh one-time authorization link via the existing `gantry ui authorize` flow after readiness — the raw URL only on an interactive TTY, otherwise the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token; a failed issuance for any other reason leaves the healthy dev stack running.
- Existing sessions remain valid after a restart or a freshly issued link without a reset; `reset`/`reset-db` end all sessions by design. Manual verification proves restart-session-survival without storing raw URLs or tokens in artifacts.
- `python3 scripts/check_architecture.py` passes because `scripts/architecture-exceptions.json` contains a single, time-bounded `direct_risky_execution` exception for `apps/core/src/cli/local.ts`, capped to the current direct spawn count only.
- Full Forge closeout runs required focused tests, deterministic verify, one autoreview pass across quality/performance/security, records evidence, and raises the PR.

## Technical Approach

Keep the existing implementation shape and tighten only the Full Forge gaps. `local.ts` remains the local source-mode coordinator because it already owns runtime-home resolution, local DB handling, resets, child supervision, health readiness, and auth-link issuance. Splitting this into a new service layer would add ceremony without changing the trusted local-operator boundary.

`approved-command-runner` is not the right helper here. It is a bounded, buffered command runner for already approved commands: it pipes stdout/stderr, enforces a timeout, redacts retained output, and returns only after the child exits. The local source supervisor needs long-lived children with inherited stdio, process-group termination, health polling, sibling shutdown, and a stop socket. Forcing it through the buffered runner would either break dev-server interactivity or require building a second supervisor on top of it.

The direct-spawn architecture exception must therefore be narrow and honest: one file, one rule, current count only, reason tied to a human operator starting a trusted source checkout, and removal condition tied to a future source-supervisor application port if this boundary becomes shared. It must not approve direct execution from agents, jobs, provider adapters, tool calls, or arbitrary shell input.

Auth link generation should continue to reuse `gantry ui authorize` instead of duplicating token creation. That keeps expiry, single-use storage, hashing, and browser-auth redemption in the existing auth path. The supervisor should print only labels and retry instructions around that command; it must not persist plaintext authorization URLs.

Vite should stay the public loopback surface for source-local dev and proxy `/ui/api`, `/auth`, `/v1`, `/healthz`, `/readyz`, and `/metrics` to the private source core. Production built UI serving remains untouched.

The two spec grills' resolved findings become a set of small, targeted additions to `local.ts`, none of which change its shape as a single CLI coordinator:

- **Ownership marker, bootstrap-only.** When `localEnvironment` bootstraps a home that did not exist before this invocation created it (the same branch that currently seeds `.env` defaults for a fresh home), also write a small Gantry-owned marker file. It is never written to an already-existing, unmarked home — the requirements grill found that "retroactive marking" is exactly the compatibility/adoption path decision 0003 forbids. `validateLocalHome`'s existing unsafe-path/symlink checks are necessary but not sufficient — they rule out obviously wrong homes, not confirm Gantry created this one. Filesystem reset refuses on a home without the marker, with a manual remediation (move/delete the old home, or use a new `--runtime-home` so a fresh, marked home is bootstrapped).
- **Database ownership bound to the reset endpoint.** `resetLocalDatabase` currently accepts any loopback DB literally named `gantry`/schema `gantry`, and `ensureLocalDatabase` only calls the existing `ownedPostgres` check on its fresh-start path, returning early (skipping the check) whenever the target is already reachable. Call `ownedPostgres` unconditionally before any reset, for the same container the supervisor is about to migrate/reset; refuse reset outright for a non-default `GANTRY_DATABASE_URL`, since a custom target's ownership can never be verified against a specific Docker container.
- **Reversible bootstrap-then-check for settings authority.** Decision 0025 makes the latest Postgres settings revision authoritative, but reading it needs Postgres up, and nothing destructive may run before authority is confirmed. Start (or confirm running) only the verified home-owned container as a reversible preflight step, read the latest settings revision (falling back to `settings.yaml` only when no revision exists yet — a genuinely fresh home), validate `storage.postgres.url_env` (the actual key; not `urlEnv`) and `.schema` plus `GANTRY_SETTINGS_POSTGRES_SCHEMA`/URL `schema=`/`GANTRY_DB_SCHEMA` against the local-mode defaults, then either continue or stop that container again before returning a precondition failure.
- **Full preflight reordering, including reset's own child-stop.** `runLocalCommand`'s `reset`/`reset-db` branch currently calls `stopLocalDevelopment(home)` before `superviseLocal` runs any of the checks above — move every precondition (home safety, Node version, database-target authority, authentication-mode authority) ahead of that stop call, so a failed precondition never leaves already-stopped children as a side effect.
- **Authentication-mode authority.** Before starting any child process, refuse when `authentication.mode` is not `local` or the origin is not loopback — `gantry ui authorize` already refuses non-local mode correctly (`apps/core/src/cli/auth.ts`), the gap is only that `local.ts` does not check first, so it starts a healthy stack and then fails authorization forever.
- **Reset-in-progress marker for crash recovery.** Write a durable marker file immediately before `resetLocalDatabase` runs; remove it only after that reset variant's last destructive step (filesystem cleanup for `reset`, schema recreation for `reset-db`) completes. A subsequent command that finds a stale marker refuses with a clear message and a rerun remediation. This is a durable flag plus a refusal, not a lock — concurrent-reset mutual exclusion stays deferred (D-0093).
- **TTY-gated token output.** Print the raw authorization URL only when `process.stdout.isTTY` is true; otherwise print the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token, so non-interactive capture (shell redirection, IDE task logs, CI) can never persist the credential.
- **Orphan-stop refusal via the database, not a public probe.** Core binds a private ephemeral port behind Vite, so a public-origin health probe cannot see an orphaned core process if Vite died. Reuse the existing `pg_stat_activity` active-connection check (already used by `resetLocalDatabase`) in `runLocalCommand`'s `stop` branch, run after this invocation's own managed children are shut down: if any other connection remains, refuse to stop Postgres and report the orphaned state.
- **CLI-surface reduction.** Remove `local status`/`local doctor` (duplicates of the existing top-level `gantry status`/`gantry doctor`); make bare `gantry local` print usage instead of dispatching to `start`.
- **IPv6 fix.** Normalize the `[::1]` literal bracket form before it reaches a bind-style API (construction of the `http://` origin URL already needs the brackets; a raw bind/listen call does not).

Build commands: extract the non-web portion of `build:runtime`'s step list into a new `build:core` script (contracts, SDK, `tsc`, migrations copy, chmod), then redefine `build:runtime` as `build:core && build:web && copy:web`. The resulting `dist/` output is unchanged; the seam is just named and independently runnable, mirroring `dev:core`'s relationship to `dev`.

Workflow: this is one Full Forge story with one implementation task. The additions above are all inside the same coordinator file and its tests — none introduce a new module, a new dependency, or a new architectural seam, so splitting into more tasks would add ceremony without a real boundary to split on. The story is visible CLI behavior, but the implementation task records `user_facing: false` because it does not build UI screens, components, styling, or motion. After the draft is approved, record the plan, record decomposition, run the task grill, implement only the scoped files, record tests, run deterministic verify, run the single autoreview helper for quality/performance/security, record reviews, record outcome, and run `pr_ready.py` before opening the PR.

## Decisions

No new decision files were created in this planning draft; the spec grill's resolutions were recorded as spec text (`docs/specs/local-dev-launch.md`, confirmed) rather than new decisions, since they implement existing decisions 0025 and 0132 rather than establishing new policy.

The operator-supervisor exception is already approved in `docs/specs/local-dev-launch.md` as: “A narrow one-call exception covers the operator-owned source supervisor; agent/tool execution remains behind the existing sandbox boundary.” This plan and its task own adding the exact, count-exact, time-bounded exception entry to `scripts/architecture-exceptions.json` — the exception does not exist yet on disk (confirmed by the spec grill); do not treat the spec's description of it as already satisfied.

Existing decisions that govern the plan include `0001-agent-runtime-platform` and `0018-provider-neutral-agent-execution-adapter` for the sandbox boundary, `0023-deployment-modes` and `0025-settings-authority` for local vs production runtime shape and settings-revision authority, `0120-local-cli-structured-invocation` for local CLI capability discipline, `0132-adaptive-browser-authentication-access` for browser auth and the loopback/local-mode requirement, and `0143-browser-write-only-secret-ingest` for secret/token handling.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| runtime behavior | Changed | Source-local start/reset supervises source core plus Vite and emits a fresh auth link after readiness; production `npm start` remains unchanged. |
| API | Unchanged by design | Browser auth, health, ready, metrics, and `/v1` routes are reused through the Vite proxy; no route contract changes. |
| data/schema | Unchanged by design | No migrations or schema edits; auth-code persistence uses the existing `gantry ui authorize` writer. |
| CLI/ops | Changed | `npm` scripts and `gantry local start/reset/reset-db/stop` route through the local supervisor; `local status`/`local doctor` are removed as duplicates and bare `gantry local` now prints usage. |
| UI | Read-only | Vite config proxies the existing web app; no React page/component edits. |
| docs | Changed | This plan plus Forge proof/docs updates; existing spec already captures the approved Full scope and deferral. |
| tests | Changed | Focused CLI local-routing tests cover env/home precedence, DB/reset boundaries, ownership/authority refusals, preflight ordering, orphan-stop refusal, supervisor ordering, auth-link issuance failure, and stop behavior. |
| settings.yaml | Changed | Local startup creates it when missing and full reset deletes/recreates it; authoritative only for a genuinely fresh home with no settings revision yet (decision 0025 governs otherwise); validates `authentication.canonicalOrigin` and `storage.postgres.url_env`/`schema` against the local defaults; existing conflicting settings fail with remediation. Reimport as the authoritative revision on next core startup is existing bootstrap behavior, not new code. |
| Postgres/runtime projection | Changed | Local reset recreates `gantry`/`pgboss` only against the verified home-owned managed container's exact endpoint, guarded by a reset-in-progress marker; auth link issuance inserts hashed single-use authorization state through existing storage. |
| control API | Unchanged by design | Existing browser-auth redemption path is reused. |
| SDK/contracts | Unchanged by design | No generated contracts or SDK APIs change. |
| Gantry MCP tools/admin skill | N-A | No MCP/admin tool surface changes. |
| channel/provider adapters | Unchanged by design | Local browser auth and dev startup do not alter provider/channel adapters. |
| audit/events | Unchanged by design | Existing auth flow owns any related events; local supervisor adds no new audit contract. |

## Task Decomposition

1. `LOCAL-DEV-FULL-T1` — Full local source-dev supervisor closeout

   Story visibility: true for CLI behavior. Task `user_facing: false`.

   Objective: finish the promoted Full Forge local-dev story as a single backend/CLI tooling task, preserving Lite behavior while adding the narrow architecture exception and PR-ready proof.

   Write scope: `package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`, `apps/web/vite.config.ts`, `apps/core/test/unit/cli/index-local-routing.test.ts`, `scripts/architecture-exceptions.json`, `README.md`, and Forge proof/docs artifacts only. No new source files.

   Acceptance criteria: all criteria in this plan’s Acceptance Criteria section.

   Required tests: focused unit coverage in `apps/core/test/unit/cli/index-local-routing.test.ts` for local command routing (including bare `gantry local` printing usage and `local status`/`local doctor` no longer existing), runtime-home precedence, `.env` default preservation, loopback origin/DB validation, managed/default DB vs custom DB behavior, reset file boundaries, migration-before-core ordering, Vite/core launch, auth-link launch after readiness, auth-link failure nonfatal behavior, stop socket/process-group cleanup, `gantry local stop` managed-container limits, bootstrap-only ownership-marker-gated filesystem reset (never retroactive), database-ownership-gated database reset bound to the exact managed endpoint (including refusal of a coincidentally-named custom database and outright refusal of a non-default `GANTRY_DATABASE_URL`), preflight-then-destroy ordering including reset's own child-stop moving after preflight, database-target-authority refusal on a conflicting settings revision/`settings.yaml`/schema-override env var, authentication-mode/loopback-authority refusal before any child process starts, reset-in-progress marker refusal after a simulated crash between DB commit and filesystem cleanup, orphan-stop refusal via the active-connection check when core is orphaned with no active socket, TTY-gated vs non-TTY authorization output, the `--runtime-home`-inclusive retry message, and IPv6 bracket-form host normalization.

   Reviewer focus: enforce the constitution and ponytail shape. This should remain a small CLI coordinator, not a new framework. Reviewers should specifically check that the direct-spawn exception is count-exact and operator-local only; no agent/tool sandbox bypass was introduced; no production start path changed; no migration hashes or schema files were repaired; no real-data reset is required for verification; no raw authorization tokens/URLs appear in artifacts; every destructive step is genuinely preceded by its precondition checks (not merely reordered in appearance); the ownership marker is never written to a pre-existing unmarked home (decision 0003); and the ownership/authority checks reuse existing helpers (`ownedPostgres`, `ensureRuntimeSettings`, the `pg_stat_activity` query) rather than introducing new abstractions.

## Risks

- Architecture exception drift: a broad exception would normalize direct risky execution outside the sandbox boundary. Mitigation: one file, one rule, max current count, reason tied to trusted local operator supervision, and architecture check in required verification.
- Token leakage in evidence: successful auth output may include a usable URL. Mitigation: do not paste raw authorization links into `.factory`, docs, PR bodies, or chat; record only that a link was printed/redacted.
- Reset blast radius: reset commands can destroy local state if path/DB checks regress. Mitigation: preserve unsafe-home, symlink, non-loopback DB, wrong DB/schema, active-client, `.env`, `postgres/`, and unknown-file tests; manual verification uses disposable homes only.
- False confidence from mocked supervisor tests: unit tests prove orchestration order but not real browser/session behavior. Mitigation: add manual disposable-home verification for link redemption and existing-session preservation.
- Long-running test lanes may be noisy in this checkout. Mitigation: run focused tests first, then deterministic verify; report exact pass/fail/block status and do not call silent or nonterminating Vitest runs green.
- Existing recurring finding `plan-contract-partial` is not in this local-dev area. Tripwire: if plan grill or autoreview flags partial acceptance criteria again, amend this plan before implementation rather than patching around it.
- Ownership-marker false refusal: an existing home from before this change has no marker and would be refused on first `local reset` after upgrade. Mitigation: this is intentional, not a bug — decision 0003 forbids retroactively adopting an unmarked home as reset-authorized. `local start`/`reset-db` are unaffected; the documented remediation for an old home is to move it aside or point `--runtime-home` at a new path so a fresh, marked home is bootstrapped. Call this out explicitly in the PR body and README as a deliberate, one-time upgrade note.
- Database-authority false refusal: a developer who intentionally customized `storage.postgres.url_env`/`schema` for source-local dev would now be refused. Mitigation: the refusal message must name the exact conflicting setting and how to align it, and this is accepted as intended per the owner's decision to enforce authority defaults.
- Reset-in-progress marker false refusal: a genuinely interrupted reset (not a crash) — e.g. the operator's own Ctrl-C during reset — also leaves the marker and triggers the same refusal on next run. Mitigation: this is the correct behavior (the reset truly did not finish); the remediation message says to rerun the same reset command, which is always safe since reset is idempotent per the ownership/authority checks.

## Verify Plan

Automated verification:

- `npm run test:unit -- apps/core/test/unit/cli/index-local-routing.test.ts`
- `npm run format:check`
- `npm run typecheck`
- `npm run build:core` (confirms the extracted script still produces backend artifacts)
- `npm run build` (confirms `dist/` output is unchanged end-to-end)
- `python3 scripts/check_architecture.py`
- `python3 .agents/scripts/verify.py --print-only` to confirm the deterministic gate shape before the full run
- `python3 .agents/scripts/verify.py`

Manual Verification:

- Use a disposable `--runtime-home` under a temporary directory and a disposable loopback Postgres target only; do not touch real developer or production runtime data.
- Start with `npm run dev -- --runtime-home <tmp-home>` or `npm run cli:dev -- local start --runtime-home <tmp-home>` as supported by the script routing, verify health and UI URL, and confirm the authorization link is printed only after readiness. Redact the URL in notes.
- Redeem the first link in a browser, confirm the UI session works, restart local dev, and confirm a new link is printed while the existing session remains valid.
- Redeem the old link a second time or after issuing a new one and verify single-use behavior through the existing auth path; record only pass/fail, never the token.
- Run `gantry local stop --runtime-home <tmp-home>` and confirm source core/Vite stop and only the verified home-owned managed Postgres container is stopped. If using a custom DB, confirm it is reported as externally managed and left running.
- Run `gantry local reset-db --runtime-home <tmp-home>` and `gantry local reset --runtime-home <tmp-home>` against disposable state, confirming `.env`, `postgres/`, and unknown files are preserved while known runtime state is removed only for full reset, and confirming the ownership marker survives `reset-db` and is rewritten fresh by `reset`.
- Point a disposable home's `--runtime-home`/`GANTRY_DATABASE_URL` at a reachable custom loopback Postgres named `gantry`/`gantry` that is NOT the managed container, and confirm `local reset` refuses it instead of dropping its schema.
- Redirect a disposable authorization retry to a non-TTY sink (`gantry ui authorize > /tmp/out.txt`, or run inside the failure path with stdout piped) and confirm the raw URL never appears in that file, only the stable UI URL and retry command.
- Kill the process mid-`local reset` after its database step (a deliberate `kill -TERM` between schema recreation and filesystem cleanup on disposable state) and confirm the next command refuses with the reset-in-progress remediation instead of starting.

This manual pass against a real disposable Docker Postgres container is the project's DB-backed-change verification requirement (`docs/architecture/current-verification-commands.md`) satisfied without a new automated integration-test lane, since the behavior under test is CLI/process lifecycle, not application-layer database queries.

Forge closeout verification (evidence and PR mechanics are owned by the plan/harness, not the capability spec):

- Record automated test evidence via `record_test_from_json.py` with `generated_by: implementer`.
- Run the single autoreview helper once for quality, performance, and security; rerun only after accepted fixes, then record all three review artifacts.
- Run `python3 factory/scripts/pr_ready.py` after tests, verify, reviews, and outcome are recorded.
- Raise the PR after the gate passes, with PR text that states the local-dev goal, the narrow operator exception, verification limits, and token-redaction discipline.
