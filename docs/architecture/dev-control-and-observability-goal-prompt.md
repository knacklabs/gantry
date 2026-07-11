# Goal Prompt: Dev Control & Observability (Tier 1)

## Objective

Close the approved Tier-1 set from
`docs/architecture/dev-experience-gap-analysis.md`: make agent settings do what
they say (effort/thinking/max-tokens knobs honored on every lane), make errors
tell the truth (structured tool errors, typed subagent failures), complete the
LLM API surface (`count_tokens`), make the OpenAPI doc generation-grade and
generate SDK types from it, turn the existing outbox + webhook machinery
into developer-subscribable lifecycle webhooks, and add the spend guards from
the max-tokens findings (per-key ceiling, per-run budget).

Use ponytail. Keep changes surgical. No compatibility shims. The worker runtime
is touched only where a stage names it explicitly.

Division of labor: all code changes go through Codex implementation handoffs.
Documentation updates (README, `docs/sdk/`, `docs/architecture/capability-management.md`)
are orchestrator-owned and land as separate doc commits — Codex stages must not
edit them.

## Locked decisions (do not re-litigate)

- Knob model: per-agent settings defaults + per-request override on the sessions
  message API (same additive pattern as the existing `response_schema` field in
  `apps/core/src/control/server/routes/sessions.ts`). Per-request override wins
  for that turn; `/thinking` conversation override continues to win over both on
  the Claude worker path.
- Claude-lane output-token asymmetry is documented, not simulated: the
  claude-agent-sdk has no per-query output-token option; `effort` is the
  Claude-side lever. `max_output_tokens` applies to DeepAgents lanes only and
  the docs say so.
- Catalog-gated validation: knobs a model can't honor are rejected at
  settings-apply/admission with an error naming the field and model, never
  silently dropped. Silent dropping is the bug class this goal exists to kill.
- SDK types are generated from the OpenAPI doc into `packages/sdk`; the
  handwritten transport (HTTP/Unix-socket/SSE) stays.
- Webhook fan-out rides the existing signed/retrying delivery machinery and the
  transactional `event_bus_outbox`; no new delivery stack.

## Stage A — Settings truth + control knobs

1. Fix B1: thread `effort` from the inline dispatcher input through
   `buildInlineModel` / `buildRunnerModel`
   (`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`,
   `apps/core/src/adapters/llm/deepagents-langchain/runner/model-factory.ts`) to
   the provider reasoning parameter (`reasoning_effort` for OpenAI-compatible;
   provider-appropriate mapping otherwise), gated on catalog capability.
2. Fix B2: consume `agents.*.effort` on the worker paths. Claude worker: merge
   into the SDK options built in
   `apps/core/src/adapters/llm/anthropic-claude-agent/runner/model-config.ts` as
   the default, with the conversation-level `ThinkingOverride` (from
   `/thinking`) still winning. DeepAgents worker: add the field to the runner
   input contract (`apps/core/src/adapters/llm/deepagents-langchain/runner/types.ts`)
   and map as in (1).
3. New per-agent `thinking` setting (off | on with optional budget tokens),
   parsed beside `effort`/`max_turns` in the settings stack (reader version
   bump). Claude lanes: map to SDK thinking options. DeepAgents lanes: map to
   the provider's reasoning/thinking parameters where the catalog says the model
   supports it; reject at settings-apply otherwise.
4. New per-agent `max_output_tokens` (positive int): DeepAgents lanes set the
   per-call output cap on the model; Claude-engine agents reject the field at
   settings-apply with the documented `effort` guidance.
5. Per-request overrides on the sessions message API: additive optional fields
   (`effort`, `thinking`, `max_output_tokens`) beside `response_schema`,
   threaded through live-turn plumbing to the lanes, same admission rules as the
   settings fields.
6. Surface thinking-capability metadata in the model catalog
   (`apps/core/src/shared/model-catalog.ts`): carry the installed SDK's
   `supportsEffort` / `supportedEffortLevels` / `supportsAdaptiveThinking` (and
   an equivalent flag for OpenAI-shape `reasoning_effort`) so (1)–(5) validate
   against it.

