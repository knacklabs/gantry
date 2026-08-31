---
issue: SKILLS-WEB-1
title: Skills inventory and agent attachment Web UI
status: approved
saved: 2026-08-31T06:21:51+00:00
story: SKILLS-WEB-1
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
# SKILLS-WEB-1 — Skills inventory and agent attachment Web UI

## Problem

Gantry has durable app-scoped skill inventory, artifacts, agent bindings, and permission boundaries, but no live browser page for operators to inspect or manage them. The Web UI must expose the approved Skills workflow without leaking storage data or treating declared actions as granted authority.

## Scope / Non-goals

Build the confirmed `/ui/skills` inventory/detail experience, browser-session Skills facade, ZIP install, lazy file inspection, read-only declared actions, navigation count, and atomic full-set agent attachment replacement.

Do not add global skill enable/disable/delete, binary download, package editing, marketplace/Git/URL install, inline capability editing, new public `/v1` or CLI semantics, fixture fallback, or a database migration.

## Acceptance Criteria

1. Viewers can search and inspect sanitized inventory, file metadata/text previews, declared actions, and attached agents at `/ui/skills`; URL state restores `skill`, `q`, and `tab`.
2. Administrators can install a validated ZIP into inventory, see the same-name update warning, and complete installation without attaching agents.
3. Administrators can atomically replace the complete attachment set with up to 100 distinct active or disabled app-scoped agents; settings projection runs once after commit.
4. Attachment never grants declared-action capability authority; browser DTOs and errors expose no storage references, hashes, credentials, tokens, stack traces, or raw upstream errors.
5. The split layout stacks on narrow screens and meets existing keyboard, focus, label, and live-status conventions.

## Technical Approach

Reuse the established same-origin browser-facade pattern: session authentication, browser scope policy, canonical Origin, CSRF, and hosted recent-reauth checks stay in thin routes; application services and repositories own behavior. Define typed browser request/response contracts and explicit sanitizing mappers rather than reusing the storage-bearing `/v1/skills` DTO.

Extend the existing skill repository/service with one transaction-backed desired-binding replacement operation. Validate the skill and every agent against the session app before mutation, activate selected bindings and soft-disable omitted active bindings in one transaction, then invoke the existing settings projection once after commit. A projection failure returns a sanitized error and relies on existing reconciliation; it does not roll back committed desired state.

Reuse the existing artifact store and ZIP parser for install and file reads. Return UTF-8 text as inert text and binary metadata without bytes. Reuse the existing React, TanStack Router/Query, Vitest, browser fetch helper, shell, and UI primitives; add no dependency or generic catalog abstraction.

## Decisions

No new decisions. The existing runtime stack, browser auth, artifact isolation, capability authority, settings authority, and navigation-summary decisions determine the implementation. The recurring `delivery-semantics` finding concerns job cards and does not touch this synchronous browser workflow; if review finds that class here, stop and escalate under WORKFLOW.md rather than adding speculative delivery machinery.

## Surface Impact

| Surface | Classification | Ownership |
|---|---|---|
| Runtime behavior | Unchanged by design | Existing next-run selected-skill materialization remains authoritative. |
| API | Changed | Task 1 adds typed same-origin browser Skills routes; public `/v1` remains unchanged. |
| Data/schema | Changed | Task 1 changes existing skill-binding rows transactionally; no schema migration. |
| CLI/ops | Unchanged by design | Existing CLI and operational commands retain their semantics. |
| UI | Changed | Tasks 2 and 3 add navigation, inventory/detail inspection, and admin dialogs. |
| Docs | Changed | The confirmed spec and this plan document the browser contract; no separate user guide is required for this bounded console feature. |
| Tests | Changed | Each task owns focused automated proof; the story closes with deterministic verify and functional evidence. |

## Task Decomposition

### Task 1 — Browser Skills facade and atomic attachment replacement
`user_facing: false`

Own typed browser contracts, explicit sanitizing mappers, session-protected list/file/install/attachment routes, the transaction-backed desired-binding replacement repository/service operation, navigation count data, and focused core unit/integration tests. Keep routes thin, validate all trust-boundary inputs with existing typed error conventions, and never serialize storage-bearing catalog records directly.

Serves acceptance criteria 1–4.

### Task 2 — Skills inspection UI
`user_facing: true`

Own the Configure navigation entry, validated URL search state, responsive split inventory/detail page, search/empty/loading/error states, Overview/Files/Actions/Agents tabs, lazy safe file preview, read-only action cards, Agent Access links, and focused web tests. Reuse existing UI primitives and browser query patterns.

Serves acceptance criteria 1, 4, and 5.

### Task 3 — Administrator install and attachment workflows
`user_facing: true`

Own the ZIP install dialog, same-name warning and success actions, complete-set attachment dialog, disabled-agent label, pending/error preservation, query invalidation, accessibility behavior, and focused web tests. Viewer sessions render no mutation controls.

Serves acceptance criteria 2–5.

## Risks

- Reusing the public skill response would leak `storageRef`; separate browser DTOs and mapper tests are mandatory.
- Per-agent bind/unbind loops cannot guarantee atomic replacement; the repository transaction is required.
- File paths are attacker-controlled package inputs; reuse validated manifest paths and encode route parameters without resolving arbitrary filesystem paths.
- Projection happens after commit, so UI failure must refetch persisted desired state and avoid claiming rollback.
- The route module can become monolithic; keep parsing/DTO mapping separate and keep request handlers orchestration-only.

## Verify Plan

- Task 1: focused browser-route auth/CSRF/origin/reauth, app-isolation, redaction, ZIP validation/update, file text/binary, attachment transaction/rollback, disabled-agent, 100-ID bound, and single-projection tests.
- Tasks 2–3: focused web tests for navigation/count, URL restoration, search/empty/error states, lazy tabs, viewer/admin controls, warnings, attachment state, Agent Access links, keyboard/focus/live status, and narrow layout.
- Run `npm run typecheck:web`, `npm run lint:web`, `npm run format:check:web`, `npm run test --workspace @gantry/web`, focused core unit/integration/Postgres tests, then `python3 factory/scripts/verify.py`.
- Record automated evidence, run one three-lens autoreview pass to clean, and run the required functional checker against the real local console/API for install, inspect, attach/detach, disabled agents, next-run wording, and unchanged action authority.

