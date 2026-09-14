---
issue: ONBOARDING-V2-1
title: V2 first-agent onboarding legacy adoption
status: approved
saved: 2026-09-14T10:29:46+00:00
story: ONBOARDING-V2-1
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
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0138-agents-are-service-kind-persons
  - 0142-third-console-role-approver
  - 0143-browser-write-only-secret-ingest
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
  - 0153-learned-decisions-project-into-job-grants
  - 0154-human-decision-memory-generic-scope
  - 0155-default-allow-gantry-tools-interactive-auto
  - 0156-ai-employee-console-resumable-deployment
  - 0157-jobs-use-the-chat-permission-ladder
  - 0158-provider-session-context-ceiling
  - 0159-adapter-session-release-port
  - 0160-physical-column-naming-is-snake-case
  - 0161-granted-capabilities-must-be-discoverable
  - 0162-onboarding-v2-legacy-adoption
  - 0163-onboarding-v2-migration-baseline
---

# ONBOARDING-V2-1 — Adopt V2 first-agent onboarding

## Problem

The complete V2 first-agent onboarding implementation exists only on the preserved local `feat/v2-onboarding` archive. It predates the current Forge task-per-PR workflow, carries interleaved web, API, runtime, and schema changes, and includes obsolete intermediate migration history. Current `origin/main` therefore has neither the approved V2 experience nor reviewable Forge evidence for it.

## Scope / Non-goals

Adopt the archive's V2 splash and four-step authenticated administrator flow into one Forge task branch created from current `origin/main`. Preserve the archive branch unchanged. Transplant exactly the product delta from base `97ded374637fd12b92dc05dbc2e482bd23035109` through inspected local archive tip `31bc4cf0740fdaad87482ba1a0c84fa1212c9fad`; exclude `.factory/**`, stale duplicate specs, and every archive migration SQL, journal edit, and snapshot. Bring across product source and product tests, resolve overlaps toward current main, correct the known readiness and secret-handling defects, generate one current-schema onboarding migration, and produce local verification, review, animation, and functional evidence.

Non-goals: redesigning the existing Console, adding new provider transports, fabricating provider readiness, changing public SDK or CLI behavior, adding compatibility shims for undeployed schema, modifying Factory scripts or Factory tests, pushing the task branch, opening its PR, or marking the story shipped. Live Slack tenant proof remains a release gate; Teams proof belongs to its later transport release. Deterministic fixture-backed contract proof is the local handoff gate. Because the user is holding the push/PR action, this task stops with every prerequisite green but is not described as Forge-complete until the held PR command runs.

## Acceptance Criteria

- The splash and all four onboarding steps conform to `docs/specs/v2-first-agent-onboarding-visual-contract.md` in light and dark themes, saved and system reduced-motion modes, and the named responsive viewports.
- The full-profile same-origin route is administrator-only, canonical-Origin checked, CSRF-protected, recent-reauthentication gated for hosted mutations, `no-store`, and never reachable through Bearer-session substitution or automatic mutation replay. Model credentials and channel secrets remain separate, write-only after submission, absent from audit/error/upstream-body projections, and cleared from browser state after successful ingest.
- Durable onboarding state resumes uniquely per app. Explicit retries reuse persisted idempotency identity, changed payloads conflict, and upstream changes invalidate only dependent downstream progress.
- A model cannot be listed, selected, saved, or projected before its typed credential configuration and selected `agentHarness` compatibility validate. Candidate credentials validate before commit; a failed candidate preserves the prior healthy credential. Existing sparse-PATCH re-enable and authentication-method replacement semantics remain intact. Policy-disabled raw mutation can use only an already-healthy typed credential.
- Workspace completion requires non-empty real conversation discovery. Provider accounts are Agent-owned and project the required service-Person alias; conversation and human approver selection follow the accepted DM/group rules.
- Console handoff stays locked until a persisted challenge receives a matching inbound message and outbound reply correlated to the exact app, Agent, provider account, conversation/thread, inbound event, outbound event, and run, followed by successful runtime projection. Projection failure preserves the satisfied challenge for explicit retry. Pending, expired, replay, correlation, and projection failures remain recoverable through the existing browser error envelope with stable codes and safe messages.
- The current schema receives exactly one generator-produced pre-release onboarding migration and metadata snapshot covering resumable setup, verification correlation, required uniqueness/indexes, and persisted idempotency. Archive migration files and snapshots are not transplanted.
- Focused product tests, disposable-Postgres lifecycle proof, lint, formatting, type checks, web/runtime builds, deterministic Forge verification, one three-lens autoreview, motion review, and rebuilt-runtime functional evidence are recorded before PR handoff.

