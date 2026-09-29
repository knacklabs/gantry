---
reader: codex (gpt-6-sol)
read_at: 2026-09-29T05:29:19+00:00
read_hash: 5f7b903be83721d4ca4105c1a706427a8370fd54
amended_hash: 3e658882f84752f04f0f82be1ff0eceaee11c2fe
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc once, then
run `forge read <doc> --amended`:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options. There is no second read.

1. The backfill can permanently skip work that is still pending.
   T1 marks **every** existing admission item consumed, including queued, deferred, and claimed items that have not started a turn. That conflicts with Done when 2 and restart recovery. Pin how pending items survive the migration and how T1–T3 ship together; “same release” is not guaranteed by their separate task merges.
   Disposition: keep amended: the backfill moves to T2's switch migration and marks consumed only items at or before their queue's saved marker, so pending items stay waiting; T1 adds nullable columns only, and every merge stays consistent (Risks)

2. The turn handoff is not specified tightly enough to prevent loss or duplication.
   `takeInput` returns IDs, but the plan does not say whether admission or [group-processing.ts](/apps/core/src/runtime/group-processing.ts:96) takes them, how that processor reads already taken IDs, or how its authoritative second read includes late arrivals. T1 must pin that handoff and a test across both reads before T2 uses it.
   Disposition: keep amended: pinned the two takers (turn start's authoritative read is takeInput; the live-turn router for follow-ups); admission never takes; T1 has a crossing test and T2 pins the id-hash key

3. The running-turn guarantee depends on work deferred to Story 3.
   [GroupQueue.sendMessage](/apps/core/src/runtime/group-queue.ts:421) reports success after writing continuation input, before the runner confirms it read the input. T3 can therefore consume a follow-up that the runner never sees before its final reply. Delivery confirmation, or an equivalent safe cutoff, belongs in this story to meet Done when 2.
   Disposition: keep amended: added T4, in which runners report the delivered continuation ids, the steering gate returns undelivered text on close, and the host releases the rest at turn end

4. Discord’s mention flag has no complete persistence path.
   T5/T6 name the inbound field, but [externalRefForMessage](/apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository-identifiers.ts:81) does not write it and [mapMessage](/apps/core/src/adapters/storage/postgres/services/canonical-message-ops-service.ts:346) does not restore it. T5 must own and pin that JSON format for T6. The same trigger contract needs a reliable way to identify a reply **to the bot**; the current message exposes a reply ID and sender name, but no pinned bot-identity lookup.
   Disposition: keep amended: T6 owns the mentionsBot format in externalRefForMessage and mapMessage; reply to the bot and the bot's thread use the stored message's is_from_me

5. T4 cannot deliver its stated command and provider tests within its scope.
   Cancelling a waiting batch as history requires consumption/control behavior outside T4’s enqueue-only scope. The provider values also live in [register-builtins.ts](/apps/core/src/channels/register-builtins.ts:140), which T4 does not own. Assign the shared registration entries to T4 and pin the command-cancellation operation in T1 or T2; do not add an After link merely to share a registry line.
   Disposition: keep amended: T5 owns the provider entries in register-builtins.ts; T1 pins consumeAll, used by T5's /stop cancel, and T5 runs After T2 for the command path it edits

6. T6 has no durable, channel-wide busy-notice contract.
   The [channel persistence handler](/apps/core/src/app/bootstrap/channel-persistence-handlers.ts:223) discards the `overloaded` result, while [external ingress](/apps/core/src/application/external-ingress/conversation-message-ingress.ts:225) has a separate path. T6 must pin who sends the notice and an atomic per-conversation five-minute throttle shared across workers; its listed scope supplies neither for every channel.
   Disposition: keep amended: T7 sends the notice through the durable outbox with key busy:<conversation>:<5-minute window> (atomic across workers), and external ingress returns busy

7. The repository API and marker deletion have missing owners.
   T1 adds `takeInput`/`releaseInput` to the port and implementation file, but [PostgresLiveTurnRepository](/apps/core/src/adapters/storage/postgres/repositories/live-turn-repository.postgres.ts:93) is the concrete port implementation and is outside T1’s scope. T3 says the old marker is deleted, yet its scope only removes use of it; [router_state](/apps/core/src/adapters/storage/postgres/schema/schema.ts:33) has no delete operation in the current port.
   Disposition: keep amended: T1's scope includes live-turn-repository.postgres.ts; T3 adds the router-state delete operation and its migration

8. Two shared runtime seams are left for later tasks to redefine.
   T2 and T5 both need the trigger decision in [message-loop.ts](/apps/core/src/runtime/message-loop.ts:369) and [group-processing.ts](/apps/core/src/runtime/group-processing.ts:223); T5’s scope omits the latter. T2 and T3 also both use `buildPendingMessagesContinuationIdempotencyKey`, but T2 does not explicitly pin the promised item-ID hash for T3. Give each shared function’s contract and crossing test to its first task.
   Disposition: keep amended: T6's scope includes group-processing.ts's trigger section and runs After T3; T2 pins the item-id idempotency key used by T3 and T4

9. Split: T2 → input acquisition and batching; command and failure handling. Split: T3 → continuation and recovery; cursor and queue-retry removal.
   Their scopes cross multiple large runtime and bootstrap files, including the 836-line group processor and 1,185-line runtime services file. Both tasks suggest substantially more than the roughly 400 changed-line task limit, and the proposed halves have distinct verification points.
   Disposition: keep the switch in one task (T2): splitting readers from writers leaves a window where the two records disagree and messages double; the deletions moved to their own task (T3), and mid-turn confirmation to T4
