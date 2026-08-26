---
slug: phone-channels-and-cost-cap
title: Phone-number identity, WhatsApp, voice, and hard cost caps (V1.1)
status: confirmed
saved: 2026-08-26T11:07:54+00:00
---

# Phone-number identity, WhatsApp, voice, and hard cost caps (V1.1)

## Capability

The same governed agent serves customers on WhatsApp and on the phone under the same
identity, permissions, and audit as chat; and an agent that reaches its monthly token
budget pauses and tells an administrator.

## Why

WhatsApp and voice both need phone identity and both must inherit the governed model; a hard budget cap needs accounting that is currently incomplete. These ship after the V1.0 video path.

## Behaviour

### Phone identity

Verified phone alias (E.164, normalised per the person spec) with possession proof; no
admin bypass. Unverified callers stay anonymous and conversation-scoped. Required by
both WhatsApp and voice; built once.

### WhatsApp

WhatsApp Business Platform Provider Account per agent; callers resolve through the
phone alias or stay anonymous; same permission gate, audit actor, and offboarding.

### Voice

Per decision 0136, voice is a `provider: 'voice'` adapter over the existing engine,
never a runtime: callers as phone aliases or anonymous; every tool call through the
gate with `PrincipalRef` audit; mid-call approvals routed to Teams/Slack/web; a
permission timeout never proceeds; the engine tolerates an offboarded agent.

### Hard cost cap

Durable app/agent/calendar-month (UTC) reservation ledger with atomic check-and-reserve
at live admission and scheduler claim; every agent-attributable model call (including
memory extraction, dreaming, permission classification) emits usage; `paused_for_budget`
state with one notification per threshold to administrator recipients via durable
delivery; cap raisable from the directory. Tokens, not USD.

## Acceptance criteria

- **IDENT-3** — Phone-number alias kind
  - Verified phone alias kind with possession proof; no admin bypass
  - Unverified callers stay anonymous and conversation-scoped
- **WA-1** — WhatsApp provider
  - WhatsApp Business Platform Provider Account per agent; callers resolve via IDENT-3 or stay anonymous
  - Same permission gate, audit actor, and offboarding as other providers
- **VOICE-1** — Voice provider adapter
  - Existing voice engine consumed as a dependency behind a provider: voice adapter; no voice contract in core
  - Mid-call approvals route to Teams/Slack/web; permission timeout never proceeds
  - gantry agent offboard disables the voice Provider Account
- **COST-2** — Per-agent hard monthly token cap
  - Durable app/agent/month reservation ledger with UTC calendar-month semantics; atomic check-and-reserve at live admission and scheduler claim
  - Every agent-attributable model call emits model.usage (memory extraction, dreaming, permission classifier included)
  - paused_for_budget state; agent replies it is paused; administrator recipients notified once per threshold via durable delivery

## Source

Grill 2026-08-26 (Q22, Q24) and decision 0136; COST split after gap sweep. Stories:
IDENT-3, WA-1, VOICE-1, COST-2.
