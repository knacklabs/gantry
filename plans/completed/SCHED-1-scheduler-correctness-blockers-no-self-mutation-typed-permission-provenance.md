---
issue: SCHED-1
title: Scheduler correctness blockers: no self-mutation, typed permission provenance
status: approved
saved: 2026-08-05T03:29:04+00:00
story: SCHED-1
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


# SCHED-1 — scheduler correctness blockers: typed permission provenance + no self-mutation

## Context

The lead-maintenance job kept pausing itself (assessment: `docs/architecture/scheduler-incident-assessment-2026-08-05.md`; decisions 0106/0107 accepted). Two root causes ship together here because each independently recreates the loop:

1. **Automatic allows read as human one-time consent.** `execution-diagnostics.ts:179-197` marks ANY successful `allow_once` with `decidedBy !== 'reviewed_rule'` as transient; `execution-finalization.ts:259-291` then pauses every recurring job with one such entry (`next_run: null`, setup-required). But five automatic policy paths emit `allow_once` (`auto_classifier`, `cached_classifier_verdict`, `trusted_root_grant`, `birthright`, `deterministic_read_only`) — invocation lifetime, not intent. `domain/permission-decision.ts:143-150` cements it by labeling every allow_once `user_temporary`.
2. **Scheduled runs edit their own control plane, auto-approved.** Scheduled runners mount all scheduler mutation tools; `gantry-tool-risk.ts` puts the five mutation verbs in medium (auto-approve), contradicting decision 0058; tests PIN that behavior. Nothing host-side can tell a scheduled caller from an interactive one — `jobId`/`runId` in scheduler IPC are runner-asserted and unverified.

Verification (recorded, file:line for every claim) found the change points are small and mostly existing seams:
- `decidedBy` is a free string by necessity (human path stuffs arbitrary `approverRef`) — so a separate typed field, not a union narrowing.
- `decisionForMode` (`domain/permission-decision.ts`) is the single choke point all emitters route through.
- The scheduled lane already exists end to end: `input.isScheduledJob` → `permissionLane: 'autonomous'` (`agent-spawn.ts:565`) → `GANTRY_PERMISSION_LANE` env → `runner/mcp/context.ts:68-70`; no new identity plumbing.
- TOOLS-1's `applyProviderAffinity` final-projection pattern is exactly the right seam shape for an unattended filter.
- The host already holds an unforgeable per-run binding: `permissionRunRestriction` map keyed `(sourceAgentFolder, responseKeyId)` (`permission-decision-coordinator.ts:264-299`), registered at spawn where `isScheduledJob`/`jobId`/`runId` are in scope, torn down on exit. The runner never supplies either key component.

## Approach — four blockers, one story

### B1. Typed permission provenance (decision 0107)

Extend the decision shape at the choke point: `decisionForMode` derives `source` (durable_rule | birthright | deterministic_policy | auto_classifier | cached_classifier | trusted_root | human_once | human_persistent) and `repeatableForFutureRuns` from its `decidedBy` argument via ONE map in `domain/permission-decision.ts`; `decisionClassification` becomes a function of `source` (the unconditional `user_temporary` fall-through dies). Unknown/human free-form `decidedBy` values map to `human_once` (conservative — the only pause-triggering source). Plumb through `PermissionApprovalDecision` (`domain/types.ts:312`), the gate emission (`runner/tool-permission-gate.ts:679` adds `source`/`repeatableForFutureRuns` beside `decided_by`), **and the signed field list** `PERMISSION_RESPONSE_FIELDS_AFTER_APPROVED` (`shared/ipc-signing.ts:11-18`) so the human-path value travels signed.

`execution-diagnostics.ts` predicate becomes: transient iff `phase === 'permission_allowed' && source === 'human_once' && !repeatableForFutureRuns` — with a fallback for legacy payloads lacking `source` (treat as before: non-reviewed_rule ⇒ transient) so in-flight runs during deploy don't silently un-pause.

### B2. Scheduler mutation tools off unattended surfaces (decision 0106)

`GantryMcpToolSelectionOptions` gains `permissionLane`; a final-projection filter in the `applyProviderAffinity` style drops the six mutation names (`scheduler_update_job/upsert_job/pause_job/resume_job/run_now/delete_job`) when the lane is `autonomous` — applied at all three host call sites AND in the runner-process `effectiveEnabledMcpToolNames` (thread `GANTRY_PERMISSION_LANE` in; fail-closed layer). Read tools stay. The scheduled prompt (`anthropic runner/index.ts:50-59`) drops the self-edit instruction and gains the control policy (inspect yes; mutate/pause/resume/delete/retrigger no; report `proposedJobChange` in the outcome).

### B3. Ask-gated scheduler mutations in auto mode (decision 0107)

