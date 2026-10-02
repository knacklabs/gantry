---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-02T10:43:37+00:00
read_hash: be8d456c27b7fbeef42b2bb04e4e3f72329b298b
round: 2
passed: no
doc_seen: be8d456c27b7fbeef42b2bb04e4e3f72329b298b
spec_seen: 0647451ab330dc4afef14f2bba398594e44808ed
notes_seen: e06cc97fff54b56b71557321df7e3901d31cf214
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Edits and deletes cannot reach a pending or claimed target under the head rule.
   They are non-control events with a higher `seq`, so T1 blocks them behind their target until it is unpacked and admitted. T1 must pin how mutations apply before that handoff; T8’s tests must pause the target’s unpacking and deliver an edit or delete meanwhile.
   Disposition: cut (moved to a later story with Done-when 4–5)

2. The edit/delete handoff is not safe against stale unpack results or replay.
   Updating a claimed row’s payload does not change the worker’s existing snapshot. The current canonical save also upserts text before admission deduplication, so replay can overwrite a newer edit. Pin the atomic boundary between mutation, persistence and `takeInput`, including durable deletion markers and attachment cleanup.
   Disposition: cut (moved to a later story with Done-when 4–5)

3. `control = true` does not deliver the promised immediate `/stop`.
   Skipping the head rule still leaves controls behind four occupied worker slots and inside codecs that perform failing lookups. “Always from different threads” also conflicts with claiming a control alongside its own thread’s head. T2 needs a control path that remains available and can resolve its authorised target without those lookups.
   Disposition: keep amended: Added reserved control capacity and raw-thread/configured-authority resolution without codec or message lookup, plus durable cutoff/cancellation.

4. Unproven: item 4: a hanging lookup is never set aside within about two minutes.
   Six attempts and backoff bound the gaps, not attempt duration. Renewing a claim indefinitely can block its thread indefinitely. T2 must pin an overall deadline, cancellation and handling of late completions, with a deterministic stalled-lookup case.
   Disposition: keep amended: Pinned persisted 120-second overall deadline, bounded attempts, abort/token fencing and late-result cleanup with a stalled-lookup owner case.

5. Unproven: item 3: concurrent saves can reverse received order.
   A worker cannot see an earlier uncommitted row when it claims a later committed row. Slack’s asynchronous event hooks make this possible even with one connection. Pin save ordering before T4, and extend T1’s crossing test with overlapping commits rather than sequential inserts.
   Disposition: keep amended: Pinned per-connection FIFO/transaction save lock and overlapping-commit/concurrent-claim crossing proof.

