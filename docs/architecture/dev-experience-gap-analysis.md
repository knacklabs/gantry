# Dev-Experience Gap Analysis: Gantry vs Agent-Building Best Practices

Audit of Gantry's developer-facing surfaces (direct LLM API, sessions/control API,
inline and worker agent runtimes) against Anthropic's agent-building guidance
(Claude Certified Architect — Foundations blueprint: agentic loops, orchestration,
tool design, structured output, context management, reliability), plus the open
max-tokens and thinking-control questions. Findings are code-truth from three
read-only codex xhigh sweeps (2026-07-11); every claim carries the file evidence.

**Theme:** Gantry usually computes or captures the right data internally, then
drops it before it reaches the developer — usage kept in a process-local map,
tool-error categories stripped before the model sees them, `effort` settings
parsed and never consumed.

Tier 1 (approved) is implemented by
`docs/architecture/dev-control-and-observability-goal-prompt.md`. Everything else
is ranked backlog.

## 1. Bugs — silent config lies (fix first)

### B1. `effort` dropped on the DeepAgents inline lane

`effort` is part of the inline dispatcher input contract
(`apps/core/src/adapters/llm/inline-lane-dispatcher.ts` lines 60–75), but the
DeepAgents lane never forwards it: `buildInlineModel`
(`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts` lines
381–394) and `buildRunnerModel`
(`apps/core/src/adapters/llm/deepagents-langchain/runner/model-factory.ts` lines
114–131) build the model without any reasoning parameter. A developer sets
`effort: high` on a non-Claude inline agent and gets silence, not an error.

### B2. `agents.*.effort` has no consumer on the worker path