Acceptance: unit tests per lane prove each knob reaches the SDK/model config;
settings validation rejects unsupported model/knob combos naming field + model;
per-request override beats the agent default within one turn; `/thinking` still
beats both on the Claude worker; a DeepAgents inline agent with `effort` set
observably changes the built model config (regression for B1); worker `effort`
consumed (regression for B2).

## Stage B — Truthful errors

1. Extend the shared tool-result shape (`McpCompatibleToolResult` in
   `apps/core/src/runtime/core-tools/registry.ts`) with a bounded structured
   error envelope: `category` (`transient | validation | business | permission`)
   + `isRetryable` + message. Populate it in core tools and the task-lifecycle
   handlers — stop dropping the internal codes in
   `apps/core/src/application/core-tools/task-lifecycle.ts`.
2. Fix B3: `mcp_call_tool` (`apps/core/src/runner/mcp/tools/mcp-proxy-tools.ts`,
   IPC side `apps/core/src/jobs/ipc-mcp-tool-handlers.ts`) preserves nested
   remote `isError` and `structuredContent` instead of flattening to text.
3. Typed subagent failure metadata: additive structured failure field on
   `AgentOutput` (`apps/core/src/runtime/agent-spawn-types.ts`) — failure type,
   attempted-action summary, partial result if any — populated where terminal
   failures are shaped today
   (`apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`,
   `apps/core/src/jobs/async-delegated-agent-task.ts`) and carried through the
   task DTO (`apps/core/src/domain/ports/async-tasks.ts`) so `task_get` and the
   parent agent see structure instead of `"Delegated child task failed."`.
   Per-child terminal DTOs survive `waitForLinkedChildTasks` aggregation.

Acceptance: unit tests prove category/isRetryable reach the model-visible tool
result for a failing core tool and a failing remote MCP tool (nested `isError`
preserved end-to-end); a failed delegated task surfaces failure type + partial
results in `task_get` and in the parent's tool result; no existing tool-result
consumer breaks (event-parity snapshot stays green).

## Stage C — LLM API surface

1. Mount `POST /llm/v1/messages/count_tokens` in
   `apps/core/src/control/server/routes/llm.ts` (same auth/scope/validator
   plumbing as `/llm/v1/messages`; the gateway already allowlists the provider
   path — see `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.ts`).
2. OpenAPI entry with typed request/response (feeds Stage D), and per-key usage
   logging consistent with the existing routes.

Acceptance: unit route test proves a count_tokens call with a registered model
alias forwards and returns the provider response; unregistered model and bad
scope behave identically to the existing LLM routes.

## Stage D — Typed SDK

1. Make the OpenAPI doc generation-grade: typed request/response schemas for the
   LLM passthrough operations (replace the bare `body: 'json'` entries in
   `apps/core/src/control/server/openapi-routes-extended.ts`), remove the
   `additionalProperties: true` fallback for core routes
   (`apps/core/src/control/server/openapi-route-helpers.ts`), and type query
   parameters with real types (numbers for limits/timeouts). Cover the new
   Stage A/C fields and routes.
3. Add type generation into `packages/sdk` from the served spec via
   `openapi-typescript` (dev dependency): a generate script plus a CI-friendly
   drift check (regenerate and diff, fail on mismatch — same spirit as the route
   inventory pinned in `apps/core/test/unit/control/openapi.test.ts`). The
   handwritten transport and resource clients in `packages/sdk/src/index.ts`
   adopt the generated types where they currently hand-declare shapes.

Acceptance: generated types compile into the SDK build; drift check fails when a
route/schema changes without regeneration; LLM passthrough and sessions
operations have non-generic request/response types; SDK build (`packages/sdk`)
passes with no hand-written duplicates of generated shapes left behind.

## Stage E — Lifecycle webhooks

1. Event subscriptions on webhook registrations: additive filter fields
   (event types, optional subject scoping by agent/session/job) on the
   registration schema (`apps/core/src/adapters/storage/postgres/schema/control-http.ts`,
   routes in `apps/core/src/control/server/routes/webhooks.ts`).
