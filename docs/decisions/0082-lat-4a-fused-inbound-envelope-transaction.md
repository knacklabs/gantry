---
status: proposed
confirmed_by: ""
date: 2026-07-29
---

# LAT-4A: Fuse The Paired Inbound Envelope Into One Transaction And Carry Name/Kind

## Context

The roadmap's Phase 4A is "One Inbound Envelope Transaction": persist normalized
metadata, one message, and all eligible admissions in one serialized
transaction, then notify new admissions after commit
(`plans/MyClaw-Response-Latency-Refactor-Plan.md`). The goal prompt's A2 adds
the mechanism: "carry name/kind metadata IN the ingress op so the separate
awaited metadata write + its 34-line queue handler die"
(`docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md`).

Measurement at `98f40dce6` (signal `S-0001-f4d3`) shows the observation holds
but the naive remedy does not.

**Persisting one inbound envelope costs 28 SQL statements** on the normal
explicit-provider-account, no-thread, no-attachment route — metadata write,
message graph write, participants, message and part, and admission enqueue,
measured with the window held open until the persistence queue drains.

(An earlier draft said "before admission wake". That boundary is not observed by
the measurement, so the wording was corrected to name the quantity actually
counted — the total persistence cost of one inbound message, which is what this
phase reduces.)

| Phase | Statements | Tables |
| --- | ---: | --- |
| metadata `ensureConversation` | 9 | apps, llm_profiles, providers, agents, agent_config_versions, provider_accounts, conversations |
| message-graph `ensureConversation` | 9 | the same seven |
| participant | 3 | users, user_aliases, conversation_participants |
| message + part | 2 | messages, message_parts |
| admission enqueue | 5 | advisory lock, idempotency lookup, id lookup, active-count, insert |

**Transaction fusion alone saves nothing.** Today is nine autocommit statements
plus `BEGIN` + 19 + `COMMIT`; a fused form is `BEGIN` + 28 + `COMMIT`. Same
statements, same round trips. Its only gain is collapsing ten durability
boundaries into one atomic visibility point — real, but not latency.

**The measured cost is a duplicate.** `ensureConversation` runs twice over the
same seven tables, and message persistence re-runs it inside its own transaction
without needing the separately committed metadata row
(`canonical-message-repository.postgres.ts:183`). Nothing in the message path
reads the metadata write.

Two constraints make deleting it non-trivial, and both are why this is a
decision rather than a refactor:

1. **The metadata call carries fields the message call omits.** Deleting it
   naively regresses `conversations.title` to the raw JID (`input.name || jid`)
   and inserts a group/channel as `conversations.kind = 'direct'`, because the
   message path omits `isGroup`
   (`canonical-graph-repository.postgres.ts:312-325,347-365`). A later rename
   also stops propagating, since the message path emits no title update.
2. **Metadata is load-bearing on six standalone paths that never persist a
   message**: Slack group discovery
   (`channel-delivery-helpers.ts:733-776`), Telegram group-join onboarding
   (`group-join-onboarding.ts:16-55`), unregistered Slack group messages
   (`channel-message-ingest.ts:113-152`), unregistered Telegram group text
   (`text-message-handler.ts:86-117`), Slack slash commands with no eligible
   route (`slash-command-ingest.ts:36-65`), and unregistered Telegram group
   media (`media-ingestion.ts:49-98`). Deleting metadata globally loses durable
   conversation rows and title/kind refreshes on all six.

## Decision

Fuse the **paired** inbound path — the one where a message actually follows —
into a single transaction that persists conversation graph state, the message
and its part, participants, and all eligible admissions, notifying admissions
**after commit**.

Within that transaction, `ensureConversation` is invoked **once**, with `name`
and `isGroup` carried into it from the ingress envelope. The paired metadata
invocation is then deleted, because its work is exactly what the surviving call
now performs.

Expected: **28 → 19 statements** to persist one inbound envelope on the measured
route, a 32% reduction, plus one atomic visibility point instead of ten
durability boundaries.

**Provider-neutral, not Telegram-only.** Gantry is a provider-neutral and
channel-neutral runtime (`docs/product/BRIEF.md`), so this fix applies to EVERY
ingress that pairs a metadata write with a message write, not to whichever
provider happened to be measured first. Five paired sites exist and all are in
scope:

| Path | Provider |
| --- | --- |
| `channels/telegram/text-message-handler.ts:106` | Telegram text |
| `channels/telegram/media-ingestion.ts:49` | Telegram media — **NOT converted, see below** |
| `channels/slack/channel-message-ingest.ts:113` | Slack |
| `channels/discord.ts:571,575` | Discord |
| `channels/teams.ts:439` | Teams |

