# Gantry Web Runtime Console — Phases 1–4 Design

**Date:** 2026-08-12

**Status:** Approved design; implementation has not started

**Scope:** A private/local, read-only web console for the one Gantry deployment serving it

## 1. Goal

Turn the existing fixture-backed web foundation into a useful operations console connected to the Gantry Control API. The console must show:

- deployment health and runtime processes;
- agents in the deployment;
- configured agent delegation, skills, capabilities, and access;
- bounded 30-day AI usage and runtime metrics; and
- live parent/child agent execution hierarchy.

The first implementation milestone is connection correctness, not feature breadth. Each phase below is a separate implementation cycle with its own approved plan, decomposition, backend/API verification, review, and required one-pass functional check. UI-side automated tests are excluded.

## 2. Product Boundaries

### Included

- One Gantry deployment, whether it runs as a workstation `all` process or as `control`, `live-worker`, and `job-worker` processes.
- A separately buildable web application that communicates only through HTTP APIs.
- A thin server-side UI API under `/ui/api/*` that holds the Control API credential.
- Full read access for the current private/local user; there are no UI roles in this scope.
- The existing UI's visual language, navigation proportions, tokens, primitives, light/dark themes, and compact operational density.
- Read-only screens and passive live updates.

### Excluded from phases 1–4

- OIDC, login, RBAC, user management, or public/network deployment.
- Mutations, agent creation, agent restart, instance restart, pause, disable, reconcile, or configuration editing.
- Multiple Gantry deployments, environments, or cross-deployment aggregation.
- Chat, conversations, memory, jobs management, models, workflows, guardrails, providers, people, external systems, and profile management.
- A new metrics vendor, Redis, a browser-held Control API key, or direct browser/database access.
- A new visual-regression framework.

OIDC is a deployment prerequisite before exposing the console beyond a trusted private/local environment, but it is deliberately not part of phases 1–4.

## 3. Current State and Gaps

### Existing assets to reuse

- `apps/web` is a Vite/React UI foundation with reusable layout, navigation, status, metric, panel, and table primitives.
- The Control API already exposes authenticated health, agents, agent administration, delegates, skills, capabilities, access, usage, sessions, and jobs contracts.
- `@gantry/sdk` is the supported client boundary for Control API calls.
- `/healthz`, `/readyz`, and `/metrics` already calculate operational state for the running process.
- The worker registry already lists registered execution workers.
- `agent_runs` already records run status and start/end timestamps.
- Async tasks already record `parentRunId`, delegated-agent work, status, progress, outcome, and failure, with a safe public DTO.
- Runtime model usage events already carry tokens, cache usage, provider status, model, and cost data.

The design follows the repository's accepted boundaries: decision 0005 keeps the Admin Web UI separate from runtime internals, decision 0025 makes Control API settings endpoints the future UI authority, decision 0027 defines the `all`/`control`/worker process roles, and decision 0013 places retention at the Runtime Event Exchange seam. There is no shipped 30-day cleanup owner today; Phase 3 must add the smallest operator-owned path consistent with that decision.

### Missing linkages

| User need | Current source | Missing connection |
|---|---|---|
| UI connection state | `/v1/health` | UI API adapter and real client state |
| Agents | `/v1/agents` and agent admin APIs | UI API routes and fixture removal |
| Runtime instances | current process state plus worker registry | authenticated Control API projection |
| Instance health/capacity | readiness and metrics calculations | shared structured response, not Prometheus parsing |
| Skills/capabilities/access | existing agent APIs | lazy UI detail routes |
| Configured hierarchy | delegate configuration | hierarchy presentation |
| Usage metrics | `/v1/usage` | cache/cost/hourly aggregation and bounded history |
| End-to-end duration | `agent_runs` | bounded runtime performance query |
| Live hierarchy | `agent_runs` plus async tasks | app-scoped list/detail/task APIs and run-scoped events |

The UI must not recreate runtime business logic. New backend work only exposes safe, structured projections from sources the runtime already owns.

## 4. Recommended Architecture

```text
Browser
  -> GET /ui/*                 React application
  -> GET /ui/api/*             thin UI API
       -> @gantry/sdk
          -> /v1/*             authenticated Control API
             -> existing repositories and runtime calculations
```

`apps/web` remains a separate application, consistent with the runtime-stack decision. It becomes a Vite/React bundle plus the smallest server-side UI API needed to hold credentials, normalize UI-facing errors, combine screen-level reads, and proxy run event streams.

The UI API:

- never imports runtime internals;
- never queries Postgres directly;
- never sends the Control API key to the browser;
- does not duplicate authorization or domain decisions;
- does not parse the Prometheus text endpoint;
- may combine existing calls only when that reduces browser round trips for one screen; and
- proxies SSE without buffering or retaining events.

