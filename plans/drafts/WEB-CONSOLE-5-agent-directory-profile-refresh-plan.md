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
  - 0043-classifier-risk-only-engine-authz
  - 0050-agent-removal-projection-cleanup
  - 0052-birthright-self-surface
  - 0054-decision-provenance-and-risk-label
  - 0056-durable-cancellation-invariant
  - 0066-race-1-skill-artifact-app-isolation
  - 0068-race-2-cluster-fenced-settings-projection
  - 0074-race-8-mandatory-atomic-async-admission
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0101-oidc-generic-google-first
  - 0103-live-admission-terminal-retention
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0109-semantic-capability-job-dependencies
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0124-web-runtime-console-read-only-integration
---

# WEB-CONSOLE-5 — Agent directory and profile refresh

## Problem

The existing private console lists agents but does not give operators a concise,
truthful view of configured composition, safe access state, and real observed
work. The profile must distinguish these concepts and retain the server-held
Control credential boundary.

## Scope / Non-goals

Change only the Agents directory and runtime agent profile. Add read-only
agent-scoped activity, safe profile projections, SDK typing, and its Postgres
index. Do not change shared console styling, other routes, authentication,
roles, imports/reconciliation, restarts, raw event data, or any write action.

## Acceptance Criteria

1. The Agents directory remains locally debounced and responsive; Enter applies
   its pending filter without navigation or a refetch.
2. A profile has exactly Summary, Delegation, Skills & capabilities, Access,
   and Activity tabs. It separates persisted status, configured delegation,
   access, and observed work.
3. UI projections contain only allowlisted values; partial dependent failures
   are named unavailable rather than reported as zero.
4. Agent activity is app-owned, newest-first, bounded to 20 in the facade, and
   uses the composite `(app_id, agent_id, created_at DESC, id DESC)` index.
5. Control API, repository, SDK, and UI-facade coverage prove input bounds,
   ordering, ownership, redaction, and partial availability. No client-side UI
   test suite is added; manual local acceptance covers the changed screens.

## Technical Approach

1. Extend the existing activity route and agent-run repository method with a
   validated optional agent filter and limit. Preserve the no-query newest-50
   response. Add the one matching Drizzle index and migration.
2. Reuse the SDK and existing server-held UI facade. Add typed catalog access
   and skill results, then make the facade allowlist its overview, catalog joins,
   jobs, and activity projection. Use a small module-local 60-second capability
   catalog cache with in-flight promise reuse; do not cache profile, access, or
   activity results.
3. Rewrite only the Agents routes and add scoped styles. Keep the existing
   primitives and tokens. The profile eagerly loads its overview and lazily
   loads each tab; it polls activity only while an observed run is nonterminal.
4. Update the web-console design documentation with the safe-profile boundary.

## Decisions

No new decisions. The existing private read-only UI boundary (0124), PostgreSQL
cutover (0008), capability artifact boundary (0021), and early-stage no
backcompat rule (0003) govern this work. Legacy tab query values map at read
time only; they are not a second rendered profile shape.

## Surface Impact

| Surface | Status | Rationale |
| --- | --- | --- |
| Runtime behavior | Changed | Read-only agent-scoped activity is added. |
| API | Changed | Activity query, SDK, and safe facade projections change. |
| Data/schema | Changed | One bounded query path and matching Postgres index are added. |
| CLI/ops | Unchanged by design | This is a browser observation surface with no operator command change. |
| UI | Changed | Only Agents directory and profile get scoped presentation and lazy sections. |
| Docs | Changed | The web-console design records the safe-profile boundary. |
| Tests | Changed | Control, repository, SDK, facade contract, build/typecheck/lint, migration, and manual checks prove it; client UI tests are explicitly out of scope. |

## Task Decomposition

1. Control activity filter and repository index serve criteria 3 and 4.
2. SDK and UI facade projections serve criteria 3 through 5.
3. Agents route refresh and scoped styles serve criteria 1, 2, and 5.

## Risks

- Capability and skill catalog responses are broad. The facade will permit only
  the documented profile fields and fall back to safe IDs when a catalog is
  unavailable.
- Agent state is configuration state, not process liveness. Profile copy and
  badges will use persisted status only; run status belongs in Activity.
- Existing activity detail owns event/task-tree rendering. The profile links to
  it instead of reproducing it.

## Verify Plan

- Focused Control route/repository tests cover malformed and repeated query
  inputs, ownership, limit bounds, ordering, and empty data.
- SDK transport and UI-server contract tests cover typed URL/query formation,
  catalog redaction/fallback, partial overview unavailability, and activity
  projection.
- Run the deterministic web build, typecheck, lint, migration verification,
  and UI-server contract runner.
- Perform one local dark/light manual pass through search, all five tabs,
  unavailable data, and run navigation.
