---
issue: MDL-1
title: Live provider model discovery and safe registration
status: approved
saved: 2026-08-03T12:00:25+00:00
story: MDL-1
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
---


# MDL-1: Live provider model discovery and safe registration

## Problem

Gantry's durable model catalog is static. When a provider publishes a model, an operator must add a `model_aliases` entry before any agent can select it. The provider already exposes a models endpoint, but Gantry does not use it for discovery. Provider removal is also ambiguous: omission from a live listing must not erase saved aliases, agent defaults, jobs, sessions, or historical run identity.

## Scope / Non-goals

Scope is a provider-neutral discovery service, live discovery for Anthropic/OpenAI-compatible/OpenRouter accounts, merged catalog results, safe registration through the existing desired-state settings revision path, CLI/API exposure, and immutable model identity on new run records. Existing aliases remain selectable when discovery is unavailable or no longer advertises them.

Non-goals are automatic registration, automatic replacement or fallback during execution, a database-backed provider inventory, polling, pricing synchronization, Bedrock/Vertex/Azure discovery, the broader model-management UX in `docs/architecture/model-management-goal-prompt.md`, session cost display, chat switching, thinking controls, and modality auto-upgrade. Those goal-prompt items are explicitly re-scoped from this feature.

## Acceptance Criteria

1. Gantry can fetch current model IDs from configured Anthropic, OpenAI-compatible, and OpenRouter providers using the existing credential boundary.
2. `GET /v1/model-providers/{providerId}/models` returns registered models plus live unregistered models and clear availability/source state; discovery failure retains saved data.
3. `POST /v1/model-registrations` validates a discovered provider model and appends a settings desired-state revision that creates a normal `model_aliases` entry.
4. Registered aliases work everywhere the existing catalog resolver is already used; raw live provider IDs remain invalid selectors.
5. Provider omission never deletes or mutates settings, agents, jobs, sessions, or run rows; an exact unavailable selection fails clearly instead of silently switching models.
6. New agent runs record nullable immutable alias/provider/model/display-name snapshots; existing rows remain valid with null snapshots.
7. CLI commands expose discovery and registration without duplicating model rules.
8. Existing `/v1/models`, model defaults, jobs, agents, and settings flows remain compatible during the additive rollout.

## Technical Approach

1. Add a small provider discovery module behind the current provider registry. It calls the provider-owned models endpoint with the existing credential resolver and auth-header logic. Bound calls to a 5-second timeout, 4 MiB response, 10 pages, and 5,000 models; reject malformed payloads and never log or persist raw responses.
2. Cache successful lists in-process by app/provider/credential version for 15 minutes. Retain the last successful value when refresh fails; deduplicate concurrent refreshes. Do not add a table or poller.
3. Merge live results with `listModelCatalog()`: registered entries always remain, matched entries become `ready`, unmatched live entries become `available_to_register`, registered omissions become `configured_not_advertised`, and discovery errors become `availability_unknown`. Only explicit provider deprecation metadata is labeled deprecated.
4. Add control API contracts/routes for discovery and registration. Registration builds the existing `model_aliases` settings shape and uses the settings desired-state compare-and-swap write path; it never writes YAML or projection tables directly.
5. Add thin SDK and CLI wrappers. The CLI prints the API state and invokes the registration endpoint; it contains no provider parsing or catalog merge logic.
6. Add nullable snapshot columns to `agent_runs` and populate them at run creation from the single resolved catalog entry. Do not backfill or attach foreign keys, so historical rows and removed aliases remain readable.
7. Map an explicit provider invalid-model response to `MODEL_NOT_AVAILABLE` with the selected alias/provider model in the diagnostic. Do not infer discontinuation from discovery omission and do not silently fall back.
8. Roll out additively: discovery first coexists with `/v1/models`; registration only adds normal aliases; merged selectors can adopt the discovery endpoint later without changing stored selectors. The built-in catalog remains the capability baseline and offline fallback.

## Decisions

No new architectural decision is required. The design applies accepted decisions 0000/0006 (credential boundary), 0007/0025/0075 (settings authority and serialized writes), 0008/0009 (canonical Postgres schema), 0015 (durable alias catalog and raw-ID rejection), and 0018 (provider-neutral execution). Live listings are observations, not desired state; durable registration remains `model_aliases`.

## Surface Impact

| Surface | Change |
| --- | --- |
| API/contracts/SDK | Add discovery and registration requests/responses; preserve `/v1/models`. |
| CLI | Add `gantry model discover` and `gantry model register`. |
| Settings/control plane | Reuse `model_aliases` and desired-state revision CAS. |
| Runtime | Existing alias resolver consumes registered aliases; add explicit unavailable error mapping. |
| Storage | Add nullable immutable model identity snapshots to `agent_runs`; no inventory table or destructive backfill. |
| Providers/security | Provider-specific parsing stays in adapters; credentials remain brokered and responses bounded/redacted. |
| Channels/jobs/memory | No new selector path; they inherit registered aliases through the current resolver and retain stored aliases on omission. |
| Documentation/operations | Document supported discovery providers, cache semantics, registration, and safe failure behavior. |

## Task Decomposition

1. Discovery vertical slice: contracts, bounded provider fetchers, cache/merge service, read-only API, SDK, CLI, and focused tests.
2. Durable registration vertical slice: validate discovery selection, write `model_aliases` through desired-state revision, expose API/SDK/CLI, and prove aliases resolve through existing agent/job paths.
3. Historical identity vertical slice: timestamped Drizzle migration, run snapshot population/readback, explicit unavailable-model error, and migration/repository/runtime checks.

## Risks

- Provider APIs differ in pagination and metadata. Keep parsers provider-owned and normalize only ID, display name, deprecation, and basic capability hints.
- Custom OpenAI-compatible endpoints can be unsafe. Reuse configured provider endpoints and existing outbound restrictions; do not accept arbitrary discovery URLs from requests.
- Live listings are incomplete or transient. Saved aliases always win durability, empty/failed refreshes never replace the last good cache, and omission is informational only.
- Concurrent registration can lose settings changes. Require the existing expected revision and surface conflicts for retry.
- Snapshot schema can drift from run creation. Populate at the canonical run creation boundary and verify repository round-trip.

## Verify Plan

- Run focused unit tests for adapter parsing, response bounds, cache refresh/deduplication, and catalog merge states.
- Run control API tests for authorization, discovery failure, successful registration, and settings revision conflict.
- Run canonical Postgres migration/repository tests for clean migration, nullable historical rows, and new run snapshots.
- Run one fake-provider agent flow proving a registered live model resolves and an explicit unavailable response does not fall back.
- Run repository deterministic verification with `python3 factory/scripts/verify.py`, then the required single autoreview and functional check because the API/CLI behavior is user-visible.
- Search for direct selector acceptance of provider IDs and direct settings writes; both must remain absent outside the canonical parser/revision paths.
