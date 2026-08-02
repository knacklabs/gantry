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

1. **Stall heartbeat.** With no agent output for 3 minutes, the existing
   progress card is edited (replace-only — never a new message, dropped if
   no card exists) to plain "Still working", once per stall; typing refresh
   stops while stalled and resumes on output. No elapsed/duration text.
2. **Discord typing.** Discord implements the TypingSink (POST
   /channels/{id}/typing via the existing REST helper); the provider-
   agnostic 4s refresh loop drives it unchanged. Slack remains sink-less
   (truthful capability), per the locked decision.
3. **Seen→running flip.** If first visible output hasn't arrived ~5s after
   the seen reaction, the reaction flips to running (hourglass) on
   Slack/Telegram/Discord; on first output it flips back to seen. This
   requires the first removeReaction implementations (Slack
   reactions.remove, Telegram setMessageReaction([]), Discord DELETE
   .../@me); reaction dedupe stays add-once per emoji.
4. **Mid-run poke + deferral receipts.** At the single continuation seam,
   both accepted continuations and rejected/deferred messages get the seen
   reaction on their latest message — one ack site covers both outcomes.
5. **Retry on the same card.** A retryable failure no longer finalizes the
   progress card; it is edited in place to "retrying <n>/<max>" (the one
   sanctioned status text, on the existing card) and only the final failure
   sends the terminal "I hit an issue." with done semantics. Retry count and
   max thread through the existing finalRetry path.

## Non-goals

Teams typing and reactions — the production SDK client is a null stub; both
ride the same real-client trigger as D-0034 (deferral recorded). Part C
dead-plumbing deletion — already shipped in PR #235; the goal-prompt doc's
Part C section is marked done instead. No new liveness text of any other
kind; per-provider edit throttles, admission queue, sanitizer untouched.

## Constraints

- Replace-only edits never create messages (no-handle drops preserved).
- All behavior unit-tested with fake timers; no Postgres surface.
- The goal-prompt doc's Part B/C sections and the program ledger row update
  to the shipped truth in the same change.
