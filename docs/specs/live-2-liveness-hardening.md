---
slug: live-2-liveness-hardening
title: LIVE-2 liveness hardening
status: confirmed
saved: 2026-08-04T14:07:00+00:00
---

# LIVE-2 — Liveness hardening: unified dispatcher, declared capabilities, deterministic tests

Story: LIVE-2
Inputs: Fable determinism audit (10 findings, 2026-08-04) + Codex xhigh holistic review
(scratchpad live1-holistic-review-result.md, 2026-08-04). Both independently converge on
the same reshape.

## Why (plain language)

Ravi sometimes doesn't see the emojis or typing indicators the agent is supposed to show.
LIVE-1 built the machinery; two independent reviews found the gaps are not in the hard
per-card ordering machinery (audited: keep all of it) but in the plumbing around it:
per-provider hand-rolled error handling, silent no-ops, unbounded caches, and tests that
assert internal call order instead of what the user actually sees.

LIVE-2 is a reshape plus targeted fixes, not a pile of point-patches.

## Locked product decisions (Ravi, 2026-08-04, in chat)

1. **Slack typing = declared absence.** Slack bots cannot set the native typing
   indicator; Slack liveness is reactions + the progress card. No emulation.
2. **Typing resumes after stall recovery.** Typing stays off while stalled (truthful),
   and resumes the moment real progress/output resumes. The invariant "typing never
   shows DURING a stall" stands.

## Settled invariants (do not re-litigate)

Serialize+coalesce+abort-deadline; strict per-card mutation exclusivity; sticky
ambiguity; truthful typing; route-scoped ordering fallback. The Discord mechanism audit
verdict: queues, tombstone behavior, fingerprints, sticky ambiguity, retained terminal
handles, runtime fencing — all load-bearing, keep.

## Scope

### A. The reshape (retires whole finding families)

- **Declared live-UX capability**: each adapter exposes one optional `liveUx` object —
  `typing: none | expiring`, `reactions: none | { removal: exact | all }` — alongside its
  operations. No inferred casts, no advertised no-ops. Teams declares `reactions: none`
  (decision 0033); Slack declares `typing: none` (locked decision 1).
- **One route-aware liveness dispatcher** for reactions + typing across providers:
  uniform best-effort deadlines, catch-and-warn error policy, rate-limit visibility
  (warn + retry-once, never silent debug-swallow), account/thread resolution with
  missing-sink observability (a resolution miss logs loudly instead of silently
  no-opping). Emoji mapping and provider idempotency stay inside adapters. Progress
  sending stays OUTSIDE the dispatcher (its false-vs-rejection semantics carry identity
  ambiguity).
- **One retry owner**: adapter live-UX operations expose failures to the dispatcher,
  including a classified rate-limit delay. They do not swallow the failure or perform
  their own retry for that operation. This matters because Slack and Telegram reaction
  helpers currently catch failures locally (`slack/reactions.ts:43-59`;
  `telegram/reactions.ts:31-44`) while Discord's shared REST helper already makes up to
  three attempts (`discord-http-helpers.ts:151-179`). The dispatcher falsifier asserts
  at most two transport attempts, so the reshape cannot accidentally multiply retries.
- **Liveness phase ownership**: one controller owning
  `active | delivering | waiting | stalled | terminal` per turn, replacing the split
  flags across group-liveness-state / group-progress-heartbeats / group-processing.
  Its outer scope starts immediately before reaction admission in
  `group-processing.ts:261` and encloses setup plus execution through final progress and
  typing cleanup (`group-processing.ts:262-834`). The progress sender remains a separate
  identity/ordering component. Stall→recovery immediately refreshes typing after a
  successful visible delivery; it does not wait for the next heartbeat tick.

### B. Correctness fixes (each bound as an acceptance criterion)

1. First-reaction await can block the turn indefinitely — bound or detach
   (group-processing.ts:137/261, live-reaction-lifecycle.ts:58).
2. Setup failure after ⏳ strands the reaction — admission+restore in one finally scope
   (group-processing.ts:261..307 vs 702; live-execution.ts:378 never calls onTerminal).
3. Telegram replaceOnly edit-failure falls through to create a duplicate message —
   propagate as ambiguous, never create (channel-delivery.ts:416,487-507; spec
   live-1-ambient-liveness.md:24).
4. Slack persisted generation survives restart while the process-local counter resets,
   muting all
   updates — resolve by STALE-AND-REPOST (grill-locked 2026-08-04): on restart a
   persisted card from a prior process is terminally marked stale (best-effort edit)
   and new work posts a fresh card; no epoch/rebase arithmetic
   (`channel-delivery-helpers.ts:489-523,656-681`; `group-processing.ts:67,147-148`).
   The persisted handle is consumed only by Slack progress delivery
   (`channel-delivery.ts:520-558,618-626`); no control, cancellation, or stop authority
   depends on cross-restart card continuity. Detect prior-process ownership lazily on
   the first non-`replaceOnly` update for that progress key; do not sweep or clear all
   persisted keys at startup. Mark the old card stale before posting the replacement,
   but a failed stale edit must not suppress the fresh post.
