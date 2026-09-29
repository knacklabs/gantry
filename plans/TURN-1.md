# One message, one turn

6 parts · Risks: a migration that backfills existing messages as already read, and removing the old "read up to here" marker · New moving parts: none

## What changes for you

- A long message that Telegram splits into parts gets one reply that answers all of it. The same goes for two or three quick messages in a row, on every channel.
- Nothing you send is silently skipped or answered twice. A photo sent just before its question is always seen by the agent: in the same turn if it arrives in time, otherwise in the next turn.
- In groups where the bot has to be mentioned, you don't need to mention it again:
  - for the rest of a split message;
  - when replying to the bot;
  - in a thread or topic where it already replied;
  - while it is working on your request.
- On Discord, @mentioning the bot now works.
- If the agent is overloaded, you're told to resend instead of hearing nothing, at most once every 5 minutes.
- Replies start about a second and a half later, because Gantry waits briefly for the rest of your message. /stop still works instantly.

## Why

See the spec: [One message, one turn](../docs/specs/one-message-one-turn.md). Split messages get two replies, follow-ups and photos are dropped, and messages can be given twice. All of this comes from storing "which messages has the agent taken in?" three times with different lifecycles, and ordering by the platform's clock. This story keeps that fact in one place, in the shared intake layer, so every current and future channel (WhatsApp, the web SDK) behaves the same.

## Done when

1. **A split message or a quick burst gets one reply.** Messages from one conversation (and thread or topic), from any sender, start exactly one turn with all of them in received order (up to 10). This covers every channel, including a Telegram message split by the platform. The turn starts:
   - 1.5 seconds after the newest message; each new message restarts the wait, up to 6 seconds after the first;
   - after 4 seconds when the newest text is at 90% or more of that platform's length limit;
   - after 1.5 seconds on platforms with no known limit.

   /stop and other session commands never wait. /stop also cancels a batch that hasn't started; its messages are kept as history.
2. **No message is lost or given twice.**
   - A message saved after a turn started (for example a slow photo) reaches the agent in that turn, if it arrives before the final reply, or in the next turn.
   - A turn that fails before replying gives its messages to the next turn. One that fails after replying never gives them again.
   - The two-worker, settings-reload and restart tests show no message dropped, doubled or left unconsumed.
3. **Mention-required groups follow the conversation.** These reach the agent without a new mention:
   - the parts of a split mention message;
   - a reply to the bot's message;
   - a follow-up in a thread or topic where the bot already replied;
   - a message sent while the agent's turn is running.

   An unrelated plain group message still does not start a turn, and the sender allowlist still applies (decision 0090).
4. **A real Discord @mention of the bot starts a turn.**
5. **An overloaded backlog is not silent.** The sender gets a short "busy, please resend" notice, at most once every 5 minutes per conversation. The message is kept as history only, so a resend isn't doubled.

## Risks

- **Database migration with a backfill (one-way).** The existing admission work items gain a receive-order number, "consumed at" and "consumed by". Every existing item is marked consumed in the same migration. If the backfill were skipped, up to 30 days of history would replay as new input.
- **The old "read up to here" marker is deleted (one-way).** This is the `last_agent_timestamp` router state. Rolling back after it is gone means old messages would be treated as unread. So the backfill ships in the same release, and the marker is only removed once turns read the new record.
- **Every first message waits 1.5 seconds** before its turn starts. Owner choice, 2026-09-29.
- **Decisions amended:**
  - 0049: an over-cap message becomes history plus a busy notice.
  - 0080: the note that a live turn carries a cursor is superseded; the authoritative second read at turn start stays.
  - 0103: the cleanup sweep deletes only consumed items.

## For the builders

**The shared seam, pinned by T1.** The admission work item (one per message per agent route) is the single record of consumption. It gets:

- `seq`: a database identity, which is the receive order;
- `consumed_at` and `consumed_by`: a turn id, a command id, `not_triggered` or `control`;
- `created_at`: from the database clock, not the provider timestamp.

Two repository calls work on it:

- `takeInput(scope, limit, consumer)` consumes the oldest unconsumed items in `seq` order and returns their message ids;
- `releaseInput(consumer)` un-consumes only that consumer's own items.

Scope is keyed on columns (conversation, thread, agent, account), not the queue-key string. Nothing can move backwards, and an item saved late is simply still unconsumed.

**Keep these existing rules:**

- the 10-message batch limit, and requeue when more remain;
- a message with `responseSchema` or `agentControls` ends its batch;
- session and control commands consume only their own message;
- the failure rules in `group-processing-flow.ts`: never replay after output was sent; keep consumed on the final retry, or once failover is exhausted and the user was told;
- the "seen" reaction on piped follow-ups;
- the trigger bypass for callable-agent follow-ups;
- the continuation idempotency key, which becomes a hash of item ids.

**Quiet window.** It lives in the enqueue transaction that already holds the per-app lock (0049, 0085):

