# Every incoming message is saved before anything can fail

8 parts · Risks: a new table that holds raw incoming messages until they are read; one unreadable message can hold up its own chat thread for about 2 minutes · New moving parts: the inbox table and the worker that reads it

## What changes for you

- Messages from Slack, Telegram and Discord are saved the moment the platform hands them over, before Gantry looks anything up.
  - Today a failed lookup can lose a message without anyone noticing: a Discord thread's parent channel, a Slack channel name, the sender's identity, or a photo download. So can a restart at the wrong moment.
  - After this story that message still gets its normal reply, once.
- If a platform sends the same message twice, you get one reply.
- Quick messages and photos from one chat reach the agent in the order Gantry received them. A slow photo no longer lets the text sent after it jump ahead.
- /stop works at once, even if an earlier message is still being read, and the messages sent before it never start a turn later.
- Editing or deleting a message before the agent has read it changes what the agent sees: it reads the edited text, and never reads a deleted message.
- If a message truly can't be read, `gantry status` says so, with the platform and a plain reason. You can retry it or dismiss it. The rest of that chat carries on.
- Rarely, a message waits a little longer, up to about 2 minutes, while an earlier message in the same thread is retried. Other chats and threads aren't held up.

## Why

See the spec: [One messaging pipeline for every provider](../docs/specs/one-messaging-pipeline.md).

Today each provider does its lookups and downloads before anything is saved, and many failures end in a log line:
- Slack has already acknowledged the event.
- Telegram skips an update whose handler failed, and its photos wait in a memory-only queue.
- Discord handles events in parallel and swallows failures.

The host then saves through a memory-only queue that can commit two messages from one chat out of order.

This story adds the first of the spec's three durable lists, the inbox. Every incoming message is written to Postgres first, then acknowledged, then read in received order by one shared worker. That worker feeds the existing intake from One message, one turn, so there's still one record of what the agent has taken in.

## Done when

1. **A message the platform handed to Gantry gets its normal reply once, even if reading it fails at first or Gantry restarts before reading it.**
2. **A message the platform delivers more than once gets one reply.**
3. **Quick messages and photos from one chat thread reach the agent in the order Gantry received them, without holding up other chats or threads. /stop is handled at once even behind a message that is still being read, and the messages before it never start a turn later.**
4. **A message that still can't be read after about 2 minutes is set aside with a plain reason shown in Gantry's status report, the admin can retry or dismiss it, and the next message in that thread is answered.**
5. **An edit or delete of a message the agent hasn't taken in yet changes what the agent sees: it reads the edited text, and never reads a deleted message, even when a set-aside message is retried.**

## Risks

- **New table, added by a migration (one-way).** `inbound_events` holds each raw event, message text included, until it is read.
  - Read events are deleted at once.
  - Set-aside events are deleted when the admin dismisses them, or after 30 days. A message nobody retried within 30 days is lost for good; the spec lists this.
- **Waiting behind a failing message is deliberate.** A message waits behind an earlier one from the same thread while that one is retried, for about 2 minutes, before the failing one is set aside.
- **Slack: Gantry takes over Bolt's handling of message events.** Bolt 4.7.3 acknowledges Events API events before any listener runs. So the Slack edge saves in the Socket Mode event hook and only then acknowledges. A Bolt upgrade could change that hook; an edge test pins it.
- **While Postgres is down, receiving pauses instead of losing.**
  - Telegram stops polling; Telegram keeps updates for up to 24 hours.
  - Discord stops handling events. If Discord drops the session meanwhile, nothing in that gap is replayed. That gap, like a restart, still relies on the existing "re-read history after reconnect" rule.
  - Slack gets no acknowledgement and redelivers.
- **History distrust after a failed handler is deleted.** The reconnect, lease-loss and disconnect fallbacks stay, because they cover messages the platform never handed over.
- **Decisions amended:**
  - 0085: the fused inbound transaction runs from the inbox worker, not the memory queue.
  - 0087: a failed handler no longer bumps the history-coverage generation; only reconnects, lease loss and disconnects do.
- **Teams has no live transport yet.** Its handler is converted, but it can't be checked live.

## For the builders

### Done-when details

