---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-05
stories: [SCHED-1]
---

# Scheduled Runs Cannot Mutate Jobs

## Context

The lead-maintenance incident (2026-08-05, assessment in
docs/architecture/scheduler-incident-assessment-2026-08-05.md) showed a
scheduled run editing its own job definition: the model called
scheduler_update_job mid-run, replaced access_requirements with a raw
RunCommand rule, readiness re-ran, and the recurring job paused itself with
next_run cleared — a self-inflicted loop no human asked for. The scheduled
runner currently receives the full scheduler tool set (update/pause/resume/
run_now/upsert/delete), and the scheduled prompt even encourages self-editing.
Decision 0058 already records that scheduler mutations affect future
unattended execution and must remain human-gated; the tool surface and prompt
contradict it.

## Decision

A scheduled (unattended) run may inspect the scheduler but never mutate it.
Scheduled-run tool surfaces carry only the read tools (get/list/runs/events/
wait/dead-letter/notification-targets); mutation tools are absent. Defence in
depth: scheduler IPC carries signed source provenance (sourceJobId,
sourceRunId, sourceRunKind), and the host rejects any mutation whose source is
a scheduled run regardless of the tool surface. Runs that discover their
configuration is wrong report a structured proposedJobChange in their outcome
for an attended agent or human to apply.

## Consequences

- The pause/resume loop class is closed at two layers (surface + host).
- Scheduled prompts must drop the self-edit instruction and gain the
  "may not mutate, pause, resume, delete or retrigger jobs" control policy.
- Attended/interactive scheduler mutations are untouched here (their approval
  policy is decision 0107's sibling change).
- Jobs that legitimately want to self-tune must route through proposed
  changes — deliberate friction, accepted.
