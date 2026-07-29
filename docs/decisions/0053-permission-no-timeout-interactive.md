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

## Implementation Note — 2026-07-28

The interactive runner wait is indefinite as decided. The prompt formatter
currently rounds timeout `0` up and displays `Reply in 1m`; that stale text is a
display bug and does not create a one-minute deadline. The job recovery path
also currently queues replacement work after releasing the prior lease rather
than resuming the same fenced run.

## Consequences
- A live turn holds its runner slot while waiting — accepted tradeoff; the human
  cancels/aborts to release it. Jobs pause durably and hold no slot.
- Preserves the durable begin/recover pipeline, the job immediate-reject-then-
  pause path, the cancel/abort escapes, and the 24h GC TTL (not a timebox).
- The prompt should not display "reply within N minutes"; the implementation
  note above records the remaining renderer defect.
- Implements the live-wait portion of the killed-5-min-timebox decision; the
  remaining display and same-fenced-run recovery gaps are called out above.
  See [[no-timed-grant-permission]] and [[permission-holistic-redesign]].
