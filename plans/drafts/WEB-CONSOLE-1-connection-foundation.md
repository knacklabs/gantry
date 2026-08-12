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
  - 0124-web-runtime-console-read-only-integration
---

# WEB-CONSOLE-1 — Connection foundation

## Problem

`apps/web` is a high-fidelity preview backed entirely by fixture data. Gantry
already has authenticated Control API reads for health and agents, but direct
browser access would expose an API key and couple the UI to runtime internals.
Operators therefore cannot tell whether the preview represents the deployment
they are operating.

## Scope / Non-goals

Build the smallest private/local connection path: serve the built UI at `/ui`,
provide `/ui/api/connection` and `/ui/api/agents`, and make Overview and
Agents consume those real reads. Reuse `@gantry/sdk`, existing shadcn-derived
primitives, query helpers, and the current visual system.

Do not add OIDC, roles, public deployment, mutations, agent creation,
instances, metrics, skills, capabilities, activity, SSE, a database
connection, a new API framework, a new cache service, or a new UI dependency.
No frontend unit, component, browser-automation, E2E, snapshot, or visual
regression suite is added; the user explicitly excluded UI-side test suites.

## Acceptance Criteria

1. A production command serves the built application at `/ui` and returns the
   application shell for known client-side deep routes.
2. A server-held Control API key is the only credential used for
   `/ui/api/connection` and `/ui/api/agents`; it is absent from browser code,
   HTML, network requests, and UI logs.
3. The UI API calls `@gantry/sdk` against existing `/v1/health` and
   `/v1/agents` routes, converts only the necessary fields to browser-safe
   models, and returns safe error codes and request IDs on failure.
4. Overview and Agents show real values and explicit loading, empty,
   disconnected, stale, retry, and partial-panel states. Production routes do
   not use fixture data or invented zero values.
5. Visible pages refresh at the approved cadence (30s connection/overview,
   agents only on visible list load/manual refresh in this phase), stop while
   the document is hidden, back off to five minutes after errors, and coalesce
   duplicate manual requests.
6. Existing desktop layout, keyboard focus, reduced-motion support, and
   light/dark tokens remain intact. State changes use short opacity/color
   transitions that do not delay interaction or shift layout.

## Technical Approach

Use the existing `apps/web` workspace as a Vite client plus a small Node
standard-library server. The server serves `dist`, applies the `/ui` base path,
and owns two UI API routes. It constructs `GantryClient` from server-only
environment variables for the Control API base URL, key, optional Unix socket,
and a bounded timeout. Invalid/missing server configuration yields an explicit
disconnected response; it must not read fixtures.

The server maps the existing SDK responses to narrow browser models. The
connection model contains only status, process role, and available feature
flags. The agent list contains stable ID, name, status, creation/update times,
and any existing safe agent fields required by the directory. It forwards no
credentials, transport socket path, authorization scopes, internal errors, or
raw response payloads. Unknown failures return a UI API error envelope with a
fresh request ID and a retryable flag, without logging secrets.

On the client, replace preview queries with a small `fetch` helper and
TanStack Query configuration that respects visibility, stale data, retry
backoff, cancellation, and deduplication. The connection indicator, Overview,
and Agents compose the existing `ConnectionState`, `PageState`, `Skeleton`,
`Empty`, `Alert`, `Panel`, `MetricTile`, `DataTable`, `Badge`, and `Button`
primitives. Delete Phase-1-irrelevant navigation and route wiring rather than
leave a second fixture product tree reachable in production.

The recommended hosting shape is a separate web process beside Gantry, not a
new route mounted inside the runtime Control API. It keeps browser concerns and
credentials at the adapter boundary from decision 0005. The web server uses the
SDK instead of `fetch`ing `/v1/*` itself, and it does not introduce a framework
or a distributed cache.

## Decisions

- [0124-web-runtime-console-read-only-integration.md](../../docs/decisions/0124-web-runtime-console-read-only-integration.md): the private read-only UI API holds credentials and consumes the Control API through `@gantry/sdk`.
- No additional decision is required: server process placement, two existing
  read routes, visual subset, polling cadences, and deferred scope are all
  approved in [web-runtime-console-phase-1.md](../../docs/specs/web-runtime-console-phase-1.md)
  and the full approved design.

## Surface Impact

| Surface | Classification | Reason |
|---|---|---|
| Runtime behavior | Unchanged by design | The UI server consumes existing reads and does not change agent execution. |
| API | Changed | Adds private `/ui/api` browser-safe read adapters; existing `/v1` contracts stay unchanged. |
| Data/schema | Unchanged by design | Phase 1 stores no UI data and issues no migration. |
| CLI/ops | Changed | Adds a bounded command/configuration path for serving the web artifact locally. |
| UI | Changed | Replaces fixture Overview/Agents with live, resilient views and trims production navigation. |
| Docs | Changed | Revises the source-only web-boundary documentation and documents environment configuration. |
| Tests | Changed | Adds focused server/API contract coverage only; frontend UI suites remain excluded by the approved scope. |
| Auth/RBAC | Deferred | OIDC and roles are explicitly deferred until before a network-exposed deployment. |
| Metrics/instances/activity | Deferred | These are separately approved Phases 2–4 and must be planned after Phase 1 proves the boundary. |

## Task Decomposition

1. **Serve and protect the UI boundary.** Add the app-local Node server,
   server-only configuration validation, static/deep-route serving, and the two
   SDK-backed safe read models. This task satisfies criteria 1–3.
2. **Connect the operational UI.** Replace preview queries/navigation/routes
   with the approved subset, compose the existing primitives for connection,
   loading, empty, stale, retry, and partial failures, and apply non-blocking
   motion/visibility-aware refresh behavior. This task satisfies criteria 4–6
   and depends on task 1.

## Risks

- The existing app is source-only, so build/package scripts could accidentally
  make the runtime image serve assets or leak environment values. Keep its
  server command separate and prove the generated browser bundle contains no
  configured key.
- The Control API uses a privileged key. Treat all errors as untrusted at the
  UI boundary and project only known fields.
- Runtime availability changes while a page is open. Preserve the last known
  good view, label it stale, and never block navigation or interaction while
  refetching.
- The UI currently has broad fixture routes. Remove their production navigation
  and route registrations as part of this clean cut; retain only reusable
  primitives and the development component lab.

## Verify Plan

- `npm run format:check:web`
- `npm run lint:web`
- `npm run typecheck:web`
- `npm run build:contracts && npm run build:sdk && npm run build:web`
- focused server/API contract command selected during JIT task planning
- `python3 factory/scripts/verify.py`
- manual functional acceptance check for `/ui` and deep links using
  `agent-browser`, including the real-data, disconnected, retry, stale, light,
  dark, keyboard-focus, and reduced-motion states

No frontend UI test command is planned, per the approved scope. A dependency
installation is not planned; existing `@gantry/sdk`, React Query, TanStack
Router, and installed shadcn-derived primitives cover this phase.