The settings parser validates the key
(`apps/core/src/config/settings/runtime-settings-agents-parser.ts` lines 295–310)
but nothing on the worker path reads it. Claude workers get thinking control only
through the `/thinking` slash command — a conversation-level `ThinkingOverride`
(`apps/core/src/domain/types.ts` lines 31–55, parsed in
`apps/core/src/session/session-command-parse.ts`) piped through
`apps/core/src/runtime/group-agent-runner.ts` → subprocess stdin → SDK options in
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/model-config.ts`. The
DeepAgents worker input contract
(`apps/core/src/adapters/llm/deepagents-langchain/runner/types.ts` lines 14–41)
has no thinking/effort field at all.

### B3. `mcp_call_tool` flattens nested `isError` from remote servers

The remote proxy preserves the nested result, but the `mcp_call_tool` wrapper
(`apps/core/src/runner/mcp/tools/mcp-proxy-tools.ts` line 204; IPC side
`apps/core/src/jobs/ipc-mcp-tool-handlers.ts` line 232) flattens it, so a remote
tool failure can read as a successful call to the model — exactly the
"silently suppressing errors" anti-pattern the guidance warns about.

## 2. Parity gaps (ranked by dev value × size)

### P1. Thinking control (S/M) — Tier 1

- Direct LLM API: **already supported** — `thinking` (Anthropic shape) and
  `reasoning_effort` (OpenAI shape) pass through untouched;
  `apps/core/src/control/server/routes/llm-request-validator.ts` (lines 39–64)
  rejects only server-side execution fields, and
  `apps/core/src/control/server/routes/llm.ts` (lines 207–237) rewrites only
  `body.model`. Pinned by `apps/core/test/unit/control/llm-routes.test.ts`.
- Agents: **no per-agent thinking knob** on any lane. Claude inline maps `effort`
  → SDK `options.effort` only
  (`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts` lines
  121–130); nothing sets thinking on/off or a budget.
- Model catalog: only a boolean `supportsThinking`
  (`apps/core/src/shared/model-catalog.ts`); the installed claude-agent-sdk
  exposes `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`
  which Gantry never surfaces, so knob validation has nothing to check against.
  `ModelProviderDefinition` (`apps/core/src/shared/model-provider-registry.ts`)
  carries no thinking metadata either.

### P2. `count_tokens` unreachable publicly (S) — Tier 1

The internal gateway already allowlists `/v1/messages/count_tokens`
(`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.ts`
lines 38, 172) but the public control API mounts only `POST /llm/v1/messages` and
`POST /llm/v1/chat/completions` (`apps/core/src/control/server/routes/llm.ts`,
`apps/core/src/control/server/openapi-routes-extended.ts`) — callers get 404.
Context-window budgeting is a core best practice; this is a one-route fix.

### P3. Structured tool errors (M) — Tier 1

Best practice: tools return error category (transient/validation/business/
permission) + retryability so agents make recovery decisions. Today core tool
results are text + optional `isError` only
(`apps/core/src/runtime/core-tools/registry.ts` lines 58, 551); task-lifecycle
has internal codes (`invalid_request`, `unavailable`) dropped before the model
sees them (`apps/core/src/application/core-tools/task-lifecycle.ts` lines 13,
201); MCP audit classifies `invalid_request|denied|success|timeout|failure`
internally without surfacing it
(`apps/core/src/application/mcp/mcp-tool-audit.ts` lines 13, 108). Seam: a
bounded structured-error envelope on the shared tool-result type plus B3's fix.

### P4. Subagent failure propagation (M) — Tier 1

`task_get` returns a structured DTO (status, summaries, progress, blocker,
receipts — `apps/core/src/domain/ports/async-tasks.ts` line 25,
`apps/core/src/jobs/async-command-task-service.ts` line 261), but the failure
itself reduces to strings: `AgentOutput.error` is a bare string
(`apps/core/src/runtime/agent-spawn-types.ts` line 75), terminal failure throws
`new Error(output.error ?? "Delegated agent run failed.")`
(`apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts` lines 543, 609), and
child failure collapses to `"Delegated child task failed."` + counts
(`apps/core/src/jobs/async-delegated-agent-task.ts` lines 362, 485). Failure
type, attempted actions, and partial results all exist upstream and get
discarded — the coordinator can't make intelligent recovery decisions.

### P5. Max output tokens (S) — Tier 1

No per-agent `max_output_tokens` on either lane. DeepAgents `maxOutputTokens`
exists only as model-profile metadata
(`apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts`
line 70) used for context-percentage math; the claude-agent-sdk exposes no
per-query output-token option (its `effort` is the Claude-side lever — the
asymmetry must be documented, not papered over). LLM API `max_tokens` is
caller-controlled passthrough (fine); the per-key ceiling is backlog (P12).

### P6. Dev-facing tool hooks (M/L) — backlog

The exam guide's highest-weighted pattern: programmatic PreToolUse/PostToolUse
interception (block by policy, transform results, enforce tool-order
prerequisites) instead of prompt hope. Gantry has the machinery internally —
fixed safety hook (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/protected-capability-hook.ts`),
`canUseTool` wiring in
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`,
provider-neutral gate (`apps/core/src/runner/tool-gate-core.ts`) — but no
developer-configurable hooks field in the agent schema
(`packages/contracts/src/settings/index.ts` line 68) and no prior-success ledger
for prerequisites. Seam: declarative interceptor references on
`RuntimeConfiguredAgent`, provider-neutral pre/post callbacks beside the existing
gate, run-scoped success ledger.

### P7. Validation-retry for `response_schema` (M) — backlog

Schema compliance is SDK/library-enforced only. Admission checks only
"non-null JSON object" — the schema is never compiled
(`apps/core/src/control/server/routes/sessions.ts` lines 44, 162); validation
failure emits a terminal `status:"error"` with the candidate text suppressed
(`apps/core/src/runtime/group-agent-runner.ts` line 619). Best practice is
retry-with-error-feedback for structural failures. Seam: compile at admission,
validate at the shared lane boundary, bounded retry controller.

### P8. Session fork / named resume (M/L) — backlog

Sessions auto-resume; there is no fork/branch-from-cursor or named-resume for
API consumers (`apps/core/src/control/server/routes/sessions.ts` line 55 route
set; action union in `apps/core/src/control/server/route-parser.ts` line 31 has
no fork). Fork needs a canonical branch at a message cursor + a new
provider-session head via
`apps/core/src/application/sessions/session-interaction-module.ts`.

### P9. MCP resources (M) — backlog

Tools-only in both directions: the inventory client exposes only `listTools`
(`apps/core/src/application/mcp/mcp-tool-list-fetch.ts` line 17), execution only
`callTool` (`apps/core/src/application/mcp/mcp-tool-proxy.ts` line 342), server
bindings authorize only tool patterns
(`apps/core/src/domain/mcp/mcp-servers.ts` line 36), Gantry's own server facade
exposes only `tool(...)` (`apps/core/src/runner/mcp/server.ts` lines 23, 65),
and the Claude worker explicitly disallows the SDK resource tools
(`apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-tools.ts` line 25).
MCP resources are the guidance's answer to "content catalogs without exploratory
tool calls".

### P10. Usage/cost API (M) — backlog

No `/v1/usage` route; live-turn usage lives in a process-local map
(`apps/core/src/runtime/model-status-store.ts` lines 19, 48), `RUN_COMPLETED`
persistence omits usage
(`apps/core/src/adapters/storage/postgres/schema/canonical-ops-repo.postgres.ts`
line 615), and gateway audits carry `apiKeyId`/`agentId`/`runId` but no token
counts (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts`
line 499). Scheduler jobs are the exception — normalized usage lands durably in
terminal job events (`apps/core/src/jobs/execution.ts` lines 515, 766), readable
via `apps/core/src/control/server/routes/runs.ts` and
`apps/core/src/control/server/routes/jobs.ts`. Seam: one
normalized usage event from all three paths + a scoped query route.

