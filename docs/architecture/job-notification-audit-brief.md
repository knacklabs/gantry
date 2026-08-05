# Audit brief: job notification gaps (status + permissions)

Read-only audit. Goal: enumerate every gap between what job notifications
currently say/do and what they SHOULD say/do, so the owner can see the full
surface before SCHED-4 lands. Two incidents frame "should": the lead-job
pause loop (docs/architecture/scheduler-incident-assessment-2026-08-05.md,
including the addendum's six UX defects) and today's report that the
"Setup needed · RunCommand" card carries no approval buttons at all.

Note current in-flight work before flagging it as a gap: branch
feat/SCHED-4A-approval-notification-ux (PR #388) already ships receipt scope
copy, completed-with-limits folding, approved-vs-attempted diffs, and repeat
escalation. Audit the BRANCH state if checked out, else note overlap.

## Surfaces to audit (with the questions per surface)

1. Setup-needed cards (jobs/execution-notifications.ts notifySchedulerSetupRequired,
   shared/job-setup-labels.ts, application/jobs/job-management-readiness.ts):
   - Actionability: no actionAffordances today — what affordance kinds exist
     (execution-notifications.ts recovery/run-again), which per-provider
     allowlists (channels/*/message-action-affordances.ts, discord-components.ts)
     and the durable-send sanitizer view allowlist would need entries for an
     approve-from-card flow? Map the exact wiring a new kind requires.
   - Content: bare tool ids vs human action; only blockers[0] shown — where do
     the remaining blockers go? Does the fingerprint dedupe suppress a card
     when the blocker SET changes but the first blocker doesn't?
   - Does anything tell the user whether the run died or degraded?
2. Terminal/status cards (jobs/status-formatting.ts, execution-notifications.ts):
   - Status label coverage: every TerminalRunStatus vs label truthfulness;
     retry messaging; dead-letter path; interrupted-run path.
   - Lifecycle/progress message retirement across ALL exits (crash paths?).
   - Silent-job flag interactions: what does a silent job's owner ever learn?
3. Permission prompts/receipts in the JOB context (channels/permission-interaction.ts,
   channel prompt deliveries): job name/step context present? Do receipts
   reach the JOB's conversation or the approver's chat only — who else should
   know? Batch prompts in job context?
4. Permission recovery loop (application/jobs/job-permission-recovery.ts,
   request_access ladder): when a durable grant lands, which notifications
   fire (or fail to) on auto-resume? Pagination cap (known: 100).
5. Event/notification consistency: job.setup_required / run.completed events
   vs what the cards say — can they contradict? deliveryState tracking; the
   notified flag vs actual provider delivery failure (what happens when
   sendMessage throws or the provider rejects)?
6. Cross-provider parity: are cards identical across slack/telegram/discord/teams
   or do allowlists/sanitizers silently drop parts (buttons, blockquotes,
   markdown bold) per provider? Name concrete drops.
7. Timing/noise: per-run dedupe fingerprints, repeated cards across runs,
   quiet-until-terminal policy adherence (job-notification-quiet work),
   anything that can spam or stay silent too long.

## Deliverable

A numbered gap list, most severe first, each with: what happens today
(file:line evidence), what should happen (grounded in the addendum/spec),
and the smallest fix shape. Flag which gaps PR #388 already covers, which
belong to SCHED-4 (card content/events), and which are NEW (not in any
recorded plan). No code changes.
