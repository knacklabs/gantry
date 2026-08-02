# LAT-3B — Settle The Pending-Replay Reuse Contract With Evidence

Issue: `LAT-3B`
Branch: `perf/phase3b-cursor-fenced-replay`
Base: `origin/main` @ `106f7d72b`
Program: MyClaw Response-Latency Refactor, Phase 3B
Governing decision: `docs/decisions/0080-lat-3b-retain-authoritative-second-fetch.md`
Sign-off: `docs/decisions/0081-client-signoff.md`
Signal: `S-0001-8b22` (contradiction) — raised and resolved before planning

## Problem

The roadmap's Phase 3B asks for cursor-fenced reuse of the admission replay so
the group processor's second fetch can be deleted. The observation behind it is
true: admission fetches pending messages
(`apps/core/src/runtime/message-loop.ts:505-518`) and the group processor
fetches the same window again (`apps/core/src/runtime/group-processing.ts:87-103`).

The premise is false, in two independent ways, and this task's job is to prove
that and pin it rather than to build the fence.

**The prize is one SQL statement.** `collectPendingMessagesSince` returns after
its first page whenever it accepts fewer messages than the page size, which is
always true at shipped defaults — `MAX_MESSAGES_PER_PROMPT` 10 against
`MESSAGE_FETCH_PAGE_SIZE` 200 (`apps/core/src/config/index.ts:485-492`,
`apps/core/src/runtime/pending-message-replay.ts:40-74`). `getMessagesSince`
makes one `listInboundMessages` call
(`canonical-message-ops-service.ts:177-202`) delegating to one `listMessages`
query (`canonical-message-repository.postgres.ts:392-407`).

**The fence cannot be built, and reuse loses messages.** The queue cursor
advances on *consumption*, not arrival (`message-loop.ts:437-466`). Messages
persisted between admission and execution
(`channel-persistence-handlers.ts:172-199`,
`conversation-message-ingress.ts:225-258`) do not move it. So "cursor
unchanged" cannot mean "no new messages", and the only way to learn about new
arrivals is the query being removed. The second fetch is an authoritative later
read by design; the group processor requeues on its `hasMore`
(`group-processing.ts:202-204,219-220,751`) and reads `responseSchema` and
`agentControls` that a bare `NewMessage[]` loses
(`pending-message-replay.ts:16-22`).

Baseline reproduced before any decision: the double fetch exists on
`106f7d72b`. Signal `S-0001-8b22` was raised on the premise, not the
observation, and resolved by revising the phase.

## Scope / Non-goals

### In scope

- `docs/decisions/0080-…` — the governing record (already committed).
- `docs/decisions/0081-client-signoff.md` (already committed).
- Corrections at source: the roadmap's Phase 3B entry and the goal prompt's A3
  section (already committed).
- **One durable regression test** pinning the contract so reuse cannot return
  without new evidence.

### Non-goals

- Any production behaviour change. No reuse, no replay payload on
  `GroupProcessOptions` or `LiveTurn.pendingMessage`, no cursor-fence
  machinery, no cache, no config change.
- Deleting the ~14 LOC the goal prompt hoped to remove. Accepted cost, recorded
  in 0080.
- Touching admission, the queue, the cursor contract, or
  `collectPendingMessagesSince` itself.

## Acceptance Criteria

- **AC1** — A test asserts that one ordinary queued turn performs **two**
  separate pending-message fetches — admission's and the group processor's —
  and that the group processor's is the one whose result feeds the turn.
- **AC2** — A test asserts the group processor's fetch costs exactly **one**
  `getMessagesSince` call at shipped defaults, pinning the one-statement
  measurement that decision 0080 rests on.
- **AC3** — A test asserts the message-loss hazard directly: with the cursor
  **unchanged** between the two fetches, a message inserted in between is still
  seen by the second fetch. This is the falsifiable core of the decision — if
  reuse were adopted, that message would be dropped.
- **AC4** — Each test names decision 0080 in a comment, so a future reader who
  wants to "optimise away the double fetch" is routed to the evidence rather
  than deleting the test.
- **AC5** — No production file under `apps/core/src/` is modified. Verified by
  the diff.
