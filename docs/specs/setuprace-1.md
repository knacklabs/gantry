---
slug: setuprace-1
title: SETUPRACE-1 Atomic claim for setup-pause notifications (close D-0053)
status: confirmed
saved: 2026-08-09T06:30:00+00:00
---

# SETUPRACE-1 — Atomic claim for setup-pause notifications

## Problem

The setup-pause notifier dedups on `setup_state.notified_fingerprint` with a
check-then-mark (check eligibility, send the card, then mark). That is not atomic.
PREFLIGHT-1 added an async creation-time notifier alongside the scheduler run-path
notifier, so two callers can observe the same un-notified fingerprint and both
deliver a setup card — violating the "exactly one card per blocker" contract. The
whole-branch autoreview re-flags this (0.98) and asks for an atomic compare-and-set
claim before delivery, cleared when delivery fails. Tracked as deferral D-0053.

## Intent

Make the shared setup-pause notification path race-safe: a caller atomically
claims the blocker fingerprint before delivering; only the winner sends the card
and publishes the event; a loser delivers nothing. Preserve today's
retryable-on-failure behavior by clearing the claim when delivery fails. A pending
claim records `notify_claim_at` and becomes reclaimable after its TTL; confirmation
clears only that timestamp, leaving the fingerprint permanently notified. Detached
creation notification reloads the job and routes through its current session. Silent /
suppressed / already-confirmed behavior is unchanged. No change to card/event content
or to authority (PERM-2 unaffected).

The delivery guarantee is exactly-once in normal operation and at-least-once across the
send-confirm crash window. The claim timestamp is also the fencing token returned to the
winner; confirm and clear match that token so a stale claimant cannot mutate a successor
claim.

## Acceptance

- Concurrent creation-notify and scheduler run-notify for one fingerprint deliver
  exactly one card and one event.
- A failed delivery clears the claim so a later attempt re-delivers (retryable).
- An abandoned pending claim is reclaimable after its TTL, while a confirmed claim
  remains suppressed.
- A detached creation notification uses the session on the reloaded job.
- Full verify.py green; whole-branch autoreview reports no actionable findings.

## Source

PREFLIGHT-1 deferral D-0053 + the whole-branch Codex autoreview finding. Belongs to
the permission-engine epic (scheduled-job setup flow). SETUPRACE-1 resolves D-0053.
