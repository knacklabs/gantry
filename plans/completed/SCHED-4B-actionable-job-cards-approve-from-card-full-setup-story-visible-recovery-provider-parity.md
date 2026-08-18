---
issue: SCHED-4B
title: Actionable job cards: approve-from-card, full setup story, visible recovery, provider parity
status: approved
saved: 2026-08-05T17:29:53+00:00
story: SCHED-4B
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
---


# SCHED-4B — Actionable job cards: approve-from-card, full setup story, visible recovery, provider parity

## Problem

The Codex job-notification audit (`docs/architecture/job-notification-gap-audit-2026-08-06.md`)
confirmed the live incident Ravi hit: a "Setup needed · RunCommand" card with
no way to act on it. Five gaps make job cards non-actionable or dishonest:

1. Setup cards carry NO approval affordance — the message-action union has no
   approval kind at all (`domain/message-actions.ts:3`); the owner must find
   the pending prompt elsewhere or type a command.
2. Setup cards show only the parsed denial summary — no triggering step, no
   died-vs-degraded, extra blockers unlisted.
3. Durable-grant auto-resume is silent (no receipt to the job's conversation,
   `application/jobs/job-permission-recovery.ts:79`) and scans at most 100
   paused jobs.
4. Lifecycle "running…" bubbles survive crash, dead-letter and stale-lease
   exits (`jobs/execution.ts:745`, `execution-dead-letter.ts:181`,
   `stale-lease-terminal.ts:127`) — exactly the exits where honesty matters.
5. Provider parity is already broken: discord renders only run-now
   (`discord-components.ts:20`), teams drops all scheduler actions but run-now
   (`teams-cards.ts:314`).

## Scope / Non-goals

In scope: audit gaps 1, 2, 4, 6, 8 (the SCHED-4B roadmap criteria).
Non-goals: batch job-context (gap 3), delivery settlement states (gap 5),
silent-job escalation (gap 9), settlement fan-out (gap 10), failure windows
(gap 11) — all folded into SCHED-4; structured worker outcomes (SCHED-4);
revision fencing (SCHED-3); any new grant path or option-set change — the
locked Allow once / Allow for future / Deny set stands (no timed grants).

## Acceptance Criteria

1. Setup cards carry an approve-this-requirement affordance settling through
   the EXISTING permission-authorization path, rendered and parseable on
   slack, telegram, discord and teams, preserved through durable enqueue.
2. Setup cards state the failed action, the triggering step, died-vs-degraded,
   and every distinct blocker (or count + expand); bare tool ids never shown.
3. Durable-grant recovery paginates until drained and emits a route-scoped
   resumed/queued receipt per affected job.
4. Lifecycle messages are retired or replaced on ALL terminal exits including
   crash, dead-letter and stale-lease, with per-exit-path tests.
5. Provider-neutral card actions render on every supported channel or degrade
   visibly to text — no silently dropped affordances.

## Technical Approach

Discovery (Codex read-only, file:line evidence recorded below and in the audit
doc) traced the full action pipeline: typed affordance → `sendJobNotification`
→ durable payload preservation (`jobs/delivery.ts:50`, `:177`) → provider
render/parse (slack `SCHEDULER_ACTION_KINDS`
`slack/message-action-affordances.ts:9`, telegram callback map
`telegram/message-action-affordances.ts:21`, `discord-components.ts:14`,
`teams-cards.ts:290` + `teams-message-actions.ts:27`) → `onMessageAction`
per provider → generic router
(`app/bootstrap/channel-message-action-router.ts:27`) → authorized runtime
handler with control-approver authority check
(`app/bootstrap/runtime-live-stop-message-action.ts:185`).

