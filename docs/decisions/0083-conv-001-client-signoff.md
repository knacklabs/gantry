---
status: accepted
confirmed_by: "Yash"
date: 2026-07-28
---

# Conv 001 Client Signoff

## Context

Gantry supports installing one existing agent into multiple channel
conversations, but the completed-setup CLI does not expose a guided operation
for it. Operators currently edit `settings.yaml` or use lower-level Control API
operations and must know internal identifiers. Yash confirmed the desired flow
after reviewing representative Slack conversation entries.

## Decision

Implement a guided **Add conversation to existing agent** flow that reuses an
existing agent and provider account, supports discovered or validated manual
conversation selection, collects conversation-specific approvers and route
behavior, presents a review, and writes through the canonical desired-state
service.

The flow is additive: it does not create agents, replace credentials, rewrite
existing conversation installs, or persist anything before confirmation.

## Consequences

- Existing provider credentials are reused by reference and are never requested
  or overwritten by this flow.
- Conversation ownership, provider-account ownership, membership, duplicate,
  and settings revision checks fail closed.
- The readable settings copy and Postgres/runtime projection remain aligned.
- Existing setup and provider-connect flows keep their current behavior.
- User-facing CLI, settings round-trip, discovery, cancellation, and projection
  behavior require focused automated and functional verification.
