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
npm run test:unit
npm run test:integration
npm run test:integration:postgres
npm run test:e2e
```

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

`npm run test:integration` is credential-free and skips Postgres-backed suites when `MYCLAW_TEST_DATABASE_URL` is unset. DB-backed changes must also run:

```bash
MYCLAW_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/myclaw_test npm run test:integration:postgres
```

`npm run test:integration:postgres` fails loudly when `MYCLAW_TEST_DATABASE_URL` is missing or not a Postgres URL, so a green default test run cannot be mistaken for database-backed evidence.

Architecture exceptions in `.codex/architecture-exceptions.json` are ratchets
for existing boundary debt. Each exception must stay time-bounded and include a
maximum count so `python3 .codex/scripts/check_architecture.py` still fails
when a branch adds new layer, provider, risky-execution, old-term, or
wrapper-only debt.

## Factory And Release Gates

```bash
python3 .codex/scripts/check_agents_hygiene.py
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/validate_work.py
```

`python3 .codex/scripts/verify.py` currently runs format, build, structural architecture, runtime truth, factory Python tests, typecheck, tests, and e2e unless overridden with `FACTORY_*` environment variables.

Use this command to inspect the deterministic verification contract without running every phase:

```bash
python3 .codex/scripts/verify.py --print-only
```

## Missing Or Currently Failing Commands

As of 2026-05-06, the domain/application cutover removes the legacy `RegisteredGroup` type and the monolithic runtime ops port from active ports. `python3 .codex/scripts/check_architecture.py` may still report old runtime terminology in adapter, CLI, and host-runtime compatibility surfaces until those outer seams are renamed to provider/conversation/thread language.

For this persistence cut, treat remaining matches for old table names in earlier migration files as historical migration context. Active Postgres schema and repository tables must use the canonical table names from migration `0009_canonical_persistence_adapter_cut`.
