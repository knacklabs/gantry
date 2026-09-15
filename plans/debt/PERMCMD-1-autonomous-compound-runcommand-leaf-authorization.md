---
issue: PERMCMD-1
title: Autonomous compound RunCommand leaf authorization
status: approved
saved: 2026-08-23T03:26:23+00:00
story: PERMCMD-1
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

# PERMCMD-1 — Autonomous compound RunCommand leaf authorization

## Problem

An autonomous run that issues a control-flow compound (`&&`/`||`/`;`) is cancelled
by the deterministic permission rails even when every leaf is already covered by a
granted `RunCommand` rule, because the compound is treated as one unmatched
command. The job dead-ends; the "Setup needed" card shows no Approve button (its
grant builder only handles single commands); and the pause emits two
notifications. Live repro: `date +"%u %H %M %Z" && date +"%Y-%m-%d %H:%M %Z"` on a
job holding `RunCommand(date +*)` was cancelled (`deterministic_rails`,
"no declared grant").

## Scope / Non-goals

Delivery-layer permission + notification only. In scope: routing `RunCommand`
through the existing generic per-leaf Bash matcher, blocking pipes, wiring the
compound grant into the setup card, and deduping the pause notification. Out of
scope: the pipe boundary (unchanged), single-command matching (unchanged), the
scheduled-job prompt itself, any new config surface.

## Acceptance Criteria

1. A control-flow compound whose every leaf matches a granted `RunCommand` rule
   resolves allowed at the classifier-decision seam (no prompt), proven with the
   live repro; unit-tested.
2. Generic for any CLI: a non-`date` cross-cli compound (`git status && npm ci`
   under `RunCommand(git *)` + `RunCommand(npm *)`) is allowed, and an
   ungranted-leaf compound still pauses; unit-tested.
3. A piped compound is never authorised from per-leaf rules; unit-tested.
4. A grantable compound needing approval yields a setup card carrying every
   per-leaf `RunCommand` rule (working Approve button); unit-tested.
5. A setup-required pause emits one notification, not both cards; unit-tested.

## Technical Approach

- **Part A** — `tool-rule-matcher.ts`: in `evaluateAutonomousToolUse`, route
  `RunCommand` (not only `Bash`) into `evaluateBashToolUse`, which already matches
  every parsed leaf against the scoped rules; add an explicit pipe block before
  matching. Reuses the existing generic per-leaf logic — no command-name coupling.
- **Part B** — `tool-execution-policy-service.ts` + `autonomous-bash-recovery-rule.ts`:
  when the single-leaf grant recovery is undefined, fall back to
  `autonomousCompoundBashRecovery` and emit an `addRules` action containing every
  per-leaf `RunCommand` rule, so the setup card's Approve button works.
- **Part C** — `execution-readiness.ts`: in `notifyJobSetupRequired`, treat a
  raised / already-pending approval prompt as terminal so the pause notifies once.

## Decisions

New decision **0134 — autonomous control-flow compounds require per-leaf
RunCommand grants**: allow a control-flow compound only with no pipe and every
leaf independently matching a granted rule; no compound-wide authority; the pipe
stays a hard boundary. Consistent with 0121 (autonomous deterministic) and 0115
(autonomous denial terminal).

## Surface Impact

Runtime behaviour: scheduled jobs stop dead-ending on benign compounds; ungrantable
compounds get a working Approve button and one notification. No API/schema/config
change. No interactive-run behaviour change.

## Task Decomposition

Single bounded task: implement Parts A+B+C, record the decision, and the five unit
tests. The change is cohesive (one permission-rails + notification behaviour) and
was validated as one bundle.

## Risks

- Weakening the pipe boundary — mitigated: pipe is explicitly blocked and tested.
- Over-granting via compound — mitigated: every leaf must independently match an
  existing rule; no new authority.
- Notification dedup regressing other pause paths — mitigated: the terminal flag
  only applies to raised/already-pending prompts; existing fallbacks preserved.

## Verify Plan

`python3 factory/scripts/verify.py` plus the five focused unit tests across
tool-rule-matcher, tool-execution-policy-service, ipc-permission-classifier-decision,
and setup-pause-prompt. Autoreview (branch) must be clean.
