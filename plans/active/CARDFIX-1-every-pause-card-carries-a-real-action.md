---
issue: CARDFIX-1
title: Every pause card carries a real action
status: approved
saved: 2026-08-31T11:01:48+00:00
story: CARDFIX-1
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
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0121-autodet-no-classifier-autonomous
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
  - 0133-gantry-tool-correlation-response-meta
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
---

# CARDFIX-1 — Every pause card carries a real action

## Problem

A job paused by a tool denial or incomplete setup tells its owner "Setup needed" and offers nothing to press. Live evidence (2026-08-31, job `card-check-2`): a piped `RunCommand` was correctly refused per-leaf authorization (0134), the run paused, and the owner got a plain-text story with an empty action surface on Slack — `formatSchedulerSetupStory` (`apps/core/src/application/jobs/scheduler-setup-story.ts`) returns text only, and no `actionAffordances` are attached at any of its delivery call sites. Worse, the "Pause job" button that other scheduler notices render is guidance-only on every provider: `MessageActionCallbackInput` has no `scheduler_pause_job` variant, so each provider replies "use the scheduler" instead of pausing (`domain/message-actions.ts:62`; Telegram `callback-handlers.ts:725`, Slack `channel-message-action-handler.ts:305`, Discord `interactions.ts:337`, Teams `message-actions.ts:407`).

## Scope / Non-goals

- Attach `actionAffordances` at the neutral layer wherever a pause/setup story is delivered through the notification route: `notifyJobSetupRequired` → `sendJobNotification` already forwards `MessageSendOptions.actionAffordances` (`jobs/execution-notifications.ts:269`, `jobs/delivery.ts:152`). Call sites: preflight (`execution-phases-setup.ts:276`), final setup (`execution-phases-run.ts:220`), permission denied/timeout (`execution-finalization.ts:192`), partial recovery (`request-access-job-recovery.ts:68`).
- Action set: compound-command denial ⇒ **Allow once for this run** (retry-and-ask, ruled) + **Pause job**; other blockers ⇒ their existing grantable setup action plus **Pause job**; every delivered pause story carries ≥1 action.
- **Retry-and-ask** (owner-ruled mechanism): a new neutral affordance kind `scheduler_retry_ask` that triggers exactly one fresh re-run of the job with interactive asking for that run (the compound then arrives as the normal ask-and-wait card; the human's Allow applies as the existing JOBPERM-2 once-grant; nothing persisted). Fresh retry per 0115; no compound grant per 0134; ask lane per 0144. One-shot idempotency mirrors the setup-card hash pattern (`setup-pause-permission-wiring.ts:230`).
- **Pause job made real**: add the `scheduler_pause_job` variant to `MessageActionCallbackInput`, route it through `channel-message-action-router.ts`, and implement the handler next to `scheduler_run_now` (`runtime-live-stop-message-action.ts:199`) with the same same-channel approver authorization; the four providers' guidance replies become real dispatches by consuming the neutral callback (their renderers already emit the button).
- Tests: neutral invariant test that every `formatSchedulerSetupStory` delivery carries ≥1 affordance; router/handler unit tests per action; the existing per-provider affordance render tests extend to the new kind (Telegram `telegram.test.ts:3413`, Slack `slack.test.ts:4819`, Discord `discord.test.ts:470`, Teams `teams.test.ts:1744`, parity `provider-affordance-parity.test.ts:31`).

**Non-goals**: the durable setup approval card's own decision options (`setup-pause-permission-prompt.ts` — it stays as is; its `decisionReason` story is not a notification delivery); `transient_permission` (delivered nowhere today — unchanged); reworking 0134/0144 policy; a pre-authorized once mechanism (rejected in grill); the six GRACE-1 findings; provider-specific handlers of any kind (owner directive: neutral only).

## Acceptance Criteria

- AC1: every `formatSchedulerSetupStory` delivery reaches the channel with at least one working action affordance, on all four providers, via the neutral affordance path; no pause/setup message is ever sent action-less.
- AC2: the compound-command denial card offers exactly Allow-once-for-this-run (retry-and-ask) and Pause job, and never a durable-grant button (0134 holds); the retry runs the job once in ask mode and is idempotent per pause story.
- AC3: tapping each offered action performs its effect through the neutral router — retry-and-ask starts one fresh run, Pause job pauses the job (same-channel approver authorized) — unit-tested per action; provider render covered by the existing per-provider affordance tests.
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Technical Approach

Copy SCHED-4B's shape end to end: build affordances where the story is built (neutral), deliver via the existing options field, route via the one router, act in the one runtime handler. New affordance kind `scheduler_retry_ask` (carries jobId + a one-shot key derived from the pause story's setup fingerprint); `scheduler_pause_job` gains its callback variant and handler. The ask-mode one-shot rerun reuses the existing trigger path with a per-run permission-mode override — the exploration's option 1 lane (ask-and-wait need, `job-permission-durability-wiring.ts:215`) without any new durable grant storage. Implementer is Codex `gpt-5.6-sol` @ `xhigh` (owner-specified), one bounded task.

## Decisions

0115 (fresh retry, no silent substitution) — honoured: retry-and-ask starts a new run. 0134 (pipe = hard boundary) — honoured: no compound grant, ever. 0144 (ask-and-wait lane) — honoured: the rerun asks via the standard card. 0121 (no classifier on autonomous) — untouched: the override makes the run interactive, not classified. 0127 (tagged setup action model) — the new kinds join the tagged model. No new decision required; if the implementer finds the per-run ask override needs a durable contract, raise a signal rather than inventing one.

## Surface Impact

Runtime behaviour (pause stories gain buttons; Pause button becomes real on all providers), neutral domain types (`message-actions.ts` union + callback variant), scheduler notification wiring, runtime message-action handler, four provider callback consumers lose their guidance-only stubs. No settings, storage schema, contracts/SDK, or migration changes expected.

## Task Decomposition

- CARDFIX-1-T1: affordances on pause stories + retry-and-ask + real Pause job + tests. Contract: AC1–AC4.

## Risks

- Double delivery: the durable setup card and the notification route coexist; the approver-route exclusion (`execution-readiness.ts:216`) must keep holding so buttons don't appear twice.
- Idempotency: a tapped retry must not stack runs — one-shot key per pause story (setup fingerprint hash pattern).
- Per-run ask override: must not leak into subsequent scheduled runs (exactly one run).
- Review budget: neutral types + wiring + handler + 4 provider consumers + tests ≈ 14–18 files.

## Verify Plan

`npx tsc --noEmit`; `npm run check:architecture`; `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels/ apps/core/test/unit/application/ apps/core/test/unit/jobs/ apps/core/test/unit/domain/`; Postgres lane host-side (permission-decision-chain + job-lifecycle suites); autoreview local with a brief pinning AC1's never-action-less invariant and the 0134/0115 constraints; live check after deploy: re-trigger `card check 2`, the pause card must show Allow once + Pause job on Slack, tapping Allow once must produce the ask card, and Pause must pause the job.
