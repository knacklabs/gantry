---
issue: SETUPRACE-1
title: Atomic claim for setup-pause notifications (close D-0053)
status: approved
saved: 2026-08-09T09:43:44+00:00
story: SETUPRACE-1
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
---
# SETUPRACE-1 — Recoverable atomic claim for setup-pause notifications

## Problem

The setup-pause notifier dedups on `setup_state.notified_fingerprint` with a non-atomic check-then-send-then-mark. Two concurrent `scheduler_upsert_job` calls for the SAME job (no per-job upsert serialization) can both observe an un-notified fingerprint and both deliver an actionable setup card — violating the "exactly one card per blocker" contract. (The scheduler-run notifier cannot race here because a blocked job is created paused with next_run=null; the remaining race is concurrent creation/update.) A naive claim-before-send fixes the double-send but, if the process crashes between the claim and delivery, permanently suppresses the card (orphaned claim) — worse than a duplicate. So the claim must be RECOVERABLE.

## Scope / Non-goals

In scope: make the shared setup-pause notifier race-safe with a RECOVERABLE atomic claim (self-healing on crash) + resolve the detached creation-notify's session from the reloaded job. Non-goals: no change to card/event content; no change to PREFLIGHT-1 wiring; PERM-2 unchanged.

## Acceptance Criteria

1. `markJobSetupNotified` is an atomic CAS that WINS the claim when the stored `notified_fingerprint` differs from the target OR an existing claim is STALE (its `notify_claim_at` is older than a TTL). It stamps `notify_claim_at = now` on a win.
2. On successful delivery, the winner CONFIRMS the claim (`notify_claim_at = null`), making it permanent (never reclaimable). On delivery failure, the winner CLEARS the claim (`notified_fingerprint = null`), making it immediately retryable.
3. A claim abandoned by a crash (pending `notify_claim_at`, never confirmed) is reclaimable after the TTL by the next notifier — no permanent suppression.
4. `notifyJobSetupRequired` claims BEFORE sending; a caller that loses the claim delivers nothing (no card, no event). Concurrent creation+creation (and creation+run) for one fingerprint deliver exactly one card and one event.
5. The detached `notifyCreatedJobSetupRequired` routes using the RELOADED job's session (resolve from `currentJob.session_id`; do not trust a captured session whose id no longer matches).
6. Silent / suppressed / already-confirmed jobs behave as before. Full verify.py green; whole-branch autoreview reports no actionable findings.

## Technical Approach

- **State:** add `notify_claim_at` (ISO timestamp | null) to `setup_state` (JSONB — no migration). `notified_fingerprint` stays the claim/delivered marker; `notify_claim_at != null` ⇒ a PENDING (unconfirmed) claim; `null` ⇒ CONFIRMED (or unclaimed).
- **CAS claim** (`canonical-job-coordination.postgres.ts markJobSetupNotified`): `SET notified_fingerprint=fp, notify_claim_at=now WHERE fingerprint=fp AND (notified_fingerprint IS DISTINCT FROM fp OR (notify_claim_at IS NOT NULL AND notify_claim_at < now()-<TTL>))`; return rows>0.
- **Confirm** — new `confirmJobSetupNotified(id,fp)`: `SET notify_claim_at=null WHERE fingerprint=fp AND notified_fingerprint=fp`.
- **Clear** — new `clearJobSetupNotified(id,fp)`: `SET notified_fingerprint=null, notify_claim_at=null WHERE fingerprint=fp AND notified_fingerprint=fp`.
- Thread confirm + clear through the domain port (`ops-repo.ts`) and impls (`repositories/canonical-job-repository.postgres.ts`, `schema/canonical-ops-repo.postgres.ts`, `services/canonical-job-ops-service.ts`). Ensure resume/refresh do not clobber a live claim (reuse the existing coordinationColumnUpdate CASE, extended for notify_claim_at).
- **Reorder** (`jobs/execution-readiness.ts notifyJobSetupRequired`): eligible pre-gate (not suppressed/silent/already-notified) → CAS claim; if lost → return false (no send/event); if won → existing prompt/card/fallback delivery → if delivered → confirm; else → clear (retryable); publish the event only on the claimed path.
- **Session** (`notifyCreatedJobSetupRequired`): after reloading `currentJob`, derive the app session from `currentJob.session_id` (via the control port) and use it; if the captured `appSession.sessionId` no longer matches, prefer the reloaded one.
- **Tests:** update the notify / permission-recovery / IPC tests to the claim→(confirm|clear) contract (mocks return the claim boolean + track confirm/clear); add concurrent creation+creation and creation+run "exactly one card/event" tests, a stale-claim-reclaim test, and a session-changed routing test. TTL constant kept small + injectable for tests.

## Decisions

- Amend 0117: setup-pause notification is gated by a RECOVERABLE atomic fingerprint claim (claim→confirm on delivery, clear on failure, stale-claim reclaim after TTL); the detached creation-notify routes by the reloaded job's session. Resolve D-0053 as fixed.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | race-safe, self-healing exactly-one notification |
| Data/schema | Changed (JSONB, no migration) | `setup_state.notify_claim_at` |
| API/CLI | Changed (additive) | `confirmJobSetupNotified` / `clearJobSetupNotified` on the ops port |
| Docs | Changed | amend 0117; resolve D-0053 |
| Tests | Changed | claim→(confirm|clear) contract + concurrency/reclaim/session tests |

## Task Decomposition

1. **SETUPRACE-1-1** — Recoverable atomic claim: `notify_claim_at` state, CAS `markJobSetupNotified` with stale reclaim, `confirmJobSetupNotified` + `clearJobSetupNotified` through all layers, the claim→(confirm|clear) reorder in `notifyJobSetupRequired`, and session-by-reloaded-job in `notifyCreatedJobSetupRequired`; update + add the concurrency/reclaim/session tests.

## Risks

- Confirm-vs-clear-vs-reclaim must be exhaustively correct (a confirmed claim is never reclaimed; a pending one is after TTL). Cover with a stale-claim-reclaim test.
- Shared notifier touches scheduler/recovery/creation — run the FULL unit + integration suite.
- TTL choice: small enough to recover promptly, large enough that a slow-but-live delivery isn't reclaimed mid-flight; keep injectable.

## Verify Plan

```
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application apps/core/test/unit/jobs apps/core/test/unit/runner
python3 factory/scripts/verify.py
```
Then whole-branch autoreview until no actionable findings (D-0053 resolved as fixed).

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-09: Use a five-minute default setup-notification claim TTL, with the claim timestamp and TTL injectable at the repository seam for deterministic stale-reclaim tests.