1. **What is covered.**
   - **Supported inputs:**
     - Slack: `message` (including `file_share`), `app_mention` and `/gantry`.
     - Telegram: text, photo, video, voice, audio, document, sticker, location, venue and contact messages, including the plain-text reply that answers a question.
     - Discord: `MESSAGE_CREATE` and the `/gantry` application command.
     - Teams: messages.
   - **Excluded** (still handled directly; button taps move in MSG-3): button taps, card submits, permission decisions and `my_chat_member`.
   - **"Handed over" means:**
     - Slack: a Socket Mode event before we acknowledge it.
     - Telegram: an update before the next `getUpdates` call.
     - Discord: a dispatch frame before the resume sequence moves past it.
     - Teams: a request before we reply to it.
   - **When the save itself fails:**
     - Slack sends no acknowledgement, so Slack redelivers.
     - Telegram and Discord retry the save in place with backoff, and receiving waits. Telegram must never throw here: grammY skips an update whose handler threw.
     - Teams returns an error.
   - **Lookups** happen only after the save: thread parent, names, sender identity and downloads. A failure throws, and the worker retries.
   - **Proof:** the T2 end-to-end tests, plus each provider's save-before-acknowledge test at its channel boundary with only the platform faked (T4 to T7).
2. **Duplicates.**
   - **Sources of duplicates:** Slack retries; Slack's paired `message` and `app_mention` for one post; Telegram re-polling after a restart; Discord replay on resume.
   - **How they are caught:**
     - While the event is unread, the inbox unique key drops the duplicate.
     - After it's read, the messages redelivery index and the admission idempotency key catch it. The key is kept 30 days.
   - **Proof:** T2 end-to-end, with a duplicate delivered before and after the first copy was read.
3. **Order and /stop.**
   - **Order.**
     - The inbox `seq` within a source chat and thread is the only order: a Slack channel plus `thread_ts`, a Telegram chat plus topic, a Discord channel or thread, or a Teams conversation.
     - The worker reads one event at a time per source thread, so intake `receive_order` follows `seq`.
   - **Downloads** happen during unpacking. A failed download falls back to the placeholder text, as today; it is not a retry reason.
   - **/stop.**
     - Session commands are recognised from the raw event with no lookup, by the codec's pure classifier, and are saved with `control = true`. A control event is claimed without waiting for earlier events in its thread.
     - When a stop is processed, the admission scope records the inbox `seq` it stopped through. An event with a lower `seq` that reaches intake later is consumed as `stopped` history and never starts a turn.
     - This builds on TURN-1 T5's `consumeAll(..., waitingBefore)`.
   - **Excluded:** the order of earlier history shown as context, which still follows the platform's timestamp, as One message, one turn defines.
   - **Proof:** T2 end-to-end, covering a slow photo then quick text from the same thread, a message in another chat answered meanwhile, and a /stop behind a failing message.
4. **Retries and set-aside.**
   - **Schedule:** 6 attempts, with backoff of 1, 4, 10, 25 and 40 seconds between them, about 2 minutes in all. Then the event becomes `set_aside`.
   - **The reason** is plain English. It names the platform and what failed, and never includes message text or tokens.
   - **Admin view.** `gantry status` shows the count per platform and the newest reason, for example: `Incoming messages set aside: 1 (Discord: couldn't find which channel thread 123 belongs to)`.
   - **Admin actions.** `gantry inbox retry <id>` and `gantry inbox dismiss <id>`.
   - **Retention.** Set-aside events older than 30 days are deleted in bounded batches by the existing retention sweep.
   - **The rest of the thread.** The next event in that thread proceeds.
   - **Proof:** T3 end-to-end.
5. **Edits and deletes.**
   - **What is covered:**
     - deletes Gantry handles today: Slack `message_deleted` and Discord `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`, which remove attachments;
     - edits, which are ignored today: Slack `message_changed`, Discord `MESSAGE_UPDATE` and Telegram `edited_message`.
   - **How they flow:** they are saved to the inbox like messages, keyed by their target.
   - **When the target is still in the inbox** (pending, claimed or set aside):
     - an edit replaces the payload text used at unpack;
     - a delete marks the target so that it is dropped when unpacked or retried.
   - **When the target was already read but not yet taken into a turn:**
     - an edit updates the saved message;
     - a delete consumes it as history and removes its attachments.
   - **After it's taken into a turn:**
     - an edit is kept in history and starts no turn;
     - a delete marks it deleted in history.
   - **A target in neither the inbox nor history** is logged and ignored.
   - **Proof:** T8 end-to-end.

### The shared seam, pinned by T1

**Table `inbound_events`** (Drizzle schema `schema/inbound-events.ts`, plus a migration):

