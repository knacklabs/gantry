---
slug: phone-channels-and-cost-cap
title: Customer support assistant: phone identity, WhatsApp, human handoff; voice and hard cost caps
status: draft
saved: 2026-08-27T07:38:53+00:00
---






# Customer support assistant: phone identity, WhatsApp, human handoff; voice and hard cost caps

## Capability

The same governed agent serves customers on WhatsApp, and when it cannot resolve a
request a human support agent takes over the same thread from Teams or Slack —
WhatsApp plus a human in the loop is a ready-made customer support assistant
(V1.0.x). Voice follows as a provider adapter, and an agent that reaches its
monthly token budget pauses and tells an administrator (V1.1).

## Why

Customer-facing teams at the first client cohort run support on WhatsApp; the
positioning's second proof is that the same AI employee, with the same audit and
offboarding, can take a support seat and hand a customer to a person without
leaving the thread. Phone identity is required by WhatsApp and voice alike and is
built once. Voice and the hard cap ship after.

## Behaviour

### Phone identity

Verified phone alias (E.164, normalised per the person spec) with possession proof; no
admin bypass. Unverified callers stay anonymous and conversation-scoped. Required by
both WhatsApp and voice; built once.

### WhatsApp

WhatsApp Business Platform Provider Account per agent; callers resolve through the
phone alias or stay anonymous; same permission gate, audit actor, and offboarding.

### Disclosure and language

First contact on WhatsApp carries an AI disclosure and privacy line as desired
state; "talk to a person" is always honoured; each agent has a default language and
templates per locale (Hindi and regional first). Milestone per decision 0146.

### Human handoff (V1.0.x)

Handoff is not approval: the human takes over the conversation. Triggers are the
customer asking for a person, the agent declaring it cannot resolve, or a
conversation policy rule. On handoff the agent pauses in that conversation only; a
handoff card — the approval card path reused — lands in the configured support
conversation in Teams or Slack with a bounded context packet; a human claims it
and replies through the agent's WhatsApp seat as themselves; resume returns the
thread to the agent with the human turns in context. The customer is told who
they are talking to at each switch. Every handoff, claim, human turn, and resume
is audited with the human's `PrincipalRef`. The console shows a read-only
Handoffs view for administrators and approvers; claiming stays in chat. Outbound messages after Meta's
24-hour window use approved templates managed as desired state.

### Voice (V1.1)

Per decision 0136, voice is a `provider: 'voice'` adapter over the existing engine,
never a runtime: callers as phone aliases or anonymous; every tool call through the
gate with `PrincipalRef` audit; mid-call approvals routed to Teams/Slack/web; a
permission timeout never proceeds; the engine tolerates an offboarded agent.

### Hard cost cap (V1.1)

Durable app/agent/calendar-month (UTC) reservation ledger with atomic check-and-reserve
at live admission and scheduler claim; every agent-attributable model call (including
memory extraction, dreaming, permission classification) emits usage; `paused_for_budget`
state with one notification per threshold to administrator recipients via durable
delivery; cap raisable from the directory. Tokens by default; currency when a price table is imported (COST-1). Per-agent rate
limits (requests/min, tokens/min) are enforced at admission with an audited refusal.

## Acceptance criteria

- **IDENT-3** — Phone-number alias kind
  - Verified phone alias kind with possession proof; no admin bypass
  - Unverified callers stay anonymous and conversation-scoped
- **WA-1** — WhatsApp provider
  - WhatsApp Business Platform Provider Account per agent; callers resolve via IDENT-3 or stay anonymous
  - Same permission gate, audit actor, and offboarding as other providers
  - WhatsApp Business Platform prerequisites (Meta business verification, phone number, message templates) documented as a deployment prerequisite; templates managed as desired state
  - First-contact AI disclosure and privacy line as desired state; 'talk to a person' always honoured; per-agent default language with templates per locale (Hindi and regional first) as desired state
- **HANDOFF-1** — Customer handoff to a human agent
  - Handoff triggers: customer asks for a person, the agent declares it cannot resolve, or a conversation policy rule fires; the agent pauses in that conversation only
  - Handoff card (reusing the approval card path) posted to the configured support conversation in Teams or Slack with a bounded context packet; a human claims it and replies through the agent's WhatsApp seat as themselves
  - Resume returns the conversation to the agent with the human's turns in context; the customer is told who they are talking to at each switch
  - Every handoff, claim, human turn, and resume is audited with the human's PrincipalRef; outbound after Meta's 24-hour window uses approved templates
  - Read-only Handoffs view in the console (open, claimed, resumed; who and when) via /ui/api/handoffs for administrator and approver; claiming stays in Teams/Slack
- **VOICE-1** — Voice provider adapter
  - Existing voice engine consumed as a dependency behind a provider: voice adapter; no voice contract in core
  - Mid-call approvals route to Teams/Slack/web; permission timeout never proceeds
  - gantry agent offboard disables the voice Provider Account
- **COST-2** — Per-agent hard monthly token cap
  - Durable app/agent/month reservation ledger with UTC calendar-month semantics; atomic check-and-reserve at live admission and scheduler claim
  - Every agent-attributable model call emits model.usage (memory extraction, dreaming, permission classifier included)
  - paused_for_budget state; agent replies it is paused; administrator recipients notified once per threshold via durable delivery
  - Cap field in the agent detail Usage & budget panel via PATCH /ui/api/agents/:id/usage-cap; paused_for_budget shown as status
  - Per-agent rate limits (requests/min, tokens/min) enforced at admission with an audited, named refusal

## Source

Grill 2026-08-26 (Q22, Q24) and decision 0136; COST split after gap sweep. Stories: IDENT-3, WA-1, HANDOFF-1 (V1.0.x); VOICE-1, COST-2 (V1.1).
