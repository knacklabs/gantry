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
---

# GANTRY-WEB-FOUNDATION — Safe Web UI foundation shell

## Problem

Gantry has no independently validated web UI starting point. The existing UI
work also includes runtime delivery and administration changes, so it cannot
be merged safely into the hosted runtime as a foundation.

## Scope / Non-goals

In scope: a source-only `apps/web` Vite/React workspace, `/ui` client base
path, responsive shell, disconnected placeholder, browser-only preferences,
web-only commands and CI steps, and a boundary document.

Out of scope: runtime serving or `/ui-api`, authentication, environment
variables, Docker or package contents, API/SDK/contracts, providers, agents,
identity, persistence, migrations, and all product consoles. The existing
full UI branch and identity stash remain untouched.

## Acceptance Criteria

1. `apps/web` independently builds under `/ui` and displays an accessible,
   responsive `Not connected` shell with local preferences.
2. Separate root commands and CI steps run web formatting, typechecking,
   linting, and building.
3. `npm run build:web` creates `apps/web/dist`; normal `npm run build` does
   not create or copy `dist/ui` and production delivery remains unchanged.
4. Documentation states that the workspace has no runtime connection and
   requires a later approved integration PR before it can be served.

## Technical Approach

Extract only the disconnected shell from the prior UI foundation commit. Keep
the existing Vite, React, TanStack router, local preference, typography, icon,
and accessible mobile-navigation patterns when they are actually imported;
remove all data, API, and product-screen code. Add `apps/web` to the current
root manifest without changing existing build, runtime, package, or delivery
scripts. Add three dedicated web validation steps to the existing CI job and
write a narrow architecture boundary document.

The simpler shape is one static document and one disconnected route rather
than a local server, mock API, or feature flags. Those mechanisms have no
consumer in this PR and would violate the source-only boundary.

## Decisions

No new decisions. This implementation follows the approved source-only scope,
including the early-stage no-backcompat and deployment-boundary decisions.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | No runtime imports, routes, environment variables, or serving changes. |
| API | Unchanged by design | No Control API, contract, SDK, or `/ui-api` work. |
| Data/schema | Unchanged by design | No repositories, schema, or migrations. |
| CLI/ops | Unchanged by design | Normal runtime build, Docker, publishing, and deployment stay unchanged. |
| UI | Changed | Adds a disconnected source-only shell and local browser preferences. |
| Docs | Changed | Records the source-only boundary and deferred integration seam. |
| Tests | Changed | CI and deterministic web workspace checks are added; existing runtime lanes remain unchanged. |

## Task Decomposition

**GANTRY-WEB-FOUNDATION-1 — disconnected shell and validation seam.**
Write scope: `apps/web/**`, root `package.json`, `package-lock.json`,
`.github/workflows/ci.yml`, `docs/architecture/web-ui-foundation.md`, and
Factory planning artifacts. This one bounded slice directly satisfies all four
acceptance criteria: it adds the only route, validates it separately, and
keeps production delivery untouched.

## Risks

- A root manifest merge could accidentally modify a production build command.
  Compare the final manifest and run the normal build to prove it did not.
- A Vite base path can be incorrectly assumed to imply server hosting. Search
  for server `/ui` and `/ui-api` routes and document the distinction.
- The shell can accrue unused dependencies. Audit imports before regenerating
  the Node 24 lockfile.

## Verify Plan

Run `npm ci`, `npm run typecheck:web`, `npm run lint:web`, `npm run build:web`,
`npm run format:check`, `npm run typecheck`, `npm run test:unit`,
`npm run test:integration`, `npm run build`, `python3 scripts/check_architecture.py`,
and `python3 factory/scripts/verify.py` with Node 24. Confirm `apps/web/dist`
exists only after `build:web`; inspect the normal build for no `dist/ui`; use
the requested cleanup search and verify the diff excludes `apps/core`,
contracts, SDK, migrations, and Docker.
