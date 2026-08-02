---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-02
stories: [LAT-4B]
---

# Thread Recency Uses the Message Timestamp

## Context

Chat-list ordering reads `conversations.updated_at` (listChats orders by it
and maps it to last_message_time). Top-level inbound messages advance it
monotonically from the MESSAGE's own timestamp — `GREATEST(existing,
message_timestamp)` — but thread messages additionally trip a duplicate
nested `conversations` upsert inside `ensureThread` that passes no
timestamp, so threads get a wall-clock (`now()`) bump instead. The nested
write is redundant in the same transaction and also clobbers
`external_ref_json.isGroup` (it passes no `isGroup` and the DO UPDATE
rewrites the ref unconditionally).

## Decision

Thread recency uses the message timestamp, exactly like top-level messages:
`GREATEST(existing, message_timestamp)`, monotonic. The nested duplicate
`conversations` write is deleted with the rest of LAT-4B's same-transaction
repeats; `ensureThread` receives the caller's already-ensured
`conversationId`.

Confirmed by Ravi in-chat (AskUserQuestion, 2026-08-02): "Message
timestamp" over "Wall clock".

## Rejected alternative

Wall-clock recency ("any persistence touch bumps the list") — rejected:
backfill and redelivery would reorder the chat list nondeterministically,
and it contradicts the top-level contract that has already shipped.

## Consequences

- A provider message whose timestamp is older than the stored `updated_at`
  pins recency instead of advancing it — identical to current top-level
  behavior.
- The `isGroup`-stripping clobber disappears with the deleted write.
