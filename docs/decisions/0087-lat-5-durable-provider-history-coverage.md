---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-30
---

# LAT-5: Durable Provider-History Coverage, Recorded From What The Provider Actually Returned

## Context

The roadmap's Phase 5 requires a new accepted decision before implementation, and
scopes durable coverage by app, provider account, conversation, exact thread
scope, provider generation, coverage cursor, bounded-window completeness,
thread-root coverage, and an expiring claim — with the explicit rule that
"provider API coverage must be recorded as actual coverage, not inferred from
local row count" (`plans/MyClaw-Response-Latency-Refactor-Plan.md`).

Read-only measurement at `b2c061ee9` (signal `S-0001-11ca`) establishes the
following.

**The defect reproduces, but not as the goal prompt states it.** The prompt says
hydration blocks prompt build "up to 2.5s" every turn. That 2.5s is a **maximum
wait for an unsettled hydration promise**
(`group-conversation-context.ts:21,167`), not a fixed per-turn cost, and it is
only entered while the local window is incomplete (`:189`). **Telegram and other
hookless adapters return skipped without any provider request**
(`channel-wiring-conversation-context.ts:28`), so they have no defect to fix.

What does reproduce, for Slack, Discord and supported Teams: while the local
window is incomplete, **every eligible turn**

1. awaits the provider history hook once (`group-conversation-context.ts:42`),
2. performs one awaited `storeMessage` per accepted message, **each in its own
   transaction** (`:81`, `canonical-message-repository.postgres.ts:150`),
3. then re-runs the local context query (`:103`).

**The completeness rules are not what the docs say.** Top-level windows use
`CHANNEL_CONTEXT_LIMIT = 30` (`conversation-context.ts:4`), but **threads require
50 messages plus a root message** (`:5,83`), not 30. The goal prompt's "30 stored
messages" is wrong for threads.

**No durable coverage state exists.** `conversations` and `conversation_threads`
carry identity, status and timestamps only (`schema/conversations.ts:11,37`).
`messages` carries per-message fields, not evidence of provider coverage
(`schema/messages.ts:20,62`). Nothing is a non-boolean, non-`updated_at`
hydrated-through cursor.

**And no adapter can currently report actual coverage.**
`ConversationContextHydrationResult` exposes only `attempted`, skipped/failed
reason, and messages (`apps/core/src/domain/ports/conversation-context-hydration.ts:17`). Slack
alone receives `has_more` and `response_metadata.next_cursor` internally and uses
them only for in-memory tail requests (`slack/conversation-context.ts:11,102,157`).
Discord receives a bare page and requests with `before`
(`discord-conversation-context.ts:67,71`); Teams returns a bare array
(`teams-types.ts:97`). So the roadmap's "actual coverage" rule **cannot be
satisfied without widening that port** — which is the enabling change, not an
optional extra.

Identity is mostly already present: app, provider account, conversation and
thread scope all exist. **Provider generation, coverage cursor, bounded
completeness, thread-root coverage and an expiring claim do not.**

## Decision

Record durable provider-history coverage as **what the provider actually
returned for a requested window**, keyed by
`(appId, providerAccountId, conversationId, threadScope)` where `threadScope`
distinguishes top-level from a specific thread.

**Widen the hydration port first.** `ConversationContextHydrationResult` gains
coverage facts alongside its messages: the boundary that was requested, the
window actually returned, whether the provider signalled more available, and the
thread-root outcome. Adapters report what they know; they do not synthesise.

**Completeness is per-provider-capability, and is labelled as such.** Slack can
report server-side completeness from `has_more`/`next_cursor`. Discord and Teams
cannot — for them, coverage means "the bounded window was requested and the
provider returned fewer than requested", which is a weaker claim and must be
stored as a weaker claim. Storing Discord/Teams coverage as if it were
server-confirmed would reintroduce exactly the inference the roadmap forbids.

**The watermark is marked complete only after every accepted write commits.** A
crash mid-hydration leaves coverage incomplete, so the next turn retries rather
than trusting a partial window (plan-validation §2).

**Reuse the existing claim substrate.** The expiring claim follows
`live_admission_work_items` — durable scoped rows with
`claim_worker_instance_id`, `claim_token`, `claim_expires_at` and a fencing
version, assigned under `FOR UPDATE SKIP LOCKED`
(`schema/live-turns.ts:134`, `live-admission-work-item-repository.postgres.ts:163,223`).
Provider generation reuses the advisory-lease generation substrate
(`runtime-store.ts:326,343`) rather than inventing a second fencing vocabulary.

**Persistence moves off the critical path.** The turn merges hydrated history in
memory for its own prompt build; the durable writes and the coverage update
happen without the turn awaiting them one transaction at a time.

## Delivery shape — confirmed with the client 2026-07-30

