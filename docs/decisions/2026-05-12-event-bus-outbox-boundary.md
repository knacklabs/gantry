# 2026-05-12 - Event Bus Outbox Boundary

## Context

Gantry may later publish runtime events through SNS/SQS, Kafka, or another
broker. The runtime already has a clean Postgres-first event path through
`runtime_events` and `event_bus_outbox`, while MCP, permission, memory, webhook
delivery, and provider-session histories own their own audit records.

## Decision

Postgres is the default event backend. `runtime_events` remains the only
runtime-observable stream. Runtime event appends synchronously write an
`event_bus_outbox` record in the same Postgres transaction. Broker dispatch is a
later adapter behind the event bus boundary.

Postgres `LISTEN/NOTIFY` is wakeup-only. It is not durable truth, and consumers
must replay from `runtime_events` or recover dispatch from `event_bus_outbox`
after missed notifications.

Runtime storage readiness validates the durable event path by checking
`runtime_events`, `event_bus_outbox`, their cursor/claim indexes, and the outbox
runtime-event uniqueness constraint. Readiness checks must not write synthetic
event or outbox rows.

Kafka, SNS/SQS, or another broker may be introduced only as a dispatcher adapter
behind `event_bus_outbox` when there is a real scaling or multi-service
requirement. Until then there is no runtime event provider abstraction, no
Kafka configuration surface, and no backend selector in settings, control API,
CLI, SDK, or MCP tools.

Audit histories remain separate stores. They may emit runtime-visible events
only when the user or public API needs to observe the outcome.

This is a strict clean cut:

- no retired event aliases
- no direct `runtime_events` inserts outside the runtime event repository
- no dual writes to old event tables
- no fallback readers or compatibility views
- no `pgmq`
- no UNLOGGED pub/sub tables
- no Kafka imports outside a future broker adapter folder

Future Go workers must consume and publish the shared event envelope. Go does
not own a second event taxonomy.

## Consequences

Postgres remains the source of truth. `pg-boss` remains the scheduler and
background job queue; it is not replaced by runtime pub/sub work. Broker lag or
downtime cannot lose runtime events because dispatchers recover from the
outbox. Unknown runtime event filter strings fail loudly at application
boundaries instead of silently querying arbitrary event names.

Retention, partitioning, and interrupted in-flight run recovery are deferred
follow-up decisions. Those designs must preserve `runtime_events` as the
runtime-observable stream and `event_bus_outbox` as the broker boundary.