**1. Prompt on pause (gap 1 — Ravi's chosen shape).** When an autonomous
denial pauses a job with `setup_required` and the blocker is GRANTABLE, the
host raises the standard interactive permission prompt itself — one message
carrying the setup story AND the locked Allow once / Allow for future / Deny
buttons. No new message-action kind and no new grant path.

The machinery already exists end to end:
- `startRequestOnlyCapabilityReview` (`jobs/ipc-admin-handlers.ts:505`)
  raises the normal provider permission UI with NO runId, records a
  `pendingAccessRequests` row, and calls `deps.requestPermissionApproval`;
  the channel requester dispatches runId-less requests immediately
  (`channels/permission-approval-requester.ts:446`); the locked option set is
  already computed for it (`jobs/request-permission-review.ts:315`).
- Settlement is the existing chain: permanent decision →
  `persistRequestPermissionRules` (`ipc-admin-handlers.ts:570-573`) →
  `recheckSetupPausedJobsAfterCapabilityUpdate` — which is exactly the
  auto-resume this story makes visible (approach item 3).

Work: lift `startRequestOnlyCapabilityReview` from file-private into a small
application seam callable from the pause path, and build the review request
from the JOB's stored requirement (the full shape — command template for
local CLI, capability id, etc. — per `application/jobs/job-tool-access-requirements.ts:172-181`),
NOT from the compact blocker tuple, which discovery proved lossy
(`job-readiness-service.ts:348`, `:394`). Grantable = semantic capabilities,
browser, and mappable tool rules; `mcp_server`/`credential`/config blockers
are not permission problems and keep the instruction-only card (with the
gap-2 content). Locked/fixed-image agents keep the operator-provisioning
message (`shared/tool-execution-policy-service.ts:579`).

Guard rails: dedupe by `setupState.fingerprint` — one pending prompt per
job+fingerprint, no re-prompt while it is unanswered or the blocker set is
unchanged (extends the existing notification CAS,
`adapters/storage/postgres/repositories/canonical-job-coordination.postgres.ts:54`);
Allow once records the transient `temporaryOnly` access for the NEXT run via
the existing pendingAccessRequests semantics and says so in the receipt
(SCHED-4A copy); prompt routing/authority rides the existing prompt path —
prompts already go to the authorized approver route, not arbitrary members.

**2. Full setup story (gap 2).** `notifySchedulerSetupRequired` today renders
`blockers[0]` only (`jobs/execution-notifications.ts:104`) and never sees
terminal diagnostics, while the terminal formatter already has the
degraded-vs-died explanation (`execution-notifications.ts:230`). Compose the
setup card from terminal outcome/diagnostics + the FULL blocker set (already
emitted by `jobs/execution-readiness.ts:178` and fingerprinted whole in
`application/jobs/job-readiness-service.ts:464`): failed action, triggering
step, died-vs-degraded line, every distinct blocker (count + expand beyond a
small N), never a bare tool id (reuse the human-readable labels from
`shared/job-setup-labels.ts`).

**3. Drained, visible recovery (gap 4).** The durable-grant path persists the
rule then calls `recheckSetupPausedJobsAfterCapabilityUpdate`
(`application/interactions/pending-interaction-permission-recovery.ts:51`),
which lists paused jobs with a hard `limit: 100`
(`application/jobs/job-permission-recovery.ts:121`). Add keyset pagination to
`JobListFilters` (`domain/repositories/ops-repo.ts:47`) with a stable
ordering in the Postgres repo
(`adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts:180`)
and loop until drained. After each successful resume+sync
(`job-permission-recovery.ts:79`), send a route-scoped "resumed/queued"
receipt via the job's notification route (today only an event is emitted,
`job-permission-recovery.ts:161`).

**4. Lifecycle retirement on every exit (gap 6).** `updateLifecycleNotification`
already implements retire-or-replace inside the notifier
(`execution-notifications.ts:134`, `:206`) but NO caller injects it: the
primary terminal call (`jobs/execution.ts:745`), dead-letter
(`jobs/execution-dead-letter.ts:181`) and stale-lease
(`jobs/stale-lease-terminal.ts:127`) all pass only `sendMessage`. Inject the
channel lifecycle updater at all three call sites; add one test per exit path
proving the stale "running…" bubble is retired or replaced.

**5. Provider parity (gap 8).** Discord renders only `scheduler_run_now`
(`discord-components.ts:20`); Teams builds a card action only for run-now and
returns null otherwise (`teams-cards.ts:297`), and its parser accepts only
run-now (`teams-message-actions.ts:135`) — yet failed terminals compose
`scheduler_pause_job` today (`execution-notifications.ts:38`). Render the
full provider-neutral kind set on discord and teams, or emit a visible text
fallback line when a provider genuinely cannot render a control — never a
silent drop. Verify the permission-prompt affordances (which item 1 now
relies on) render on all four providers too. Note: slack and telegram
currently treat a pause tap as a hint, not a dispatch
(`slack/channel-message-action-handler.ts:278`,
`telegram/channel-connect.ts:599`); parity here means rendering + the same
hint/dispatch semantics across providers, not new pause-dispatch behavior.

