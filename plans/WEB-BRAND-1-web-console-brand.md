---
decisions_reviewed: [0000-credential-broker-boundary, 0001-agent-runtime-platform, 0002-symphony-forge-adoption, 0003-early-stage-no-backcompat, 0004-gantry-naming-and-public-repo, 0005-runtime-stack, 0006-config-secret-source-boundary, 0007-settings-runtime-truth, 0008-storage-backend-cutover, 0009-canonical-domain-schema-cutover, 0010-claude-runtime-materialization, 0011-provider-session-artifact-store, 0012-browser-capability-boundary, 0013-runtime-event-exchange, 0014-external-ingress-vs-outbound-webhooks, 0015-model-catalog-and-cache-accounting, 0016-event-bus-outbox-boundary, 0017-jsonb-runtime-payload-boundary, 0018-provider-neutral-agent-execution-adapter, 0019-simple-permission-and-job-tool-lifecycle, 0020-mcp-source-vs-action-capability, 0021-capability-artifacts, 0022-delivery-vehicle, 0023-deployment-modes, 0024-locked-preset, 0025-settings-authority, 0027-process-roles-and-multi-live, 0028-agent-harness-selection, 0029-agent-communication-reaction-binding, 0030-agent-communication-reasoning-safety, 0031-send-message-files-authority, 0032-signed-artifact-links-deferred, 0033-teams-reactions-deferred, 0034-client-signoff, 0035-epics-approved, 0040-permission-execution-two-axis-model, 0041-client-signoff, 0042-decision-view-16k-prefix-stripped, 0043-classifier-risk-only-engine-authz, 0044-ci-runner-isolation, 0045-inbound-attachment-descriptor-writer, 0046-llm-process-local-admission, 0050-agent-removal-projection-cleanup, 0051-client-signoff, 0052-birthright-self-surface, 0053-permission-no-timeout-interactive, 0054-decision-provenance-and-risk-label, 0055-client-signoff, 0056-durable-cancellation-invariant, 0057-arch1-client-signoff, 0058-readonly-scheduler-birthright, 0062-perm6-client-signoff, 0063-perm7-client-signoff, 0064-client-signoff, 0065-perm8-client-signoff, 0066-race-1-skill-artifact-app-isolation, 0067-client-signoff, 0068-race-2-cluster-fenced-settings-projection, 0069-client-signoff, 0070-client-signoff, 0071-race-4-browser-profile-lock-aba, 0072-client-signoff, 0073-race-6-profile-mirror-version-guard, 0074-race-8-mandatory-atomic-async-admission, 0075-race-9-serialize-file-backed-settings-write, 0076-client-signoff, 0077-race-5-lease-loss-lifecycle, 0078-lat-3a-single-memory-hydration-per-turn, 0079-client-signoff, 0080-lat-3b-retain-authoritative-second-fetch, 0081-client-signoff, 0082-fence-1-durable-lease-generation, 0083-conv-001-client-signoff, 0084-client-signoff, 0085-lat-4a-fused-inbound-envelope-transaction, 0086-client-signoff, 0087-lat-5-durable-provider-history-coverage, 0088-client-signoff, 0089-thread-turns-read-channel-context, 0090-sender-allowlist-trigger-only, 0091-client-signoff, 0092-client-signoff, 0093-client-signoff-is-a-pinned-project-gate, 0094-conversation-file-trust-program, 0095-client-signoff, 0096-thread-recency-message-timestamp, 0097-public-session-conversation-aggregate, 0098-streamed-message-projection-timing, 0099-rate-limits-singleton-authority, 0100-mig-1-client-signoff, 0101-oidc-generic-google-first, 0102-runtime-hardening-audit-harvest, 0103-live-admission-terminal-retention, 0104-co-1-recovery-intent-reframe, 0105-physical-attachment-workspace-handoff, 0106-scheduled-runs-cannot-mutate-jobs, 0107-typed-permission-decision-provenance, 0108-job-definition-revision-fencing, 0109-semantic-capability-job-dependencies, 0110-live-ux-capability-dispatcher, 0112-legacy-single-canonical-shape, 0113-enforce-no-backcompat-architecture-check, 0114-canonical-job-owner, 0115-autonomous-tool-denial-terminal, 0117-scheduled-job-declare-tools-at-creation, 0118-identity-scoped-approval-and-grants, 0119-provider-neutral-group-approver-bootstrap, 0120-local-cli-structured-invocation, 0121-autodet-no-classifier-autonomous, 0122-capability-template-amendment, 0123-recovery-proposal-birthright, 0124-bounded-durable-card-delivery, 0125-host-only-template-amendment, 0126-typed-terminal-denial-event, 0127-tagged-setup-action-model, 0128-permission-approval-result, 0129-capsafe-local-cli-terminal-wildcard, 0130-capsafe-capability-run-dispatch-only, 0132-adaptive-browser-authentication-access, 0133-gantry-tool-correlation-response-meta, 0135-browser-model-provider-credential-facade]
---