### P11. Message Batches passthrough (M) — backlog

`/v1/messages/batches` is neither gateway-allowlisted nor publicly mounted
(gateway 400 / public 404). Best-practice batch workloads (overnight analysis at
50% cost) can't run through Gantry-held credentials. Needs allowlist + routes +
polling semantics; do after P2.

### P12. Spend ceilings (S/M) — Tier 1

From the max-tokens findings: per-key `max_tokens` ceiling (reject in
`apps/core/src/control/server/routes/llm-request-validator.ts` — S) and a
per-agent per-run token budget checked at turn boundaries against the usage the
runner already returns (M; mid-turn cutoff stays backlog). Folded into Tier 1
(Stage F) at user direction.

## 3. Innovation pillars (grounded)

### I1. Typed SDK package (M) — Tier 1

Closer than assumed: a handwritten typed Node SDK already exists
(`packages/sdk/src/index.ts` — HTTP/Unix-socket transport, SSE parsing, resource
clients) and the OpenAPI 3.1 doc is served unauthenticated at `/openapi.json`
with Swagger UI (`apps/core/src/control/server/routes/openapi.ts`). Blocking
trustworthy generation: LLM passthrough operations are untyped `body:'json'`
(`apps/core/src/control/server/openapi-routes-extended.ts`), undocumented
operations fall back to `additionalProperties:true`
(`apps/core/src/control/server/openapi-route-helpers.ts` lines 18–21), all query
params are strings, and `SessionDetails` has an unrestricted metadata object
(`apps/core/src/control/server/openapi-schemas.ts`). Route inventory is
test-pinned (`apps/core/test/unit/control/openapi.test.ts`). Plan: close schema
gaps, then generate types into `packages/sdk` (transport stays handwritten) with
a drift check.

### I2. Lifecycle webhooks (M) — Tier 1

Mostly wiring: durable `runtime_events` log + transactional `event_bus_outbox`
(`apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts`
lines 95–127) + full outbound delivery machinery — registration, HTTPS/host
validation, HMAC signatures, retries, dead-lettering, replay
(`apps/core/src/control/server/routes/webhooks.ts`,
`apps/core/src/control/server/webhook-delivery.ts`, wakeup in
`apps/core/src/application/runtime-events/webhook-delivery-wakeup.ts`) — all
exist. Missing: event-type/subject filters on registrations
(`apps/core/src/adapters/storage/postgres/schema/control-http.ts` lines 88–118
are destination-only), automatic fan-out (deliveries fire only when an event
carries a `webhookId`), a located claim/settle consumer for the outbox
(`apps/core/src/adapters/storage/postgres/repositories/event-bus-outbox.postgres.ts`
has a publisher only), an enriched envelope (top-level
agentId/conversationId/threadId), and a generic pending-interaction event in the
taxonomy (`apps/core/src/domain/events/runtime-event-types.ts`).

### I3. Run replay / eval harness (L) — backlog, manifest first

Runs persist config version, provider handles, permission decisions
(`apps/core/src/adapters/storage/postgres/schema/runs.ts`), messages persist
identity + `response_schema` metadata, and events are queryable per run. But
there is no immutable run-input manifest (final prompt + ordered trigger
messages + resolved tool policy + memory recall + schema —
`apps/core/src/runtime/group-processing.ts` lines 713–735 is where all of it is
in scope simultaneously), `createSessionAgentRun` doesn't even attach the message
id, MCP audits store argument shapes not values (no deterministic tool stubs),
and DeepAgents checkpoints
(`apps/core/src/adapters/llm/deepagents-langchain/runner/session-store.ts`) are
adapter-private, mutable, and absent for scheduled jobs. Phase 1 of any replay
feature is manifest capture at the `group-processing.ts` seam; the replay/diff
use case comes after.

## 4. Tier table

| Tier | Items | Where |
| --- | --- | --- |
| 1 (approved) | B1 B2 B3, P1 P2 P3 P4 P5 P12, I1, I2 | `docs/architecture/dev-control-and-observability-goal-prompt.md` |
| 2 | P6 hooks, P7 validation-retry, P10 usage API | next goal prompt after Tier 1 ships |
| 3 | P8 fork, P9 MCP resources, P11 batches, I3 replay | backlog |
