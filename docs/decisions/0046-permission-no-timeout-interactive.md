---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-24
---

# Permission No Timeout Interactive

## Context
The locked decision to remove the 5-minute permission timebox (durable pause, no
timebox, until the admin replies) was never fully implemented: two 5-minute
timeboxes still exist and auto-cancel/auto-answer prompts — `USER_QUESTION_TIMEOUT_MS`
(ask_user_question) and `PERMISSION_APPROVAL_TIMEOUT_MS` (permission approvals,
across all channels). Live testing hit this: a question "timed out" and the agent
took an unwanted default. Each timebox has a runner-side poll deadline AND a
host-side channel timer (the same env-injected number); both auto-terminate the
prompt.

## Decision
The INTERACTIVE (live-turn) lane waits for the admin INDEFINITELY — no timebox —
with cancel/abort as the only escape. Both halves change: the runner poll loses
its deadline (abort-only) and the host channel timers stop finalizing prompts as
"timed out". The interactive floor in `permission-timeout.ts` is relaxed to allow
a no-timeout value. The JOB lane is UNCHANGED: it already rejects immediately
(timeout 0) and pauses durably, resuming the same work via the recovery
orchestrator when the admin approves.

## Consequences
- A live turn holds its runner slot while waiting — accepted tradeoff; the human
  cancels/aborts to release it. Jobs pause durably and hold no slot.
- Preserves the durable begin/recover pipeline, the job immediate-reject-then-
  pause path, the cancel/abort escapes, and the 24h GC TTL (not a timebox).
- Removes the "reply within N minutes" prompt text (no deadline to show).
- Fully implements the killed-5-min-timebox decision — see
  [[no-timed-grant-permission]] and [[permission-holistic-redesign]].
