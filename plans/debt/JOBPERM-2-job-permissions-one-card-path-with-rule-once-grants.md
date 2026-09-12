---
issue: JOBPERM-2
title: Job permissions: one card path with rule/once grants
status: approved
saved: 2026-08-27T17:22:55+00:00
story: JOBPERM-2
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
# JOBPERM-2 — Job permissions: one card path with rule/once grants

## Problem

A scheduled-job run raises permission requests like chat does. JOBPERM-1 (#444) gave job runs one native card with exactly Allow / Deny, where Allow saves a rule. But `jobPermissionDurability.attachRequest` (`apps/core/src/app/bootstrap/job-permission-durability-wiring.ts:212`) returns `false` when `persistentRules(request)` is empty — any tool, any command shape that cannot become a saved rule (piped commands per decision 0134, over-length inputs, no rule suggestion). The IPC wrapper (`apps/core/src/runtime/ipc-interaction-processing.ts:205`) then falls through to the classic chat requester, and the job-only option rewrite (`apps/core/src/runtime/ipc-permission-classifier-decision.ts:437`) leaves that prompt with a single Cancel button. Live: run 0798f2bc (2026-08-27 16:39Z), `permission_prompts` row 6299a039 rendered `["cancel"]`; the run sat on a question that could only be answered "no", and nothing logged the prompt.

Two prompt systems for one run are the defect. Outcome: ONE card path for every job-run permission; a request that cannot be remembered still gets Allow / Deny, where Allow means "this run only"; the fallback and the cancel-only rewrite are deleted.

Spec: `docs/specs/job-permissions-once-grants.md` (confirmed). Owner decisions: attach failure ⇒ deny the tool call with a plain reason (fail closed, no chat prompt); a once row whose run ended ⇒ settles visibly as expired and is re-asked next run; T1 deploys as soon as it is green.

## Scope / Non-goals

In scope: the host job-permission durability path (attach, need/revision record, projection copy, settlement, replay), the IPC wrapper's job branch, the classifier's job-only option rewrite, and their tests.

Non-goals: setup-pause prompt path (`setup-pause-permission-prompt.ts`, not cancel-only); provider renderers (Slack/Discord/Teams consume generic affordances; Telegram card sender unchanged); runner and heartbeat (runner already verifies signed allow_once, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts:329`); A-0066 pre-IPC rejections; schema migrations; CHAN-2 T2 (parked; plan backed up in scratchpad/chan2-park and /tmp/chan2/CHAN-2-plan.md).

## Acceptance Criteria

- AC1: a job-run request with no persistable rule creates a `once` need row and a card revision with Allow / Deny; no classic prompt is sent and the job-only cancel-only option rewrite no longer exists.
- AC2: Allow on a `once` row replays a signed `allow_once` to the runner, writes no rule, and the held tool call resumes; Deny denies; the card settles and logs delivery as today.
- AC3: `rule` rows behave exactly as before (rule write + replay); existing rows without a mode read as `rule`.
- AC4: a job attach failure denies the tool call with a logged plain reason instead of falling through to the chat prompt.
- AC5: a `once` row whose run ended before a decision settles as expired with copy "Expired — the run ended before a decision; it will ask again next run" and never becomes durable authority.

## Technical Approach

Validated by a Codex terra @ xhigh read-only pass (brief `plans/codex-briefs/jobperm-single-path-permissions.md`).

- Grant mode per need row: `grant: 'rule' | 'once'`, derived in `attachRequest` from `persistentRules(request).length > 0`. Persisted inside the existing JSONB need/revision record (A-0065: no new table, no migration); absent ⇒ `rule` on read.
- `rule` needs keep today's canonical-rule identity and settlement. `once` needs use request-id identity so an earlier Allow never covers a later request/run; a once row has no grant atoms.
- Row copy: shared projection (`apps/core/src/domain/job-permission-card-actions.ts`) renders a once row from the sanitized request summary with the suffix "(this run only)". Buttons stay exactly Allow / Deny for the whole card.
- Allow: both modes re-run the deterministic rails; only `rule` writes rules. A once Allow replays a signed `allow_once` decision (`decidedBy: human_once`, no `updatedPermissions`) to the waiting runner.
- Expiry: a once row whose waiter is gone (run ended / 24h) settles as `expired` (AC5 copy). Never durable authority.
- IPC: `attachRequest` is called for EVERY job-run request; if it returns false/throws, the wrapper denies the tool call with reason "Could not raise the job permission card: <cause>" and logs it — never the classic requester.
- Delete the `if (input.hostJobId)` decision-option rewrite in `ipc-permission-classifier-decision.ts` (lines 436–440). Keep `permission-approval-requester` and channel prompt code.

Files (production, ~180 lines): `apps/core/src/app/bootstrap/job-permission-durability-wiring.ts` (attach classification, once revalidation, signed once replay); `apps/core/src/application/interactions/job-permission-durability.ts` (need/effect contracts carry `grant`); `apps/core/src/domain/ports/job-permission-durability.ts` (persisted row shape gets optional `grant`); `apps/core/src/application/interactions/job-permission-card-projection.ts` (row projection retains grant; atom paging tolerates an empty once scope); `apps/core/src/domain/job-permission-card-actions.ts` (once/expired row copy; actions unchanged); `apps/core/src/application/interactions/job-permission-provider-actions.ts` (Allow transition preserves once mode); `apps/core/src/application/interactions/job-permission-reconciler.ts` (rule-vs-once apply/replay/handoff guards at `:330`/`:341`; once expiry settlement); `apps/core/src/runtime/ipc-interaction-processing.ts` (attach failure fails closed); `apps/core/src/runtime/ipc-permission-classifier-decision.ts` (delete the rewrite).

Tests (~230 lines): `apps/core/test/unit/application/jobperm-durability.test.ts` (once attach / replay / no-rule-write / absent-grant-reads-as-rule / expired settlement); `apps/core/test/unit/application/jobperm-ask-and-wait.test.ts` (`jobperm-1-t1-card-not-cancel` moves off the removed option shape; IPC attach failure denies with reason); `apps/core/test/unit/application/jobperm-edges.test.ts` (provider-card contract: once row copy, Allow/Deny only); `apps/core/test/integration/permission-decision-chain.postgres.integration.test.ts` (signed scheduled once-card attach → Allow → `allow_once` replay, no rule written).

## Decisions

No new decision record: this completes decision 0144 (autonomous ask-and-wait chat parity) by removing the last non-card prompt for job runs; 0134 (pipes never create a durable rule) and A-0065/A-0066 are preserved. If review finds the once-grant semantics need their own record, amend 0144 rather than adding a new number.

## Surface Impact

Job permission card: a new row shape "(this run only)" and an "Expired — …" settled copy; buttons unchanged (Allow / Deny). Chat prompts: unchanged. Job runs: never see the classic prompt; an un-raisable card denies the tool call with a plain reason. No CLI, config, schema or API change.

## Task Decomposition

- JOBPERM-2-T1 — once grants end to end: attach every job-run request (grant rule/once), once settlement + signed allow_once replay, IPC fail-closed, classifier rewrite deleted, unit coverage (durability, ask-and-wait, edges). Contract: AC1, AC2, AC3, AC4. Deploys as soon as green.
- JOBPERM-2-T2 — once expiry + integration proof: expired settlement/copy for once rows whose run ended, Postgres integration test for the once chain. Contract: AC5 + AC2 integration proof.

## Risks

- A once Allow must never write a rule (0134); guard in settlement and assert in tests.
- Reconciler guards at `:330`/`:341` assume non-empty atoms; a once row with no atoms must not be treated as "nothing to apply".
- Historic need rows lack `grant`; absent must read as `rule` (AC3).
- A dead once waiter (run ended) must settle as expired, never replay into a later run (AC5).
- Fail-closed deny on attach failure must carry a reason the agent can act on and a log line (AC4); no silent fallthrough.

## Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/jobperm-*.test.ts`; full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; `python3 factory/scripts/verify.py`.
- `GANTRY_TEST_DATABASE_URL=… npm run test:integration:postgres` (permission-decision-chain suite).
- Live: deploy (`npm run build:runtime` + `launchctl kickstart -k gui/$(id -u)/com.gantry`, only with no active run lease), trigger KnackLabs via the control-api script; a piped command must show one card row "… (this run only)" with Allow / Deny; Allow resumes the run, no rule row written; log shows 'Job permission card delivered'.
