# Testing strategy

Tests prove behavior at the smallest level that can falsify the risk.

- Unit tests isolate domain/application behavior without external infrastructure.
- Integration tests prove module and adapter interaction.
- Postgres integration tests prove transactions, locking, ordering, constraints,
  leases, and database behavior against real Postgres.
- End-to-end tests prove externally observable API, CLI, channel, or runtime flows.
- Hermetic agent tests simulate provider behavior while exercising Gantry-owned
  orchestration; real-provider checks are separate, credentialed evidence.

Place tests beside the repository's established test roots and name the behavior
under test. Fixtures must make ownership and cleanup explicit. Mock external
systems at owned interfaces; do not mock away the database semantics, concurrency,
or serialization contract being tested. Retries are for an explicitly transient
boundary, never a way to hide a flaky assertion.

Bug fixes include a regression test unless the failure is documentation-only or
cannot be reproduced deterministically; explain that exception. Tests must be
isolated, deterministic, bounded by meaningful timeouts, and safe to run in any
order.

**Mechanical:** `npm test`, `npm run test:integration:postgres`,
`npm run test:e2e`, `npm run test:e2e:agent:hermetic`, typecheck, and CI
provide executable layers.

**Review:** The PR's risk determines which layers are required. Persistence and
concurrency changes need real Postgres proof; public-flow changes need end-to-end
proof; provider adapters need contract-focused integration coverage.

**Recommendation:** Prefer one precise regression over broad snapshot churn.
