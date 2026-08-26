---
slug: agent-identity-and-offboarding
title: Agent identity and offboarding for people and agents
status: confirmed
saved: 2026-08-26T11:07:53+00:00
---

# Agent identity and offboarding for people and agents

## Capability

Every AI agent is a principal in the same identity graph as the humans it works with.
An agent is a `kind: service` Person (per the confirmed `person-identity-aliases` spec,
decision 9) bound one-to-one to its `agentId`. Its channel seats (Provider Accounts)
and tool accounts (Connector Accounts) attach as aliases exactly as a human's Slack,
Teams, or OIDC logins do. Onboarding, scoped access, audit, and offboarding therefore
read identically for a person and an agent, and `gantry <person|agent> offboard` is one
use case with two entry points.

## Why

Onboard, scope, audit, and offboard must read the same for a person and an agent, or the positioning is a slogan. Today agents are configuration, audit actors are six ad-hoc shapes, and there is no offboarding for either kind.

## Behaviour

### Identity model

- Agent principal: `people` row with `kind: service`, `agentId` as a unique, immutable
  binding. Created when the agent is created; never minted from a live message.
- Agent aliases: alias kinds `provider_account` (subject = the provider's stable bot
  identity, e.g. Slack `bot_user_id`; providerAccountId = the Provider Account id) and
  `connector_account` (subject = the external account identity, e.g. mailbox address;
  providerAccountId = the Connector Account id). `verified` is set by the connect
  flow that proved control, never by the People API.
- Cross-kind uniqueness: an alias key belongs to at most one Person of any kind. A
  subject can never be both human and service. Migration fails on collision.
- Shipped baseline: `users` + `user_aliases(provider, providerAccountId, externalUserId)`
  is the current schema. This spec's alias kinds are new `provider` values under that
  key; no second alias table.
- App = org for all chat channels; SDK-embedded customer products are separate apps.
  Departments are never separate apps.
- Agent-sender classification runs before participant or message persistence on every
  channel: a sender whose alias resolves to a service Person is metadata-only, never
  creates a human Person, never hydrates personal memory, never triggers a run.
  In-runtime delegation (worker runs spawned by an agent) is one principal's run tree
  and is not agent-to-agent; agent-to-agent channel addressing stays off.

### Audit actor

- One persisted actor shape everywhere: `PrincipalRef { kind: human | service | system,
  personId?, aliasId? }`. Locked-posture denials (`denied_by_profile`) and API-key
  actors (`api-key:<kid>`) map to `system` with the original reference retained.
- Migration matrix covers `runtime_events.actor`, `permission_audit_events.actor_id`,
  `mcp_server_audit_events.actor_id`, `person_merge_audit.actor`, permission decision
  `approver_ref` / `actor_context_json`, and provenance fields; each row is migrated,
  backfilled, or explicitly exempted in the matrix. All writers go through one
  stamping helper; bare strings fail typecheck.

### Offboarding

- `offboard(personId)` is one atomic use case for both kinds: retire every alias (fail
  closed), remove every Conversation Install, disable Provider and Connector Accounts
  (secret references untouched), retire person-scoped grants (ADR 0118), cancel
  scheduled jobs with durable cancellation intent (in-flight runs finish but start no
  new tool call), set status `offboarded`, emit one identity audit row plus a named
  runtime event and outbox entry through the existing append path (ADR 0016).
- Human additionally: redact personal memory and DM content irreversibly — the erase
  graph is `message_parts` payloads for direct conversations, memory evidence,
  candidates, reviews, session summaries — keeping alias keys and audit rows in
  redacted form. Manual trigger only; IdP/SCIM-driven deprovisioning is deferred.
- Atomic boundary: Provider Accounts and installs are Postgres projections of revisioned
  desired state (ADR 0025). Offboard writes one desired-state revision and the
  identity/runtime/outbox rows in one orchestration with recovery; `settings.yaml` is
  a mirror, never the transaction.
- Administrator-only. `main_agent` cannot be offboarded. `agent remove` is permitted
  only on an offboarded agent. Retired aliases are never revived; re-onboarding is a
  new principal.

### Control surface

`people:read` lists both kinds; `people:admin` links/retires aliases; `agents:admin`
offboards (either kind) and reads offboarded memory/audit with `memory:read`. Every
mutation audited with `PrincipalRef`.

## Acceptance criteria

- **IDENT-2** — Agent identity: agents as principals
  - Provider Accounts project to aliases with cross-kind uniqueness; a subject is never both Person and Agent
  - Every audit row carries a PrincipalRef actor; no bare 'agent' string remains
  - gantry agent offboard retires aliases, removes installs, disables accounts, cancels jobs atomically; agent remove is gated on offboarded
  - Agent senders never create a Person, load personal memory, or trigger a run
  - Migration from shipped IDENTITY-01 shape (users + user_aliases(provider, providerAccountId, externalUserId)) to (appId, kind, authorityId, subject) with collision-fail
  - Atomic boundary defined as desired-state revision + identity/runtime/outbox orchestration with recovery (ADR 0025); settings.yaml is a mirror
  - Agent-sender classification runs before participant/message persistence in Slack, Teams, Discord
  - Offboard emits a named identity event through the existing runtime-event/outbox path (ADR 0016) and retires connector accounts (ADR 0137)
- **AUDIT-1** — Audit actor migration matrix to PrincipalRef
  - Migration matrix covers runtime_events.actor, permission_audit_events.actor_id, mcp_server_audit_events.actor_id, person_merge_audit.actor, decision approver_ref/actor_context_json, and provenance fields; each row: migrate, backfill, or explicitly exempt
  - All 103 writers route through one actor-stamping helper; bare strings ('agent','runtime','permission','sdk', CLI names) fail typecheck
  - denied_by_profile (locked posture) and api-key:<kid> shapes mapped
- **IDENT-4** — Person offboarding
  - gantry person offboard <personId> and a directory action retire all aliases (fail closed), redact personal memory and DM content, and keep alias keys and audit rows in redacted form
  - One atomic transaction with identity audit, runtime event, and outbox
  - Manual trigger only; IdP/SCIM-driven deprovisioning is deferred
  - Erase graph enumerated: message_parts.payload_json for DMs, memory evidence, candidates, reviews, session summaries; join strategy defined where no Person FK exists
  - Person-scoped grants (ADR 0118) revoked in the same transaction

## Source

IDENTITY-02 (docs/architecture/identity-01-canonical-person-continuous-memory-plan.md),
grilled 2026-08-26 (Q3, Q4, Q14, Q15, Q21, Q27) and reconciled to IDENTITY-01 decision 9
the same day; gap sweep docs/architecture/ai-employee-v1-gap-analysis.md (identity).
Stories: IDENT-2, AUDIT-1, IDENT-4.
