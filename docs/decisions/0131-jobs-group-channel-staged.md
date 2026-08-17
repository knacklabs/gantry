---
status: proposed
confirmed_by: ""
date: 2026-08-17
stories: [JOBFLOW-1]
---

# Scheduled jobs stage and execute at the group/channel level, not per-topic/thread

## Context

A scheduled job's execution used to resolve against the exact
`(conversation + agent + threadId + providerAccountId)` tuple
(`resolveExecutionContext`, `apps/core/src/jobs/execution-context.ts`), and job
creation copied the ambient topic/thread into `execution_context.threadId`
(`apps/core/src/runner/mcp/tools/scheduler-tool-helpers.ts`). So a job created
inside a Telegram forum topic (or Slack thread) became *executionally* pinned to
that thread. When the specific thread route later stopped resolving — a closed
topic, a route the live table no longer carried — the run dead-lettered with
"Execution context route not found" even though the group/channel itself was
active and installed. This blocked `job-knacklabs-lead-maintenance` (pinned to
topic 6898). Visibility (`canAccessSchedulerJob`) already scoped on the
conversation only, so execution was the outlier that over-pinned on the thread.

## Decision

Scheduled jobs stage and execute at the group/channel (conversation) level. A
topic/thread is a **delivery** detail only — it decides where a reply lands,
never whether or where a run executes. `resolveExecutionContext` omits the thread
from the execution queue key entirely, so a live/absent/closed thread can neither
steer nor block a run. The provider account stays a separate, thread-independent
discriminator: the first notification-route account (primary order) that maps to
a live conversation route is used — skipping a stale/reordered/removed account.
Conversation-wide resolution happens ONLY when the job names no account at all;
if it names accounts but none is live it resolves to none, rather than executing
through an unrelated installation. A single live installation resolves directly. Any `threadId` on
`execution_context` is used only as a delivery fallback (`executionThreadId ??
primaryRoute.threadId`), never for execution routing.

**Rejected alternative:** thread-pinned execution (binding a run to the topic it
was created in). It made execution fragile to a delivery-surface detail and is
the exact defect this decision retires. Do not reintroduce a thread into
execution routing.

## Consequences

- A closed/absent topic can no longer break a job; the run proceeds at the group
  level and delivery falls back to the group when the thread is gone.
- Delivery to a live topic/thread is preserved (`executionThreadId ??
  primaryRoute.threadId`).
- The fix lives at the resolution boundary, so it covers BOTH new jobs and every
  existing thread-pinned row (e.g. job-knacklabs-lead-maintenance) without a data
  migration; job creation is unchanged.
- Enforced as an AGENTS.md non-negotiable. New job-routing code must not key
  execution on `threadId`.
