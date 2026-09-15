---
issue: AUDIT-2
title: Security and architecture audit paydown
status: approved
saved: 2026-08-10T19:44:27+00:00
story: AUDIT-2
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
---

# AUDIT-2 — Security and architecture audit paydown

## Problem

An external audit (2026-08, snapshot `bb340b0ae`, full text in
`docs/architecture/audits/audit-2026-08-bb340b0ae.md`) reported 5 High, 6 Medium, 1 Low, and
five simplifications. The findings are 28 commits stale and this week merged PRs #400/#403/#404/
#401/#405/#406; several may already be fixed (the Low arch-gate finding already is —
`check:architecture` passes on current main). Acting on stale findings risks wasted or
duplicate work, so the story front-loads a read-only verification pass, then fixes small
confirmed blockers and splits architecture-decision blockers into their own planned stories.

## Scope / Non-goals

In scope: a read-only Codex verification of every audited item against current main; a triage
that fixes small self-contained blockers in-story and records the rest as their own stories or
as closed (rejected/already-fixed).

Non-goals: the architecture-decision blockers themselves (cluster rate authority superseding
0099, browser-profile lifecycle/streaming, scheduler-authority split, canonical restamp) — each
gets its own planned story with its own decision record; no code for those lands here.

## Acceptance Criteria

1. Every audited High, Medium, and simplification has a current verdict — confirmed-current,
   changed, or already-fixed — with current file:line evidence, recorded in the audit doc.
2. Confirmed small self-contained blockers are fixed in-story with tests; confirmed
   architecture-decision blockers are captured as their own roadmap stories.
3. Rejected and already-fixed items are recorded closed with rationale.

## Technical Approach

Task 1 is a read-only verification run: `./forge delegate --read-only AUDIT-2-1` hands the
audit doc to Codex (gpt-5.6-terra, high) which walks each finding against current main and
returns per-item verdicts with file:line. The orchestrator records the verdicts back into the
audit doc and re-decomposes: confirmed small fixes become later tasks in this story; confirmed
architecture blockers become new roadmap stories; rejected/fixed items are annotated closed.

## Decisions

None new in this story. The verification may supersede audit assumptions but records no
decision; architecture-decision blockers carry their decisions in their own stories.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Unchanged | verification pass; any fixes are scoped per confirmed finding |
| Data/schema | Unchanged | none in this story |
| API/CLI | Unchanged | none |
| UI | Unchanged | none |
| Docs | Changed | audit doc gains per-item verdicts; new stories recorded |
| Tests | Changed | only if a small blocker is fixed in-story |

## Task Decomposition

1. **AUDIT-2-1 (read-only, Codex via `forge delegate --read-only`)** — verify every audited
   item against current main; return per-item verdict (confirmed-current / changed /
   already-fixed) with current file:line. No code.

(Later tasks are re-decomposed from AUDIT-2-1's verdicts: small confirmed blockers become
bounded fix tasks here; architecture blockers become their own stories.)

## Risks

- Stale findings: mitigated by making verification the first, gating task.
- Scope creep: architecture-decision blockers are explicitly split out, not fixed here.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
python3 factory/scripts/verify.py
```
The verification task itself is read-only and produces verdicts, not code; verify runs against
any in-story fix tasks that follow.
