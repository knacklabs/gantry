# Persistence and migrations

Postgres is the production authority for runtime state. Domain/application code
depends on repository ports; Postgres schemas, SQL, transactions, and driver
types remain in persistence adapters.

A migration is ordered, immutable after release, forward-applicable, and safe
for the deployment sequence that will run it. Schema and Drizzle definitions,
repository behavior, indexes, constraints, and migration files change together.
Backfills define bounds, resumability, idempotency, lock impact, and observability.
Destructive changes require an explicit cutover and rollback or recovery plan.

Transactions enclose one consistency boundary. Concurrency-sensitive behavior
uses database guarantees—constraints, locks, compare-and-set, leases, fencing,
and deterministic ordering—rather than process-local assumptions.

**Mechanical:** migration generation/check commands, real Postgres integration
tests, typecheck, and architecture checks cover physical consistency.

**Review:** Reviewers inspect lock duration, table scans, index strategy,
deployment ordering, rollback/recovery, app scoping, transactions, and race
proof.

**Recommendation:** Prefer constraints that make invalid state impossible over
periodic cleanup of preventable invalid rows.
