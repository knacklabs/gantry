---
name: preexisting-markrunnotified-mock-failure
description: canonical-job-repository unit test fails on mworker branch independent of live-turn work
metadata: 
  node_type: memory
  type: project
  originSessionId: 9dc33c25-3d61-436c-8c67-8027a566c482
---

On branch `feature/mworker-01-safe-multi-worker-execution`, the unit test
`apps/core/test/unit/adapters/storage/postgres/canonical-job-repository.postgres.test.ts`
> "persists run notification timestamps on canonical agent runs" fails with
`this.db.update(...).set(...).where(...).returning is not a function`.

The hand-rolled db mock in that test lacks `.returning()`, which
`PostgresCanonicalJobRepository.markRunNotified` now calls (lease-fenced
notification change from the uncommitted Plan 1/2 multi-worker work). It is a
**pre-existing** failure in the uncommitted base, not a regression from the
Plan 3 live-turn / horizontal-execution work. Full unit suite otherwise green
(3307 passing). See [[agent-access-simplification]] context branch.