6. Trap: Discord’s single dispatch chain can expire interaction acknowledgements: item 1.
   An earlier save retry—or a direct interaction handler—can block `/gantry` and button taps beyond Discord’s three-second response deadline. Immediate control opcodes do not cover `INTERACTION_CREATE`. T6 must define the bypass and failure outcome while keeping resume advancement contiguous. [Discord’s interaction contract](https://docs.discord.com/developers/interactions/receiving-and-responding).
   Disposition: keep amended: Discord interactions bypass dispatch work, meet an acknowledgement/failure timer and advance resume only through completed frames.

7. T1’s event identities do not cover all supported inputs safely.
   Slack’s `channel:ts` rule has no slash-command identity; Discord bulk deletes have several targets but the contract accepts one `targetKey`; Telegram edits keyed by `edit_date` can collide within one second. Pin stable identities and bulk representation in T1, using Telegram’s distinct `update_id` for edit events. [Telegram’s update and message fields](https://core.telegram.org/bots/api#update).
   Disposition: keep amended: T1 pins separate receipt/target keys, stable slash ids, Telegram update ids, partial edits and multi-target bulk deletion.

8. T1 leaves shared codec and mutation contracts for later tasks to invent.
   `classifyInbound` has no return type or unsupported/malformed-input outcome, and `applyToTarget` has no normalized edit shape, result or claimed-target semantics. T2 and T4–T8 all depend on these choices. The first task must pin them, including textless updates and multiple delete targets.
   Disposition: keep amended: T1 pins classifier/unsupported/malformed, normalized edit/result, control/origin and question-reply signatures before split implementations.

9. Immediate inbox deletion contradicts the confirmed spec’s retained duplicate identity.
   The spec retains unpacked events for 30 days and AC2 requires redeliveries to be unpacked once. Message/admission keys act after unpacking and provide no receipt for `drop` outcomes. Retain completed event identities—discarding raw payload if desired—or explicitly reconcile this departure before approval.
   Disposition: keep amended: Completed/drop/dismiss identity receipts remain for 30 days after settlement; raw payload may be discarded and the sweep owns expiry.

10. Unproven: item 1: Telegram’s question-answer reply is not safe across restart or replay.
    `tryResolveUserQuestionOtherReply` in `telegram/channel-prompts.ts` depends on memory maps and removes the reply binding while answering. After restart, or a crash before inbox settlement, that same reply can become an ordinary agent message. T5 needs a durable, repeatable resolution contract and a named recovery case.
   Disposition: keep amended: T5-B owns durable account/topic-qualified reply bindings, atomic answer/inbox receipts and named restart/settlement replay proof.

11. T2 cannot carry inbox sequence numbers or record the stop cutoff within its Scope.
    The path crosses `channel-persistence-handlers.ts`, `RuntimeMessageRepository.storeMessageWithLiveAdmission`, the canonical message service and repository, and the authorised stop handler. Those boundaries are outside T2. Assign them there and pin the cutoff’s scope, durable storage and atomic admission check; test restart, a refused stop and a retried set-aside predecessor.
   Disposition: keep amended: T2-B/T2-C own ports, wrappers, canonical/admission and authorised stop seams, exact cutoff scope and restart/refused/retried cases.

12. T4’s Scope excludes code required by its promised codec conversion.
    `resolveChannelName` and `resolveUserName` in `slack/channel-state.ts` swallow lookup failures, while the ingestion wrappers in `channel-interactions.ts` return `void`. T4 permits only registration changes in the latter and excludes the former. Expand ownership so the real codec can return messages and throw retryable lookup failures.
   Disposition: keep amended: T4 owns retryable channel-state lookups, both returning interaction wrappers, edit shapes and download/canvas budget boundaries.

13. T7 can remove existing deletion handling before T8 replaces it.
    Both become eligible after T4–T6, but T7 deletes `onMessageAttachmentsDeleted` while existing Slack and Discord deletion paths require it. Make replacement deletion handling precede that removal, or move the removal to a final cleanup task. Also pin when the new adapter methods become required so intermediate tasks keep building.
   Disposition: keep amended: T8-A replaces deletion handling before T7/T7-A cleanup; dependencies and staged required capabilities keep intermediate builds working.

14. Item 4 gives the admin commands but no way to discover their required inbox IDs.
    Status exposes only counts and the newest reason. Add IDs to an actionable status/list output and pin retry/dismiss results for missing, already handled and concurrently changed rows. Unproven: item 4: no named test exercises dismissal or retry/dismiss races.
   Disposition: cut (moved to a later story with Done-when 4–5)

15. Unproven: items 1 and 2: the named restart test stops before the important partial commits.
    T2 covers restart before unpacking, but not failure after one fan-out route commits, after intake commits, or after input is consumed before settlement. Extend the owner recovery test through those boundaries, including a shared connection serving two accounts, and verify preserved consumption with no second reply.
   Disposition: keep amended: T2-D's recovery owner crosses cached decode, shared-account partial fan-out, intake commit and consumed/committed input before settlement.

16. Unproven: item 5: several promised mutation states have no named proof.
    T8 does not name an edited set-aside target retried later, deletion after a turn, bulk deletion, or missing-target handling. Its before-consumption cases must explicitly exercise both inbox-held and already persisted targets, including the concurrent handoff in findings 1–2.
   Disposition: cut (moved to a later story with Done-when 4–5)

17. Split: T1 → basic inbox storage/claim contract and mutation/admin storage operations.
    Twelve repository operations, the port, schema and migration suggest substantially more than 400 changed lines. T1 also implements foundations for items 4 and 5 despite listing only 1–3. Keep shared types pinned first, then assign the remaining operations to bounded owners.
   Disposition: keep amended: Split T1 into shared types/schema/save, claim/lifecycle, admin/retention and held-target storage, with relevant Covers and bounded budgets.

18. Split: T2 → unpack worker/fan-out and durable stop-cutoff integration.
    The reference worker alone is 355 lines; wiring, fan-out, admission schema changes and the stop boundary make this substantially larger than 400 changed lines. The split should retain one owner end-to-end test for each promised behavior.
   Disposition: keep amended: Split T2 into worker, route extraction, persistence, fan-out/wiring, provenance/cutoff storage, raw control and recovery proof with bounded owners.

## Round 2

19. Disputed keep 3: replayed `/stop` can cancel a newer turn.
    Existing stop routing resolves the currently active turn, and command idempotency is scoped by `liveTurnId`. A crash after cancellation but before inbox settlement can therefore replay the stop against a successor. Pin the original turn—or “no active turn”—durably with the cutoff/control receipt, and extend T9’s restart case to prove a later turn survives replay.
   Disposition: keep amended: T20 pins the original turn or explicit no-active-turn with cutoff/command in one transaction; T9 replay proof keeps a successor running.

20. The held-delete guard can bypass the deletion retries the plan promises to preserve.
    The guard throws before the direct callback runs, but raw deletion retention currently happens inside `createChannelAttachmentDeletionHandler`. A guard failure therefore never reaches that retry worker. T10/T14 must pin how both guard and existing attachment deletion survive failure, with a boundary case proving eventual cleanup.
   Disposition: keep amended: T21 puts the held guard inside the existing retained raw deletion retry, pins raw scope before T10/T14 and owns eventual attachment-cleanup proof.

21. Trap: blanket Discord interaction deferral breaks modal-opening buttons: item 1.
    `openDiscordRichFormInteraction` opens a modal through the initial type-9 response; it cannot do that after a deferred acknowledgement. Give modal-opening buttons an immediate response path and add the corresponding T14 boundary case. [Discord’s response types](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback-type).
   Disposition: keep amended: T14 preserves the immediate rich-form modal branch before generic deferral and owns the stalled-dispatch type-9/expired-form boundary case.

22. Telegram utility handling has contradictory save rules.
    The supported-input section excludes `/chatid` and `/ping` from the inbox, while Builder traps says `next()` runs **after save** for those utilities. Pin them as unsupported inputs passed directly to the utility handlers without saving, and make T12’s middleware test assert that distinction.
   Disposition: keep amended: T12 classifies /chatid and /ping as unsupported, calls next without saving and asserts that supported text saves without propagation.

23. T12 has no owned bridge for its promised post-save media handling.
    Existing media handling is available only through registered grammY callbacks and an asynchronous queue; it does not return an unpack result. T12 excludes that implementation, and T13 converts it later. Pin media activation to T13 while preserving the current path during T12, or explicitly assign the intermediate bridge and its proof.
   Disposition: keep amended: T12 keeps media on existing unsaved handlers/queue; T13 owns returning media codec, activation and single-path middleware proof together.

24. Completed control receipts retain content outside the fields settlement clears.
    `InboundControl` contains raw text and parsed command arguments in `control_json`, but settlement clears only payload and cached decode. That contradicts the promise to retain compact identities without incoming content. T2 must clear content-bearing control fields on completion and assert this in its settlement case.
   Disposition: keep amended: T2 atomically clears control_json with payload/cached decode, retains content-free receipts and owns settlement/redelivery proof.
