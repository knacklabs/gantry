# One message, one turn

7 parts · Risks: a migration that marks already-read messages from the old marker, and removing that marker · New moving parts: none

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

- **Database migration with a backfill (one-way).** T1 adds nullable columns to the existing admission work items: receive order, "consumed at" and "consumed by". T2's migration then backfills them from the saved "read up to here" marker at switch time:
  - an item is marked consumed only if its message is at or before its queue's saved marker;
  - every other item (queued, deferred or claimed but not yet in a turn) stays waiting, and the next turn takes it.
  If the backfill were wrong, old history would replay or pending work would be skipped. It gets its own integration test that seeds both kinds of item.
- **The switch is one task, so every merge leaves the system consistent.**
  - T1 adds the record, but nothing uses it yet.
  - T2 moves every reader and writer to it in one step. The old marker is still written but no longer read, which is harmless.
  - T3 then deletes the marker (the `last_agent_timestamp` router state, one-way).
  No merge leaves two records that disagree.
- **Every first message waits 1.5 seconds** before its turn starts. Owner choice, 2026-09-29.
- **Runner protocol change:** runners report which mid-turn messages actually reached the model. Both runners (Claude and DeepAgents) change in the same task as the host side.
- **Decisions amended:**
  - 0049: an over-cap message becomes history plus a throttled busy notice.
  - 0080: the authoritative second read at turn start *is* the consumption step; the note that a live turn carries a cursor is superseded.
  - 0103: the cleanup sweep deletes only consumed items.

## For the builders

**The record, pinned by T1.** The admission work item (one per message per agent route) is the single record of consumption.
- Columns:
  - `seq`: a database identity, which is the receive order across all workers;
  - `consumed_at` and `consumed_by`: `turn:<id>`, `command:<id>`, `history` or `stopped`;
  - `created_at`: from the database clock, not the provider timestamp.
- Operations, on the concrete `PostgresLiveTurnRepository` and its port:
  - `takeInput(scope, limit, consumer)` consumes the oldest unconsumed items in `seq` order, in one statement, and returns their message ids;
  - `releaseInput(consumer)` un-consumes only that consumer's own items;
  - `consumeAll(scope, consumer)` is used for history and /stop.
- Scope is keyed on columns (conversation, thread, agent, account), not the queue-key string.
- Nothing can move backwards, and an item saved late is simply still unconsumed.

**Who takes input: exactly two callers, pinned by T2.**
1. **Turn start.** Group processing's authoritative read (0080) *is* `takeInput(scope, 10, turn:<id>)`. It reads the message rows for the ids it took, and no earlier read is reused. A message saved after that call is picked up by the next caller.
2. **The live-turn router, for mid-turn follow-ups.** It calls `takeInput(scope, n, command:<id>)`.

Admission itself never takes input: it only decides whether to wake a turn. The continuation idempotency key becomes a hash of the taken item ids. T2 pins this in `pending-message-replay.ts`, with a test crossing turn start and a follow-up that arrives late.

**Mid-turn confirmation, T4.**
- Each continuation file carries its command id.
- The runner reports, in its final output, the command ids whose text reached the model. The steering gate's close returns what it buffered but didn't deliver, instead of discarding it.
- At turn end the host releases items taken by unconfirmed commands, and deletes any leftover continuation files, so the next turn gets them.

**Keep these existing rules:**
- the 10-message batch limit, and requeue when more remain;
- a message with `responseSchema` or `agentControls` ends its batch;
- session and control commands consume only their own message;
- the failure rules in `group-processing-flow.ts`: release on failure before any output; keep consumed after output, on the final retry, or once failover is exhausted and the user was told;
- the "seen" reaction on piped follow-ups;
- the trigger bypass for callable-agent follow-ups.

**Quiet window, T5.** It lives in the enqueue transaction that already holds the per-app lock (0049, 0085):
- insert the item as `deferred` with `defer_until = now() + window`;
- the window is 1.5 s, or 4 s when the text is at least 90% of the provider's `maxInboundTextLength`, which is set on the provider entries in `register-builtins.ts`;
- push the queue's other deferred items to the same time, capped at the first item's `created_at` plus 6 s;
- session commands skip the window, and /stop calls `consumeAll(scope, stopped)` on a waiting batch.

**One trigger rule, T6.**
- `decideBatch` is used in both places a trigger is decided today: the admission check in `message-loop.ts` and turn start in `group-processing.ts`.
- `mentionsBot` is stored in the message reference JSON. T6 owns that format: it is written by `externalRefForMessage` and restored by `mapMessage`, so no migration.
- "Reply to the bot": the replied-to stored message has `is_from_me`. "The bot's thread": the thread holds a stored message with `is_from_me`.
- The text-pattern match stays as the fallback for adapters that don't set the flag yet.
- Since T2 there is one trigger point, turn start in `group-processing.ts`; `message-loop.ts` no longer decides triggers.
- A thread continuation still needs at least one allowed sender in the current batch. A fix already enforces this; keep it in `decideBatch`. The bot's-thread rule must not widen it to any sender.
- "The bot's thread" must look at outbound rows too, using the all-directions context read rather than the inbound-only one. Live Slack roots are stored without a thread id, so an inbound-only lookup misses them and an unmentioned follow-up gets no reply.
- Telegram sets `mentionsBot` from bot mention entities in `entities` or `caption_entities`, and from raw text or a caption matching the route's own trigger. The global `@<assistant name>` prepend is deleted. A media placeholder such as `[Photo]` must not stop a caption's trigger from matching.

