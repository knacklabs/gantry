---
issue: AUTODET-1
title: Autonomous runs decide permissions deterministically — no classifier
status: approved
saved: 2026-08-11T11:44:50+00:00
story: AUTODET-1
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
---

# AUTODET-1 — Autonomous runs decide permissions deterministically (no classifier)

## Problem

On a scheduled (jobId-bearing) run, a tool call that the worker's local matcher
misses goes to the host, which evaluates: hard denies → host-reviewed rules →
deterministic rails → **classifier** (whenever auto mode is on,
`ipc-permission-classifier-decision.ts:239`). The classifier's "allow" rescues
the call (`decidedBy: auto_classifier` — 45 RunCommands survived on luck); its
"ask" is unanswerable on an autonomous run, so the runtime cancels → terminal
denial (0115) → paused job + card. Same call, different day, different outcome:
the KnackLabs job's `send_message` was cancelled at 08:53 and allowed at 10:01.
Production survey: RunCommand 45 classifier-allows / 15 cancels; send_message
1/1. Spec (confirmed): docs/specs/autonomous-deterministic-permissions.md.

Codex exploration (read-only, gpt-5.6-terra@high) established:
- The worker deliberately excludes the job's `allowedTools` from its local
  autonomous matcher (anti-self-authorization, tool-permission-gate.ts:108) and
  defers to the host; the HOST is the durable authority and already matches
  reviewed rules when `jobId` exists (ipc-permission-classifier-decision.ts:121,
  :154). Granted-implies-matched already holds AT THE HOST.
- The "reviewed_rule allow carrying a no-match reason" is an attribution split:
  the worker's local-miss text rides the IPC request (tool-permission-gate.ts:484)
  while the host's allow is correctly labeled — display bug, not an authz bug.
- `send_message` has NO destination parameter (schemas.ts:75); the registry
  injects the run's own conversation/thread (registry.ts:212). Own-conversation
  is the only possible destination — the spec's "other destinations need a
  declared grant" clause is vacuous today and stays a future public-contract
  decision.

## Scope / Non-goals

In scope: remove the classifier from the autonomous (jobId) decision path at
the host IPC tail; a host reviewed-rule miss becomes the existing deterministic
terminal denial (SCHED-6/CAPRULE-1 pause + one grantable card); provenance and
reason strings become truthful; tests across both runner lanes.

Non-goals: interactive-run classification (unchanged); a destination-bearing
send_message contract (no destination argument exists — separate future
decision); changes to worker-local matcher scope (the anti-self-authorization
design stays); rule-shape/syntax changes; new grant UI (the existing card flow
is the recovery path); revisiting 0115.

## Acceptance Criteria

1. No autonomous-run permission decision is made by the classifier:
   `decidedBy=auto_classifier` never appears for a `jobId`-bearing request
   after cutover (unit-asserted; log/event greppable).
2. Granted implies matched at the decision authority: a tool in the job's
   effective allowed tools is host-authorized deterministically (existing host
   reviewed-rule path, now the sole tail) — pinned by a test using
   `mcp__gantry__send_message`.
3. Ungranted tool on an autonomous run: deterministic terminal denial routed to
   the existing pause + one grantable card, with a truthful reason naming the
   missing grant (no classifier prose).
4. Fix-and-continue proven end to end: granting from the pause card resumes the
   job; the re-run is authorized by the reviewed rule and completes without
   re-asking (integration test at the job-lifecycle level).
5. Both runner lanes covered: anthropic_sdk gate and DeepAgents facade/shell
   wrappers observe identical outcomes for the same declared grants.
6. Decision record: new decision (autodet-no-classifier-on-autonomous-runs)
   accepted, amending the auto-mode contract; spec AC about send_message
   destinations recorded as satisfied-by-construction (own-conversation only).

## Technical Approach

**Core change (one seam).** In
`apps/core/src/runtime/ipc-permission-classifier-decision.ts` the tail that
consults `consultPermissionClassifierBeforePrompt` (:239) gains a guard: when
the request carries `jobId` (autonomous), skip the classifier entirely and
return the existing no-approval cancellation (the same shape the runtime
produces today when an unattended ask is cancelled), with reason
"Autonomous runs decide deterministically: <tool> has no declared grant"
and provenance `decidedBy: deterministic_rails` (typed provenance, 0107).
The host-reviewed evaluation before the tail (:121-:154) is untouched — it
remains the durable authority that makes granted-implies-matched true.

