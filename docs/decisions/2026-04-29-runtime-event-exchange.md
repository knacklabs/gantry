# 2026-04-29 - Runtime Event Exchange

## Context

Runtime-visible delivery events are currently represented through more than one
active stream: control HTTP events for SDK sessions and webhooks, agent run
events for run history, job event writes, route-local SSE/wait polling, and
projection-specific listing logic. This conflicts with the platform direction
that runtime behavior should be provider-neutral, channel-neutral, and backed by
one durable Postgres truth.

Audit records are different from delivery streams. MCP audit events, memory
recall events, permission decisions, and webhook delivery attempts are owned
histories for their modules and should not be collapsed into a generic pub/sub
table.

## Decision

MyClaw will use a single Runtime Event Exchange for runtime delivery streams.
`RuntimeEvent` is the canonical observable runtime event concept for SDK event
listing, SSE/wait, webhook projection, run events, job events, and app-channel
session/control output.

The active durable stream is `runtime_events`. Postgres `LISTEN/NOTIFY` is only
a wakeup mechanism. Consumers must recover missed notifications by replaying
from `runtime_events` using a cursor.

The canonical cursor is `runtime_events.event_id`, a monotonic numeric id.
External SDK/control response shapes remain stable; route and SDK adapters map
canonical runtime events into existing public DTOs.

`AgentRunEvent` no longer owns the observable event stream as a separate active
concept. Run-event responses are projections filtered from `RuntimeEvent`.
`control_http_events` and `agent_run_events` must not be active source, schema,
route, repository, application-use-case, or test-harness dependencies after the
cutover. Historical migration files may retain old table names as history.

Webhook delivery state remains a delivery-history table, but delivery rows must
reference `runtime_events.event_id`. The Postgres append path creates matching
webhook delivery rows in the same transaction as the runtime event.

## Event Taxonomy

Runtime event types remain explicit strings. Initial active families are:

- `session.message.inbound`
- `session.message.outbound`
- `session.message.streaming`
- `session.typing`
- `session.progress`
- `job.triggered`
- `job.run.started`
- `job.started`
- `job.streaming`
- `job.tool_denied`
- `job.tool_activity`
- `job.completed`
- `job.failed`
- `job.run.completed`
- `job.run.failed`
- run lifecycle and output event types required by existing run listing APIs
- `webhook.test`

New event families require an owner and tests for publish/query/projection
behavior.

Runtime events are also mirrored into the local event bus outbox in the same
Postgres transaction as the `runtime_events` append. Broker adapters such as
SNS/SQS or Kafka may later dispatch from that outbox, but they must not create
parallel runtime event writers, compatibility aliases, or alternate event
taxonomies.

## Boundaries

Runtime Event Exchange covers pub/sub delivery streams only. It does not own:

- MCP server audit history
- memory recall history
- permission decision and audit history
- webhook attempt history
- provider session artifact history

Those modules may publish runtime-visible notifications when needed, but their
durable audit truth remains in their own records.

## Consequences

This is a clean-cut refactor. There will be no compatibility views, dual writes,
automatic migration flows, or fallback readers for old local state. Migration
0018 is schema-only and fail-loud: it refuses to run if old runtime event,
control HTTP event, agent run event, or webhook delivery tables contain rows.
Operators must export or explicitly clear those rows before applying the cut.

Storage, control routes, app channel, jobs, run APIs, SDK projections, and
webhook delivery must converge on the exchange in the same implementation
program. Partial cutovers are not acceptable because they reintroduce split
event truth.

Rolling deploys across the Runtime Event Exchange cut are not supported. Stop
old runtimes before applying the migration, then start only the upgraded runtime
after the schema cut succeeds.

Retention will be implemented at the Runtime Event Exchange seam rather than in
projection-specific tables. Until partitioning lands, providerConnections must run an
operator-owned retention job for `runtime_events.created_at` that matches their
audit SLA.

The cleanup gate must search active source, active schema, route code,
repositories, use cases, tests, and docs for stale event names. Remaining old
names are allowed only in historical migrations, external SDK docs preserving
public naming, or explicit architecture docs explaining the removal.
