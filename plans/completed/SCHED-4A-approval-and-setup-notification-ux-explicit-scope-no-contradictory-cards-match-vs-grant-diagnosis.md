---
issue: SCHED-4A
title: Approval and setup-notification UX: explicit scope, no contradictory cards, match-vs-grant diagnosis
status: approved
saved: 2026-08-05T09:07:11+00:00
story: SCHED-4A
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


# SCHED-4A — approval & setup-notification UX: explicit scope, no contradictory cards, match-vs-grant diagnosis

## Context

Ravi's six-point UX critique (assessment addendum, `docs/architecture/scheduler-incident-assessment-2026-08-05.md`) — this story ships the priority slice (items 2/4/5/3): approvals must say whether they're one-time or durable and confirm "will ask again next run"; a run that recovers must never emit a green Completed card and an orange Setup-needed card as contradicting peers; "granted but the command shape didn't match" must read differently from "not granted" (with the approved-pattern vs attempted-command diff — the `gog sheets get … | head -50` misdiagnosis); and a job asking for the same tool repeatedly must escalate its copy with the ask count.

Discovery (file:line evidence recorded) found every hard part already exists — this is a rendering/copy story:

- **Item 2**: the option set is provider-neutral in ONE file (`channels/permission-decision-options.ts:21` — the locked Allow once / Allow for future / Deny set; request options win) and every provider renders from it. The post-approval receipt is `channels/permission-interaction.ts:146` `formatPermissionReceiptText()`, allow-once fallthrough at `:171-173` — used by all six providers. It already receives the full decision but branches on `mode`, ignoring SCHED-1's `repeatableForFutureRuns`. "Read-only defaults durable" is already satisfied upstream: the deterministic read-only gate auto-allows before any human prompt exists.
- **Item 4**: setup card built in `jobs/execution-notifications.ts:92-115`, completion card in `jobs/status-formatting.ts` (heuristic `'Completed with issues'` at `:101`); both fire from the same scope in `jobs/execution.ts` (finalize at `:636` → terminal notify at `:748`). `notifyJobSetupRequired` returns a "notified" boolean that is DROPPED at all three finalization call sites — threading it (or reusing `pauseReason === SETUP_REQUIRED_PAUSE_REASON`) is the whole hook. A suppression precedent already exists at `execution-notifications.ts:134-140`.
- **Item 5**: the matcher already computes `closestRule` (nearest approved pattern + normalized attempted command, `shared/tool-rule-matcher.ts:66-76`, `:423-431`) and it is plumbed all the way to `PermissionApprovalRequest` (`domain/types.ts:208`) — rendered by exactly ZERO channels. Adding "Approved: X / Attempted: Y" to `formatPermissionContextLines()` (`channels/permission-interaction.ts:342`) reaches every provider for free. Commands MUST pass `sanitizePermissionCommandText`; patterns pass `sanitizePermissionText` (`channels/permission-text-sanitizer.ts`).
- **Item 3**: `permission_promotion_counters` already tracks per-(agent, tool-shape) human allow-once counts with `createdAt`/`updatedAt`, is read at prompt-build time, and even renders a promotion hint today (`permission-interaction.ts:356-359`). "In D days" is one field propagation (`firstAskedAt` beside `promotionHintCount`); the copy changes to the escalation form. Deliberately per agent+tool-shape (not per job) — the existing key; per-job would be a schema change the addendum doesn't require.

## Approach — one bounded task

1. **Receipt copy keyed on provenance** (`channels/permission-interaction.ts:163-173`): when `decision.repeatableForFutureRuns === false` (fall back to `mode === 'allow_once'` for legacy decisions), the receipt reads "Approved for this run only." plus, on the `request.jobId` branch (context lines already distinguish scheduled-job vs chat at `:342-347`), "It will ask again next run." The durable branch keeps its "Saved for <agent>. Manage access to revoke it later." No option-set changes — the locked set stands (no-timed-grant decision honored).