**Reason truthfulness (small).** The worker's local-miss `decisionReason`
(tool-permission-gate.ts:484) must not masquerade as the host's rationale on
allows: keep the worker text as diagnostic context but let the host's actual
match reason ("Allowed by <rule>") be the recorded decisionReason. This kills
the confusing "allowed + no-match-reason" pairing.

**Downstream (no change).** Terminal denial → `execution-finalization.ts:174`
pause + deduped card; `autonomous-tool-denial.ts` recovery_action request_access
— all existing SCHED-6/CAPRULE-1 machinery, reused as-is. Both lanes already
convert host denials to terminal run denials (anthropic gate :538; DeepAgents
facade-tools :117 / shell-tool :176 / onPermissionDenied).

## Decisions

New decision `0121-autodet-no-classifier-autonomous` (number pending
origin/main collision check at push): autonomous permission decisions are a
pure function of declared grants; the classifier is interactive-only; rejected
alternative "classifier as allow-only rescue" (Ravi rejected in chat
2026-08-11) pinned in the record. Reconciled with 0043 (classifier stays
risk-only where it runs; this narrows where it runs) and 0107 (the new denial
carries typed provenance `deterministic_rails`). Grill-locked semantics
confirmed by Ravi in chat 2026-08-11: remove entirely (not allow-only), spec
confirmed, fix-and-continue is an AC. send_message destinations: recorded as
satisfied-by-construction (own-conversation only — no destination argument
exists); a destination-bearing contract is a named future decision.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | scheduled misses deny deterministically instead of classifier coin-flip |
| Data/schema | Unchanged | no migration |
| API/CLI | Unchanged | none |
| UI | Unchanged | same pause card, truthful reason text |
| Docs | Changed | new decision; spec cross-reference |
| Tests | Changed | coordinator/classifier-decision units + both-lane units + job-lifecycle integration |

## Task Decomposition

1. **AUTODET-1-1** — host tail guard: skip classifier for jobId requests →
   deterministic terminal denial with truthful reason + typed provenance;
   reason-attribution fix; unit tests
   (ipc-permission-classifier-decision.test.ts:326,
   permission-decision-coordinator.test.ts:150,
   tool-execution-policy-service.test.ts:151, tool-permission-gate.test.ts:810,
   deepagents-gantry-facade-tools.test.ts:286,
   deepagents-gantry-shell-tool.test.ts:187,
   deepagents-terminal-denial-turn.test.ts:57).
2. **AUTODET-1-2** — fix-and-continue integration proof: grant-from-card →
   resume → reviewed-rule authorization → completion
   (job-lifecycle.postgres.integration.test.ts:567,
   execution-finalization.test.ts:96, execution-diagnostics.test.ts:59);
   decision record + docs.

## Risks

- New denials where the classifier used to luckily allow (~45 RunCommand
  variants): each becomes at most one grantable card, then determinism. This is
  the accepted trade (Ravi, chat, 2026-08-11 — "Remove entirely").
- The guard must key on the run's autonomy (jobId in the signed request), not
  worker-supplied fields a compromised worker could omit — use the same
  host-verified run-registry context CAPRULE-1 stamped (host authority trap).
- Interactive runs must be provably untouched: the guard's predicate is
  jobId-presence only; coordinator ordering unchanged.
- decisionMode/provenance consumers (cards, events, admin surfaces) must accept
  `deterministic_rails` cancellations for this path — check the pause-card copy
  renders the truthful reason, not raw matcher prose.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime apps/core/test/unit/runner apps/core/test/unit/adapters apps/core/test/unit/jobs apps/core/test/unit/shared apps/core/test/unit/application
python3 factory/scripts/verify.py
```
Live smoke after merge: trigger the KnackLabs job → completes with zero
classifier decisions (`grep auto_classifier` on the run's events is empty);
temporarily revoke a granted tool → one pause card → grant from card → job
resumes and completes.
