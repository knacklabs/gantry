---
issue: CHAN-3
title: Job runner: split runActiveJob and runQuery by phase
status: approved
saved: 2026-08-28T05:40:48+00:00
story: CHAN-3
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
---
# CHAN-3 — Job runner: split runActiveJob and runQuery by phase

## Problem

The PR #444 cyclomatic review named three giants; CHAN-2 (#451) retired the Telegram callback. Two remain: `runActiveJob` in `apps/core/src/jobs/execution.ts:116` (AST CC 76, ~400 lines of an 848-line file) and `runQuery` in `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:102` (CC 81, ~600 lines of a 770-line file). Every incident fix of the last two weeks (lease/heartbeat, notifications, finish nudge, stream open/close, permission waits) landed inside one of them, each harder to review than it should be because the whole phase sequence lives in one body.

## Scope / Non-goals

In scope: the two functions, one sibling module each, architecture-map entries, no test edits (additions only). Strictly verbatim moves (owner ruling): call sites move; no dedup, no hoists, no signature changes to anything outside the two files. Non-goals: behaviour, the heartbeat/nudge/stream semantics themselves, other runner or jobs files, dedup follow-ups.

## Acceptance Criteria

- AC1: `runActiveJob` in jobs/execution.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, sequenced from a body whose own complexity is <= 15; no behaviour change.
- AC2: `runQuery` in runner/query-loop.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, driven from a loop body whose own complexity is <= 15; no behaviour change.
- AC3: No behaviour change: existing unit and Postgres integration tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
- AC4: Branch based on main after PR #451 (CHAN-2).

## Technical Approach

Same recipe as CHAN-2 T2. Complexity measured with the AST counter used there (branches + logical operators, baseline 1).

- `runActiveJob` (jobs/execution.ts:116–~520) → `apps/core/src/jobs/execution-phases.ts`. Build one `ActiveJobRunContext` (deps, job, runId, execution context, failover candidates, app session, lease context, event state, logger fields) once; phases as named functions taking the context: resolve execution context / dead-letter, model failover candidates, app session + setup pause, lease claim + heartbeat wiring, run bind + JOB_STARTED event, system job turn, agent invocation with failover + provider metadata updates, result/finalization handoff, cleanup (the existing `try/finally` shape stays in the sequencer so lease release ordering is untouched). Existing helpers (`resolveExecutionContextOrDeadLetter`, `claimSchedulerRunLease`, `runJobAgentWithFailover`, `execution-finalization.ts`, …) are called, not re-implemented.
- `runQuery` (runner/query-loop.ts:102–~700) → `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases.ts`. Build one `QueryLoopContext` (stream, agentInput, flags like enableIpcFollowups/isScheduledJob, nudge state, accumulators, steering gate, logger) once; phases: SDK options/sandbox setup (the two-axis model block and env wiring, verbatim), per-message handlers for `system` (init / api_retry / other), `assistant`, `stream_event` (text deltas), `result` (incl. the Q-0105/Q-0108 nudge and stream.end decisions verbatim), and close/end. The `for await` loop stays in `runQuery` as the dispatcher (type → handler).
- Architecture map: entries for both new modules (`scripts/architecture-map.json`) if `check:architecture` requires them; each new module <= 700 lines or split by the same rule.

## Decisions

No new decision record: internal structure only; 0040 (two-axis model) comments move with their code. Active decisions reviewed; none constrains this. Roadmap kind = feature so the refactor ratchet (net-growth veto) does not apply to a split.

## Surface Impact

None user-visible. Module layout: two new sibling files; the two giants shrink to sequencers.

## Task Decomposition

- CHAN-3-T1: `runActiveJob` split (jobs/execution.ts + jobs/execution-phases.ts + architecture map). Contract: AC1, AC3, AC4.
- CHAN-3-T2: `runQuery` split (runner/query-loop.ts + runner/query-loop-phases.ts + architecture map). Contract: AC2, AC3.

## Risks

- Moved phases that read variables computed earlier must receive them through the context; a miss surfaces as a tsc error or a failing existing test (both gating).
- `try/finally` ordering around lease release/heartbeat stop must stay in the sequencer, not inside a phase.
- The `result` branch carries incident fixes (nudge, stream.end) — verbatim move; the runner suites (`apps/core/test/unit/runner/*`) are the oracle.

## Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/ apps/core/test/unit/runner/` unchanged and green (git diff --stat -- apps/core/test empty); full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; Postgres lane `GANTRY_TEST_DATABASE_URL=… npm run test:integration:postgres`; CC report (scratchpad/cc.mjs) over the four files: sequencers <= 15, every phase <= 25; `python3 factory/scripts/verify.py`.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-28: AC1/AC2 'ONE sibling module' is read as one module per phase group whenever a single module would exceed the 700-line architecture budget after prettier (owner ruling 2026-08-28; T1 = execution-phases-setup/-run, T2 = query-loop-phases-setup/-messages).