## Decisions

No new decision expected: reuses 0019 (permission/job tool lifecycle),
0053 (no-timeout interactive prompts), 0054 (provenance + risk label),
0107 (typed provenance). Locked option set honored (no-timed-grant).

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | new card affordance + settlement, setup-card content, recovery drain + receipts, lifecycle retirement, provider rendering |
| Data/schema | Unchanged by design | keyset pagination uses existing columns; no migration |
| API | Unchanged by design | message-action union is internal, not public API |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | provider chat surfaces only |
| Docs | Changed | audit doc is the spec; decision docs untouched |
| Tests | Changed | affordance round-trip per provider, setup-card matrix, drain + receipt, per-exit retirement |

## Task Decomposition

Two bounded tasks (separate concerns, sequential):

1. **SCHED-4B-1 — prompt on pause + full setup story + provider parity**
   (gaps 1, 2, 8): application seam over the request-only capability review,
   raised from the setup pause for grantable blockers with fingerprint-keyed
   dedupe; setup-card/prompt composition from terminal diagnostics + the full
   blocker set; discord/teams scheduler-kind parity or visible text fallback,
   permission-prompt affordances verified on all four providers.
2. **SCHED-4B-2 — visible recovery + lifecycle honesty** (gaps 4, 6): keyset
   drain in recovery + route-scoped receipts, lifecycle updater injected on
   all three terminal exits with per-exit tests.

## Risks

- Prompt spam: every scheduled pause now raises a real prompt. The
  fingerprint-keyed dedupe (one pending prompt per job+fingerprint, never
  re-raised while unanswered) is the load-bearing guard; it gets its own
  tests, including the blocker-set-changed case.
- No new grant path: the pause prompt must go through the request-only review
  seam and settle via the existing persist → recheck chain; the review
  request is built from the job's stored requirement, never reconstructed
  from the lossy blocker tuple.
- Prompts with no runId: decision 0053 (no-timeout interactive) means an
  unanswered pause prompt persists — intended, but the prompt must be
  retired/updated when the blocker set changes or the job is deleted.
- Recovery drain touches the Postgres repo ordering — keep ordering stable
  and test the >100 case with a seeded fake, not a real 101-job fixture.
- Teams/discord renderer changes ride provider adapters (architecture rule:
  provider specifics stay behind adapters).
- Roadmap criterion 1 says "approve-this-requirement affordance"; the chosen
  shape satisfies it with the standard prompt's affordances raised at pause
  time (owner-approved UX choice) — noted here so the reviewer doesn't flag
  the absence of a new action kind as a gap.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels apps/core/test/unit/jobs apps/core/test/unit/application apps/core/test/unit/domain
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the change reverted:
1. A setup pause on a grantable blocker raises exactly one standard
   permission prompt (locked options) built from the job's stored
   requirement; answering Allow for future persists the rule and the job
   resumes via the existing recheck; Allow once records the transient
   next-run access and the receipt says so.
2. A second pause with the same fingerprint does not re-prompt; a changed
   blocker set retires the old prompt and raises a fresh one; a
   non-grantable blocker (mcp_server/credential) raises no prompt and keeps
   the instruction card.
3. Setup card/prompt for a multi-blocker pause lists every blocker with
   human labels plus the died-vs-degraded line and triggering step; never a
   bare tool id.
4. With 150 paused matching jobs, recovery resumes all 150 and sends one
   route-scoped receipt per job (or bounded aggregate).
5. Each terminal exit (primary, dead-letter, stale-lease) retires or replaces
   the lifecycle bubble — one test per path.
6. Discord and teams render the neutral scheduler kind set or a visible
   fallback line, and permission-prompt affordances round-trip on all four
   providers; no silently dropped affordance (snapshot per provider).

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-06: When run-scoped permission requests with the same full interaction scope coalesce, only the first caller receives the provider prompt delivery callback; all callers share the settlement decision.
- 2026-08-06: A process crash between shared durable permission-row creation and provider delivery can leave a setup fingerprint with an instruction card but no approval button until its blocker set changes; closing that shared-path gap requires canonical durable ownership or lease reissue and is deferred.
- 2026-08-07: No durable scheduler run-to-progress-card identity exists; stale-lease cleanup after process death sends the terminal timeout receipt but cannot safely replace the old running card in SCHED-4B-2.
