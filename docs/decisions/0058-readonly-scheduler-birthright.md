---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-26
---

# Readonly Scheduler Birthright

## Context
A live run on 2026-07-26 prompted for `scheduler_resume_job` while the read-only scheduler
tools passed silently. The runtime logs show the rails behaving exactly as designed:

| tool | decidedBy | latency |
|---|---|---|
| `scheduler_list_runs` | birthright | 91ms |
| `scheduler_list_events` | birthright | 137ms |
| `scheduler_get_job` | birthright | 95ms |
| `scheduler_resume_job` | `5759865942` (human, Telegram) | 15s |

So the reported symptom was not a defect. But auditing the full scheduler surface against the
birthright sets surfaced three tools that ask despite being pure reads:

- `scheduler_get_dead_letter` — the canonical "why did my job fail" lookup
- `scheduler_list_notification_targets` — every other `scheduler_list_*` is already birthright
- `scheduler_wait_for_events` — observes, and its non-blocking sibling `scheduler_list_events`
  is already birthright

These look like omissions rather than decisions: they are the same shape as tools already in
the set, and they defeat the stated intent that the agent can inspect its own surface and
debug itself without interrupting a human.

## Decision
Add those three tools to `GANTRY_INPUT_INDEPENDENT_BIRTHRIGHT_TOOLS`.

Verified read-only in source before widening a security-relevant allowlist — by structure,
not by name:

- all three route through `requestSchedulerData`, the same helper the already-birthright
  reads use and NOT the helper the mutations use
- all three are registered in `ipc-scheduler-query-handlers.ts`, not
  `ipc-scheduler-mutate-handlers.ts`
- `schedulerWaitForEventsHandler` was read directly: a poll-and-subscribe loop over
  `listEvents()` that closes its subscription in `finally`. No ack, no consume, no write.
  It blocks until events arrive or the deadline passes, and that deadline bounds it.

Every scheduler mutation stays outside birthright: `upsert`, `update`, `delete`, `pause`,
`resume`, `run_now`, `job`.

### Also granted: `memory_review_pending` (added 2026-07-26)

A sweep of all 65 registered tools found one more of the same shape. `memory_review_pending`
calls `AppMemoryService.listPendingReviewPage()` — a paged read. Its neighbours are already
granted: `memory_search` is input-independent birthright, and `memory_save` is input-gated
birthright. So the agent could already search memory and write to memory without asking, but
had to interrupt a human to ask *what is waiting for that human's approval*. That is backwards,
and matches the tool's own description ("what needs memory approval?").

Not granted, and deliberately: `admin_permission_list`, `settings_desired_state` and
`guided_action_preview` are read-only in effect but sit behind
`sourceAgentHasAdminToolCapability`. That admin tier is an existing, deliberate boundary;
widening it is a separate policy decision rather than an omission to tidy up.

## Consequences
- The agent can read dead letters, notification targets and awaited events without a prompt,
  which is the self-debugging case birthright exists for.
- The line is now explicit: class-D birthright covers the agent's OWN working state
  (`todo_update`, `memory_save`, `brain_write`, `procedure_save`, `task_cancel`,
  `task_message`). Scheduler mutations are shared state that causes future UNATTENDED
  execution, so they remain human-gated regardless of how routine they look.
- `scheduler_resume_job` was considered and deliberately NOT granted. It creates no new
  capability and is the runtime's own recommended self-heal, but a job is usually paused
  BECAUSE something failed — auto-resume could re-trigger a failure loop with no human ever
  seeing it. Revisit only if autonomous self-healing becomes an explicit goal.
- These tools are input-independent: they are allowed before the `inputIsIncomplete` rail,
  like the other reads, because the decision does not depend on inspecting their payload.
- Hard floors are unaffected. This widens only the birthright set, not the rails.

See [[perm-4-legibility-birthright]] for the two-tier model this extends.