Initially, the UI artifact is packaged beside Gantry and points to the local deployment's `all` or `control` process. The same artifact can later run on another service by changing its server-side Control API base URL and credential. That portability does not change the browser contract.

### Credential scopes

Reuse existing Control API scopes rather than create a UI-specific authorization model:

- `sessions:read` for health and read-only activity;
- `agents:admin` for the existing agent configuration views; and
- `usage:read` for metrics.

The current private/local user has access to all screens. UI roles are deferred until authentication is designed.

## 5. Information Architecture and Existing Style

### Primary navigation

```text
Operations
  Overview
  Live activity

Administration
  Agents

Runtime
  Instances
  Metrics
```

### Nested pages

```text
/overview

/activity
/activity/:runId
  Task tree
  Events

/agents
/agents/:agentId
  Identity
  Delegation
  Skills
  Capabilities
  Access
  Recent activity

/instances
/instances/:instanceId
  Overview
  Health
  Capacity
  Runtime capabilities

/metrics
  Overview
  Usage
  Runtime
```

Configured delegation and live execution are intentionally separate: agent pages answer “what may delegate to what,” while Live activity answers “what is running or ran beneath this run.”

### Visual continuity

Keep the existing approximately 232px grouped sidebar, application header, connection state, theme control, page headers, metric tiles, panels, data tables, status badges, Spline Sans/Mono typography, and existing light/dark tokens. Preserve reusable primitives and the development component lab.

Remove irrelevant fixture routes from the production route tree and navigation. Do not copy the reference images exactly; use their operational density, clear nesting, health emphasis, and drill-down pattern within the existing Gantry UI system.

### Screen behavior

- **Overview:** connection status, deployment summary, instance health, agent/run counts, current capacity, and attention items. Every card links to its owning page.
- **Instances:** one row per known process with role, state, last heartbeat, work state, capacity, and runtime capabilities. Detail tabs expose the same structured data without raw Prometheus output.
- **Agents:** searchable list with status and counts. Agent details load delegation, skills, capabilities, access, and recent activity only when their tab opens.
- **Metrics:** small summary cards and bounded charts for 24h, 7d, or 30d; default 24h. Missing signals say “Unavailable,” never zero.
- **Live activity:** recent and active parent runs. A run detail renders a keyboard-accessible task tree plus an event list and uses SSE only while visible.

## 6. API Design

### UI API routes

The UI API is private to the web application and deliberately unversioned. It translates existing versioned Control API contracts into browser-safe screen resources.

| Phase | UI API | Backing Control API |
|---|---|---|
| 1 | `GET /ui/api/connection` | existing `GET /v1/health` |
| 1 | `GET /ui/api/agents` | existing `GET /v1/agents` |
| 2 | `GET /ui/api/overview` | agents plus new runtime summary |
| 2 | `GET /ui/api/instances` | new `GET /v1/runtime/instances` |
| 2 | `GET /ui/api/agents/:agentId` | existing agent admin read |
| 2 | `GET /ui/api/agents/:agentId/delegates` | existing delegate read |
| 2 | `GET /ui/api/agents/:agentId/skills` | existing skill read |
| 2 | `GET /ui/api/agents/:agentId/capabilities` | existing capability read |
| 2 | `GET /ui/api/agents/:agentId/access` | existing access read |
| 3 | `GET /ui/api/metrics/usage` | extended `GET /v1/usage` |
| 3 | `GET /ui/api/metrics/runtime` | new bounded runtime performance API |
| 4 | `GET /ui/api/activity/runs` | new `GET /v1/agent-runs` |
| 4 | `GET /ui/api/activity/runs/:runId` | new run detail API |
| 4 | `GET /ui/api/activity/runs/:runId/tasks` | new safe task projection |
| 4 | `GET /ui/api/activity/runs/:runId/events` | new JSON/SSE run event API |

Agent detail tabs use separate requests. There is no eager “load every agent relation” aggregate.

### Runtime instance projection

`GET /v1/runtime/instances` combines:

1. the request-serving `control` process, or the current workstation `all` process; and
2. registered `live-worker` and `job-worker` records from the existing worker registry.

The current process entry uses a clearly synthetic identity such as `control:self` and `source: current_process`. A workstation `all` process that also appears in the worker registry is deduplicated by its worker ID. Worker entries retain their registered IDs.

Each item exposes only operational fields needed by the UI: process role, observed state, last heartbeat, readiness summary, draining state, queue/work state, slot/capacity counts, and runtime capability names. It omits credentials, leases, internal correlation values, and provider secrets.

This scope inventories the request-serving control process, not every replica behind a future load balancer. A multi-control registry is a separate future requirement.