- insert the item as `deferred` with `defer_until = now() + window` (1.5 s, or 4 s when the text is at least 90% of the provider's `maxInboundTextLength`);
- push the queue's other deferred items to the same time, capped at the first item's `created_at` plus 6 seconds;
- the first item to run takes the whole batch, and its siblings find nothing and complete;
- the near-limit length is one `maxInboundTextLength` per provider in the provider registry.

**One trigger rule.** `decideBatch` is the single trigger rule, used at turn start and for mid-turn follow-ups. It reads the `mentionsBot` flag that each adapter sets on the inbound message (stored in the existing message reference JSON, so no migration). The text-pattern match stays as the fallback for adapters that don't set the flag yet.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | One record of what each message was consumed by | Migration adding the receive order and consumed columns, a partial index on unconsumed items, and the backfill marking existing items consumed. `takeInput`/`releaseInput`, receive time from the database clock, and the 0103 sweep limited to consumed items. | 2 | `apps/core/src/adapters/storage/postgres/schema/live-turns.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts`, the repository's port type, `docs/decisions/0103-*` | Postgres integration: consumes in receive order; an item saved late is taken next; release only undoes its own consumer; backfill marks existing items consumed; sweep keeps unconsumed items. One test crossing enqueue → `takeInput`. | | no |
| T2 | Turns take their input from that record | Turn start, batching, session commands and failure handling consume and release through `takeInput`/`releaseInput` instead of reading and moving the marker. | 2 | `apps/core/src/runtime/message-loop.ts`, `apps/core/src/runtime/group-processing.ts`, `apps/core/src/runtime/group-processing-flow.ts`, `apps/core/src/runtime/pending-message-replay.ts`, `apps/core/src/runtime/group-session-command-state.ts` | Unit and integration tests for batch limit, schema-ending batch, session command, failure before output releases, failure after output keeps consumed | T1 | yes |
| T3 | Recovery, follow-ups and restarts use the same record; the old marker is deleted | Live-turn continuations and recovery release and consume items. The startup scan becomes "queues with unconsumed items". Deleted: `lastAgentTimestamp`, its save/load/recover code, the cursor payload on live turns, and GroupQueue's in-memory turn retry. | 2 | `apps/core/src/app/bootstrap/live-execution.ts`, `apps/core/src/app/bootstrap/live-turn-continuation.ts`, `apps/core/src/app/bootstrap/live-recovery-coordinator.ts`, `apps/core/src/app/bootstrap/runtime-services.ts`, `apps/core/src/app/bootstrap/runtime-services-active-new.ts`, `apps/core/src/app/bootstrap/runtime-app.ts`, `apps/core/src/runtime/group-queue.ts`, `docs/decisions/0080-*` | `apps/core/test/e2e/claim-protocol-two-process.postgres.e2e.test.ts` extended so no message is doubled or dropped across two workers; a settings-reload test; a restart-recovery test | T2 | yes |
| T4 | Quiet window before a turn starts | The enqueue defers items by the window, groups a conversation's items, uses the longer window after a near-limit message, and lets session commands skip it | 1 | `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts` (enqueue only), `apps/core/src/channels/provider-registry.ts` | Postgres integration: three quick messages give one batch; the wait restarts per message; the 6 s cap; a near-limit message gives 4 s; a provider with no limit gives 1.5 s; /stop not delayed and cancels a waiting batch as history | T1 | yes |
| T5 | One rule for whether a message is for the agent | `decideBatch` used at turn start and for mid-turn follow-ups. The `mentionsBot` field is pinned on the inbound message type, and the thread rule works on every provider. | 3 | `apps/core/src/runtime/group-trigger-policy.ts`, `apps/core/src/runtime/message-loop.ts` (trigger section), `apps/core/src/domain/types.ts` | Unit: split mention batch, reply to the bot, thread the bot is in, mid-turn follow-up, unrelated message ignored, allowlist still enforced | T2 | yes |
| T6 | Discord mentions and the busy notice | Discord sets `mentionsBot` from its native mention. An overloaded message sends one busy notice and stays as context. Decision 0049 amended. | 4, 5 | `apps/core/src/channels/discord/index.ts`, `apps/core/src/app/bootstrap/channel-persistence-handlers.ts`, `docs/decisions/0049-*` | Discord ingest unit test with `<@id>` and `<@!id>`; overload test: the message is kept as history only, and a second overloaded message within 5 minutes sends no second notice | T5 | yes |

New moving parts: none

## Notes

- **Later stories**, from the same analysis:
  - Story 2, "Channel intake contract": the written adapter contract; `mentionsBot` for Telegram, Slack and Teams; media saved as a placeholder first on Telegram, Slack and Discord; saving kept in order per conversation.
  - Story 3, "One path for mid-turn messages": the runner confirms delivery, and GroupQueue's message lane is removed.
- **A separate small fix deletes dead code:** the unreachable Telegram direct-message draft streaming, and the Telegram 429 wrappers that autoRetry makes unreachable (after choosing one retry owner).
- **Findings the analysis confirmed but this story leaves alone** (they belong to the outgoing-reply and failure-message stories):
  - Slack thread broadcasts are ignored;
  - Slack and Discord reply splitting;
  - Telegram formatting fallback;
  - the 60-second "failed but delivered" report;
  - the ⏳ reaction;
  - "I hit an issue." with no reason.