2. **Fold/suppress the contradictory cards**: `finalizeSchedulerJobRun` returns `setupNotified` (the dropped boolean); `notifySchedulerTerminalRunState` receives it plus the run diagnostics. When the run COMPLETED after a blocked-but-degraded step: fold — `statusLabel()` gains "Completed with limits" and a `⚠️ Degraded: <blocker summary>` line (from `transientPermissionApprovals`/`toolDenial` already in `JobRunDiagnostics`), and the standalone setup card for that fingerprint is suppressed (extend the precedent at `execution-notifications.ts:134-140`). When the run genuinely died on the blocker, the setup card remains the single card (terminal suppressed, as today).

3. **Match-vs-grant diagnosis**: `formatPermissionContextLines()` renders, when `request.closestRule` exists: `Approved pattern: <sanitizePermissionText(rule)>` / `Attempted: <sanitizePermissionCommandText(command)>` — reaching prompts and receipts across providers. The denial message path (`shared/permission-decision-message.ts`) distinguishes wording: "no matching approved pattern" (closestRule present) vs "not granted" (no rules for the tool). Honest caveat kept as a code comment: with multiple RunCommand rules the "nearest" is currently first-parsed, not similarity-ranked (ponytail ceiling; similarity ranking is follow-up if it ever misleads).

4. **Repeat escalation**: propagate `firstAskedAt` beside `promotionHintCount` (`runtime/permission-classifier.ts:436` → `ipc-permission-classifier-decision.ts:402` → `domain/types.ts:227`); the hint line becomes "Asked N times in D days, each approved once only. Approve permanently?" (N ≥ threshold, D from `createdAt`). The existing threshold (2) and human-allow-once-only increment semantics stand.

## Files

- `apps/core/src/channels/permission-interaction.ts` — receipt copy, context lines (approved/attempted), escalation line
- `apps/core/src/shared/permission-decision-message.ts` — not-granted vs unmatched wording
- `apps/core/src/jobs/execution-finalization.ts`, `jobs/execution.ts`, `jobs/execution-notifications.ts`, `jobs/status-formatting.ts` — setupNotified threading, fold/suppress, "Completed with limits" + degraded line
- `apps/core/src/runtime/permission-classifier.ts`, `runtime/ipc-permission-classifier-decision.ts`, `apps/core/src/domain/types.ts` — firstAskedAt propagation
- Tests: `channels/permission-interaction.test.ts` (receipt variants incl. legacy-mode fallback, approved/attempted rendering incl. sanitizer block, escalation copy), `jobs/status-formatting.test.ts` + `execution-notifications`/`finalization` tests (fold vs suppress vs died-on-blocker matrix), classifier propagation test.

## Verification

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels apps/core/test/unit/jobs apps/core/test/unit/runtime apps/core/test/unit/shared
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the fix reverted:
1. Allow-once receipt says "Approved for this run only" (+ "It will ask again next run" only with a jobId); durable receipt unchanged; legacy decisions without provenance fields keep working.
2. A completed run with a degraded step produces ONE card: "Completed with limits" + degraded line, and no standalone setup card for the same fingerprint; a run that died on the blocker produces the setup card only.
3. A RunCommand miss with rules present renders the approved pattern and the sanitized attempted command; a tool with no rules renders "not granted" wording; a secret-bearing attempted command renders the sanitizer's replacement, never the raw text.
4. The escalation line appears with count and day-span at the threshold, replacing the old hint.

## Risks

- Copy changes ripple into notification-formatting snapshot tests across providers — expected churn, kept mobile-first per the notification-UX conventions.
- Suppressing the setup card on recovered runs must not lose the blocker record: the readiness event/fingerprint persistence is untouched; only the outbound card is folded.
- Per-agent (not per-job) escalation keying is deliberate; noted in code.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | notification copy/folding, receipt copy, prompt context lines |
| Data/schema | Unchanged by design | no migrations (counters already store timestamps) |
| API | Unchanged by design | none |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | provider chat surfaces only |
| Docs | Changed | addendum is the spec |
| Tests | Changed | receipt/card/diagnosis/escalation matrices |

`user_facing: false` in the factory sense (no control-plane/UI surface), though the OUTPUT is user-visible chat copy — functional check: the test matrices above pin the exact copy.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-05: The repeat-escalation day span is the inclusive elapsed span: at least 1 day, otherwise ceil((now - firstAskedAt) / 24 hours).
