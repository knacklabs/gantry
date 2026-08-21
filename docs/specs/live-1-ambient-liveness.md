---
slug: live-1-ambient-liveness
title: LIVE-1 ambient liveness
status: confirmed
saved: 2026-08-02T08:54:13+00:00
---

# LIVE-1 — Ambient liveness (Part B)

## Capability

While the agent works, the conversation shows honest ambient liveness with
zero added messages: the existing progress card flips to a plain "Still
working" via a replace-only edit when nothing has happened for 3 minutes
(and typing stops lying at the same moment); Discord gets a real typing
indicator; a slow spawn flips the seen reaction to a running hourglass and
clears it on first output; messages poked into or deferred behind an active
run get a seen reaction so they never look lost; a retried turn edits its
existing failure card ("retrying 2/3" / final "I hit an issue.") instead of
leaving an unexplained fresh turn.

## Behaviour (acceptance)

1. **Stall heartbeat.** With no agent output activity for 3 minutes, the
   existing provider progress card is edited (replace-only — never a new
   provider message, dropped if no card exists) to plain "Still working",
   once per stall. The in-app channel may emit `SESSION_PROGRESS` but never
   `SESSION_MESSAGE_OUTBOUND` for this update. Typing refresh stops while
   stalled and resumes on output. The clock resets for every new
   visible-turn/interaction-resume epoch so waiting for user input cannot
   cause an immediate false stall. The once-per-stall latch is set before its
   async edit starts, and timer work is turn-fenced: nothing may edit after
   success, failure, stop, or teardown. No elapsed/duration text.
2. **Discord typing.** Discord implements the TypingSink (POST
   /channels/{id}/typing via the existing REST helper). Typing options carry
   the active thread id so Discord thread replies target the thread rather
   than the parent channel. `false` sends no Discord request; stopping 4s
   refreshes lets Discord's typing signal expire. Slack remains sink-less
   (truthful capability), per the locked decision.
3. **Seen→running flip.** If first visible output hasn't arrived ~5s after
   the seen reaction, the reaction flips to running (hourglass) on
   Slack/Telegram/Discord; on first output it flips back to seen. This
   requires the first removeReaction implementations (Slack
   reactions.remove, Telegram setMessageReaction([]), Discord DELETE
   .../@me). Removal is separately capability-sniffed from addition. Slack and
   Discord clear the exact emoji; Telegram's empty-list API clears all bot
   reactions and therefore all message-scoped dedupe keys. The 5s transition,
   first-visible-output transition, and terminal cleanup are serialized and
   turn-fenced; a run that ends without output finishes on seen, never a stale
   hourglass.
4. **Mid-run poke + deferral receipts.** Both continuation-routing paths — the
   ordinary message-loop send and the direct already-active durable-owner
   route — issue the same best-effort seen receipt after either a routed or a
   deferred/rejected outcome. The receipt targets the newest provider-backed
   message and never a synthetic `external-ingress:` reference. Receipt failure
   does not alter routing, cursor, admission, or retry outcomes.
5. **Retry on the same card.** A retryable failure no longer finalizes the
   progress card; it is edited in place to "retrying <n>/<max>" (the one
   sanctioned status text, on the existing card) and only the final failure
   sends the terminal "I hit an issue." with done semantics. Retry count and
   max thread through the existing finalRetry path. The incoming retry count is
   retries already consumed, so retryable failure displays count + 1; count ==
   max is final. `maxRetries: 0` is terminal on the initial failure.

## Non-goals

Teams typing and reactions — the production SDK client is a null stub; both
ride the same real-client trigger as D-0034 (deferral recorded). Part C
dead-plumbing deletion — already shipped in PR #235; the goal-prompt doc's
Part C section is marked done instead. No new liveness text of any other
kind; per-provider edit throttles, admission queue, sanitizer untouched.

## Constraints

- Replace-only edits never create provider messages (provider-card no-handle
  drops preserved). In-app progress events are allowed but outbound message
  events are not.
- `onFirstProgress` remains the seen-receipt/timer-start hook; it is not first
  output. First output is a distinct once-only hook after non-empty sanitized
  agent output receives a delivery settlement other than `not_delivered`.
- Async stall/reaction callbacks re-check their turn token after provider
  awaits, preventing late post-terminal edits or reaction flips.
- All behavior unit-tested with fake timers; no Postgres surface.
- The goal-prompt doc's Part B/C sections and the program ledger row update
  to the shipped truth in the same change.
