# Postgres Query Policy

Gantry uses Drizzle as the default interface for repository-owned Postgres data
access. Repositories should define tables in `apps/core/src/adapters/storage/postgres/schema/`
and use Drizzle inserts, updates, deletes, selects, transactions, and upserts for
normal CRUD behavior.

Raw SQL remains acceptable for Postgres operational primitives that Drizzle does
not model as durable application data access:

- migrations and schema bootstrap
- readiness and health probes
- advisory locks that intentionally pin a `pg` client
- `LISTEN`, `UNLISTEN`, and `pg_notify`
- narrow Drizzle `sql` fragments for expression predicates, counters, `CASE`,
  `GREATEST`, and index expressions

Concurrency-sensitive claim paths should still use Drizzle transactions and row
locks when the query builder can express the operation. New raw CRUD queries
should explain why Drizzle is not the better owner and must be added to the
raw-SQL allowlist test deliberately.

Runtime event append and webhook delivery enqueue are one transaction by design:
an event that asks for webhook delivery should not become visible without its
retryable delivery row. Non-webhook subscribers still observe committed events
through the runtime event exchange after that transaction succeeds.

JSON-shaped runtime payload columns that repositories query, index, validate, or
partially update belong in native Postgres `jsonb`. Repository writers for
`jsonb` columns pass objects or arrays through Drizzle rather than JSON strings;
readers may tolerate legacy string-shaped test mocks at the adapter boundary.

Keep canonical runtime state normalized as typed columns. Use `jsonb` for
adapter-owned payloads, provider references, metadata, schedules, targets, and
memory value objects, not as a replacement for fields used to route, authorize,
lease, resume, dedupe, audit, or join runtime records.