# WEB-BRAND-1 — Gantry Web Console Logo Assets

## Problem

The web console still presents temporary boxed `G` badges and an inline legacy
favicon rather than one crisp, reusable Gantry identity mark.

## Scope / Non-goals

Deliver the approved concept-23 mark for the browser console's shared auth,
sidebar, favicon, and touch-icon surfaces. Preserve all existing live
wordmarks, copy, routes, layout, authentication behavior, and Google sign-in.
Do not add a PWA manifest, extra icon exports, images fetched from elsewhere,
configuration, API, schema, persistence, or runtime changes.

## Acceptance Criteria

1. Auth and sidebar use the canonical accessible visual mark without legacy G
   badges.
2. The built console serves the canonical mark, favicon, and 180px touch icon
   under `/ui/`.

## Technical Approach

Add one transparent public SVG containing exactly three 7 by 7 modules at the
approved coordinates. Add one small internal `GantryMark` component that
resolves this SVG from `import.meta.env.BASE_URL` and uses it as a
`currentColor` CSS mask. Replace the two shared badge consumers, preserving the
existing live text. Add the tiled favicon and use installed Sharp once to render
the 180px touch icon. Cover geometry, consumers, links, removal of the legacy
assets, and PNG dimensions with one source-focused Vitest test.

## Decisions

No new decisions. This plan follows the confirmed visual contract and existing
Vite, React, Tailwind, Vitest, and Sharp installations. CSS masking is the
smallest same-origin asset reuse mechanism and avoids a second inline vector
copy; Sharp is already installed and is used only to produce the required PNG.

## Surface Impact

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | Static identity assets do not affect auth or runtime behavior. |
| API | Unchanged by design | No browser facade or Control API changes. |
| Data/schema | Unchanged by design | Branding has no durable state. |
| CLI/ops | Unchanged by design | No operator command or deployment configuration changes. |
| UI | Changed | Replace the shared visual identity consumers and browser icon links. |
| Docs | Changed | The confirmed WEB-BRAND-1 visual contract records the approved asset rules. |
| Tests | Changed | One focused asset and consumer test proves the static contract. |

## Task Decomposition

1. `WEB-BRAND-1-1` — Add the canonical SVG, favicon, touch icon, masked mark
   component, shared auth/sidebar integrations, and focused asset test.
   `user_facing: true`. Serves both acceptance criteria.

## Risks

CSS masks can regress only if the canonical public path is wrong. The focused
test verifies the base-resolved component source and the build verifies copied
assets beneath `/ui/`. The mark is decorative where live text remains.

## Verify Plan

- Run the web test, typecheck, lint, format check, and build commands.
- Run the deterministic factory verifier and `git diff --check`.
- Inspect auth stacking below 60rem, authenticated navigation in both themes,
  and browser-icon output at its intended dimensions.
- Run one branch autoreview covering quality, performance, and security.
