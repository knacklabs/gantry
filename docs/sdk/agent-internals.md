# Agent Internals For SDK Consumers

This document explains what a backend developer is using when they call `@gantry/sdk`.

## Boundary

The SDK talks to the Gantry control server. The control server is a host runtime surface, not an agent feature. ACP/ACPS remain harness/runtime concerns and are not part of the public SDK contract.

Agents cannot choose callback URLs, API keys, webhook headers, or channel destinations. They can only react to durable inbound messages and emit structured events through host-owned tools.

For contributor-level runtime internals and source-reading paths, see [runtime components](../architecture/runtime-components.md).

## Locked access preset

A customer-facing agent can be provisioned with
`agents.<id>.access.preset: locked`. A locked agent works only with
pre-provisioned capabilities and cannot escalate its own access. What this means
for an SDK consumer:

- **The parent runtime is the security boundary.** Authority tools
  (`request_*`/`admin_*`/`settings_*`) are unmounted on the child runner, but that
  is UX, not the trust boundary. A forged IPC request from a locked runner is
  **denied parent-side and audited (`denied_by_profile`)** on both the task and
  permission IPC paths, and an unreadable lock status fails closed. Permission
  prompts are disabled (`permissionMode: deny`).
- **Host-authored instructions are projected policy-aware.** Runtime rules,
  capability/operating guidance, runner tool descriptions, and the seeded default
  `AGENTS.md` follow the resolved preset automatically, so a locked agent is not
  told about request/approval machinery it cannot use. Operator-owned `SOUL.md`
  and `AGENTS.md` content is never rewritten or string-stripped.
- **Introspection is provisioned-only.** `mcp_list_tools` and capability status
  show only what is currently provisioned — no requestable-tool ladder.

The preset is an operator setting, not an SDK call; the SDK contract is unchanged
whether an agent is `full` or `locked`. See
[Locked Preset](../decisions/2026-06-11-locked-preset.md).

## Message Flow

```mermaid
sequenceDiagram
  participant App as Backend App
  participant SDK as @gantry/sdk
  participant Control as Gantry Control Server
  participant Store as Postgres
  participant Queue as Per-Session Queue
  participant Agent as Host Agent

  App->>SDK: sessions.ensure()
  SDK->>Control: POST /v1/sessions/ensure
  Control->>Store: upsert app session
  App->>SDK: sessions.sendMessage()
  SDK->>Control: POST /v1/sessions/:id/messages
  Control->>Store: insert inbound message + control event
  Control->>Queue: enqueue normal processing
  Queue->>Agent: spawn host agent run
  Agent->>Control: app channel outbound event
  Control->>Store: append durable control event
  SDK-->>App: wait, stream, or webhook event
```

`sendMessage()` is intentionally not an RPC call into the model. It writes an inbound message, then the normal runtime processor claims work. This makes retries, ordering, status events, and webhook delivery durable.

## Job Flow

```mermaid
sequenceDiagram
  participant App
  participant SDK
  participant Control
  participant Boss as pg-boss
  participant Store as Postgres
  participant Agent

  App->>SDK: jobs.create({ kind })
  SDK->>Control: POST /v1/jobs
  Control->>Store: persist Gantry job definition
  Control->>Boss: schedule/queue execution
  App->>SDK: jobs.trigger(jobId)
  SDK->>Control: POST /v1/jobs/:id/trigger
  Control->>Store: create triggerId
  Control->>Boss: enqueue run claim
  Boss->>Control: run claimed
  Control->>Store: bind triggerId to runId
  Control->>Agent: run prompt in session/group context
  Agent->>Store: run events and result
  SDK-->>App: jobs.wait(triggerId)
```

The SDK exposes Gantry jobs, triggers, runs, events, and results. It does not expose raw `pg-boss` concepts. `trigger()` returns `triggerId` immediately; execution later binds a `runId`.

## Channel Onboarding Flow

```mermaid
sequenceDiagram
  participant App
  participant SDK
  participant Control
  participant Store as Postgres
  participant Provider as Provider Adapter

  App->>SDK: providerConnections.create()
  SDK->>Control: POST /v1/provider-connections
  Control->>Store: persist non-secret config + runtimeSecretRefs
  App->>SDK: providerConnections.discoverConversations()
  SDK->>Control: POST /v1/provider-connections/:id/discover-conversations
  Control->>Provider: discover conversations with runtime-owned secret
  Control->>Store: upsert normalized conversations
  App->>SDK: agents.conversationBindings.enable()
  SDK->>Control: PUT /v1/agents/:agentId/conversation-bindings/:conversationId
  Control->>Store: upsert active AgentConversationBinding
```

The control API never accepts raw Slack, Telegram, Teams, or WhatsApp tokens in
providerConnection payloads. Backend apps pass runtime secret references, and the host
runtime resolves those references through `RuntimeSecretProvider`. Teams and
WhatsApp are catalog placeholders until provider adapters exist.

## Webhook Flow

```mermaid
sequenceDiagram
  participant Store as Postgres
  participant Dispatcher as Webhook Dispatcher
  participant App as Backend App

  Store->>Dispatcher: claim pending delivery
  Dispatcher->>App: POST signed event
  alt accepted
    Dispatcher->>Store: mark delivered
  else retryable failure
    Dispatcher->>Store: backoff retry
  else final failure
    Dispatcher->>Store: dead-letter
  end
```

Webhook URLs are registered by the app, signed with per-destination secrets, retried durably, and dead-lettered after bounded failures. Apps should deduplicate on event id.

## Storage

Postgres is the runtime store:

- `pg-boss` schedules and claims jobs.
- `pgvector` and embedding cache tables support optional semantic memory recall when embeddings are enabled and backfilled.
- Postgres full-text search remains the always-available retrieval path and the lexical fallback when query embedding is unavailable.
- Control events, messages, jobs, runs, triggers, sessions, webhooks, deliveries, and memory records are first-party Gantry tables.

## Event Contract

Every control event has:

- monotonic `eventId`
- typed `eventType`
- JSON payload
- optional `sessionId`, `jobId`, `runId`, `triggerId`
- optional correlation id
- timestamp

Backend apps should treat events as the durable integration stream. The current agent transcript and stdout are implementation details.