5. Telegram topic typing drops message_thread_id — typing lands in the right topic
   (channel-delivery.ts:759, typing-indicator.ts:14, channel-wiring-live-ux.ts:17).
6. Telegram reaction flip does remove-ALL then re-add. Use the declared
   `reactions.removal` capability directly: for `all`, replace the bot's reaction with
   the terminal reaction without a preceding removal; for `exact`, retain the ordered
   remove-then-add transition (`live-reaction-lifecycle.ts:42-54`;
   `telegram/reactions.ts:32-37,64-69`). Do not add a second provider-specific flip
   flag beside `liveUx`.
7. Discord setTyping throws unguarded — dispatcher error policy covers it (was
   group-processing.ts:307/594 turn-killer).
8. Multi-account same-provider sink resolution returns undefined → all liveness silently
   no-ops — route-based recovery + loud diagnosis
   (channel-wiring-route-provider-account.ts:33-47).
9. Discord thread reactions fall back to the PARENT channel on cache miss (404) — fail
   the reaction instead; fix the test that asserts the wrong fallback as success
   (discord.test.ts:1876-1935).
10. Batch turns react only to the latest message — backwards-scan like
    continuation-receipts.ts:15-20.
11. Typing recovery can lag until the next 4-second heartbeat: successful visible
    delivery resets the stall epoch (`group-liveness-state.ts:80-89`), and the next
    non-stalled heartbeat refreshes typing (`group-progress-heartbeats.ts:212-215`).
    Refresh immediately on the `stalled -> active` transition while preserving the
    invariant that failed or still-in-flight delivery does not restart typing.

The previously proposed "5s flip race can end with no reaction" is rejected as stale.
The lifecycle serializes timer and terminal work and checks `settled` after the delayed
removal (`live-reaction-lifecycle.ts:26-30,67-87`); the delayed-removal interleaving is
already covered (`test/unit/bootstrap/live-reaction-lifecycle.test.ts:84-112`). Keep an
end-state regression, but it is not a LIVE-1-red falsifier or a new correctness fix.

### C. Deletions (simplification with proof)

- Delete only the unreachable rollback of `lastDesired` for an undispatched stall link
  (`group-progress-channel-sender.ts:203-214`). `lastDesired` is assigned only after a
  link becomes dispatched (`group-progress-channel-sender.ts:540-550`), so the equality
  branch at lines 211-213 cannot be true; keep the surrounding cancellation function.
- Delete the unused `multipartMutationByProgressKey` alias
  (`discord-progress.ts:32-38`); the mutation queue itself remains the owner.
- DEFER the three lifetime reaction-dedupe registries. They are unbounded and candidates
  for later simplification, but they are not dead: Discord reads/writes its set in
  `discord-ambient-liveness.ts:19-45,48-77`, Slack in `slack/reactions.ts:31-59,62-89`,
  and Telegram in `telegram/reactions.ts:9-44,47-75`. Removing an active request-
  suppression cache based only on provider idempotency is not a proven-dead deletion.
  Reopen when adapter contracts and stateful tests prove duplicate add/remove calls do
  not change visible state or violate the liveness request ceiling.
- Discord active/tombstone parallel-map collapse: DEFERRED (grill-locked 2026-08-04)
  — behavior is audited-correct; storage refactor reopens the hardest-won machinery
  for no user-visible gain. Deferral trigger: the next bug traced to the dual-map
  migration logic.

### D. Determinism test hardening

- A small stateful fake provider (messageId→rendered card, messageId→reaction set,
  in-flight mutation gauge) shared by liveness suites; assert final provider-visible
  state: final text, final reaction set, exactly one card, no duplicate post, concurrency
  ceiling. Model: discord-progress.test.ts:1795.
- Failure/latency-injecting falsifiers: provider errors, rate-limit responses, slow
  settlements, restarts — asserting end state, not call order.
- One flow-level test of admission → lifecycle → wiring → channel (the chain had zero
  end-to-end coverage).
- Two-account sink-resolution tests (the multi-account silent no-op class).
- Slack restart test uses real restart arithmetic (no hand-picked generation numbers).

## Out of scope

- Progress-ordering machinery internals (audited healthy).
- Slack typing emulation via the progress card (rejected).
- Real Teams reactions (impossible for bots; decision 0033 documents).
- Slack canvas / content work (CONTENT-1 lane).

## Success criteria

- All 11 surviving correctness fixes have falsifier tests that fail on the LIVE-1 tree.
- Capability declarations are the single source of liveness truth; no advertised no-ops.
- The two proven-dead paths stay deleted; deferred reaction caches do not grow beyond
  their current role.
- verify.py green; agent-e2e delta included (runtime-behavior change).

