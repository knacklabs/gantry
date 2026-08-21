# Contributing to Gantry

Thanks for improving Gantry. This guide describes the result a contribution must
produce; it does not require a particular editor, agent, or development harness.
Read the canonical [engineering standards](docs/engineering/README.md) before a
non-trivial change.

## Development environment

- Node.js `>=24 <26`
- npm `11.16.0` (pinned by `packageManager`)
- Postgres for runtime and persistence integration work
- `ripgrep`
- Linux `sandbox_runtime`: `bubblewrap` and `socat`
- Docker for image checks and the easiest disposable Postgres setup

Install the lockfile exactly:

```bash
git clone https://github.com/knacklabs/gantry.git
cd gantry
npm ci
npm run build
```

Copy `.env.example` to `.env`, use a disposable local Postgres database, and
never commit secrets or private deployment data. Run the runtime with
`npm run dev`, or build and run migrations plus the compiled runtime with
`npm start`. Use `npm run cli:dev -- <command>` while changing the CLI.

If setup fails, first confirm `node --version`, `npm --version`, Postgres
reachability, and required extensions. `gantry doctor` diagnoses a configured
runtime; [the debug checklist](docs/DEBUG_CHECKLIST.md) covers runtime failures.

## Engineering workflow

1. Start from an issue or focused problem statement.
2. Read the current architecture, accepted decisions, and policy for the
   affected surface.
3. Keep the change at its owning boundary; avoid unrelated cleanup.
4. Add the smallest tests that can falsify the risk.
5. Update contracts, generated files, migrations, and authoritative docs in the
   same change.
6. Run the change-specific checks below and report any environment-dependent
   checks honestly.
7. Review the final diff for secrets, customer data, generated noise, and
   accidental public-contract changes.

Maintainers may use the optional [factory workflow](docs/FACTORY.md), but its
tools assist this engineering contract rather than define it.

## Validation matrix

Run `npm run format:check`, `npm run lint`, `npm run typecheck`,
`npm run docs:check`, and `npm run check:architecture` for every code change.
Then select additional proof by risk:

| Change                                                     | Required focused proof                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Documentation or metadata only                             | `npm run docs:check`, formatting for changed files, `git diff --check`                          |
| Domain/application logic                                   | focused unit tests, then `npm test`                                                             |
| Adapter or module integration                              | focused integration tests, then `npm test`                                                      |
| Postgres schema, query, transaction, lease, or ordering    | `npm run db:migrations:check`, focused real-Postgres tests, `npm run test:integration:postgres` |
| Public API, SDK, CLI, settings, event, or webhook contract | contract tests, relevant integration/E2E suite, `npm run build`                                 |
| Channel/provider or complete runtime flow                  | relevant integration test and `npm run test:e2e`; use hermetic agent E2E where applicable       |
| Package contents or dependency                             | `npm run security:package`, `npm run security:sbom`, build and focused interface tests          |
| Runtime image or deployment asset                          | `npm run security:images` and the owning deployment/image checks                                |
| Performance or concurrency                                 | repeatable baseline, focused load/concurrency proof, and correctness regression tests           |

Purpose of common commands:

- `npm run format:check`: deterministic source formatting.
- `npm run lint`: static correctness and repository lint policy.
- `npm run typecheck`: TypeScript contract consistency without emission.
- `npm test`: unit plus non-Postgres integration behavior.
- `npm run test:integration:postgres`: real database semantics; requires
  `GANTRY_TEST_DATABASE_URL` pointing to a disposable database.
- `npm run test:e2e`: externally observable runtime flows.
- `npm run check:architecture`: source dependency direction and structural
  budgets.
- `npm run docs:check`: documentation links, lifecycle, taxonomy, evidence,
  and repository identity.
- `npm run build`: contracts, SDK, runtime, examples, and generated migration
  packaging.
- `npm run security:package`: published package contents and secret/safety
  exclusions.

Expensive suites need not run locally when unrelated, but the PR must name what
ran, what did not, and why CI is sufficient.

## Contracts, migrations, and generated files

Public Control API, SDK, CLI, settings, environment variables, database schema,
events, webhooks, and exported TypeScript types evolve under
[API and contract rules](docs/engineering/api-and-contracts.md).

For schema changes, update the Drizzle schema and generate a timestamped
migration:

```bash
npm run db:migrations:generate -- --name add_feature
npm run db:migrations:check
```

Use `npm run db:migrations:custom -- --name backfill_feature` for bounded data
work or SQL the generator cannot express. Review generated SQL, deployment
ordering, lock impact, backfill resumability, and rollback/recovery. Never edit
an already released migration.

Do not hand-edit generated SDK, contract, migration, or architecture artifacts.
Update their source, use the documented generator, and commit synchronized
output plus provenance.

## Pull-request readiness

A PR is ready for review when it:

- explains the problem, chosen solution, affected boundaries, and user/operator
  impact;
- has focused scope with no unrelated cleanup;
- includes regression proof or a concrete reason tests are unnecessary;
- identifies architecture, security, compatibility, migration, dependency, and
  performance impact;
- updates authoritative documentation and examples with behavior;
- contains no secrets, customer data, personal paths, or private deployment
  details;
- includes generated output only when its source and regeneration path are
  present;
- lists commands run and any honest verification limitations.

Review [testing](docs/engineering/testing.md), [dependencies](docs/engineering/dependencies.md),
and [documentation governance](docs/engineering/documentation.md) for the
surface-specific standard.