### Runtime summary

A structured runtime summary reuses the calculation functions behind readiness and metrics. It does not call or parse `/metrics`. It reports deployment state, known instance counts by role/state, current work/backlog, and capacity signals required by Overview.

The internal `/healthz`, `/readyz`, and `/metrics` endpoints keep their existing operational purpose and remain unavailable to the browser.

### Usage and performance metrics

Extend the existing usage aggregation instead of introducing a parallel telemetry store. Supported outputs include:

- request and run counts;
- input and output tokens;
- cache read and cache write tokens;
- recorded cost and the currency/unit already present in normalized usage;
- model and agent grouping;
- status distribution; and
- UTC time buckets.

Time ranges are fixed at 24h, 7d, and 30d, with 24h as the default. Bucket size scales with the range so responses stay bounded. Model mix returns the highest-volume models plus an `Other` group rather than an unbounded series.

Runtime p95 is explicitly labeled **end-to-end agent run duration** and is calculated from `agent_runs.startedAt` and `agent_runs.endedAt`. It is not presented as model-call latency. Provider/model-call latency remains an OpenTelemetry concern until Gantry owns a reliable persisted aggregation for it.

### Live activity contracts

`/v1/agent-runs` is app-scoped and distinct from the existing scheduled-job `/v1/runs` contract. List and task responses are cursor-paginated and expose safe operational fields only.

The run detail joins the parent agent run to its delegated async-task tree through `parentRunId`. Task nodes may expose kind, public ID, parent relationship, status, progress, timestamps, safe outcome summary, and safe failure summary. They must not expose private correlation IDs, leases, credentials, raw provider identifiers, or arbitrary internal payloads.

The event endpoint supports a bounded JSON catch-up and SSE continuation using an event cursor. The UI opens it only for a visible run detail and closes it on navigation or when the document is hidden.

## 7. Refresh, Caching, and Failure UX

### Client refresh policy

| Resource | Behavior while visible |
|---|---|
| Connection and Overview | poll every 30 seconds |
| Instance inventory | poll every 60 seconds |
| Metrics | poll every 5 minutes |
| Agent detail tabs | fetch on first open; refresh manually |
| Visible run detail | SSE after bounded initial fetch |

All polling stops when the browser tab is hidden. Failures use exponential backoff capped at five minutes. Manual refreshes are deduplicated and rate-limited so repeated clicks cannot create a request burst.

The UI API uses short, per-process, in-memory TTL caching only for safe duplicate reads. It adds no Redis or distributed cache. Cache keys include route and query parameters, and concurrent identical requests share one in-flight request.

### State presentation

- First load uses skeletons sized like the final content.
- A successful empty response gets an explicit empty state, not an error.
- A panel failure does not erase successful sibling panels.
- After a refresh failure, prior data remains visible with a stale timestamp and warning.
- A disconnected Control API never falls back to fixtures or fabricated zeros.
- Optional metrics render “Unavailable” when absent.
- Errors shown to the browser contain safe codes, messages, and request IDs only.
- SSE reconnection resumes from the last event cursor and shows a visible reconnecting/paused-live state.

These controls minimize server load without making operational state feel frozen.

## 8. Retention and Data Safety

Metrics history is bounded to 30 days at the Runtime Event Exchange ownership seam. Cleanup is batched and removes eligible runtime usage/event rows older than 30 days only when no pending outbox, webhook, or delivery reference still requires them. Pending delivery evidence may therefore remain older than 30 days until delivered or otherwise resolved.

Cleanup does not modify permission decisions, audit records, or other stores with independent retention requirements. The Phase 3 implementation plan must assign one explicit operator-owned cleanup path and add deterministic checks proving the boundary and pending-delivery protection.

## 9. Delivery Phases and Dependencies

```text
Phase 1: Connection foundation
    |
    v
Phase 2: Read-only operational inventory
   / \
  v   v
Phase 3: Metrics history     Phase 4: Live hierarchy
```

Phase 1 is the required base. Phase 2 establishes shared runtime and agent projections. Phases 3 and 4 both depend on Phase 2 but do not depend on each other. They can be planned and delivered separately after Phase 2.

### Phase 1 — Connection foundation

Deliver:

- build and serve the existing React application at `/ui` with deep-route fallback;
- add the minimal UI API server path;
- connect `/ui/api/connection` and `/ui/api/agents` through `@gantry/sdk`;
- replace fixtures on Overview and Agents with real loading, empty, stale, disconnected, and retry states; and
- package the UI for the private/local Gantry deployment.

Acceptance:

- `/ui` and a deep route load from the built artifact;
- the browser receives real local Control API data through server-held credentials;
- Overview and Agents contain no fixture fallback;
- stopping the Control API produces the designed disconnected state;
- the Control API key is absent from HTML, JavaScript, browser requests, and logs.

### Phase 2 — Read-only operations

Deliver:

- the approved Overview, Instances, and Agent detail screens;
- the structured runtime summary and runtime instances Control APIs;
- instance health, capacity, and runtime capabilities;
- configured delegation, skills, capabilities, access, and recent agent activity; and
- stale-heartbeat and degraded-state presentation.

Acceptance:

- workstation `all`, request-serving `control`, and registered workers render correctly without duplicates;
- stale heartbeat and degraded readiness are distinguishable;
- configured delegation is not mixed with live execution hierarchy;
- agent detail tabs load independently and lazily;
- all responses omit sensitive operational internals.

### Phase 3 — Bounded metrics

Deliver:

- metrics Overview, Usage, and Runtime tabs;
- 24h, 7d, and 30d UTC aggregation;
- request, token, cache, cost, model-mix, run-volume, status, and end-to-end duration metrics;
- bounded model series, cursor-paginated supporting lists, and short UI API caching; and
- the 30-day cleanup path.

Acceptance:

- aggregate values match seeded source events and runs;
- time buckets and range boundaries are correct in UTC;
- p95 is calculated and labeled as end-to-end agent run duration;
- missing optional data renders unavailable rather than zero;
- cleanup preserves the latest 30 days and pending delivery evidence;
- response point counts and query work are bounded for every range;
- cache and concurrent-request deduplication behavior are covered by focused tests.

### Phase 4 — Live agent hierarchy

Deliver:

- recent/active agent run list and run detail;
- safe delegated-task tree and event list;
- run-scoped SSE with cursor resume; and
- accessible expansion, status, progress, outcome, and failure presentation.

Acceptance:

- a real parent run and delegated agent task render in the correct hierarchy;
- running, completed, failed, and cancelled states are distinguishable;
- progress, safe outcome, and safe failure summaries update correctly;
- private fields are absent from JSON and SSE;
- reconnect resumes from a cursor without duplicating events;
- the browser closes the stream when hidden or navigated away;
- the hierarchy is usable by keyboard and understandable without color alone.

## 10. Verification Contract

Each phase is one bounded Gantry factory cycle. Before implementation it receives its own approved plan and capability-driven decomposition. The implementer adds the smallest backend/API automated tests that protect new contracts, aggregation, retention, and credential boundaries, then runs deterministic verification and one autoreview pass covering quality/performance/security.

Do not add frontend unit tests, component tests, browser-automation tests, end-to-end UI tests, snapshots, or a visual-regression platform for these four phases. The repository-required functional check remains a single manual-style acceptance pass for the user-visible flow; it is evidence of operability, not a maintained UI test suite. Backend/API verification should reuse existing helpers and contracts. Do not add a generic UI abstraction for testing.

Cross-phase invariants:

- no browser-visible Control API credential;
- no fixture fallback in production routes;
- no direct web-to-database access;
- no mutations or restart controls;
- no unbounded list, chart, event-stream, or retention query;
- no readiness/metrics text parsing when structured calculations already exist; and
- connection, empty, stale, partial-failure, and disconnected states remain explicitly covered by the phase acceptance checklist.

## 11. Planned Surface Impact

| Surface | Planned ownership | Phase |
|---|---|---|
| `apps/web` route tree and screens | existing web app | 1–4 |
| `apps/web` server-side UI API | thin browser/Control boundary | 1–4 |
| `packages/contracts` | new structured read contracts only | 2–4 |
| `packages/sdk` | typed clients for new Control reads | 2–4 |
| Control API runtime projection | current process and worker registry | 2 |
| Usage aggregation and runtime performance | existing usage/run sources | 3 |
| Runtime event retention | existing event-exchange ownership seam | 3 |
| Agent-run/task/event projection | existing run/task/event sources | 4 |
| Packaging/deployment configuration | private/local UI artifact | 1 |

Exact files belong in each phase's implementation plan after current source is rechecked. This design does not authorize implementation or unrelated refactoring.

## 12. Decisions and Deferred Work

The recommended approach is a thin UI API over the existing Control API because it preserves Gantry's public boundary, keeps credentials server-side, and lets the web artifact move to another service later without coupling it to runtime internals. Direct browser-to-Control API access was rejected because it exposes privileged credentials and complicates later authentication. A separate observability stack was rejected because current scale does not justify its operating cost.

Deferred work is explicit rather than scaffolded: OIDC and RBAC, multiple deployments, multiple control-replica inventory, mutations, restarts, agent creation, provider/model call latency dashboards, and external metrics infrastructure. Add them only after a separate approved design establishes the need.