## Independent premise critique (2026-08-04)

| Premise | Verdict | Current-tree evidence |
| --- | --- | --- |
| Capability support is inferred by casts | Verified | `channel-capability-ports.ts:15-21,47-60` checks method presence and casts; `channel-provider.ts:126-141` models the operations as a broad `Partial` intersection. |
| Teams advertises reactions and Slack lacks typing | Verified | Teams exposes an empty `addReaction` at `teams.ts:271`; Slack's channel delivery exposes reactions at `slack/channel-delivery.ts:140-173` and no typing operation. |
| Live-UX routing silently misses ambiguous accounts | Verified | `channel-wiring-live-ux.ts:22-25,38-41,54-57` uses `findBoundChannel`; `channel-wiring.ts:135-157` binds that to the exact-account helper, whose no-account ambiguous case returns `undefined` at `channel-wiring-route-provider-account.ts:33-47`. |
| First reaction can block setup | Verified | `group-processing.ts:137-145,261` awaits the hook; `live-reaction-lifecycle.ts:58-63` awaits the provider add without a local bound. |
| Setup failure can strand the reaction | Verified | Reaction admission precedes context, cursor, and typing setup at `group-processing.ts:261-307`, but terminal cleanup is detached only inside the later `runAgent` finally at `group-processing.ts:676-723`; `live-execution.ts:378-410` finalizes the run without calling the reaction hook itself. |
| Telegram replace-only edit failure can create | Verified | The no-handle guard is at `channel-delivery.ts:416-422`, but an existing-handle edit failure unconditionally posts at `channel-delivery.ts:487-507`, without checking `replaceOnly`. |
| Slack restart arithmetic can mute updates | Verified | Progress generations are process-local (`group-processing.ts:67,147-148`), persisted Slack state retains `generation` (`slack/channel-state.ts:65-71`; `channel-delivery-helpers.ts:656-681`), and a lower new generation is rejected at `channel-delivery-helpers.ts:489-507`. No non-progress consumer of the persisted map was found; its load/use boundary is `channel-delivery.ts:520-558,618-626`. |
| Telegram topic typing loses the topic | Verified | Wiring forwards `threadId` at `channel-wiring-live-ux.ts:17-30`, but Telegram's method accepts only `(jid,isTyping)` at `channel-delivery.ts:759-760`, and `typing-indicator.ts:3-19` sends no `message_thread_id`. |
| Telegram flip removes all reactions | Verified | The lifecycle removes before adding at `live-reaction-lifecycle.ts:42-54`; Telegram removal sends an empty reaction list at `telegram/reactions.ts:64-69`. The accepted shape uses the declared removal mode, not another flag. |
| Discord typing can fail a turn | Verified | Initial typing is awaited without a catch at `group-processing.ts:303-307`; Discord performs a throwing POST at `discord.ts:226-235`. |
| Discord thread reaction falls back to parent | Verified | Resolution falls through to the JID-derived parent at `discord.ts:642-653`; the expiry test expects that parent request at `test/unit/channels/discord.test.ts:1876-1933`. |
| Batch reaction target uses only the last message | Verified | `group-processing.ts:123-130` derives the reaction ref from `latestMessage`; continuation receipts already backwards-scan at `continuation-receipts.ts:14-20`. |
| The 5-second flip race is unfixed | Rejected | The transition chain and post-removal settlement check are at `live-reaction-lifecycle.ts:26-30,67-87`; the exact delayed-removal race is tested at `test/unit/bootstrap/live-reaction-lifecycle.test.ts:84-112`. |
| Typing permanently stops after a stall | Corrected | Successful visible delivery resets the stall epoch at `group-liveness-state.ts:80-89`, and heartbeat refresh resumes at `group-progress-heartbeats.ts:212-215`; the surviving defect is up-to-4-second recovery lag, not permanence. |
| All three cleanup groups are dead | Corrected | The alias is unreferenced outside its declaration (`discord-progress.ts:32-38`) and the undispatched rollback branch is unreachable by assignment order (`group-progress-channel-sender.ts:203-214,540-550`). Reaction registries have active read/write consumers listed in section C, so their deletion is deferred rather than mislabelled proven. |

### Accepted vs rejected hardenings

Accepted: a single declared-capability dispatcher; exactly one retry owner with an
at-most-two-attempt falsifier; an outer post-trigger controller scope; capability-driven
Telegram reaction replacement; lazy per-key Slack stale-and-repost with fresh-post
independence; immediate successful stall recovery typing; backwards-scan reaction
targeting; exact-thread Discord reaction failure; the unused alias deletion; and only
the unreachable `lastDesired` rollback sub-branch deletion.

Rejected or deferred: a provider-specific Telegram flip flag (duplicate truth beside
`liveUx`); the already-fixed 5-second flip race as a new fix; deleting the whole stall-
notice supersession function; and deleting active reaction caches under a "dead state"
claim before their request-ceiling effect is proven redundant.
