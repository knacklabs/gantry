---
slug: web-runtime-console-phase-4
title: Web Runtime Console — Phase 4: Live Execution Tree
status: draft
saved: 2026-08-12T18:01:38+00:00
---

# Web Runtime Console — Phase 4: Live Execution Tree

## Why

The private console now explains deployment health, configured agents, and
bounded historical metrics, but it cannot show what agents are doing now or
how one run delegated work. Operators need a read-only execution view that
follows Gantry's durable run and task truth without exposing raw prompts,
provider payloads, logs, credentials, or private correlation data.

## Product model

An activity tree is one app-owned agent run with its persisted asynchronous
tasks nested by parent task; `agent_runs` owns the root, `agent_async_tasks`
owns execution edges and progress, and Runtime Event Exchange events are only
safe invalidation signals for refreshing that durable projection.

## Behaviour

- Operations navigation adds **Live activity** between Overview and Metrics.
- `/activity` shows the 50 most recent agent runs for this Gantry deployment,
  newest first. Each row shows agent ID, cause, status, start time, elapsed or
  completed duration, and a link labelled **Open tree**.
- Status filters are **All**, **Active**, **Completed**, and **Needs attention**.
  They filter the already bounded response in the browser and never create
  arbitrary database queries.
- An empty list says **No agent activity yet** and explains that new runs will
  appear after Gantry starts processing work.
- `/activity/:runId` shows a root run card and a nested task tree. Each task
  shows its safe kind, target agent ID when present, status, current phase,
  latest progress, blocker, safe output or failure summary, and timestamps.
- A run with no delegated or asynchronous work says **No child tasks for this
  run**. A projection over the 100-task cap says **Showing the first 100 tasks**.
- The detail header shows **Live** while its same-origin event stream is open,
  **Reconnecting** while the browser reconnects, and **Completed** after a
  terminal run no longer needs a stream.
- **Refresh** performs one manual refetch. Stream invalidations are coalesced
  to at most one detail refetch per second.
- A failed initial request shows **Activity is unavailable** with **Retry**. A
  failed refresh retains the last successful tree and says **Showing the last
  successful activity**. A missing or cross-app run shows **Run not found**.
- The screen is read-only. It has no cancel, retry, restart, steer, approve,
  disable, or reconcile action.

## Data and authority contract

- Add an app-scoped AgentRunRepository list operation capped at 50 and ordered
  by `created_at DESC, id DESC`. Detail ownership is checked against the API
  key's app before any task or event read.
- Add an authenticated, typed Control API activity list and detail projection
  requiring `sessions:read`. The list returns safe run identity/status/timing
  only. The detail returns the safe root plus at most 100 tasks and a total so
  truncation is explicit.
- Build task hierarchy from `parent_run_id` plus the allowlisted
  `privateCorrelationJson.parentTaskId`. The target agent edge may use only the
  allowlisted `privateCorrelationJson.targetAgentId`. Never return the rest of
  private correlation, authority snapshots, leases, fencing tokens, execution
  provider IDs, provider session/run IDs, conversation/message IDs, permission
  decision IDs, workspace/sandbox IDs, stdout/stderr tails, receipts, raw
  events, prompts, tool input, credentials, or transport data.
- Safe task content is limited to persisted `summary`, `outputSummary`,
  `errorSummary`, and the public progress fields `currentPhase`,
  `lastProgress`, `lastToolSummary`, and `blocker`.
- The stream endpoint reuses Runtime Event Exchange cursor replay and the
  existing concurrent-stream cap. It emits only `{ eventId, type, createdAt }`
  for the owned run; payloads and internal correlation are never serialized.
  Events trigger a detail refetch rather than becoming a second activity
  state store.
- The UI server proxies the list, detail, and event stream with its existing
  server-held Control API credential. The browser never receives that key.
- The activity list polls every 30 seconds only while its route is visible.
  Non-terminal detail uses one visible-only `EventSource` plus one 30-second
  visible fallback refetch so a task update without an event cannot leave the
  tree stale. Terminal runs do not open a stream or poll. Closing or navigating
  away closes the upstream stream immediately.
