---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-29
---

# LAT-3B: Retain The Authoritative Second Message Fetch; Reject Cursor-Fenced Replay Reuse

## Context

The response-latency roadmap names Phase 3B "Cursor-Fenced Pending Replay
Reuse": reuse a preloaded pending replay when cursor, queue identity,
conversation/thread/provider scope, replay ids, and replay cursor are all
internally consistent, falling back to the authoritative load on mismatch
(`plans/MyClaw-Response-Latency-Refactor-Plan.md`, Phase 3B).

The underlying observation is real. Admission fetches pending messages
(`apps/core/src/runtime/message-loop.ts:505-518`) and the group processor
independently fetches the same window later
(`apps/core/src/runtime/group-processing.ts:87-103`), both through
`collectPendingMessagesSince`
(`apps/core/src/runtime/pending-message-replay.ts:24-75`). Admission's replay is
reused only inside `processQueueMessages` via `preloadedInitialReplay`
(`message-loop.ts:291-302,370-385`); it never reaches the group processor.

The goal prompt already flagged the reuse claim as unproven
(`docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md`,
plan-validation §3, "A3 double fetch — OBSERVATION TRUE, REUSE CLAIM FALSE AS
WRITTEN"), and instructed: "If the queue cannot provide that fence cheaply,
retain the authoritative second fetch. A3 should be split from this cycle
unless that cursor contract is designed and tested."

Read-only measurement at `106f7d72b` settles both halves of that instruction.

**The prize is one SQL statement.** `collectPendingMessagesSince` returns after
its first page whenever it accepts fewer messages than the page size, which is
necessarily true at the shipped defaults — `MAX_MESSAGES_PER_PROMPT` is 10 and
`MESSAGE_FETCH_PAGE_SIZE` is 200 (`apps/core/src/config/index.ts:485-492`,
`pending-message-replay.ts:40-74`). `getMessagesSince` makes one
`listInboundMessages` call
(`apps/core/src/adapters/storage/postgres/services/canonical-message-ops-service.ts:177-202`),
which delegates to a single `listMessages` query
(`canonical-message-repository.postgres.ts:392-407`). So the entire second
fetch is **one repository call and one SQL statement per turn**, not a fan-out.

**The fence cannot be built cheaply, and reuse is not merely risky — it drops
messages.** The two fetches are deliberately at different times. The queue
cursor advances after a successful active-run pipe
(`message-loop.ts:437-466`), and new inbound messages are persisted
concurrently by the channel persistence handler
(`apps/core/src/app/bootstrap/channel-persistence-handlers.ts:172-199`) and by
external ingress
(`apps/core/src/application/external-ingress/conversation-message-ingress.ts:225-258`).

The decisive point: **the cursor advances on consumption, not on arrival.** A
message that lands between admission's fetch and the group processor's fetch
does not move the cursor. So "cursor unchanged" does **not** imply "no new
messages", and there is no cheap signal that does — detecting new arrivals
requires exactly the query the reuse is trying to remove. The second fetch is
not redundant work; it is an authoritative later read whose whole job is to see
messages admission could not.

Reuse would also break machinery that depends on the later read: the group
processor requeues on `replay.hasMore`
(`group-processing.ts:202-204,219-220,751`) and consumes `responseSchema` and
`agentControls` from the replay, none of which survive passing a bare
`NewMessage[]` (`pending-message-replay.ts:16-22`). `GroupProcessOptions` does
not carry a replay payload today
(`apps/core/src/runtime/group-processing-types.ts:51-70`), and
`LiveTurn.pendingMessage` currently stores only
`{ kind: 'message_cursor', queueJid, cursorBefore }`
(`apps/core/src/domain/ports/live-turns.ts:58-80`,
`apps/core/src/app/bootstrap/live-execution.ts:263-273`).

## Decision

**Do not implement replay reuse. Retain the authoritative second fetch.**

The trade is a correctness regression — silently dropping inbound messages that
arrive mid-turn — bought for one SQL statement on the hot path. That is the
wrong side of the trade at any latency budget this program cares about, and the
program's own primary metric (inbound message to first content-bearing
delivery) would move by an amount indistinguishable from noise.

This is a REVISION of the phase, not an abandonment of it. LAT-3B delivers:

1. this decision record, carrying the measured numbers and the reason;
2. a durable regression test that pins the contract — both fetches exist, the
   second costs exactly one repository call, and the group processor's read is
   the one that feeds the turn — so a future cycle cannot reintroduce reuse on
   vibes without new evidence;
3. no production behaviour change.

**What would reopen this.** Reuse becomes worth revisiting only if ALL of the
following hold, and the burden is on the proposal to show them:

- a durable signal exists that distinguishes "cursor unchanged" from "no new
  inbound messages in scope" without issuing the fetch (for example, a
  per-conversation arrival watermark maintained by the write path);
- `GroupProcessOptions` or the live-turn payload carries a full
  `PendingMessageReplay` including `cursorAfter`, `hasMore`, `responseSchema`,
  and `agentControls`, not a message array;
- measurement shows the second fetch is material against the primary metric —
  which at one statement per turn requires either a much larger configured
  `MAX_MESSAGES_PER_PROMPT` relative to page size, or evidence that this query
  is contended in production.

## Consequences

The double fetch stays. Anyone reading the roadmap's Phase 3B entry, or the
goal prompt's A3, must read this record instead: the observation there is
correct and the remedy there is wrong.

The roadmap and the goal prompt are edited in this task to point here, so the
instruction is corrected at source rather than left to be rediscovered by the
next person who reads "double fetch" and assumes it is free money.

`plans/MyClaw-Response-Latency-Refactor-Plan.md` Phase 3B moves from
"directionally valid after rebaseline" to closed-by-measurement, joining job
latest-run batching and IPC replay cleanup in the Closed/Measurement-Gated
section.

Accepted cost: the ~14 LOC the goal prompt hoped to delete stay. That was
always the honest size of this item — the goal prompt itself scored A3 as a
code-cleanliness win, not a latency win, and the cleanliness is not worth the
message-loss risk.

Risk that this decision is wrong: if production later shows this query
contended, or configuration changes so the replay pages more than once, the
measured premise here expires. The regression test pins the operation count
precisely so that change is loud rather than silent.
