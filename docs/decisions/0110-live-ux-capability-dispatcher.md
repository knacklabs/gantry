---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-04
stories: [LIVE-2]
---

# Live UX Capability Dispatcher

## Context

LIVE-1's ambient liveness (reactions, typing, progress) works through per-provider
plumbing that hand-rolls error handling differently in each adapter: Telegram
catches, Discord throws (and can fail a whole turn), Slack has no typing at all,
and Teams advertises a reaction method that is a no-op (contradicting decision
0033). Capability support is inferred with casts; rate-limit failures are swallowed
at debug level; multi-account sink resolution can silently no-op every liveness
signal. Two independent reviews (Fable determinism audit, Codex xhigh holistic
review, both 2026-08-04) converged on the same reshape.

## Decision

1. Each channel adapter declares its liveness support in one optional `liveUx`
   capability object — `typing: none | expiring` and
   `reactions: none | { removal: exact | all }` — next to the operations
   themselves. Declarations are truthful: no advertised no-ops, no inferred casts.
   Teams declares `reactions: none` (per 0033). **Slack declares `typing: none`** —
   Slack bots cannot set the native indicator and we do not emulate it; Slack
   liveness is reactions + the progress card. (Confirmed by Ravi in chat,
   2026-08-04.)
2. One route-aware liveness dispatcher owns reaction and typing delivery for all
   providers: bounded best-effort deadlines, catch-and-warn error policy,
   rate-limit warn + one retry, and loud missing-sink diagnosis. Emoji mapping and
   provider idempotency stay inside adapters. Progress sending stays OUTSIDE the
   dispatcher: its false-vs-rejection semantics carry message-identity ambiguity
   the dispatcher must not flatten.
3. **Typing resumes after stall recovery.** The truthful-typing invariant is kept —
   typing never shows while stalled — but recovery (real progress or output
   resuming) re-enables it; a single stall no longer silences typing for the rest
   of the turn. (Confirmed by Ravi in chat, 2026-08-04.)

## Consequences

- Liveness failures become observable (warn-level with route context) instead of
  silent; a liveness outage can no longer fail a turn.
- The capability object is the single source of liveness truth for wiring,
  jobs-side requirements, and docs; adapters that gain abilities change their
  declaration, not core plumbing.
- Rejected: a parallel boolean capability matrix maintained apart from the
  adapters (drifts); Slack typing emulation via progress-card edits (noise,
  duplicates the card); permanent typing stop after one stall (the behavior users
  reported as "typing disappeared").
- Implies LIVE-2 work: dispatcher module, adapter declarations, phase-controller
  consolidation, and deletion of the cast-based inference.