2. Outbox consumer: claim/settle worker tailing `event_bus_outbox`
   (`apps/core/src/adapters/storage/postgres/repositories/event-bus-outbox.postgres.ts`
   currently has a publisher only), matching events against subscriptions and
   fanning out through the existing signed/retrying delivery path
   (`apps/core/src/control/server/webhook-delivery.ts`) — replacing nothing,
   only feeding it. The existing per-event `webhookId` response-mode flow keeps
   working unchanged.
3. Enriched delivery envelope: top-level `agentId` / `conversationId` /
   `threadId` (already on the event —
   `apps/core/src/domain/events/events.ts`) alongside the existing fields.
4. New generic pending-interaction runtime event (emitted where durable pending
   interactions are recorded) added to the taxonomy
   (`apps/core/src/domain/events/runtime-event-types.ts`) so consuming apps can
   react to "agent is waiting on a human" without polling.
5. OpenAPI + generated SDK coverage for the new registration fields.

Acceptance: integration test (disposable Postgres): register a webhook with an
event-type filter, drive a run to terminal state, assert exactly the subscribed
events are delivered (signed, with the enriched envelope) and unsubscribed types
are not; a pending interaction emits the new event and is delivered; outbox rows
are settled (no unbounded growth); dead-letter path still works.

## Stage F — Spend guards (max-tokens findings)

1. Per-key `max_tokens` ceiling on the direct LLM API: optional per-API-key
   output-token limit (additive field on the control API key record,
   `apps/core/src/shared/control-api-keys.ts`). Requests whose `max_tokens` /
   `max_completion_tokens` exceed the key's limit are rejected with a shaped
   `400` naming the limit and field, inside the existing validator
   (`apps/core/src/control/server/routes/llm-request-validator.ts`). Reject, do
   not clamp — silently altering caller payloads is the silent-config bug class
   again. Unset = unlimited (current behavior).
2. Per-agent per-run token budget: optional `max_run_tokens` setting parsed
   beside the Stage A knobs. Accumulated normalized usage (the same usage the
   runner already returns per turn on `AgentOutput`) is checked at turn
   boundaries in `apps/core/src/runtime/group-agent-runner.ts`; exceeding the
   budget produces a clear terminal error naming the budget and observed total.
   No mid-turn cutoff in v1 — document the turn-granularity ceiling.

Acceptance: LLM route test proves an over-ceiling request 400s naming the
limit and an at-limit request passes; an inline agent with a small
`max_run_tokens` terminates with the named budget error at a turn boundary
while an unset budget keeps current behavior; settings validation rejects
non-positive values.

## Non-goals

Backlog, explicitly out of scope here (see the gap analysis): dev-facing tool
hooks, `response_schema` validation-retry, session fork/named resume, MCP
resources, Message Batches passthrough, `/v1/usage` API, mid-turn token
cutoff, run replay/eval harness.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Knobs honored on all lanes; structured errors; outbox consumer. |
| `settings.yaml` | Additive | `thinking`, `max_output_tokens`, `max_run_tokens` per agent; reader version bump. |
| API keys | Additive | Optional per-key max-tokens ceiling field. |
| Postgres | Additive | Webhook subscription fields; outbox claim columns if needed. No table drops. |
| Control API | Additive | count_tokens route; per-request knob fields; webhook filter fields. |
| SDK/contracts | Changed | Generated types adopted in `packages/sdk`; additive `AgentOutput` failure field. |
| Model catalog | Additive | Thinking/effort capability metadata. |
| Gantry MCP tools | Changed internally | Structured error envelope on tool results. |
| Channel adapters | Unchanged | Live-turn event sequence untouched (snapshot-pinned). |
| Docs | Changed | Capability-management doc gains knob + webhook sections. |
| Tests | Changed | Per-stage coverage above. |

## Focused Verification