**Two PRs, port first.** LAT-5A widens
`ConversationContextHydrationResult` so adapters report the requested boundary,
the window actually returned, any provider completeness signal, and the
thread-root outcome — with no behaviour change and no schema. LAT-5B adds the
durable record, its migration, the claim and the generation on top. Each is
reviewable alone, and if 5B stalls on the schema, 5A has still landed the
capability the roadmap's "actual coverage" rule depends on.

**Provider-neutral by shape, not Slack-shaped with others bolted on.** The
coverage fields live on the shared `ConversationContextHydrationResult`
(`apps/core/src/domain/ports/conversation-context-hydration.ts`), and the capability difference
is expressed as DATA — a completeness *kind* the adapter reports — not as
Slack-specific optional fields that other adapters leave undefined. Designing
around `has_more`/`next_cursor` and special-casing the rest would make Slack the
implicit reference implementation and force every future provider to be described
in Slack's terms. A fourth provider that gains a history hook inherits the shape
and reports whichever kind it can honestly support.

**Telegram and every other hookless provider are correctly out of scope, and
this is not an omission.** Only Slack, Discord and Teams implement
`hydrateConversationContext` (`slack/channel-state.ts:655`, `discord.ts:216`,
`teams.ts:234`). Everything else falls through to
`{ attempted: false, skipped: true, reason: 'unsupported' }`
(`channel-wiring-conversation-context.ts:28-36`) and makes NO provider request,
so there is no repeated call to remove and nothing a coverage record could
avoid. Adding coverage state for them would be dead rows. If Telegram ever gains
a history hook it picks up the same port and the same coverage semantics without
further design.

**Discord and Teams get the weaker claim, explicitly labelled.** Their coverage
is recorded as *request-bounded* ("the bounded window was requested and the
provider returned fewer than requested"), never as Slack's server-confirmed
completeness. The stored shape must make the distinction unmissable, and no read
path may promote the weaker claim to the stronger one. They still get the saving;
the record stays honest about how much it actually knows.

**A new dedicated table**, `conversation_history_coverage`, keyed by app +
provider account + conversation + thread scope. Not columns on `conversations`
and `conversation_threads`: those would need the same columns duplicated across
two tables to cover top-level and per-thread scope, would widen rows read on
every turn, and would put claim/lease columns on core identity tables.

**The 2.5s deadline is out of scope and stays as it is.** It bounds
first-visible latency when a provider is slow; coverage reduces how OFTEN it is
reached, not how long it waits. Changing it is a separate behavioural judgement
with no measurement behind it, and lowering it would trade history completeness
on genuinely slow providers.

## Scope boundaries

In scope: the hydration port's coverage fields; the durable coverage record and
its migration; per-provider coverage reporting for Slack, Discord and Teams; the
claim and generation fencing; moving on-path persistence off the critical path;
correcting the 30-vs-50 documentation error.

Out of scope: Telegram and other hookless adapters (nothing to remove); changing
`CHANNEL_CONTEXT_LIMIT` or the thread limits; the memory/session hydration paths
(LAT-3A owns those); the inbound envelope (LAT-4A); model or delivery latency.

## Consequences

**This phase is materially larger than 3A or 4A.** It carries a schema
migration, a domain-port change, and per-provider semantics that differ by
capability. It is the first phase in this program to touch durable schema. If
review or measurement shows the port widening and the durable record are
separable, splitting them into two PRs is preferable to one large change — and
that split should be taken rather than resisted.

Acceptance is measured on **operation counts, not milliseconds**: provider
history calls per turn (1 on an uncovered turn, **0** on a covered one), on-path
persistence transactions, and the repeat context query. The 2.5s figure is a
ceiling on an unsettled promise and **must not be quoted as a saving**; no
millisecond claim is available without a real provider run, and none will be
made.

Postgres-backed, so the disposable Postgres lane is required and a missing
`GANTRY_TEST_DATABASE_URL` is a blocker rather than a pass.

**A boundary found while investigating a live report, worth stating because it
limits what this phase can promise.** Coverage records what the PROVIDER
returned; it cannot repair history the runtime never stored locally. When a
conversation's sender allowlist is in `drop` mode and a sender is not on it,
every route is filtered out and the handler returns BEFORE persisting
(`channel-persistence-handlers.ts:148-170`), so that message is never written at
all. The context query itself filters only on conversation, thread scope and
direction — there is no sender filter — so a stored message is always eligible
for the window regardless of author. The hole is therefore at write time and is
permanent: no history hydration, watermark or larger window recovers it. This is
provider-neutral and affects Telegram exactly as much as Slack. It is NOT in
LAT-5's scope; it is recorded so nobody reads "durable history coverage" as a
promise that the agent sees everything humans see in the channel.

Accepted risk: a coverage record that is wrong in the optimistic direction
silently truncates conversation history for the model — worse than the latency it
saves. Every completeness signal must therefore be falsifiable in test, and the
weaker Discord/Teams claim must never be promoted to the stronger Slack one.
