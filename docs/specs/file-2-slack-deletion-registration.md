---
slug: file-2-slack-deletion-registration
title: FILE-2 Slack deletion registration
status: confirmed
saved: 2026-08-02T02:16:17+00:00
---

# FILE-2 — Slack registration on the neutral attachment-deletion operation

## Capability

A message deleted in a Slack conversation the agent participates in tombstones
that message's stored attachments durably, scope-fenced, with the deleted copy
served honestly and stored bytes reclaimed whenever Slack supplies the scope or
the exact stored message can recover it. The one unknowable pre-insert threaded
case is explicit below. Telegram is documented as having no deletion signal
for ordinary bot chats — a capability-matrix truth, not code.

## Behaviour (acceptance)

1. **Slack `message_deleted` routes.** The Bolt `message` listener is already
   inbound-gated (`apps/core/src/channels/slack/channel-interactions.ts:265-273`)
   and its ingest subtype guard currently drops the event
   (`apps/core/src/channels/slack/channel-message-ingest.ts:105-110`). A
   claim-or-pass deletion router runs first inside that ingest function and
   emits `providerId:'slack'` plus
   `externalMessageIds:[deleted_ts.trim()]` — the deleted message's ts, never
   event `ts`. `providerAccountIds` is omitted because the existing
   per-account wrapper injects the credential-sharing account set
   (`apps/core/src/channels/provider-account-channel-connect.ts:171-177`).
2. **Thread scope is defensive.** Slack's
   [`message_deleted` example](https://docs.slack.dev/reference/events/message/message_deleted/)
   omits `previous_message`, although its SDK
   [`MessageDeletedEvent` type](https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/MessageDeletedEvent)
   declares it. When present, any nonblank `previous_message.thread_ts` is the
   stored thread key, matching ingest's current `thread_id: event.thread_ts`;
   absent thread ts means the top-level `sl:<channel>` key. When
   `previous_message` itself is absent, the
   router uses `fallbackConversationJid:'sl:<channel>'` with
   `requireStoredMessageMatch:true` and the repository recovers the exact
   stored row's `threadId ?? conversationJid`. An unknown id writes no marker;
   a pre-insert threaded deletion with no previous-message scope is explicitly
   unknowable and must not write a falsely scoped marker.
3. **Admission is account-fenced.** `findConversationRoutesForChat` is checked
   for each `inboundProviderAccountIds` entry, falling back to the channel's
   `providerAccountId`. A route belonging only to a different provider account
   cannot admit the event. Stored fallback remains fenced by app, provider,
   account, conversation jid, and exact external message id. Slack supplies one
   deleted message id per event, so this route does not depend on Discord's
   bulk-sibling admission behavior.
4. **Durability is reused, with one internal fallback correction.** FILE-1B's
   pair-grain markers, insert-time consumption, retry worker, startup sweep,
   and neutral repository port remain. The existing stored-message fallback is
   broadened to resolve a threaded row by its conversation jid and retain that
   row's own thread key. There is no new repository operation or migration.
5. **Gating inherited.** Registration lives inside the existing
   `inbound !== false` Bolt block: interaction-only and live-turns-off
   connections never observe deletions (structural, asserted).
6. **Identifier and failure truth.** A `message_deleted` without a nonblank
   deleted ts or channel claims the event without a durable write. A valid
   deletion with no callback throws. A callback rejection reaches Bolt's error
   hook and inbound-dispatch-failure signal; it is not counted as successful
   live dispatch.
7. **Telegram truth.** Decision 0094's matrix and the program doc state that
   Telegram's Bot API emits no deletion update for ordinary bot chats
   (`deleted_business_messages` requires a Business connection the adapter
   has no concept of); nothing is registered and nothing pretends to be.
8. **`file_deleted` stays lazy.** The read-time taxonomy already tombstones
   on `file_deleted`; no eager event route (it would need a new
   identity-based repository operation for a latency-only gain).

## Non-goals

Telegram Business accounts; Slack `message_changed` attachment reconciliation
(same class as Discord's MESSAGE_UPDATE — D-0039); eager `file_deleted`
routing; Teams (D-0034).

## Constraints

- No schema change and no new repository port operation; the internal
  stored-message fallback semantics change as specified above.
- The dead `message_changed` line under the subtype guard is removed only if
  the routing change makes it genuinely unreachable-dead in the new shape.
- 0094 matrix rows flip in the same change, with citations.

## Required falsifiers

- Ordinary messages still pass to the existing ingest path; only
  `message_deleted` is claimed.
- Deleted ts versus event ts, preservation of a present thread key, top-level
  jid, omitted `previous_message`, blank identifiers, missing callback, and
  callback rejection through Bolt's error hook are each asserted.
- Route admission is proved for the owning account and rejected for a
  different account; shared-credential delivery makes one callback with the
  complete injected account set.
- Real Postgres proves separately that an admitted identified-scope
  delete-before-insert is retained, and that an unadmitted stored threaded
  message can be deleted when `previous_message` is absent while an unknown id
  leaves no marker.
- A repeated Slack event is idempotent, exact unrelated attachments remain
  live, and resolving a tombstoned attachment returns
  `ATTACHMENT_DELETED_COPY` with zero provider calls.
