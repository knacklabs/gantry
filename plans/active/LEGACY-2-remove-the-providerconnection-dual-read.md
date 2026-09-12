---
issue: LEGACY-2
title: Remove the providerConnection dual-read
status: approved
saved: 2026-08-29T18:18:41+00:00
story: LEGACY-2
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

# LEGACY-2 — Remove the providerConnection dual-read

## Problem

When provider connections became provider accounts (2026-07-02), the old `providerConnection` name survived as an in-memory shadow field: `runtime-settings-types.ts:40` declares it, `runtime-settings-parser.ts:241` fills it from `providerAccount`, and about twenty sites read `providerAccount ?? providerConnection`. Decision 0003 says the runtime carries no internal back-compat, so LEGACY-1 fenced this with 19 time-boxed architecture exceptions (`scripts/architecture-exceptions.json`, symbol `providerConnection`, kind `dual_read`, `remove_by 2026-08-28`). They expired: `npm run check:architecture` is red on main and on every branch, and JOBPERM-3 cannot close its stage. Owner ruling (2026-08-29): remove the dual-read now, before JOBPERM-3 ships.

## Scope / Non-goals

- Delete the shadow field declaration and the parser fill; delete the two secondary optional shadows (`control-plane-storage-model.ts:141`, `cli/provider-utils.ts:114`).
- Collapse every `providerAccount ?? providerConnection` read to `providerAccount`: Slack `permission-approval-delivery.ts:122`, `control-plane-storage-model.ts:191`, `provider-utils.ts:140`, `runtime-settings-binding-derivation.ts:29/44`, `conversation-install-settings.ts:123`, `settings-revision-document.ts:51`, `runtime-settings-renderer.ts:436`, `runtime-settings-validation.ts:190/194/219`, `desired-state-export-helpers.ts:182`, `desired-state-provider-conversations.ts:103`, `desired-state-service-helpers.ts:169/187/227/365`, `desired-state-conversation-reconcile.ts:103`, `observer-activation.ts:86`.
- Stop creating the shadow property in writers: `conversation-install-settings.ts:67`, `runtime-settings.ts:406`, `desired-state-current-export.ts:248/515`, `desired-state-conversation-reconcile.ts:204/283`; drop the strip in `config/index.ts:163`.
- Rename the rename-only locals/helper names that carry the exact token (`routes/agents.ts:638-659`, `desired-state-export-helpers.ts:126/135/175`, `desired-state-service-helpers.ts:486`, `runtime-settings.ts:344/361/484`) to `providerAccount…`; no behaviour change.
- Delete the 19 `providerConnection` entries from `scripts/architecture-exceptions.json`.
- Tests: update the 74 test/fixture mentions only where they assert or construct the shadow field; assertions on `provider_account` stay.

**Non-goals**

- The old document key `provider_connection` keeps being rejected by the existing strict key check (`runtime-settings-compact.ts:150`, `runtime-settings-parser.ts:187`) — no silent drop, no new code (locked decision 1).
- `providerConnectionId` (ConversationRoute, identity-event payloads, CLI setup return names in `cli/slack.ts`, `discord.ts`, `teams.ts`, `telegram-connect.ts`, `group-helpers.ts`) and the OpenAPI enum `missing_provider_connection` stay untouched (locked decision 3; deferral).
- The conversation-JID dual-read (LEGACY-1's "LEGACY-2" prose item) — separate Phase-8 migration.
- No data migration: migration 0092 already rewrote `provider_connection` → `provider_account`; serialisers already emit only `provider_account`.

## Acceptance Criteria

- AC1: the providerConnection shadow field is removed from the runtime settings types and the parser no longer fills it; every `providerAccount ?? providerConnection` read collapses to providerAccount (settings parser/validation/renderer/exports/reconcile/observer activation, control-plane storage model, CLI provider utils, Slack permission delivery, control routes).
- AC2: a settings document that still carries providerConnection / provider_connection keeps being rejected by the existing strict key check (no new code); nothing dual-reads it in memory.
- AC3: the 19 providerConnection entries are deleted from scripts/architecture-exceptions.json and `npm run check:architecture` passes with no providerConnection exception.
- AC4: existing unit and Postgres integration suites pass (only assertions that named providerConnection change); tsc green.

## Technical Approach

Mechanical single-cut removal, one bounded task. Order: types + parser first (tsc then lists every dependent site), collapse the reads, remove the writers' shadow property, rename the locals, delete the exception entries, fix the tests that referenced the shadow. The guard matches the exact token with word boundaries (`scripts/architecture_rules.py:41/48`), so `providerConnectionId` does not trip it and needs no change. No new helpers, no compat shims.

## Decisions

- 0003 (no internal back-compat) — this is its enforcement; no new decision needed.
- 0007 / 0025 (settings as runtime truth, settings authority) — unchanged; `provider_account` remains the sole source.
- 0009 (canonical schema cutover) — consistent.
- Deferral to record: rename of `providerConnectionId` + `missing_provider_connection` enum (external-facing).

## Surface Impact

Runtime settings parsing/validation/rendering (internal types only), control-plane storage model, control route `agents.ts` (local rename), CLI provider utils, Slack permission approver lookup, architecture exceptions file. No settings.yaml shape change, no contract/SDK change, no migration, no docs/prompt change.

## Task Decomposition

- LEGACY-2-T1: remove the shadow field, dual-reads, shadow writers and rename-only locals; delete the 19 exceptions; update the affected tests. Contract: AC1–AC4.

## Risks

- A missed `?? providerConnection` site compiles only if the property still exists — deleting the type first makes tsc the safety net.
- Slack approver lookup: the expression becomes `conversation.providerAccount === providerAccountId`; keep account-qualified matching (no widening).
- `settings_revisions` rows that carry only the old key would already fail today; migration 0092 covered them — a read-only live-DB inventory is a closeout check, not a code change.
- Review budget: ~20 source files + tests; refactor ratchet applies (kind refactor).

## Verify Plan

`npx tsc --noEmit`; `npm run check:architecture` (must pass with zero providerConnection exceptions); `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/ apps/core/test/unit/channels/ apps/core/test/unit/cli/ apps/core/test/unit/application/ apps/core/test/unit/control/`; Postgres lane host-side (`npm run test:integration:postgres` subset touching settings revisions); `python3 factory/scripts/verify.py` at closeout; autoreview local with a brief stating "no behaviour change; old key still rejected". Closeout check (read-only, host-side): inventory `settings_revisions.settings_document_json` for any remaining `provider_connection` key — expected zero after migration 0092.
