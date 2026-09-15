---
issue: JOBPERM-1
title: Chat-parity permissions for scheduled jobs
status: approved
saved: 2026-08-23T11:16:48+00:00
story: JOBPERM-1
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
---

# JOBPERM-1 — Chat-parity permissions for scheduled jobs

## Problem

The autonomous permission lane hard-returns "denied" without waiting
(permission-callback.ts:265-276, timeout 0), so any scheduled-run tool call
needing a host decision dies: compounds (fixed by #434), Browser (granted yet
unreachable), request_access (itself denied), any unlisted tool. Six days of
"Needs permission" dead-ends in two weeks; runs killed, accuracy lost, reruns
required. Full validated design: plans/review-briefs/
scheduled-job-permission-parity-design.md (v9 FROZEN, 7 adversarial Codex
xhigh rounds, 57 findings resolved). This plan implements v9 verbatim.

## Scope / Non-goals

IN: v9 sections A (ask-and-wait lane, need model, reconciler, card-revision
outbox, living card, lease/slot rules), B (browser prompt-naming fix only),
C (request_access + catalog + unprojected contract), D (truthful statuses),
the v9 Deletions (single-cut), one decision record. OUT: NOTIFY-3 result-card
rendering; JOBPERM-2 in-session reprojection; JOBPERM-3 toolbox-at-creation;
any interactive/chat behavior change; any classifier on autonomous runs
(0121); any weakening of the remote-content-execution boundary.

## Acceptance Criteria

1. Unmatched grantable tool call raises the standard card; authorized Allow
   resumes the SAME run in place; rule persists; next run silent-allows.
2. Browser works for a granted job with no card (host verdict awaited).
3. Living card coalesces needs; revision/epoch-bound batch; no unseen
   approvals; provider contract tests on Telegram, Slack, Discord.
4. Deny terminal per need with Reconsider epoch; handoff card keeps Deny +
   human Approve-and-run-again.
5. Hard-boundary and unprojected cases yield typed truthful results, never
   permanent grants or auto-reruns.
6. v9 Deletions land: old autonomous lane paths removed, source-asserted.

## Technical Approach

Implement v9 exactly; it is the authoritative contract. Core seams:
soften the hostJobId cancel (ipc-permission-classifier-decision.ts:184-210)
into the interactive tail (:447); delete the worker hard-returns
(permission-callback.ts:265-276, permission-ipc-client.ts:228-239) so the
existing poll loop serves both lanes; extend the 24h auth purpose to
jobId-bearing requests; durable need rows (reusing the pending-interaction
store) with asking_epoch, one reconciler, card-revision outbox; lease-deadline
extension from host-monotonic pending intervals; slot release/re-acquire
around waits; persistence via the setup-pause wiring with the fingerprint
short-circuit extended; actor authorization via 0118 machinery. Every stage
is implemented by Codex via forge delegate with the v9 doc as review contract.

## Decisions

New decision: "Autonomous runs ask-and-wait (chat parity)" — supersedes the
cancel consequence of 0121, amends 0115; records the two owner-accepted
physics limits and the single-cut deletions. Consistent with 0053, 0056,
0106, 0118, 0124, 0134.

## Surface Impact

Runtime behavior only: scheduled jobs stop dead-ending on permissions; one
living approval card per job in the job's channel; truthful agent-facing
results. No API/schema change beyond the need-row reuse of the
pending-interaction store; no interactive-chat change; net non-test LOC down
outside the need/outbox modules (Deletions).

## Task Decomposition

T1 lane-core: the single-cut (Deletions) + ask-and-wait for the simple case
(one need, confirmed delivery, approve/deny, resume, persistence, truthful
results, browser await). T2 durability: need states + reconciler +
card-revision outbox + epoch/actor binding + lease/slot rules + handoff +
coalescing/living card. T3 edges + live proof: hard-boundary equivalence
class, unprojected/catalog/request_access contract, provider contract tests,
agent-e2e + live KnackLabs scenarios.

## Risks

Provider card semantics drift (mitigated: contract tests x3 channels);
lease-extension accounting bugs (host-monotonic union, tested for skew/
restart/overlap); losing the single-cut (mitigated: source assertions that
deleted paths are gone); scope creep beyond v9 (mitigated: v9 is frozen; any
deviation returns to the owner).

## Verify Plan

python3 factory/scripts/verify.py green per stage; the v9 validation-plan
unit list mapped into required_tests per task; autoreview per stage with the
v9 doc as --prompt-file; live scenarios 1-3 on KnackLabs before pr_ready.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-23: JOBPERM-1-T2 reuses pending_interactions by storing one deterministic JSONB need row per job and canonical need identity plus one deterministic JSONB card/outbox row per job; no parallel permission-state table is introduced.
- 2026-08-24: Hard-boundary commands return a typed kind=reformulation_required code=remote_content_execution result to the model without creating a permission need, card, or terminal denial event.