`gantry-tool-risk.ts`: the five mutation verbs move medium → high (delete already high); reads stay low. Correct the pinning tests: `gantry-tool-risk.test.ts:68-83` (five scheduler entries move to the high `it.each`; memory/brain entries stay) and `permission-classifier.test.ts:788-809` (subject tool switches to a genuinely routine mutation, plus a new scheduler-asks case). Persistent reviewed grants keep working (0065 preserved).

### B4. Host-side rejection of scheduled-source mutations (decision 0106)

Trust root is host state, not runner claims: widen `PermissionRunRestriction` to `{ hideAuthorityTools, runKind: 'scheduled' | 'interactive', jobId?, runId? }`, populated from `input.isScheduledJob` at the existing registration (`agent-spawn.ts:259-260`). `ipc-scheduler-mutate-handlers.ts` looks up `(sourceAgentFolder, responseKeyId)` — `responseKeyId` comes from the host-minted `threadBinding`, never raw — and rejects every mutation whose entry is `scheduled` **or missing** (process-local map; absent = untrusted, deny mutations). Belt-and-braces: `writeIpcFile`'s signed `requestContext` (`runner/mcp/ipc.ts:71-78`) also stamps `sourceJobId`/`sourceRunKind` from env (add `GANTRY_RUN_ID` next to `GANTRY_JOB_ID` at `agent-spawn-helpers.ts:156` for `sourceRunId`), giving audit provenance on every IPC task.

## Decomposition (two bounded tasks)

- **SCHED-1-1 (B1 + B3)**: typed provenance end to end + risk reclassification + corrected tests. The regression backbone: recurring job stays active after each automatic source; pauses only on explicit human one-time consent.
- **SCHED-1-2 (B2 + B4)**: unattended tool-surface filter (both selection paths) + host-side mutation rejection + prompt control policy + signed source stamp.

## Files

- `apps/core/src/domain/permission-decision.ts`, `domain/types.ts` — source map + decision fields
- `apps/core/src/runner/tool-permission-gate.ts`, `shared/ipc-signing.ts`, `runner/permission-ipc-client.ts` — wire + signing
- `apps/core/src/jobs/execution-diagnostics.ts`, `jobs/execution-finalization.ts` — pause predicate
- `apps/core/src/application/permissions/gantry-tool-risk.ts` — risk table
- `apps/core/src/runner/gantry-mcp-tool-surface.ts`, `runner/mcp/tool-provider-affinity.ts` (sibling module for the lane filter), `runner/mcp/server.ts`, `runner/mcp/context.ts` — unattended surface
- `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`, `deepagents-langchain/runner/gantry-mcp-env.ts` — pass the lane
- `apps/core/src/runtime/permission-decision-coordinator.ts`, `runtime/agent-spawn-permission-run-restriction.ts`, `runtime/agent-spawn.ts`, `runtime/agent-spawn-helpers.ts` — run-restriction widening + env
- `apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts`, `runner/mcp/ipc.ts` — host rejection + stamp
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/index.ts` — scheduled prompt
- Tests: `gantry-tool-risk.test.ts`, `permission-classifier.test.ts` (corrected), `execution-diagnostics.test.ts` + `execution-finalization.test.ts` (per-source regressions), scheduler-surface + mutate-handler + IPC tests; both sandbox spawn suites get any new runner-reachable module.

## Verification

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs apps/core/test/unit/runtime apps/core/test/unit/runner apps/core/test/unit/application apps/core/test/unit/domain apps/core/test/unit/shared
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the fix reverted:
1. Recurring job remains active after runs containing allows from each automatic source (auto_classifier, cached_classifier_verdict, trusted_root_grant, birthright, deterministic_read_only, reviewed_rule); pauses on explicit human allow_once.
2. A scheduled spawn's tool surface (both selection paths) lacks all six mutation tools and keeps the read tools; interactive keeps both.
3. A forged mutation IPC from a scheduled run (and one with a missing run-restriction entry) is host-rejected; an interactive mutation asks in auto mode; reads stay unprompted.
4. Legacy `permission_allowed` payloads without `source` keep today's pause semantics (deploy-transition safety).
5. Human-path decisions carry `source` inside the signed field set (tamper test).

## Risks

- Free-form human `decidedBy` mapped conservatively to `human_once`: over-pausing stays possible for genuinely-human approvals — correct per the decision; automatic paths are the ones that must never pause.
- The run-restriction map is process-local; multi-process control planes would need a durable variant — out of scope, documented (single-runtime deployment today; missing-entry = deny mutations is the safe default either way).
- Risk-table flip changes live behavior for interactive scheduler edits (now ask in auto mode) — intended per 0058; reviewed persistent grants still short-circuit.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | pause predicate, unattended tool surface, mutation approval policy, host rejection |
| Data/schema | Unchanged by design | no migrations (definition_revision is SCHED-3) |
| API | Unchanged by design | none |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | none |
| Docs | Changed | decisions 0106/0107 recorded; prompt policy text |
| Tests | Changed | corrected pins + per-source regression backbone |

`user_facing: false` — unattended-execution correctness; no human-facing surface changes.
