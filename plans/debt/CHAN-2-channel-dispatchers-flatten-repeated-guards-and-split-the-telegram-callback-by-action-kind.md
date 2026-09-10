---
issue: CHAN-2
title: Channel dispatchers: flatten repeated guards and split the Telegram callback by action kind
status: approved
saved: 2026-08-27T16:17:12+00:00
story: CHAN-2
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

# CHAN-2 — Channel dispatchers: flatten repeated guards and split the Telegram callback by action kind

## Problem

The Codex cyclomatic review of PR #444 measured the Telegram `bot.on('callback_query:data')` callback in `apps/core/src/channels/telegram/channel-connect.ts` (lines 59–~750) at CC 188 — one function handling user-question answers, `lt:stop`, `jp:` card taps, `r:` compact retries and `perm:` classic prompts, recomputing the callback context per branch. It also found five places where an optional-guard chain is recomputed per branch. Nothing here is behaviour; all of it makes provider-side review harder than it should be.

## Scope / Non-goals

In scope: (1) the five hoists named in the review; (2) splitting the Telegram callback into one named handler per action kind in ONE sibling module (`telegram/callback-handlers.ts` — owner choice 2026-08-27) plus a thin dispatcher, with the callback context (message, chat, thread, user, provider account) computed once and passed in. Non-goals: `runActiveJob` and `runQuery` (CHAN-3); any behaviour change; any change to what messages, cards or permissions do.

## Acceptance Criteria

- AC1: The five review hoists are applied: telegram/message-action-affordances.ts dead early-returns removed; telegram/channel-connect.ts callback context computed once; slack/channel-message-action-handler.ts channelId/userId hoisted; discord/interactions.ts component user id hoisted; teams/cards.ts thread fragment computed once.
- AC2: The Telegram bot.on callback in telegram/channel-connect.ts is split by action kind into named handlers, each with cyclomatic complexity <= 25, dispatched from a callback whose own complexity is <= 15; no behaviour change.
- AC3: No behaviour change: existing unit tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
- AC4: Lands after PR #446 merged (CHAN-1 folder layout); branch based on main after it.

## Technical Approach

Two tasks:
1. **CHAN-2-T1 Hoists**: the five one-line/one-block simplifications, each in its own file, no signature changes. Verified by the unchanged unit suites of each provider.
2. **CHAN-2-T2 Telegram dispatcher split**: extract a `TelegramCallbackContext` built once at the top of the callback; move each action-kind branch into a named function in ONE sibling module (`telegram/callback-handlers.ts`); the callback becomes: parse data → build context → dispatch by prefix → existing default. Ceilings (owner choice 2026-08-27): handler <= 25, dispatcher <= 15, measured with an AST cyclomatic counter (the review's method); if the `jp:` handler exceeds 25, split it into parse-token / resolve-target / apply-decision helpers inside the same module. The split moves call sites; it does not re-implement `parseJobPermissionCardAction`, `decideJobPermission`, or the `lt:stop` / `perm:` helpers. Existing telegram tests pass unchanged.

## Decisions

No new decision record: internal structure only; no contract, interface or behaviour change. Active decisions reviewed; none constrains this.

## Surface Impact

Internal to the four provider adapters. No CLI/API/settings/schema/docs/user-visible change. A new module may need an entry in `scripts/architecture-map.json`.

## Task Decomposition

- CHAN-2-T1: five hoists (5 files; tests untouched).
- CHAN-2-T2: Telegram callback split (channel-connect.ts + telegram/callback-handlers.ts + architecture-map entry; tests unchanged or added).

## Risks

- Behaviour drift while moving branches into handlers: mitigated by "existing tests unchanged" as a hard rule plus per-handler CC measurement; any edit to an existing test other than additions is a red flag.
- Line budgets: the new module may need an architecture-map entry.

## Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels` unchanged and green; full unit lane; `npm run test:integration:postgres`; `npx tsc --noEmit`; `npm run check:architecture`.
- CC report on `channel-connect.ts` and `callback-handlers.ts`: dispatcher <= 15, every handler <= 25.