- **AC6** — Release gates green: `format:check`, `typecheck`, `lint`,
  `test:unit`, `test:integration`, `check:architecture`, `verify.py`.

## Technical Approach

Tests only, in `apps/core/test/unit/runtime/group-processing.test.ts`, reusing
that file's existing scaffolding.

Instrument the repository's `getMessagesSince` with a counting spy and drive one
queued turn through `processGroupMessages`. Assert the call count and, for AC3,
have the spy return an extra message on the second invocation while leaving the
cursor argument identical — proving the later read is what surfaces it.

AC3 is the important one and it is written to fail loudly if someone later
implements reuse: under reuse the second fetch never happens, so the inserted
message never reaches the turn and the assertion breaks. That is the intended
tripwire.

No new harness primitive is needed; the existing counting approach used for
LAT-3A's `memory_hydrate_calls` is enough, and this phase does not warrant a new
operation-name constant for a contract that is deliberately not changing.

## Decisions

- `docs/decisions/0080-lat-3b-retain-authoritative-second-fetch.md` — reject
  replay reuse, retain the authoritative second fetch, with the measured numbers
  and the three conditions that would reopen it.
- `docs/decisions/0081-client-signoff.md` — sign-off for the revised scope.

No further new decisions. The revision itself was routed through signal
`S-0001-8b22` rather than taken silently.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Unchanged by design** | This phase deliberately changes no production code; its output is evidence plus a decision. AC5 enforces it. |
| API | **Unchanged by design** | No handler, contract, or port touched. |
| Data / schema | **Unchanged by design** | No migration, no query change. The measurement is *of* an existing query. |
| CLI / ops | **Unchanged by design** | No command, setting, or config key. |
| UI | **N-A** | No user-visible surface. |
| Docs | **Changed** | Decisions 0080 and 0081 added; the roadmap's Phase 3B entry and the goal prompt's A3 section corrected at source so the rejected remedy is not rediscovered. |
| Tests | **Changed** | Three assertions pinning the two-fetch contract, the one-call cost, and the message-loss hazard. |
| Deferred | **N-A** | Nothing parked. Reuse is rejected with reopen conditions, not deferred — 0080 names what new evidence would be required. |

## Task Decomposition

One bounded stage; the decision and doc corrections are already committed.

**Stage LAT-3B-1 — pin the contract.**
Write scope: `apps/core/test/unit/runtime/group-processing.test.ts`.
Add the three assertions (AC1, AC2, AC3) with decision-0080 comments.
Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`.

## Risks

- **The tests could ossify the wrong thing.** If a future cycle legitimately
  earns reuse (per 0080's three reopen conditions), these tests must be deleted
  as part of that work, not worked around. The comments say so explicitly.
- **A one-call assertion is configuration-dependent.** It holds because
  `MAX_MESSAGES_PER_PROMPT` (10) is far below `MESSAGE_FETCH_PAGE_SIZE` (200).
  If that ratio ever inverts the replay pages and the count changes — which is
  exactly the signal 0080 wants to be loud, so the test failing there is
  correct behaviour, not brittleness. The test comment records this.
- **Reviewer may read "no production change" as "no work done."** The PR body
  leads with the measurement and the message-loss reasoning so the value is the
  evidence, not the diff size.

## Verify Plan

1. **AC3 must be able to fail.** Confirm the inserted-message assertion fails if
   the test is rewritten to consume the first fetch's result — i.e. simulate
   reuse and watch the message disappear. That is the whole decision in one
   check.
2. **AC5 by inspection**: `git diff origin/main --stat -- apps/core/src` must be
   empty.
3. Smallest relevant suite, then local autoreview on the uncommitted diff until
   clean, then commit.
4. Branch closeout: `npm run format:check`, `npm run typecheck`, `npm run lint`,
   `npm run test:unit`, `npm run test:integration`, `npm run check:architecture`,
   `verify.py` (with the `.envrc` vars exported and WITHOUT
   `GANTRY_TEST_DATABASE_URL`, under `caffeinate`).
5. Postgres lanes are not required: this phase touches no persistence path and
   changes no query. Stated here rather than silently skipped.
6. ONE branch-wide autoreview, three lenses, then record the three artifacts.
