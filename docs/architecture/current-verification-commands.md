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
npm run test:e2e
```

## Default Test And Build

```bash
npm test
npm run build
```

`npm test` runs the contracts build, unit tests, and integration tests. `npm run build` cleans generated build output, builds contracts and SDK packages, runs `tsc`, and copies Postgres migrations into `dist/`.

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

As of 2026-04-27, `python3 .codex/scripts/check_architecture.py` still reports existing layer-boundary, provider-specific string, old runtime term, empty-folder, and wrapper-only issues across the runtime, CLI, channel, and legacy workspace projection surfaces. The canonical Postgres cut adds the storage adapter under `apps/core/src/adapters/storage/postgres/`, but does not complete the broader runtime/domain terminology refactor from `RegisteredGroup` and `groupFolder` to canonical conversation/workspace concepts.

For this persistence cut, treat remaining matches for old table names in earlier migration files as historical migration context. Active Postgres schema and repository tables must use the canonical table names from migration `0009_canonical_persistence_adapter_cut`.