| column | type | meaning |
|---|---|---|
| `id` | text pk | uuid |
| `seq` | bigint generated always as identity | our receive counter, the only order |
| `app_id` | text not null, foreign key to apps | |
| `provider` | text not null | canonical provider id |
| `provider_account_id` | text not null | the account whose connection received it |
| `source_channel` | text not null | the platform's chat id, from the raw event with no lookup |
| `source_thread` | text not null default '' | thread or topic id from the raw event, or '' |
| `kind` | text not null | `message`, `edit` or `delete` |
| `event_key` | text not null | the platform's identity for this event: Slack `channel:ts` (for an edit, plus the edit's `ts`), Telegram `chat:message_id` (edits add `edit_date`), Discord message or interaction id (edits add `edited_timestamp`), Teams activity id |
| `target_key` | text | for an edit or delete, the `event_key` of the message it changes |
| `control` | boolean not null default false | a session command, claimed without waiting |
| `payload` | jsonb not null | the raw event as received |
| `deleted` | boolean not null default false | the target was deleted before it was read |
| `state` | text not null default `'pending'` | `pending`, `claimed` or `set_aside`; read events are deleted |
| `attempts` | int not null default 0 | |
| `next_attempt_at` | timestamptz | backoff |
| `claim_token`, `claim_expires_at` | text, timestamptz | |
| `last_error` | text | plain reason, never message text |
| `received_at` | timestamptz default `clock_timestamp()` | |

- Unique on `(app_id, provider, provider_account_id, kind, event_key)`.
- Partial index on `(app_id, provider, provider_account_id, source_channel, source_thread, seq)` where `state IN ('pending','claimed')`.

**Edge contract** (`channels/channel-provider.ts`):
- `ChannelOpts.saveInbound(event: { sourceChannel; sourceThread; kind; eventKey; targetKey?; control }, payload: unknown): Promise<void>`. It resolves only after commit and inserts with `ON CONFLICT DO NOTHING`.
- The edge acknowledges only after `saveInbound` resolves.
- Building the event fields is pure: the codec's `classifyInbound(payload)` does no lookups.

**Codec contract:**
- `ChannelAdapter.classifyInbound(payload)` is pure.
- `ChannelAdapter.unpackInbound(payload): Promise<{ kind: 'messages'; messages: NewMessage[] } | { kind: 'drop'; reason: string }>` may do lookups and downloads.
- Throw `InboundUnpackError(plainReason)` to retry with that reason. Any other error retries with "couldn't read this <Platform> message (<error name>)".
- `drop` covers bot echoes, unrouted chats and a reply that answered a question. It deletes the event and logs, as today.

**The worker's claim** (`runtime/inbound-unpack-loop.ts`):
- Modelled on `runtime/live-admission-work-loop.ts`: claim, renew, release on stop.
- It runs wherever channels are connected and claims only events for accounts bound in this process.
- It wakes in-process when `saveInbound` commits, with a 2-second poll as backstop.
- It reads up to 4 events at once, always from different threads.
- Claim TTL is 30 seconds, renewed while unpacking.
- **The head rule:** a non-control event is claimable only when no earlier `pending` or `claimed` event has the same app, provider, account, source channel and source thread. Use `FOR UPDATE SKIP LOCKED` in `seq` order, the same claim shape as `live-admission-work-item-repository.postgres.ts`. Control events skip the head rule.

**After unpacking,** the shared step runs for each message:
- **Fan-out:** fan out over the bound connection's `inboundProviderAccountIds`. This logic moves out of the `onMessage` wrapper in `provider-account-channel-connect.ts`.
- **Host handler:** call the host persistence handler: route check, service-identity check, `storeMessageWithLiveAdmission` per route, and TURN-1 T7's busy notice. The admission item carries the inbox `seq`.
- **Settle:** `DELETE ... WHERE id = $id AND claim_token = $token`.
- **No single transaction.** These steps are safe to repeat, as the spec says: a crash between them re-reads the event, and the message and admission keys dedupe it.
- **On failure:**
  - set `state='pending'`, `next_attempt_at = now() + backoff(attempts)`, `last_error = reason`;
  - on the sixth failed attempt, set `state='set_aside'`.

**One crossing test, owned by T1:**
- A fake edge saves twice for one thread, once for another thread, and one control event behind a failing event.
- Claims across two connections return only the heads plus the control event.
- Settling unblocks the next event; a retry blocks its thread; set-aside unblocks it.

### Deleted in this story (replacing behaviour deletes the old path)

