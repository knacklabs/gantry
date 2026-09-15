---
issue: JOBPERM-3
title: Settled job permission cards disappear like chat prompts
status: approved
saved: 2026-08-30T08:29:31+00:00
story: JOBPERM-3
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
# JOBPERM-3 — Settled job permission cards disappear like chat prompts

## Problem

An approved chat permission prompt goes away: Telegram, Discord and Slack delete the message (`telegram/permission-prompt-settlement.ts:82`, `discord/permission-prompt-settlement.ts`, `slack/channel-interactions.ts` `delete_original`), falling back to a receipt edit only if the delete fails; Teams, whose bot messages cannot be deleted, edits the prompt to a receipt card (`teams/interaction-handlers.ts:440–470`). The job permission card (JOBPERM-1/2) never does: when its last row is answered the projection emits a `retire` revision with no outcome (`application/interactions/job-permission-card-projection.ts:155`) and the shared text is the static "All permission requests for this job are settled." (`domain/job-permission-card-actions.ts:70`); every provider edits the card to that line and it stays in the group. Owner feedback 2026-08-28: "these one-time permission messages stick around; they should disappear like in chat." Amended 2026-08-28 after signal S-0041: a denied row stays live per decision 0144, so retire outcomes are `allowed | expired`.

## Scope / Non-goals

In scope: the shared card projection (retire outcome + receipt text), the durability record (deleted/receipt state for idempotent retries), the durable-send wiring, and the four provider deliveries of a retire revision (Telegram, Slack, Discord delete; Teams receipt card). Non-goals: chat prompts (unchanged), card behaviour while rows are open, the once-expiry rule (JOBPERM-2), rule persistence, any UI beyond the retire step.

## Acceptance Criteria

- AC1: when every row of a job permission card is settled by Allow, the card message is deleted on Telegram, Discord and Slack and edited to a one-line approved receipt on Teams; a failed delete falls back to the receipt edit.
- AC2: when the remaining rows of a card have expired (the run ended before a decision), the card is edited to one line per expired request ('Expired: <command>') on every provider — never deleted; a card containing a denied row keeps its live rows (decision 0144: a Deny stays available with one-tap Reconsider) and does not retire.
- AC3: the retire outcome (allowed | expired) is carried on the card revision by the shared projection; provider deliveries act on it; retry of a retire revision is idempotent.
- AC4: existing unit and Postgres integration suites pass (only new or updated assertions on the retire text/operation); tsc, architecture check green.

## Technical Approach

- Projection: when the revision operation is `retire`, compute `retireOutcome: 'allowed' | 'expired'` from the settled needs (`cancelled`+`expiredAt` ⇒ `expired`; denied needs never reach retire because `livingCardNeeds` keeps them live per 0144) and carry the expired rows on the revision (`JobPermissionCardRevision` in `domain/ports/job-permission-durability.ts`, JSONB record — no migration, A-0065). `jobPermissionCardText` renders: `allowed` ⇒ the approved receipt line (used only where a delete is impossible or fails); `expired` ⇒ one line per row: "Expired: <label>". Card actions stay empty for retire.
- Wiring (`app/bootstrap/job-permission-wiring-setup.ts` ~`:315`): a retire revision with `retireOutcome === 'allowed'` is delivered as a **delete** of `providerMessageId` (new `MessageSendOptions.deleteMessageId`, `domain/types.ts:545` area) with the receipt text as fallback; `expired` stays an edit (`replaceMessageId`) with the receipt text.
- Providers: Telegram (`channels/telegram/job-permission-card-delivery.ts` + `channel-delivery.ts`) — `deleteMessage`, fallback `editMessageText` receipt; Slack (`channels/slack/channel-delivery.ts:104` edit path) — `chat.delete`, fallback `chat.update`; Discord (`channels/discord/index.ts:184` edit path) — `messageMutations.delete`, fallback edit; Teams — no delete: reuse the chat receipt card (`buildTeamsMessageCard` + `updateActivity`, as `teams/interaction-handlers.ts:451` does) or send the receipt if no activity id is recorded.
- Idempotency (AC3): the durability record marks the retire revision `deletedAt` (or `receiptMessageId`) the way settled message ids are recorded today (`deliveries.settledMessageId`, `telegram/job-permission-card-delivery.ts:53`); a retried retire revision no-ops when either is set. The reconciler's delivery log gains `operation: 'delete'` in the existing 'Job permission card delivered' line.

## Decisions

No new decision record: this reverses one JOBPERM-1 copy choice (the static "settled" line) to match the chat-prompt behaviour already decided per provider; 0124 (bounded durable card delivery) and 0144 hold. Kind = feature.

## Surface Impact

Group chats: an answered job card vanishes (Telegram/Discord/Slack) or becomes a one-line approved receipt (Teams); an expired card becomes per-row 'Expired:' lines; a card with a Deny stays as today (Reconsider). No CLI/config/schema change.

## Task Decomposition

- JOBPERM-3-T1: shared projection + record + wiring + Telegram delete (the owner's channel), with the receipt text and idempotent retry; unit + Postgres coverage. Contract: AC1 (Telegram part), AC2, AC3, AC4.
- JOBPERM-3-T2: Slack + Discord delete and Teams receipt card on the same revision shape; provider unit coverage. Contract: AC1 (remaining providers), AC4.

## Risks

- A delete racing an in-flight edit of the same message: keep the per-message lane serialization the Telegram card delivery already uses (`deliveries.serialize`).
- Recovery after a restart must not delete twice or re-send a receipt: `deletedAt`/`receiptMessageId` on the revision gate the retry.
- Teams cannot delete: receipt card is the ceiling; must not throw when no activity id is recorded (fall back to a plain receipt message).
- Expired wording must come from the need state (`expiredAt`), never from card text parsing; a denied need must never be treated as retired (0144 Reconsider).

## Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/jobperm-*.test.ts apps/core/test/unit/channels/` green (only retire-text/operation assertions updated); full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; Postgres lane `GANTRY_TEST_DATABASE_URL=… npm run test:integration:postgres`; `python3 factory/scripts/verify.py`.
- Live: deploy the branch, trigger KnackLabs, answer a "this run only" row with Allow → the card message disappears from the Telegram group; an untapped once row on a later run → the card becomes an 'Expired: …' line and stays.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-28: AC2 'denied or expired' is read as EXPIRED only: per decision 0144 an explicit Deny stays a live card row with one-tap Reconsider, so a card containing a denied row never retires; a card retires only when every row is allowed (deleted on Telegram/Discord/Slack, receipt card on Teams) or when its remaining rows expired (edited to 'Expired: <command>' lines, never deleted) — owner ruling 2026-08-28.