- Add the smallest `(app_id, created_at DESC, id DESC)` agent-run index needed
  to keep the fixed newest-50 list bounded as history grows. Nothing else is
  persisted: no activity table, Redis cache, or telemetry store is added.

## Acceptance criteria

1. The activity list returns at most 50 app-owned agent runs, and a run from a
   different app is neither listed nor readable by ID.
2. Activity detail returns one safe root and at most 100 tasks correctly nested
   by parent task, with target agent edges and an explicit truncation signal.
3. The Control API and UI facade responses contain none of the prohibited
   runtime, provider, conversation, permission, log, credential, or raw event
   fields.
4. A visible non-terminal detail opens one capped SSE connection, resumes from
   a cursor, emits safe invalidations only, coalesces refetches to one per
   second, keeps one 30-second fallback refetch, and closes both proxy and
   upstream connections on navigation or disconnect. Terminal details neither
   stream nor poll.
5. The production UI exposes Live activity list and nested detail routes with
   loading, empty, populated, truncated, stale, disconnected, missing-run,
   keyboard, reduced-motion, and light/dark behavior.
6. Focused repository, Control API, SDK/OpenAPI, and UI-server facade/stream
   contract tests pass. No frontend unit, component, browser automation,
   snapshot, or visual-regression suite is added; the user-facing flow receives
   a manual browser acceptance pass.

## Validation plan

- Repository integration proof: app isolation, fixed 50-run ordering, task
  nesting inputs, target-agent extraction, and the 100-task truncation total.
- Control API/OpenAPI/SDK proof: required scope, 404 for missing/cross-app run,
  response parsing, safe field allowlist, SSE cursor replay, stream cap, and
  disconnect cleanup.
- UI-server contract proof: server-held credential, safe list/detail projection,
  streaming headers/bytes, upstream abort when the browser closes, and no raw
  payload forwarding.
- Manual local browser proof: list/detail navigation, active/completed filters,
  nested and empty trees, live/reconnecting/terminal states, stale/offline and
  missing run, keyboard, themes, reduced motion, console errors, and Axe.
- Run focused checks from
  `docs/architecture/current-verification-commands.md`, then Factory
  deterministic verification and one branch-wide autoreview pass.

## Surface impact matrix

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Read-only/observable | Existing runs, tasks, and events gain a bounded observer; execution and scheduling do not change. |
| `settings.yaml` | Unchanged by design | Limits and refresh cadence are fixed product safety bounds, not operator settings. |
| Postgres/runtime projection | Changed | Adds an app-scoped bounded run list, its supporting app/time index, and safe run/task tree reads. |
| Control API | Changed | Adds authenticated activity list, detail, and safe invalidation SSE routes. |
| SDK/contracts | Changed | Adds typed activity DTOs and SDK reads/stream request support. |
| CLI | Unchanged by design | Activity is a web-console observation surface only. |
| Gantry MCP tools/admin skill | Unchanged by design | No new agent/admin mutation or introspection tool is exposed. |
| Channel/provider adapters | Unchanged by design | The projection is provider- and channel-neutral. |
| Docs/prompts | Changed | Records activity ownership, safe fields, bounds, and stream lifecycle. |
| Audit/events | Read-only/observable | Runtime Event Exchange remains durable truth; payloads are not exposed or duplicated. |
| Tests/verification | Changed | Adds backend/facade contract proof and manual browser validation; frontend suites remain excluded. |

## Locked decisions

- This is actual execution hierarchy, not configured delegation hierarchy.
- The tree is root agent run to asynchronous tasks; nested task edges use
  parent task IDs. It does not invent child run relationships absent from the
  durable schema.
- Streams carry invalidation envelopes only; the durable detail projection is
  always refetched and remains authoritative.
- One deployment, read-only, private/local, full access; authentication/OIDC,
  RBAC, mutations, restarts, multi-deployment aggregation, raw logs, and raw
  event inspection remain deferred.
