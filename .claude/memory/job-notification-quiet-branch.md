---
name: job-notification-quiet-branch
description: feature/job-notification-quiet (stacked on auto-permission) shipped quiet-until-terminal job notifications; deployed to local runtime; PR pending until
metadata: 
  node_type: memory
  type: project
  originSessionId: 968040bb-9312-4913-b84e-c735654be245
---

`feature/job-notification-quiet` (commit `2c81e5439`, stacked on
`feature/auto-permission-mode`) makes scheduled jobs quiet until terminal: no
start message, no todo/plan channel mirror (guard is `!context.data.jobId` in
ipc-agent-task-lifecycle-handlers.ts — interactive plans still render), and one
adaptive end message in status-formatting.ts (no fabricated
Used/Changed/Delegated lines; "⚠️ Completed with issues" when the report has a
real `Needs attention:` value — presentation-only, durable run status
unchanged). Three xhigh local review rounds; deployed to the local runtime.

Not pushed: PR waits until [[auto-permission-trust-pause]] PR #212 merges, then
rebase onto main and open (or fold if user prefers). Known ceiling: agent-prose
auth failures still count as completed for retries/leases; flipping durable
status needs a structured failure marker at the adapter boundary.

**Why:** user found start/plan/receipt messages noisy on Telegram; wanted one
honest end message. **How to apply:** don't reintroduce per-phase job chatter;
notification routes get exactly one terminal outcome
(docs/architecture/autonomous-jobs.md states the default).