## Technical Approach

1. Start `ONBOARDING-V2-1-T1` through Forge from current `origin/main`; let Forge hydrate the approved story evidence into that task worktree. Transplant the archive delta from pinned base `97ded374637fd12b92dc05dbc2e482bd23035109` through pinned local tip `31bc4cf0740fdaad87482ba1a0c84fa1212c9fad`, excluding `.factory/**`, `docs/specs/**`, and `apps/core/src/adapters/storage/postgres/schema/migrations/**`. Preserve current-main package metadata and journal, then apply only product dependency changes proven by the adopted source.
2. Reuse the existing browser route dispatcher, browser session/role/Origin/CSRF/reauth guards, browser model-provider facade, channel-account creation/discovery facade, Agent/Person services, desired-state projection, audit services, and provider adapters. Add a focused application-layer first-agent onboarding service as the atomic owner of custom role, Agent, service Person, first config revision, audit event, unique setup, and idempotency receipt; the Postgres adapter supplies its single transaction. Keep the browser route a typed request/response mapper using the repository's existing `{ error: { code, message } }` envelope, `no-store`, redaction, and no Bearer fallback.
3. Treat credential submission as candidate-validate-commit: require explicit auth method and compatible `agentHarness`, validate the complete typed candidate before replacing stored state, preserve any prior healthy credential on failure, and retain existing sparse-PATCH re-enable behavior. Keep channel secrets in the capability-secret path. Audit only actor/resource ids, provider/auth-mode metadata, result code, and fingerprints—never values or upstream bodies.
4. Add canonical Drizzle tables/repository operations for the unique per-app onboarding setup, request fingerprint/idempotency key/result, dependent-state revisions, and exact verification correlation lifecycle. Use provider-account and conversation foreign keys, partial active-challenge uniqueness, expiry/correlation indexes, snake_case physical columns, created/updated timestamps, and structured lifecycle logs. Update current schema exports, then run the repository migration generator once with an onboarding name. Commit only its generated SQL, journal entry, and current snapshot. The pre-release rollback is replacement from clean current main plus disposable-Postgres regeneration; no runtime compatibility or data-copy path exists because decision 0163 records no deployment.
5. Adopt the repository-native React route, existing UI primitives, local Fontsource/Iconify assets, scoped Tailwind utilities, SVG artwork, Sonner host, and CSS required for reference-only effects that Tailwind cannot express compactly. Keep the fixed desktop/tablet rail and mobile block, keyboard/label/contrast support, 200% zoom usability, deterministic animation controls, and accessible reduced-motion fallbacks.
6. Correct the archive during transplant at its existing seams: use session-scoped splash draft state; clear secret inputs after successful ingest; gate model queries and selection on validated configuration; reject empty discovery without advancing; persist/resume completed steps; distinguish the DM counterpart from recognised group installer/manual membership; preserve a satisfied challenge across projection retry; and require verification plus runtime projection before Console navigation.
7. Document each new same-origin route in the control-server OpenAPI owner with method, schema, safe examples, and required authorization behavior. Although these are cookie-session browser routes rather than Bearer APIs, the documentation and tests must make that separation explicit and must contain no credentials.
8. Retain and update archive product tests. Add focused route/state tests and a disposable schema-isolated Postgres lifecycle suite for atomic creation, uniqueness, expiry, replay, full correlation, invalidation, candidate credential preservation, and idempotent retry. Add one repository-owned visual acceptance script that uses existing `playwright-core` and browser Canvas pixel reads—no image library—to load `docs/reference/onboarding/gantry-onboarding-v2.dc.html` and the rebuilt UI, wait for `document.fonts.ready`, freeze named animation frames, apply only documented intentional-difference masks, and fail on any unexpected pixel. Write temporary PNG/JSON review output outside application assets and record its result through Forge's test recorder.
9. Rebuild and restart the runtime from the task branch, retain status/log evidence, and verify `/healthz`, `/readyz`, and `/ui/onboarding` before performing the full authenticated flow through Console handoff. Record unavailable live Slack tenant proof honestly as release-only, never as passing local evidence.

## Decisions

