# Gantry engineering standards

This directory is the tool-agnostic engineering contract for Gantry. It defines
what a correct, maintainable change looks like. CI, repository scripts, review,
and the optional factory workflow enforce or assist with this contract; they do
not replace it.

## Authority

When sources conflict, use this order:

1. current implementation and executable tests;
2. accepted, non-superseded [architecture decisions](../decisions/README.md);
3. current architecture and implementation documentation;
4. current feature documentation;
5. active implementation plans;
6. historical and archived material.

A discrepancy between source and an accepted decision is a defect to reconcile,
not permission to silently choose either side.

## Policy index

| Policy                                                      | Primary repository owner                                                                  | Primary mechanical proof                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Source organization](source-organization.md)               | `apps/core/src/`, `packages/`, `ops/`, `scripts/`, `docs/`, `plans/`, `factory/`          | `npm run check:architecture`                                                          |
| [Coding standards](coding-standards.md)                     | TypeScript modules and their owning package                                               | `npm run typecheck`, `npm run lint`, `npm run format:check`                           |
| [Architecture rules](architecture-rules.md)                 | Domain, application, adapter, delivery, and composition boundaries under `apps/core/src/` | `npm run check:architecture`                                                          |
| [Testing](testing.md)                                       | Established test roots and Vitest configurations                                          | `npm test` and the risk-specific test scripts in `package.json`                       |
| [Dependencies](dependencies.md)                             | Package manifests, the lockfile, and Gantry-owned provider interfaces                     | Build, package-content, SBOM, and dependency security checks                          |
| [API and contracts](api-and-contracts.md)                   | Control API, CLI, settings, `packages/contracts/`, and `packages/sdk/`                    | Typecheck, build, contract, generation, migration, and package checks                 |
| [Errors and observability](errors-and-observability.md)     | Domain errors, delivery adapters, process boundaries, telemetry, and audit records        | Lint, typecheck, tests, and telemetry schemas                                         |
| [Configuration and secrets](configuration-and-secrets.md)   | Settings schemas, startup validation, and the credential boundary                         | Schema validation, secret scanning, protected-file rules, and documentation checks    |
| [Persistence and migrations](persistence-and-migrations.md) | Postgres schema and repository adapters                                                   | Migration checks, real-Postgres integration tests, typecheck, and architecture checks |
| [Performance](performance.md)                               | The boundary that owns the measured workload                                              | Committed budgets, benchmarks, load/concurrency tests, and regression suites          |
| [Documentation governance](documentation.md)                | `docs/`, `plans/`, and generated documentation sources                                    | `npm run docs:check`                                                                  |

Each policy labels rules as **Mechanical**, **Review**, or **Recommendation**.
Mechanical rules name an executable owner where one exists. Review rules require
engineering judgment. Recommendations are defaults that may be changed with an
explicit reason.

## Applying the contract

Start with [source organization](source-organization.md) and the policy closest
to the surface you are changing. Use [testing](testing.md) to choose proof and
[documentation governance](documentation.md) to update the authoritative record
in the same change. The contributor workflow and change-specific command matrix
live in [CONTRIBUTING.md](../../CONTRIBUTING.md).

If a rule cannot be verified mechanically, its policy names the review question
instead of presenting automation as proof it does not provide.