The duplicate-skip rule and the name/isGroup carry are expressed ONCE in a
shared channel-layer helper rather than copied five times, so a sixth provider
inherits the behaviour instead of re-implementing it. Per-provider control flow
(drop logging, early returns, media handling) stays with each adapter.

**Telegram media is deferred, not done (D-0025).** It was converted and then
reverted before merge. With the fusion applied it ran `ensureConversation`
exactly once and issued 13 statements, yet left NO conversation row — while the
same fixture shape works for Telegram text, Slack and Teams. The likeliest
explanation is that the fused transaction rolled back and took the conversation
row with it, where previously the metadata write committed independently and
survived. That is a genuine consequence of fusing and it is not understood well
enough to ship. Measured before/after for the other three is uniform:

| Provider | Before | After | Saved |
| --- | ---: | ---: | ---: |
| Telegram text | 28 | 19 | 9 |
| Slack | 29 | 20 | 9 |
| Teams | 28 | 19 | 9 |
| Telegram media | 22 | 22 | 0 — deferred |

The saving is exactly nine statements per provider, which is the duplicate
`ensureConversation`. Note the totals differ per provider: a single shared
expected count would have been wrong for two of the four, so the tests carry
per-provider measured numbers.

**Discord uses the adapter-seam fallback, not mocked integration coverage.**
`DiscordChannel.connect` wires inbound dispatch through its WebSocket gateway
(`channels/discord.ts:140-149`), and `MESSAGE_CREATE` reaches the private
message handler only from that dispatch (`channels/discord.ts:530-550`).
Driving it locally therefore requires replacing the WebSocket and REST
transport. LAT-4A-3 does not label that an integration test: the registered
paired-message shape is covered at the Discord unit adapter seam, including
the `onMessage` identity and absence of a standalone metadata call. No Discord
Postgres statement count was observed or added to the expectation table.

**Standalone metadata sites stay untouched** — they never pair with a message:
Slack group discovery (`channel-delivery-helpers.ts:763`), Slack slash commands
(`slash-command-ingest.ts:36`), Telegram group-join onboarding
(`group-join-onboarding.ts:31`), and provider-account channel connect
(`provider-account-channel-connect.ts:117,127`).

**A trap found while implementing, recorded so it is not repeated.** The skip
cannot be narrowed to group chats. `onMessage` refuses an unregistered DIRECT
message with no configured binding
(`channel-persistence-handlers.ts:130-141`), so no envelope follows for those
either, and gating the metadata write on `isGroup` deletes their conversation
row outright — measured as `ensureConversation` dropping to zero calls on that
path. The correct rule is: write standalone metadata whenever the chat has no
registered route, regardless of kind.

**Explicitly out of scope, unchanged:**

- The six standalone metadata paths above. They never persist a message, so
  there is no envelope to fuse them into; they keep their metadata write exactly
  as it is.
- Collapsing the stable app/profile/provider/agent/account identity upserts
  *inside* `ensureConversation`. Plan-validation §1 calls that unsafe without a
  commit-backed graph-ready receipt carried from ingress/setup, and it stays out
  of this phase. This decision deletes a redundant *call*, not the upserts
  within it.
- Attachment, thread, and multi-route statement shapes beyond preserving their
  current behaviour. A thread adds a second nine-statement `ensureConversation`
  plus a `conversation_threads` insert; that is measured but not optimised here.

## Consequences

The roadmap's "stable graph upsert deletion is out of scope unless
after-measurement earns a separate decision and PR" is satisfied in the narrow
sense only: this record earns the deletion of the duplicate *call* on the paired
path. It does not authorise the upsert-level work, which still needs its own
decision.

Acceptance must include a regression proving `conversations.title` and
`conversations.kind` survive a **first group message** — that is precisely what
a naive deletion breaks, and a test that only exercises direct conversations
would pass while shipping the bug.

Multi-route behaviour is the main semantic risk: today each selected route gets
its own sequential store/admission call
(`channel-persistence-handlers.ts:182`). The fused operation must retain every
route's admission identity and trigger decision, and that needs explicit
coverage rather than trust.

Notify-after-commit is a behaviour change worth stating plainly: an admission
must not become observable to a waking worker before the message it refers to is
committed. Getting this backwards would surface a wake for a message that is not
yet visible.

Accepted risk: the fused transaction holds locks across more work than the
message transaction does today, including the graph upserts previously done
outside any transaction. The lock window grows. This is judged acceptable
because the added statements are short upserts on small identity tables, but if
contention appears in production this decision is the thing to revisit.
