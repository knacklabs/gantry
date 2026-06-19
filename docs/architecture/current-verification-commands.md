# Current Verification Commands

Use Node `>=24 <26` for local development, CI, and runtime deployments. The package manager is `npm`.

## Setup

```bash
npm install
```

## Small Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm run security:audit
npm run security:sbom
npm run security:package
npm run security:images
npm run test:unit
npm run test:integration
npm run test:integration:postgres
npm run test:e2e
```

`security:audit` is scoped to production dependencies. The current Drizzle Kit
development-only advisory requires a breaking/downgrade package-manager change
to silence and is not part of the production runtime dependency gate.

Durable session resume changes should additionally run the focused unit checks:

```bash
npm run test:unit -- apps/core/test/unit/application/session-resume-use-cases.test.ts apps/core/test/unit/runtime/group-processing.test.ts
```

Postgres-backed continuity changes should add the focused repository and
integration checks:

```bash
npm run test:unit -- apps/core/test/unit/application/session-resume-use-cases.test.ts apps/core/test/unit/runtime/session-resume-runtime.test.ts apps/core/test/unit/adapters/storage/postgres/canonical-session-repository.postgres.test.ts apps/core/test/unit/adapters/storage/postgres/canonical-ops-repo.postgres.test.ts
npm run test:integration:postgres -- apps/core/test/integration/session-continuity-postgres.integration.test.ts apps/core/test/integration/postgres-domain-repositories.integration.test.ts
```

Provider-session artifact and redaction changes should run:

```bash
npm run test:unit -- apps/core/test/unit/session/provider-transcript-archive.test.ts apps/core/test/unit/adapters/postgres-provider-artifact-store.test.ts apps/core/test/unit/application/sessions/session-interaction-module.test.ts apps/core/test/unit/runner/claude-logging.test.ts
```

Canonical tool execution boundary changes should run:

```bash
npm run test:unit -- apps/core/test/unit/shared/tool-execution-policy-service.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runner/protected-capability-hook.test.ts apps/core/test/unit/runner/protected-capability-guard.test.ts apps/core/test/unit/runner/mcp/scheduler-tools.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runner/agent-runner-ipc.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts
npm run test:integration -- apps/core/test/integration/claude-agent-sdk-boundary.integration.test.ts apps/core/test/integration/permission-approval-ipc.integration.test.ts
rg -n "PROTECTED_CAPABILITY_PATTERN|mcpServers.*Bash|\\.mcp\\.json.*Bash|permissionMode.*Bash|alwaysAllowedTools|continue: false|target_json\\.capabilityPolicy|jobExtraTools|runScript\\(" apps/core/src apps/core/test docs --glob '!docs/architecture/current-verification-commands.md'
rg -n "scheduler_grant_tool" apps/core/src apps/core/test docs --glob '!docs/architecture/current-verification-commands.md'
rg -n "allow_job_policy" apps/core/src apps/core/test docs --glob '!docs/architecture/current-verification-commands.md'
python3 .codex/scripts/check_architecture.py
```

Expected cleanup-search interpretation:

- active protected capability denial should flow through
  `ToolExecutionPolicyService`, with Claude hook/guard files acting only as
  adapter projections;
- `continue: false` remains expected only for single protected SDK hook blocks,
  not ordinary tool-policy denial;
- docs and tests may mention protected terms to prove target-based behavior;
  active Bash policy should fail closed when a protected path is an action
  target, while preserving explicitly safe text-payload flows such as issue or
  PR bodies.
- SDK Bash/file/MCP subprocess protection should be visible as
  `sandbox.filesystem.denyWrite` entries sourced from
  `GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON`; direct scheduler scripts should
  fail closed until an equivalent OS sandbox runner exists.

Clean-cut session continuity cleanup must also verify that unsupported legacy
continuity paths did not return:

```bash
rg -n "legacyAgentSessionId|legacyDescendantIdLike|descendantUserIdLike|metadata_json::jsonb #>>|id LIKE 'agent-session|compatibility backfill|old-state import|repair old" apps/core/src apps/core/test docs --glob '!docs/architecture/current-verification-commands.md'
rg -n "scope_key|agent_session_digests|ProviderSession.externalSessionId|provider-session" docs/architecture/session-resume.md docs/architecture/provider-session-artifacts.md apps/core/AGENTS.md apps/core/src/adapters/storage/postgres/AGENTS.md apps/core/src/adapters/storage/postgres/repositories apps/core/test/unit apps/core/test/integration
```

Expected cleanup-search interpretation:

- stale legacy continuity identifiers, JSON metadata-derived scope lookups, old
  state imports, and repair/backfill compatibility paths should have no active
  runtime or repository matches;
- `provider-session` remains expected in current provider metadata,
  redaction/logging tests, artifact-store code, and docs because provider
  artifacts and provider resume handles are adapter metadata, not canonical
  continuity state;
- migration or decision-history mentions are historical context only and must
  not be referenced by active runtime startup, reset, or resume code.

No-legacy runtime cleanup slices should also record broad search evidence:

```bash
rg -n "legacy|compat|shim|old path|TODO: remove|remove after refactor|legacy/|linkedSessions|deliverTo|threadId|sessionId|legacy_message_row|system:dreaming" apps/core/src apps/core/test docs/architecture/current-verification-commands.md -S
```

Expected cleanup-search interpretation:

- `threadId` and `sessionId` remain expected when they are the current canonical
  execution, session, and thread field names; do not rewrite them only to
  satisfy text search.
- `linkedSessions`, `deliverTo`, `notificationTarget`, and old top-level
  scheduler route aliases should appear only in reject-only tests, migration
  rejection evidence, or the runtime parser's unsupported-field denylist.
- `system:dreaming` remains expected for current system-owned memory dreaming
  job IDs and unit tests.
- `legacy`, `compat`, `shim`, and removal-TODO matches in active runtime code
  require review unless they are denylist/error-message text or test names that
  prove old behavior is rejected.

Architecture cleanup slices that touch outbound delivery contracts should also run:

```bash
rg -n "iterTelegramTextChunks|countTelegramTextChunks|sendWithPartialDeliveryGuard|PartialMessageDeliveryError|TELEGRAM_DRAFT_MAX_LENGTH|partially_sent" .
rg -n "bot\\.api\\.sendMessage\\(|chat\\.postMessage\\(|sdkClient\\.sendMessage\\(" apps/core/src/app apps/core/src/runtime apps/core/src/jobs apps/core/src/session apps/core/src/domain apps/core/src/application
python3 .codex/scripts/check_architecture.py
```

## Default Test And Build

```bash
npm test
npm run build
```

`npm test` runs the contracts build, unit tests, and integration tests. `npm run build` cleans generated build output, builds contracts and SDK packages, runs `tsc`, and copies Postgres migrations into `dist/`.

`npm run test:integration` is credential-free and skips Postgres-backed suites when `GANTRY_TEST_DATABASE_URL` is unset. DB-backed changes must also run against a disposable Docker Postgres container for the current task. Enable `vector` and `pg_trgm` in that disposable database before running migrations:

```bash
GANTRY_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gantry_test npm run test:integration:postgres
```

`npm run test:integration:postgres` fails loudly when `GANTRY_TEST_DATABASE_URL` is missing or not a Postgres URL, so a green default test run cannot be mistaken for database-backed evidence. Stop and remove the disposable container after the check; do not run feature verification against persistent developer data under `~/gantry/postgres`.

Architecture exceptions in `.codex/architecture-exceptions.json` are ratchets
for existing boundary debt. Each exception must stay time-bounded and include a
maximum count so `python3 .codex/scripts/check_architecture.py` still fails
when a branch adds new layer, provider, risky-execution, old-term, or
wrapper-only debt.

Anthropic/Claude provider-boundary debt is tracked separately in
`.codex/provider-boundary-exceptions.json`. Entries must use exact file paths
and exact token counts. The checker fails when a new token appears outside
`apps/core/src/adapters/llm/anthropic-claude-agent/**`, when an expected count
changes, or when broad config, memory, or shared paths are approved for this
gate.

## Factory And Release Gates

```bash
python3 .codex/scripts/check_agents_hygiene.py
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/validate_work.py
```

LOCAL-35 refactor phase progress uses the recorded T0 baseline:

```bash
python3 .codex/scripts/check_refactor_line_delta.py --check-diff --baseline-file docs/architecture/refactor-baseline.md
```

By default this phase check includes committed changes, tracked working-tree
changes, and untracked source files under the checked paths. Use
`--committed-only` only when intentionally inspecting the committed branch
scope; the default gate must remain the working review scope.

The final PR or overall refactor deletion target remains a branch-base check:

```bash
python3 .codex/scripts/check_refactor_line_delta.py --check-diff --base-ref origin/main
```

`python3 .codex/scripts/verify.py` runs structural format checks, build,
architecture, runtime truth, factory Python tests, typecheck, tests, and e2e
unless overridden with `FACTORY_*` environment variables. It prints phase
start/finish progress and records per-phase timing in `.factory/verify.json` so
long phases are diagnosable while they run. Each phase has a 30-minute timeout
by default; local factory debugging can override that with
`FACTORY_VERIFY_TIMEOUT_SECONDS`.

Use this command to inspect the deterministic verification contract without running every phase:

```bash
python3 .codex/scripts/verify.py --print-only
```

Use this command when you want independent read-only post-build checks to run in
parallel without changing the default command contract:

```bash
python3 .codex/scripts/verify.py --parallel-safe
```

## Missing Or Currently Failing Commands

As of 2026-05-06, the domain/application cutover removes the legacy `RegisteredGroup` type and the monolithic runtime ops port from active ports. `python3 .codex/scripts/check_architecture.py` may still report old runtime terminology in adapter, CLI, and host-runtime compatibility surfaces until those outer seams are renamed to provider/conversation/thread language.

For this persistence cut, treat remaining matches for old table names in earlier migration files as historical migration context. Active Postgres schema and repository tables must use the canonical table names from migration `0009_canonical_persistence_adapter_cut`.