- **The host persistence queue:**
  - `persistenceQueue` (`channel-wiring.ts:104,228`) and its shutdown drain (`:681`);
  - `enqueueAndWait` and the `persistenceQueue` dependency in `channel-persistence-handlers.ts`.
- **The Telegram media queue:** `mediaIngestionQueue` (`telegram/channel-state.ts:79`, `channel-connect.ts:95`, `channel-delivery.ts:647`), its drain (`disconnect.ts:34,59`), and `enqueueMediaStore` in `media-ingestion.ts`.
- **The queue code itself:** `app/bootstrap/async-task-queue.ts` and its test. It has no other users.
- **Lookups and downloads before the save** move into each codec:
  - Slack: `resolveChannelName`, `resolveUserName`, `enrichMessage` and the slash-command lookups.
  - Telegram: `tryResolveOther`, metadata writes and downloads.
  - Discord: `resolveDiscordConversationContext` and attachment capture, in the message handler and `/gantry`.
  - Teams: `resolveTeamsInboundIdentity`.
- **Discord's lenient thread lookup** that silently routes a thread message to its parent channel when the lookup fails, along with the retry loop from the stopgap fix. The codec always fails closed and the inbox retries. Button and interaction lookups keep their lenient path.
- **Discord's `void this.handle(...).catch(...)`.** It is replaced by one ordered chain.
- **The history-distrust trigger on handler failure:** `onDispatchFailure` (`conversation-history-coverage-lifecycle.ts`, `slack/channel-connect.ts`, `discord/gateway.ts`). The rest of `ConversationHistoryCoverageDistrust` stays.
- **The old inbound contract:**
  - `ChannelOpts.onMessage`;
  - the fan-out wrapper (`provider-account-channel-connect.ts:161-186`);
  - `InboundMessageDeliveryError` and `InboundMessageDeliveryResult`;
  - `onMessageAttachmentsDeleted` as a direct callback.
- **The silent drop when the identity lookup fails** (`channel-persistence-handlers.ts:194-205`). It now throws, so the worker retries.

### Builder traps

- **Slack:**
  - Handle `receiver.client`'s `slack_event` yourself.
  - For `events_api` message events (including `message_changed` and `message_deleted`), `app_mention` and `slash_commands`: classify, `await saveInbound`, then `ack()`.
  - Everything else goes to `app.processEvent` exactly as Bolt did.
- **Telegram:**
  - One middleware for `message` and `edited_message` saves the update. It calls `next()` only for `/chatid` and `/ping`.
  - A failed save retries with backoff until it succeeds or the bot stops, and never throws.
  - The codec reads the raw `Update`, not a grammY `ctx`. Take the bot username from `bot.botInfo`.
- **Discord:**
  - Control opcodes are handled immediately.
  - Dispatch frames go through one promise chain.
  - `this.sequence` moves only after the save commits.
  - `/gantry` saves, then acknowledges, within Discord's 3 seconds.
  - `discord/index.ts` is at 739 of its 740-line budget. Move message handling into the new codec file.
- **Wiring:**
  - Start and stop the worker from a new `app/bootstrap/inbound-unpack-wiring.ts`; `channel-wiring.ts` is at 777 of 790 lines.
  - Bootstrap files only wire.
