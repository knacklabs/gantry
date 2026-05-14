# 2026-05-12 - Event Bus Outbox Boundary

## Context

MyClaw may later publish runtime events through SNS/SQS, Kafka, or another
broker. The runtime already has a clean `runtime_events` stream, while MCP,
permission, memory, webhook delivery, and provider-session histories own their
own audit records.

## Decision

`runtime_events` remains the only runtime-observable stream. Runtime event
appends synchronously write an `event_bus_outbox` record in the same Postgres
transaction. Broker dispatch is a later adapter behind the event bus boundary.

Audit histories remain separate stores. They may emit runtime-visible events
only when the user or public API needs to observe the outcome.

This is a strict clean cut:

- no retired event aliases
- no direct `runtime_events` inserts outside the runtime event repository
- no dual writes to old event tables
- no fallback readers or compatibility views

Future Go workers must consume and publish the shared event envelope. Go does
not own a second event taxonomy.

## Consequences

Postgres remains the source of truth. Broker lag or downtime cannot lose
runtime events because dispatchers recover from the outbox. Unknown runtime
event filter strings fail loudly at application boundaries instead of silently
querying arbitrary event names.
