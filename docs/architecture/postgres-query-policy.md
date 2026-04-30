# Postgres Query Policy

MyClaw uses Drizzle as the default interface for repository-owned Postgres data
access. Repositories should define tables in `apps/core/src/adapters/storage/postgres/schema/`
and use Drizzle inserts, updates, deletes, selects, transactions, and upserts for
normal CRUD behavior.

Raw SQL remains acceptable for Postgres operational primitives that Drizzle does
not model as durable application data access:

- migrations and schema bootstrap
- readiness and health probes
- advisory locks that intentionally pin a `pg` client
- `LISTEN`, `UNLISTEN`, and `pg_notify`
- narrow Drizzle `sql` fragments for JSON casts, expression predicates,
  counters, `CASE`, `GREATEST`, and index expressions

Concurrency-sensitive claim paths may stay as explicit raw SQL while they are
covered by focused tests and called out in cleanup verification. New raw CRUD
queries should explain why Drizzle is not the better owner.