- `docs/decisions/0162-onboarding-v2-legacy-adoption.md` authorizes the one-task legacy exception because the archive history is already interleaved. This does not establish a precedent; future work returns to bounded task-per-PR delivery.
- `docs/decisions/0163-onboarding-v2-migration-baseline.md` requires one generated current-schema migration because Gantry is not deployed. Decision 0003 therefore permits deleting the archive's intermediate migration history rather than maintaining a compatibility path for nonexistent deployed data.
- Decisions 0000, 0006, 0135, and 0143 keep model credentials and channel capability secrets in their existing separate typed stores and make browser ingestion write-only. Runtime-secret references are not a model-credential substitute.
- Decisions 0132, 0138, 0142, 0156, and 0119 define full-profile browser authorization, Agent/service-Person identity, approver authority, resumable readiness, and group installer seeding.
- Existing TypeScript, React, TanStack Query/Router, Tailwind, Radix primitives, Sonner, Iconify, Vitest, Playwright Core, browser Canvas, Drizzle, ESLint, Prettier, and repository architecture checks are reused because they already own these surfaces. Canvas supplies the pixel oracle, so no image-comparison dependency or alternate test framework is introduced.
- The companion visual contract and active safety decisions override contradictory prototype behavior while the V2 HTML remains authoritative for visual primitives. This is the confirmed requirements-grill answer, not a new implementation choice.
- Decision 0162 is an explicit, one-time deviation from WORKFLOW.md's normal backend/frontend task separation. The accepted archive boundary and this grill's confirmed answer control this story only. The task contract carries a 75-file/50,000-line review budget because the pinned transplant is 62 product files/5,521 lines before one generator-owned snapshot; generated metadata is reviewed as generator output while all handwritten changes receive normal three-lens review.
- No new decision record is required.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | First-run state, downstream invalidation, provider readiness, correlated verification, projection, resume, and Console gating become durable and truthful. |
| API | Changed | A protected same-origin onboarding facade and Slack manifest read endpoint orchestrate existing application services with typed DTOs/errors; public Bearer contracts remain unchanged. |
| Data/schema | Changed | One generated pre-release migration adds resumable setup, idempotency, verification correlation, constraints, and indexes. |
| CLI/ops | Unchanged by design | Onboarding is browser-owned; existing CLI setup remains available and runtime startup commands do not change. |
| UI | Changed | The V2 splash, rail, four steps, provider/workspace flows, drawers, motion, themes, global Sonner notices, and accessible responsive states are adopted. |
| Docs | Changed | The confirmed capability spec, companion visual contract, decisions, Forge plan/evidence, and review-ready PR description travel with the task. Existing operational Slack documentation is updated only where canonical manifest ownership moved. |
| Tests | Changed | Focused core/web tests, generated migration checks, disposable-Postgres lifecycle coverage, deterministic screenshots/motion frames, builds, review, and functional evidence are required. |
| Settings/config | Read-only | Existing browser access, provider registry, and deployment-mode policy are consumed; no new setting or secret source is introduced. |
| SDK/contracts | Unchanged by design | No public SDK type, CLI contract, or external provider protocol changes. |
| Provider/channel adapters | Changed | Existing Slack manifest ownership and inbound/outbound verification correlation are wired into onboarding; no simulated provider behavior or new transport is added. |
| Factory scripts/tests | Unchanged by design | Forge is consumed exactly as shipped; only validated story/task evidence generated by its recorders is committed. |

## Task Decomposition

### ONBOARDING-V2-1-T1 — Adopt and harden the complete V2 onboarding flow

`user_facing: true`

Own the full pinned archive transplant, current-main conflict resolution, application transaction owner, browser facade and OpenAPI contract, single generated migration, web/core product tests, known defect corrections, deterministic visual/motion proof, runtime rebuild, and Forge evidence. This one-task shape is the explicit legacy exception in decision 0162 and the confirmed plan-grill answer: the adopted delta is reviewed as one end-to-end readiness invariant rather than producing backend-only and UI-only intermediate review branches.

Acceptance served: all eight criteria above.

Expected shape: keep the browser route a thin coordinator; keep typed DTO/error definitions, Drizzle schema/repository operations, provider-specific manifest mapping, shared UI primitives, onboarding model setup, workspace setup, and route orchestration in their existing separate modules. Reuse shared session/CSRF, model-provider, channel-account, identity, projection, audit, copy, switch, dialog, and toast seams. Validate every required boundary input and retain stable constants/enums for lifecycle states and error codes. Do not add a second onboarding route, generic workflow engine, compatibility layer, local toast host, provider mock, timer-based success, or speculative abstraction.