**Busy notice, T7.**
- Every channel's persistence handler acts on the `overloaded` result. It sends the notice through the durable outbox with the idempotency key `busy:<conversation>:<5-minute window>`, so exactly one worker sends it.
- The external ingress path returns a "busy" error to the caller instead.
- The notice goes only to a message that would have started a turn: the route needs no trigger, or `decideBatch` says yes, and the sender is allowed. Unmentioned chatter and disallowed senders get no notice. Send one notice per message, not one per route, and include the thread in the key.
- SDK sessions and delegated follow-ups are handled by a separate fix, not T7.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | One record of what each message was consumed by | Nullable columns: receive order, consumed at, consumed by. A partial index on unconsumed items. `takeInput`/`releaseInput`/`consumeAll` on the port and the concrete repository, `created_at` from the database clock, and the 0103 sweep limited to consumed items. No production caller yet. | 2 | `apps/core/src/adapters/storage/postgres/schema/live-turns.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `apps/core/src/adapters/storage/postgres/repositories/live-turn-repository.postgres.ts`, `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts`, the repository port type, `docs/decisions/0103-*` | Postgres integration: consumes in receive order across two connections; a late item is taken next; release only undoes its own consumer; the sweep keeps unconsumed items. A crossing test: enqueue → turn-start take → late enqueue → next take. | | no |
| T2 | Switch every reader and writer to the record, in one step | Turn start, follow-ups, session commands, failure handling and recovery consume and release through the record. The backfill migration comes from the saved marker. The marker is still written but no longer read. Pins the two callers and the item-id idempotency key. | 2 | `apps/core/src/runtime/message-loop.ts`, `apps/core/src/runtime/group-processing.ts`, `apps/core/src/runtime/group-processing-flow.ts`, `apps/core/src/runtime/pending-message-replay.ts`, `apps/core/src/runtime/group-session-command-state.ts`, `apps/core/src/app/bootstrap/live-execution.ts`, `apps/core/src/app/bootstrap/live-turn-continuation.ts`, `apps/core/src/app/bootstrap/live-recovery-coordinator.ts`, `apps/core/src/app/bootstrap/runtime-services.ts`, `apps/core/src/app/bootstrap/runtime-services-active-new.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `docs/decisions/0080-*` | Backfill test seeding items before and after the marker. The two-process e2e (`apps/core/test/e2e/claim-protocol-two-process.postgres.e2e.test.ts`) extended: nothing doubled or dropped. Settings reload and restart recovery. Failure before output releases; failure after output keeps. | T1 | yes |
| T3 | Delete the old marker | Deletes `lastAgentTimestamp`, its save/load/recover code, the setter dependencies and the cursor payload on live turns. Adds a migration removing the `last_agent_timestamp` row; nothing else deletes router state, so no new repository operation is added. Lowers the architecture-map limits T2 raised for live-execution, runtime-services and group-processing; the live-turn repository's limit moves to T8. | 2 | `apps/core/src/app/bootstrap/runtime-app.ts`, `apps/core/src/runtime/group-queue.ts`, the storage ops port and its Postgres implementation for router state, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `scripts/architecture-map.json` (lowering the limits T2 raised), plus removing now-unused setter wiring in the T2 files | Existing suites green with no cursor references left; a type check that no setter remains | T2 | no |
| T4 | The agent confirms which mid-turn messages it read | Continuation files carry their command id. Both runners report delivered ids, and the steering gate's close returns undelivered text instead of dropping it. At turn end the host releases unconfirmed commands' items and clears leftover files. | 2 | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/**` (steering gate, query loop, IPC input, output frame), the DeepAgents runner's live-control and output, `apps/core/src/runtime/continuation-input.ts`, `apps/core/src/runtime/group-queue-live-turn-hooks.ts`, the agent spawn workspace cleanup | A follow-up arriving at close is given to the next turn; a leftover file never reappears in an unrelated turn; the runner output-frame contract test | T2, T8 | yes |
| T5 | Quiet window before a turn starts | The enqueue defers items by the window, groups a conversation's items, and uses the longer window after a near-limit message. Session commands skip it, and /stop cancels a waiting batch as history. | 1 | `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts` (enqueue only), `apps/core/src/channels/provider-registry.ts`, `apps/core/src/channels/register-builtins.ts`, the /stop handling in `apps/core/src/runtime/group-session-command-state.ts` | Postgres integration: three quick messages give one batch; the wait restarts per message; the 6 s cap; near-limit gives 4 s; no limit gives 1.5 s; /stop is not delayed and cancels a waiting batch as history | T2 | yes |
| T6 | One rule for whether a message is for the agent | `decideBatch` at both trigger points. `mentionsBot` on the inbound type and in the stored reference JSON. The reply-to-the-bot and bot's-thread lookups work on every provider. | 3 | `apps/core/src/runtime/group-trigger-policy.ts`, `apps/core/src/runtime/message-loop.ts` (trigger section), `apps/core/src/runtime/group-processing.ts` (trigger section), `apps/core/src/domain/types.ts`, `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository-identifiers.ts`, `apps/core/src/adapters/storage/postgres/services/canonical-message-ops-service.ts`, `apps/core/src/channels/telegram/text-message-handler.ts`, `apps/core/src/channels/telegram/media-ingestion.ts`, `apps/core/src/channels/telegram/channel-connect.ts` | Unit tests: split mention batch; reply to the bot; the bot's thread on Slack, Telegram topic and Discord thread; mid-turn follow-up; an unrelated message kept as history; allowlist enforced. A round-trip test for `mentionsBot` through storage. | T3 | yes |
| T7 | Discord mentions and the busy notice | Discord sets `mentionsBot` from `<@id>`/`<@!id>`. An overloaded message sends one durable, throttled notice on every channel, and external ingress returns "busy". Decision 0049 amended. | 4, 5 | `apps/core/src/channels/discord/index.ts`, `apps/core/src/app/bootstrap/channel-persistence-handlers.ts`, `apps/core/src/application/external-ingress/conversation-message-ingress.ts`, `docs/decisions/0049-*` | Discord ingest test for both mention forms. Overload across two workers: one notice per 5 minutes, and the message kept as history only. The external ingress returns busy. | T6 | yes |
| T8 | Input is committed before anything leaves | A nullable `committed_at` on admission items, plus a conditional `commitInput` that runs before a turn's first visible send, before the model step that reads a follow-up, and before a command's side effect. Every release adds `committed_at IS NULL`, so committed input never goes back. Taking a follow-up and appending its command become one transaction, and so do rejecting a command and releasing its item. A new message commits at the first visible send, so a turn that fails before replying still gives it to the next turn. This replaces the in-process "output reached the user" release rule. Each item also carries a stored attempt count, which sets the final-retry notice, so GroupQueue's in-memory turn retry is deleted and the durable record is the one retry owner. T8 lowers the live-turn repository's architecture-map limit back to 770 once the delivered-output check it replaces is gone. | 2 | `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts`, `apps/core/src/adapters/storage/postgres/repositories/live-turn-repository.postgres.ts`, `apps/core/src/adapters/storage/postgres/schema/**`, `apps/core/src/domain/ports/live-turns.ts`, `apps/core/src/runtime/group-processing.ts`, `apps/core/src/runtime/group-processing-flow.ts`, `apps/core/src/runtime/group-output-buffer.ts`, `apps/core/src/runtime/message-loop.ts`, `apps/core/src/runtime/live-turn-continuation-command.ts`, `apps/core/src/app/bootstrap/live-recovery-coordinator.ts`, `apps/core/src/app/bootstrap/live-execution.ts`, `apps/core/src/runtime/group-queue.ts` | Postgres: two-connection races for claim, commit and release; a crash between take and append; a crash between reject and release; a command that takes effect then throws; a stream that reaches the channel and dies before its transcript is saved, then recovery; a queued but unread follow-up recovered | T2 | yes |

New moving parts: none

## Notes

- **T8 comes from T2's review (owner decision, 2026-10-01).** T2's reviews kept finding crashes between two separate writes: take then append a follow-up, reject then release it, stream the final chunk then save the transcript. These gaps moved out of T2 so that one durable rule closes them together. The design is a claim/commit split taken from a Codex design review.
- **T8 also batches the take.** Turn start takes up to 10 items one at a time, with a claim and a message fetch for each. T8's commit rewrite takes the batch in one bounded repository call: claim in receive order, stop at a command or control message, and return the message rows. Ownership fencing stays. This is an optimisation from an external review, not a measured problem.
- **T3 to T8 (owner decision, 2026-10-01).** T3 found that nothing durable retries a turn that fails after it starts, so deleting GroupQueue's in-memory retry would break the final-retry notice. That deletion moves to T8, together with a stored attempt count. The live-turn repository's limit (798, from 770) also comes down in T8, which removes the delivered-output check that holds those lines.
- **Later stories**, from the same analysis:
  - Story 2, "Channel intake contract": the written adapter contract; `mentionsBot` for Telegram, Slack and Teams; media saved as a placeholder first on Telegram, Slack and Discord; saving kept in order per conversation.
  - Story 3, "One path for mid-turn messages": GroupQueue's message lane and its duplicate capacity gate are removed. Runner confirmation is already in this story.
- **A separate small fix deletes dead code:** the unreachable Telegram direct-message draft streaming, and the Telegram 429 wrappers that autoRetry makes unreachable (after choosing one retry owner).
- **Findings the analysis confirmed but this story leaves alone** (they belong to the outgoing-reply and failure-message stories):
  - Slack thread broadcasts are ignored;
  - Slack and Discord reply splitting;
  - Telegram formatting fallback;
  - the 60-second "failed but delivered" report;
  - the ⏳ reaction;
  - "I hit an issue." with no reason.