- **Engines:** nothing here is engine-specific. Both runners see the same intake.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | The inbox and its contract | The `inbound_events` table and migration. The repository and port: save, claimHeads (control events skip the head rule), renew, settle, retryLater, setAside, retry, dismiss, countSetAside, applyToTarget. The edge and codec types and `InboundUnpackError`. No production caller yet. | 1, 2, 3 | `apps/core/src/adapters/storage/postgres/schema/inbound-events.ts`, `apps/core/src/adapters/storage/postgres/schema/index.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `apps/core/src/adapters/storage/postgres/repositories/inbound-event-repository.postgres.ts`, `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts`, `apps/core/src/domain/ports/inbound-events.ts`, `apps/core/src/channels/channel-provider.ts` (new types only) | `apps/core/test/integration/inbound-events.postgres.integration.test.ts`: the crossing test; a duplicate key is ignored; heads only, across two connections and two threads; a control event is claimed behind a failing head; an expired claim is reclaimed; retry blocks its thread; set-aside unblocks it | | no |
| T2 | The worker reads every saved message in order | `runtime/inbound-unpack-loop.ts` with claim, unpack, the shared step and settle; backoff; set-aside on the sixth attempt. The fan-out helper is extracted in `provider-account-channel-connect.ts`, and `saveInbound` is bound per connection with an in-process wake. Admission items carry the inbox `seq`, and a stop records the `seq` it stopped through. A fake provider harness. | 1, 2, 3 | `apps/core/src/runtime/inbound-unpack-loop.ts`, `apps/core/src/app/bootstrap/inbound-unpack-wiring.ts`, `apps/core/src/app/bootstrap/channel-wiring.ts` (start/stop lines only), `apps/core/src/channels/provider-account-channel-connect.ts`, `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts` (inbox seq and stopped-through), `apps/core/src/adapters/storage/postgres/schema/live-turns.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, `apps/core/src/domain/ports/live-turns.ts`, `apps/core/test/harness/fake-inbound-provider.ts` | End-to-end `apps/core/test/e2e/inbound-inbox.postgres.e2e.test.ts`: `answers a handed-over message once after its lookup fails twice`; `answers a message saved before a restart once after the restart`; `answers a twice-delivered message once, before and after it was read`; `gives a slow photo and the quick text after it to the agent in received order while another chat is answered`; `handles /stop at once behind a message still being read and never starts a turn for the earlier message`. Unit `apps/core/test/unit/runtime/inbound-unpack-loop.test.ts`: the backoff schedule and releasing claims on stop | T1, TURN-1 T5 | yes |
| T3 | An admin sees, retries and dismisses messages that couldn't be read | `gantry status` shows set-aside counts per platform and the newest plain reason; `gantry inbox retry` and `gantry inbox dismiss`; set-aside rows older than 30 days are deleted by the retention sweep | 4 | `apps/core/src/cli/status.ts`, `apps/core/src/cli/inbox.ts`, the CLI command registry entry, the existing retention sweep file | End-to-end `apps/core/test/e2e/inbound-set-aside.postgres.e2e.test.ts`: `sets aside an unreadable message with a plain reason shown by status and answers the next one in that thread`; `answers a set-aside message once the admin retries it after the lookup recovers`. Unit `apps/core/test/unit/cli/status.test.ts` for the status line. Postgres retention case in the existing retention test file | T2 | yes |
| T4 | Slack saves before acknowledging | The Slack edge in the Socket Mode hook. A pure classifier, plus a codec built from `ingestSlackMessage` and `ingestSlackSlashCommand` that returns messages. Bolt's message and command listeners go. Slack's `onDispatchFailure` goes. | 1, 2 | `apps/core/src/channels/slack/channel-connect.ts`, `apps/core/src/channels/slack/channel-message-ingest.ts`, `apps/core/src/channels/slack/slash-command-ingest.ts`, `apps/core/src/channels/slack/slack-message-deletion.ts`, `apps/core/src/channels/slack/channel-interactions.ts` (registration only), `apps/core/src/channels/slack/channel-delivery.ts` | `apps/core/test/unit/channels/slack-socket-mode-lifecycle.test.ts`: acks only after the save commits; no ack when the save fails; `message` plus `app_mention` saved once. `apps/core/test/unit/channels/slack.test.ts`: classify and unpack cases (file share, thread, `/gantry` as a control event, unrouted chat dropped, a failed channel lookup throws) | T2 | yes |
| T5 | Telegram saves before taking the next update | The Telegram edge middleware with retry in place. A pure classifier and one codec for text and media (downloads during unpack, placeholder fallback), plus the question-answer reply. The media queue and its drain are deleted. | 1, 3 | `apps/core/src/channels/telegram/channel-connect.ts`, `apps/core/src/channels/telegram/text-message-handler.ts`, `apps/core/src/channels/telegram/media-ingestion.ts`, `apps/core/src/channels/telegram/channel-state.ts`, `apps/core/src/channels/telegram/channel-delivery.ts`, `apps/core/src/channels/telegram/disconnect.ts` | `apps/core/test/unit/channels/telegram.test.ts`: an update isn't finished until it is saved; a failed save is retried, not skipped; classify and unpack cases (photo with caption, reply to the bot, topic thread, `/stop` as a control event, `mentionsBot` kept); a failed download keeps the placeholder | T2, TURN-1 T6 | yes |
| T6 | Discord saves before moving its resume point | The ordered dispatch chain, with the sequence moved after the save. A new `discord/inbound-codec.ts` (pure classifier, message and `/gantry`) whose parent lookup fails closed. `/gantry` saves, then acknowledges. Discord's `onDispatchFailure`, the lenient thread fallback and the stopgap retry loop go; `index.ts` gets smaller. | 1 | `apps/core/src/channels/discord/gateway.ts`, `apps/core/src/channels/discord/gateway-dispatch.ts`, `apps/core/src/channels/discord/index.ts`, `apps/core/src/channels/discord/inbound-codec.ts`, `apps/core/src/channels/discord/live-attachment-capture.ts`, `apps/core/src/channels/discord/conversation-context.ts`, `apps/core/src/channels/discord/message-deletion.ts`, `apps/core/src/channels/discord/interactions.ts` (`/gantry` only) | `apps/core/test/unit/channels/discord/discord.test.ts`: frames are handled in arrival order; the resume sequence moves only after the save; a failed thread lookup throws and is never routed to the parent; `/gantry` is saved before its acknowledgement | T2, TURN-1 T7 | yes |
| T7 | Teams joins, and the old inbound path is deleted | Teams `ingestMessage` becomes edge plus codec; card submits stay direct. Deletes `ChannelOpts.onMessage`, the fan-out wrapper, `InboundMessageDeliveryError`, the persistence queue and its drain, `async-task-queue.ts` and its test, and the remaining `onDispatchFailure`. A failed identity lookup now throws. Decisions 0085 and 0087 amended. | 1, 3 | `apps/core/src/channels/teams/index.ts`, `apps/core/src/channels/teams/types.ts`, `apps/core/src/channels/channel-provider.ts`, `apps/core/src/channels/provider-account-channel-connect.ts`, `apps/core/src/channels/conversation-history-coverage-lifecycle.ts`, `apps/core/src/app/bootstrap/channel-persistence-handlers.ts`, `apps/core/src/app/bootstrap/channel-wiring.ts`, `apps/core/src/app/bootstrap/async-task-queue.ts` (delete), `apps/core/test/unit/bootstrap/async-task-queue.test.ts` (delete), `apps/core/test/unit/bootstrap/channel-wiring.test.ts`, `apps/core/test/integration/inbound-envelope-statements.postgres.integration.test.ts`, `docs/decisions/0085-*`, `docs/decisions/0087-*` | `apps/core/test/integration/inbound-envelope-statements.postgres.integration.test.ts`: the statement budget, measured through the shared step, and a failed sender-identity lookup retried, not dropped. `apps/core/test/unit/channels/teams/teams.test.ts`: a Teams message is saved before it is read. Type check: no `onMessage` left on channel options | T4, T5, T6, TURN-1 T7 | yes |
| T8 | Edits and deletes follow their message | Slack `message_changed` and `message_deleted`, Telegram `edited_message`, and Discord `MESSAGE_UPDATE`, `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK` are classified as `edit` or `delete` with a `target_key`. `applyToTarget` changes a target still in the inbox; the shared step updates or consumes a saved message not yet taken into a turn, or records the change in history. | 5 | `apps/core/src/runtime/inbound-unpack-loop.ts` (edit and delete branch), `apps/core/src/channels/slack/channel-message-ingest.ts`, `apps/core/src/channels/slack/slack-message-deletion.ts`, `apps/core/src/channels/telegram/text-message-handler.ts`, `apps/core/src/channels/discord/inbound-codec.ts`, `apps/core/src/channels/discord/message-deletion.ts`, `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts` (edit and delete of an unconsumed message) | End-to-end `apps/core/test/e2e/inbound-edits-deletes.postgres.e2e.test.ts`: `reads the edited text of a message edited before it was taken in`; `never reads a message deleted before it was taken in, even after the admin retries it`; `keeps an edit after the turn as history without starting a turn` | T4, T5, T6 | yes |

New moving parts: the `inbound_events` table (items 1–5); the inbox unpack worker loop (items 1, 3, 4, 5). No new notify channel or service.

## Notes

- **Out of scope** (later stories):
  - button taps, card submits and permission decisions through the inbox (MSG-3);
  - moving connection ownership and saving connection checkpoints (MSG-4);
  - the outbox for every send (MSG-2);
  - folding the web SDK path and `external_ingress_invocations`, which are already durable, into this table;
  - a web admin view of set-aside messages.
- **Planning decisions:**
  - Set-aside messages are shown to the admin only; the sender gets no notice.
  - The stopgap Discord retry fix merges now; T6 deletes it.
- **TURN-1 coupling:**
  - The busy notice for an overloaded backlog stays TURN-1 T7's. It runs inside the host handler, which the shared step calls.
  - Intake order stays `receive_order` and `takeInput`. The inbox adds no second consumption record.