Review budget: 75 changed product files and 50,000 changed lines. This deliberately accommodates the pinned 62-file legacy transplant and one generator-owned Drizzle snapshot; the task must still stop if it exceeds twice either limit, and handwritten source remains subject to focused tests and full review.

Tripwire: if review flags `plan-contract-partial` again, stop and escalate it under WORKFLOW.md Recurring Findings rather than locally weakening or expanding this approved contract. The unrelated `delivery-semantics` recurring class is outside this story; onboarding correlation follows decision 0156 and is explicitly tested.

## Risks

- A transplant can overwrite newer main behavior. Apply product paths selectively, inspect every overlap against current main, and keep package metadata plus migration journal based on current main.
- Secret values can leak through browser state, logs, errors, or DTOs. Keep write-only endpoints, clear successful drafts, serialize metadata/fingerprints only, and assert supplied values are absent from responses and recorded artifacts.
- Apparent readiness can outrun real state. Make each transition derive from persisted validated/discovered/correlated/projected evidence and pin all negative paths.
- One generated snapshot can be large. Accept generator-owned metadata required by the current Drizzle chain; reject only the archive's duplicate historical snapshots and never hand-edit generated metadata.
- The legacy task is broad. Contain it with the fixed archive base/tip, explicit exclusions, one-task write scope, small cohesive commits, targeted checks after each slice, and one final deterministic gate.
- Visual tests can be flaky. Pin browser/runtime inputs, wait for local fonts, control named animation time, and distinguish static pixel baselines from interaction/motion evidence.
- Live providers may be unavailable. Treat fixtures as contract proof and list live Slack tenant checks as a release gate, not as completed evidence; Teams belongs to its later transport release.

## Verify Plan

- `npm run test --workspace @gantry/web -- src/app/app.test.ts src/onboarding-splash.test.ts src/onboarding-step-one.test.ts src/features/onboarding src/features/preferences/preferences-route.test.ts src/ui/primitives/copy-button.test.ts src/features/channel-accounts/channel-account-queries.test.ts`.
- `npm run test:unit -- apps/core/test/unit/control/server/browser-onboarding.test.ts apps/core/test/unit/control/server/browser-agents.test.ts apps/core/test/unit/cli/slack.test.ts` plus the exact existing correlation/projection unit files touched by the transplant.
- Start a disposable `pgvector/pgvector:pg16` container pinned by digest, export its schema-isolated `GANTRY_TEST_DATABASE_URL`, then run `npm run test:integration:postgres -- apps/core/test/integration/onboarding-verification.postgres.integration.test.ts`. The suite covers atomic creation, unique app setup, persisted idempotency conflict/replay, expiry, full correlation, provider-account binding, challenge preservation, and downstream invalidation.
- Run `npm run db:migrations:generate -- --name v2_onboarding` exactly once, inspect generator output, then run `npm run db:migrations:check` and the focused migration-journal unit test.
- Run the repository-owned onboarding visual command at 1920x956, 1469x800, 1280x800, 1024x768, and 768x1024 in dark/light, saved/system reduced motion, named reveal/roll/hover/press/verification frames, keyboard flow, labels, contrast, and 200% zoom. It must fail on any pixel outside documented intentional-difference masks after local fonts load.
- `npm run lint`, `npm run lint:web`, `npm run format:check`, `npm run format:check:web`, `npm run typecheck`, `npm run typecheck:web`, `npm run build:web`, and `npm run build:runtime`.
- Restart the local runtime from the rebuilt branch and retain listener/log proof plus successful `/healthz`, `/readyz`, and `/ui/onboarding` responses before browser functional testing.
- `python3 factory/scripts/verify.py`.
- One direct autoreview helper invocation covering quality, performance, and security, plus `review-animations`; fix blocking findings and rerun affected checks.
- Rebuilt local functional check for splash through Console handoff in light/dark themes, saved/system reduced motion, the named responsive viewports, Back/resume behavior, provider validation/loading, Slack Create → Connect, empty-discovery refusal, approver selection, challenge expiry/replay/correlation, projection retry, and final Console entry.
- Record automated and functional evidence only through Forge recorders. Leave the task branch clean, local, and unpushed with a review-ready PR description and explicit release-only live-tenant proof.
