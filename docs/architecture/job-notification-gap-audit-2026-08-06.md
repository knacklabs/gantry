# Job-notification gap audit — 2026-08-05

Read-only Codex audit (gpt-5.6-terra @ high) against main post-PR #388, run
from the brief in `job-notification-audit-brief.md`. Eleven gaps, most severe
first. Each is tagged: **SCHED-4B** (new story, ships next), **SCHED-4**
(folded into that story's acceptance criteria), or already covered. The
suspected first-blocker dedupe bug was checked and is NOT present — the
readiness fingerprint hashes the sorted full blocker set
(`application/jobs/job-readiness-service.ts:469`).

## Critical

1. **Setup cards cannot approve the missing access.** (NEW → SCHED-4B)
   `notifySchedulerSetupRequired` sends text only — no `actionAffordances`
   (`jobs/execution-notifications.ts:107`), and the message-action union has
   no approval kind at all (`domain/message-actions.ts:3` — scheduler/stop/
   review kinds only). This is exactly the buttonless "Setup needed ·
   RunCommand" card Ravi hit. Fix shape: one bounded approve-this-requirement
   affordance that settles through the EXISTING permission-authorization path
   (no new grant path), added to the union, each provider allowlist/renderer
   (`slack/message-action-affordances.ts:8`,
   `telegram/message-action-affordances.ts:21`, `discord-components.ts:14`,
   `teams-cards.ts:297` + `teams-message-actions.ts:27`) AND the durable
   enqueue payload (`jobs/delivery.ts:177`) — otherwise buttons strip on
   delivery (known sanitizer behavior).

## High

2. **Setup cards lack the required story.** (SCHED-4B; content criteria were
   already in SCHED-4) Only the parsed denial summary is shown — no
   triggering step, no died-vs-degraded statement, and additional distinct
   blockers beyond the summarized one are not enumerated. Fix: build the card
   from terminal diagnostics + outcome; list every blocker (or count +
   expand); never a bare tool id.
3. **Permission batches erase job context.** (NEW → SCHED-4) The batch
   prompt returns `contextLines: []`
   (`channels/permission-batch-coalescer.ts:135`), so a batched ask from a
   scheduled job loses the job-name/step framing single asks carry. Fix:
   carry per-request job context into batch rows.
4. **Durable-grant auto-resume is invisible and capped.** (SCHED-4B; the
   100-cap was already in SCHED-4) When a durable grant lands,
   `job-permission-recovery.ts:79` resumes matching paused jobs silently —
   no receipt to the job's conversation — and scans at most 100 paused jobs.
   Fix: paginate until drained + a route-scoped resumed/queued receipt.
5. **`deliveryState` can claim `sent` on enqueue success.** (SCHED-4)
   `jobs/delivery.ts:167` reports success when the durable enqueue succeeds;
   `execution-completion-events.ts:44` projects that as delivered even if the
   provider later rejects. Fix: project persisted delivery settlement, not
   enqueue.

## Medium

6. **Lifecycle retirement is unwired on non-primary exits.** (NEW → SCHED-4B)
   The retire-or-replace path added for normal terminals is not injected on
   the crash terminal (`jobs/execution.ts:745`), dead-letter
   (`jobs/execution-dead-letter.ts:181`) or stale-lease
   (`jobs/stale-lease-terminal.ts:127`) exits — stale "running…" bubbles
   survive exactly the exits where honesty matters most. Fix: inject the
   updater on every exit + per-exit-path tests.
7. **Status labels are heuristic.** (SCHED-4, already) `statusLabel()` infers
   from summary text; needs the structured completed|partial|blocked worker
   outcome SCHED-4 already specifies.
8. **Provider action parity is already broken.** (NEW → SCHED-4B) Discord
   renders only `scheduler_run_now` (`discord-components.ts:20`); Teams
   drops every scheduler action except run-now (`teams-cards.ts:314`) — a
   paused job on those channels has no pause/resume affordance today. Fix
   with the affordance work, or degrade visibly to text.
9. **`job.silent` suppresses even blocking failures.** (NEW → SCHED-4)
   `execution-notifications.ts:84,99,141` gate ALL cards, so a silent job
   can pause or dead-letter with the owner never told. Fix: split
   routine-quiet from actionable-health escalation.
10. **No settlement receipt to the job's conversation.** (NEW → SCHED-4)
    Approving from another route (CLI, other channel) settles the permission
    with no causal receipt where the job lives. Fix: settlement event +
    projector fan-out.
11. **Per-run terminal cards can spam retries.** (NEW → SCHED-4) Terminal
    cards key on runId (`execution-notifications.ts:220`), so a retrying job
    emits one card per attempt. Fix: per-job failure window.

## Already covered (verified, no action)

- Receipt scope copy, approved-vs-attempted diff, repeat escalation,
  completed-with-limits folding — shipped in PR #388 (SCHED-4A).
- First-blocker dedupe suppression when the blocker set changes — disproven,
  fingerprint covers the sorted set.
