---
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
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
---

# WEB-PROVIDERS-2 — Correct registry-driven credential setup

## Problem

The shared provider dialog silently chooses the first authentication method, ignores registry help and multiline presentation, sends blank fields during rotation, cannot reactivate a disabled credential without replacing its hidden values, and describes a local Gantry preflight as upstream verification.

## Scope / Non-goals

Implement the correction through the executable provider registry, existing model-credential application service, same-origin browser facade, and shared web dialog. Preserve write-only secret handling and all browser authorization controls.

Non-goals: provider-specific forms, new HTTP routes, new provider SDKs, network probes, persistence migrations, model-selection changes, background monitoring, browser-readable secrets, or behavior changes to the Bearer Control API and CLI.

## Acceptance Criteria

- Multi-method providers require explicit authentication selection before fields or save are available, while single-method providers remain compact.
- Same-method edits and disabled reactivation use sparse PATCH with atomic merged validation; method replacement uses complete PUT.
- Registry help text, required fields, configured field names, and multiline presentation reach the shared browser form without secret values.
- Configuration checks describe Gantry-side credential availability and never claim upstream connectivity.
- Focused automated and synthetic browser checks cover every provider mode without real credentials or upstream calls.

## Technical Approach

1. Add optional `multiline: true` to the existing credential field definition, set it only on Vertex `serviceAccountJson`, and include it in the registry-derived sanitized metadata. Expose the already-returned `configuredFields` and multiline hint in the web type.
2. Extend `ModelCredentialService.rotate` with an explicit browser-only reactivation option that defaults off. When enabled for a disabled credential, accept an empty or sparse object, merge it with the stored payload, validate the complete payload, and activate only through the existing atomic upsert. The same-origin browser facade opts in; Bearer API and CLI callers retain current rejection behavior.
3. Make the dialog mode controlled: current stored mode for existing credentials, the only mode for single-mode first setup, and no mode for multi-mode first setup. Render the existing `SelectField`, `Input`, and `Textarea` primitives from registry metadata; reset the form when mode or provider changes.
4. Construct submissions from the selected mode. Same-mode edits/reactivation use PATCH with non-empty fields only; first setup and method replacement use PUT with `authMode` and all required values. Show replacement and stored-field guidance without exposing values.
5. Rename the action and safe response copy to `Check configuration`, describing only whether Gantry can resolve and project the credential.

## Decisions

No new architecture decision is required. The plan applies accepted decisions 0000, 0001, 0003, 0006, 0007, 0132, and 0135. It reuses the repository-mandated TypeScript, React, Radix primitives, Vitest, ESLint, Prettier, and architecture checker because they already own these surfaces; no tooling or library choice is introduced.

The browser-only opt-in on the existing rotation service is preferred over changing rotation globally because the approved scope explicitly preserves Bearer API and CLI behavior. A separate endpoint or provider-specific reactivation service is rejected as unnecessary.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Browser-managed disabled credentials can reactivate after merged validation and atomic persistence. |
| `settings.yaml` | Unchanged by design | Provider credential values and UI metadata do not belong in settings. |
| Postgres/runtime projection | Read-only | Existing encrypted payload and atomic upsert contracts are reused without schema or repository changes. |
| Control API | Changed | Same-origin browser PATCH opts into reactivation and safe preflight copy changes; Bearer routes remain unchanged. |
| SDK/contracts | Unchanged by design | The browser DTO is internal to the console and no public SDK contract changes. |
| CLI/ops | Unchanged by design | CLI disabled-rotation rejection and commands remain unchanged. |
| Gantry MCP/admin skill | Unchanged by design | No MCP credential-management surface participates in this browser flow. |
| Channel/provider adapters | Read-only | Executable provider registry metadata is consumed; provider execution and SDK adapters do not change. |
| UI | Changed | Shared dialog gains explicit method selection, help text, stored indicators, multiline input, sparse updates, and accurate copy. |
| Docs/prompts | Changed | Credential architecture and confirmed capability spec document the browser-only reactivation contract. |
| Audit/events | Unchanged by design | Existing credential-updated audit event is emitted only after successful upsert. |
| Tests/verification | Changed | Focused service, registry, web request/state, and synthetic browser proof are required. |
| Data/schema | Unchanged by design | No migration, table, column, or stored payload shape changes. |

## Task Decomposition

### T1 — Registry metadata and browser reactivation contract

`user_facing: false`

Own the registry field hint, sanitized service metadata, browser-only rotation option, same-origin route opt-in, safe preflight response copy, and focused core tests.

Acceptance served: sparse PATCH atomicity; registry metadata and secret containment; honest configuration semantics; provider-mode coverage.

Expected shape: extend existing types and service/route branches only. Keep validation in the registry normalizers, persistence in the existing repository upsert, and the route thin. Do not add a provider abstraction, endpoint, schema, or new error vocabulary.

### T2 — Shared credential dialog behavior

`user_facing: true`

Own the web client type, controlled mode/form state, generic selection/help/stored/multiline rendering, request construction, copy, and focused web plus synthetic browser tests.

Acceptance served: explicit first selection; compact single-mode forms; sparse PATCH versus complete PUT; draft clearing; configured-field display; accurate check copy; representative provider UI proof.

Expected shape: reuse existing `SelectField`, `Input`, `Textarea`, dialog, and inline live-region patterns. Keep request construction as a small pure function that focused Vitest can falsify; keep the component responsible only for state, rendering, and calling the existing facade. No new dependency, provider component, animation, or design-system primitive.

## Risks

- A disabled credential could activate before validation. Prevent this by validating the fully merged payload before the single upsert and test invalid input leaves status and fingerprint unchanged.
- A hidden default mode could return. Make the request builder return no request without an explicit multi-mode selection and test it.
- Blank fields could erase stored values. Filter empty strings before PATCH and test the stored payload/fingerprints retain omitted fields.
- Registry metadata could leak secrets. Return names, labels, booleans, and fingerprints only; assert serialized responses exclude supplied values.
- Uncontrolled inputs could survive a mode/provider change. Remount/reset the form on both transitions and prove it in the functional check.

## Verify Plan

- `npm run test:unit -- apps/core/test/unit/core/model-provider-registry.test.ts apps/core/test/unit/core/model-credential-service.test.ts apps/core/test/unit/auth/browser-auth-routes.test.ts`
- `npm run test --workspace @gantry/web -- src/features/operations/routes/providers-route.test.ts`
- `npm run typecheck:web`
- `npm run lint:web`
- `npm run format:check:web`
- `python3 scripts/check_architecture.py`
- `python3 factory/scripts/verify.py`
- One autoreview pass with quality, performance, and security lenses.
- Functional browser check for Bedrock, Anthropic, Vertex, and one single-key provider using synthetic same-origin responses and no real credentials.

