# LIVE-2 — Liveness hardening: unified dispatcher, declared capabilities, deterministic tests

Status: draft
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

LIVE-2 is a reshape plus targeted fixes, not ten point-patches.

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
- **Liveness phase ownership**: one controller owning
  `active | delivering | waiting | stalled | terminal` per turn, replacing the split
  flags across group-liveness-state / group-progress-heartbeats / group-processing.
  Admission and terminal cleanup live in the same scope (fixes stranded-⏳ class).
  Stall→recovery transition re-enables typing (locked decision 2).

### B. Correctness fixes (each bound as an acceptance criterion)

1. First-reaction await can block the turn indefinitely — bound or detach
   (group-processing.ts:137/261, live-reaction-lifecycle.ts:58).
2. Setup failure after ⏳ strands the reaction — admission+restore in one finally scope
   (group-processing.ts:261..307 vs 702; live-execution.ts:378 never calls onTerminal).
3. Telegram replaceOnly edit-failure falls through to create a duplicate message —
   propagate as ambiguous, never create (channel-delivery.ts:416,487-507; spec
   live-1-ambient-liveness.md:24).
4. Slack persisted generation survives restart while the counter resets — restored-epoch
   rebase rule so a restarted process can still update/terminalize old cards
   (channel-delivery-helpers.ts:489,656; group-processing.ts:67).
5. Telegram topic typing drops message_thread_id — typing lands in the right topic
   (channel-delivery.ts:759, typing-indicator.ts:14, channel-wiring-live-ux.ts:17).
6. Telegram reaction flip does remove-ALL then re-add — no-op flip flag so fast turns
   don't wipe unrelated reactions (live-reaction-lifecycle.ts:42-54).
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
11. 5s flip race near first-output can end with NO reaction — settle to exactly one
    terminal reaction.
12. Typing permanently stops at stall (group-progress-heartbeats.ts:212) — resume on
    recovery per locked decision 2.

### C. Deletions (simplification with proof)

- Three lifetime reaction-dedupe registries (discord.ts:114, slack/channel-delivery.ts:60,
  telegram/channel-reactions.ts:5) — providers are idempotent; delete the sets and
  plumbing.
- Unreachable undispatched-stall rollback in group-progress-channel-sender.ts:203.
- Unused multipartMutationByProgressKey alias (discord-progress.ts:36).
- Discord active/tombstone parallel maps → one keyed lifecycle registry with
  retained/active status, preserving tombstone BEHAVIOR (definitive-missing survives
  eviction).

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

- All 12 correctness fixes have falsifier tests that fail on the LIVE-1 tree.
- Capability declarations are the single source of liveness truth; no advertised no-ops.
- Deleted state stays deleted (no re-grown lifetime sets).
- verify.py green; agent-e2e delta included (runtime-behavior change).