```bash
npm run build
npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

DB-backed integration uses disposable Postgres. Unit/control suites import from
source modules (mock convention). Event-parity snapshot must stay green.

## Runtime Smoke

Build + `launchctl kickstart -k gui/$(id -u)/com.gantry` + `gantry status`.
Then: one inline DeepAgents turn with `effort` + `max_output_tokens` set
(observably applied); one Claude worker turn proving `/thinking` still overrides
the settings default; one `count_tokens` call via the public API; one webhook
subscription receiving a run-terminal event end-to-end. Knacklabs lead-gen job
to successful terminal result. Capture exact blockers — never claim green
without it.

## PR Closeout

One PR for the goal; stages land as sequential commits. Stage only goal-related
files. Final pipeline section: implementation summary, verification results,
build/launchctl evidence, smoke results (including the webhook delivery), clean
autoreview result (`python3 ~/.claude/skills/autoreview/scripts/autoreview
--mode branch --base origin/main`, rerun until clean), remaining risks.

## Bounded Write Scope

- `apps/core/src/config/settings/**` (knob parsing/validation + reader version)
- `apps/core/src/runtime/agent-inline.ts`, `apps/core/src/runtime/agent-spawn-host.ts`,
  `apps/core/src/runtime/agent-spawn-admission.ts`, `apps/core/src/runtime/agent-spawn-types.ts`,
  `apps/core/src/runtime/agent-spawn.ts`, `apps/core/src/runtime/group-agent-runner.ts`
  (knob threading + failure field; spawn seam carries worker defaults into runner input)
- `apps/core/src/domain/types.ts`,
  `apps/core/src/application/sessions/session-interaction-module.ts`,
  `apps/core/src/runtime/pending-message-replay.ts`,
  `apps/core/src/runtime/group-processing.ts`,
  `apps/core/src/runtime/message-loop.ts` (per-request overrides must survive
  durable message admission and replay to reach the runner)
- `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts`,
  `apps/core/src/adapters/storage/postgres/services/canonical-message-ops-service.ts`
  (override persistence on the message record, same binding as `response_schema`)
- `apps/core/src/adapters/llm/anthropic-claude-agent/**`,
  `apps/core/src/adapters/llm/deepagents-langchain/**`,
  `apps/core/src/adapters/llm/inline-lane-dispatcher.ts` (lane mappings)
- `apps/core/src/shared/model-catalog.ts`, `apps/core/src/shared/model-provider-registry.ts`
  (capability metadata)
- `apps/core/src/runtime/core-tools/registry.ts`,
  `apps/core/src/application/core-tools/task-lifecycle.ts`,
  `apps/core/src/runner/mcp/tools/mcp-proxy-tools.ts`,
  `apps/core/src/jobs/ipc-mcp-tool-handlers.ts` (structured errors)
- `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`,
  `apps/core/src/jobs/async-delegated-agent-task.ts`,
  `apps/core/src/jobs/async-command-task-service.ts`,
  `apps/core/src/domain/ports/async-tasks.ts` (failure propagation)
- `apps/core/src/shared/control-api-keys.ts`,
  `apps/core/src/control/server/routes/llm-request-validator.ts` (per-key ceiling)
- `apps/core/src/control/server/routes/llm.ts`,
  `apps/core/src/control/server/routes/sessions.ts`,
  `apps/core/src/control/server/routes/webhooks.ts`,
  `apps/core/src/control/server/webhook-delivery.ts`, OpenAPI modules under
  `apps/core/src/control/server/` (routes + schemas)
- `apps/core/src/adapters/storage/postgres/**` (webhook subscription fields,
  outbox consumer, and the webhook persistence seam:
  `apps/core/src/adapters/storage/postgres/repositories/control-plane-repository.postgres.ts`,
  `apps/core/src/adapters/storage/postgres/schema/control-plane-records.postgres.ts`,
  `apps/core/src/adapters/storage/postgres/schema/control-plane-canonical.postgres.ts`)
- `apps/core/src/domain/events/**` (pending-interaction event, envelope fields)
- `packages/sdk/**` (generated types + adoption), root/workspace package.json
  scripts for generation/drift check
- Tests + docs for the above. Nothing else.
