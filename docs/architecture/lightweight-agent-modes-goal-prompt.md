# Goal Prompt: Inline Agent Runtime + Direct LLM API

## Objective

Add two lightweight execution surfaces to Gantry, leaving sandbox worker agents untouched:

1. **Stage 1 — Direct LLM API**: Anthropic-compatible and OpenAI-compatible passthrough endpoints so consuming apps can make raw model calls with Gantry-held credentials.
2. **Stage 2 — Inline agent runtime**: agents flagged `runtime: inline` run their agent loop in-process in the app host (no worker subprocess, no sandbox), with core Gantry tools + remote streamable-HTTP/SSE MCP servers.

Use ponytail. Keep changes surgical. No compatibility shims. Do not modify the worker runner processes except where a seam is explicitly named below.

## Decisions (already made — do not re-litigate)

- Same first-class Gantry agent; new per-agent `runtime: worker | inline` field, default `worker`.
- True in-process execution (no warm pool, no slim subprocess).
- Provider split preserved inline: Claude models → in-process `@anthropic-ai/claude-agent-sdk` `query()`; all other providers → in-process deepagents/langgraph with PostgresSaver.
- Hard-reject at registration/settings-apply when an inline agent holds worker-only capabilities (skills, stdio MCP servers, fs/bash access). `inline → worker` always allowed; switching resets provider-session continuity (existing behavior on route change), DB-backed state persists.
- Inline tool surface: `send_message`, `ask_user_question`, memory read/write, subagent task-lifecycle tools, plus the agent's remote `http`/`sse` MCP servers connected directly in-process. Library-internal subagents (deepagents `subagents`, SDK agents) stay disabled.
- Inline agents run scheduled jobs (synthetic heartbeats + existing failover chain) and can spawn/receive subagent tasks through the same `spawnAgent` choke point.
- Graph workflows deferred; no authoring surface.

## Stage 1: Direct LLM API

### Required behavior

- `POST /llm/v1/messages` (Anthropic Messages shape) and `POST /llm/v1/chat/completions` (OpenAI shape), streaming and non-streaming, so official SDKs work via `baseURL` swap.
- Auth via existing control API bearer keys; usage attributed per key. Bad key → 401. Model must be a registered Gantry model route/alias (resolved via `apps/core/src/shared/model-provider-registry.ts`), not a raw provider model id.
- Requests forward through the existing Gantry Model Gateway; the control layer never re-implements provider auth.

### Implementation shape

1. New route module `apps/core/src/control/server/routes/llm.ts`, mounted in `apps/core/src/control/server/index.ts` (`createControlRequestHandler`). Reuse `authorizeControlRequest` + rate-limiter plumbing from `handler-context.ts` / `rate-limit.ts`; raw body via `readRawBody` in `http.ts`; stream by piping the gateway response directly to `res`.
2. Add an explicit `llm:invoke` scope to `apps/core/src/shared/control-api-keys.ts` (no `llm:*` scope exists today).
3. Gateway access: mint a brokered injection (`GantryModelGatewayBroker.getInjection` via `apps/core/src/application/credentials/agent-credential-service.ts` `getAgentCredentialInjection`, broker from `apps/core/src/adapters/credentials/agent-credential-broker-factory.ts`) and `fetch` the loopback gateway — the same pattern as `runWithGantryGateway` in `apps/core/src/adapters/llm/openai-memory/openai-memory-llm-client.ts` and `memory-gateway-injection.ts`. Gateway routing already allowlists `/v1/messages` and `/v1/chat/completions` (`gantry-model-gateway-routing.ts` `assertProviderPathAllowed`).
4. **Token scope gotcha**: gateway tokens are run-scoped with revoke-on-run-end (`gantry-model-gateway-secret-ref.ts`). Add an API-key scope (e.g. `api_key:<id>`) to gateway token validation — do not fake a run id.
5. Per-key usage rows through the existing request-log seam in `apps/core/src/control/server/http.ts`. OpenAPI entries in `openapi-routes-extended.ts`.

## Stage 2: Inline agent runtime

### Config + admission

- Add `runtime: worker | inline` to the agent settings schema (settings reader version bump per repo convention).
- Hard-reject at registration/settings-apply and in pre-spawn admission (`apps/core/src/runtime/agent-spawn-admission.ts` pattern): inline + (skills, stdio MCP, fs/bash grants) = config error naming each offending capability.

### Execution path — contract validated by codex xhigh

- New `runInlineAgent()` in `agent-inline.ts` (new module in `apps/core/src/runtime/`), **signature-compatible with `spawnAgent(group, input, onProcess, onOutput, options): Promise<AgentOutput>`**, branched at the existing call sites (`apps/core/src/runtime/group-agent-runner.ts`, `apps/core/src/jobs/execution.ts`, `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts` inherit it via the choke point).
- Preserve `AgentOutput` field semantics exactly: `status/result/error/providerSession/newSessionId/sessionInit/usage/usageEventId/contextUsage/runtimeEvents/compactBoundary/interactionBoundary/continuedByFollowup` — `group-agent-runner.ts` (`persistProviderSessionFromOutput`, `completeSuccessfulRuntimeSessionRun`) and `apps/core/src/jobs/execution.ts` (`runJobAgentWithFailover`, `streamHandler`, `finalizeSchedulerJobRun`) all consume them.
- **Stop/queue handle**: `GroupQueue.registerProcess` (`apps/core/src/runtime/group-queue.ts`) and `stopActiveGroupRun` (`group-queue-stop.ts`) assume a ChildProcess-like target (`pid`, `kill()`, process-group signals). Provide an inline run handle satisfying the same stop contract, backed by `AbortController` — do not leave inline runs unstoppable.
- **Live-turn hooks**: register `LiveTurnLocalRunnerHooks` (`apps/core/src/runtime/live-turn-authority.ts`) for inline runs — continuation, close, stop, ownership-loss stop, interaction-resolution draining. Replace `FilesystemRunnerControlPort` (file-drop under `DATA_DIR/ipc/...`) with an in-memory control port implementing the same port interface; this gives follow-up continuation and steering without the filesystem protocol.
- **Event parity is the real contract**: emit the identical live-turn event sequence (`turn_started` → deltas → terminal, session-init frame, permission-request events) through the same emission path worker runs use (see `apps/core/src/runtime/live-turn-authority.ts` and the session-events flow consumed by `apps/core/src/control/server/routes/sessions.ts`). Snapshot-test inline vs worker event sequences for the same turn.
- **Permissions**: inline tool gates call `application/permissions` services directly but must still record durable `pending_interactions` before prompting and resolve them (`apps/core/src/runtime/ipc-interaction-processing.ts` `recordPendingInteractionRequested` / `resolvePendingInteractionRecord`).
- **Setup/cleanup parity**: `spawnAgent` owns gateway token injection, MCP projection, and `preparedExecution.cleanup()`; the inline path must perform equivalent setup and guaranteed teardown (revoke gateway tokens on run end) — none of it is "subprocess-only".
- **Scheduled jobs**: emit synthetic `JOB_HEARTBEAT` runtime events in-process so the scheduled-run stall detection (`apps/core/src/runtime/agent-spawn-scheduled-idle.ts`, diagnostics in `apps/core/src/jobs/execution-diagnostics.ts`) sees liveness; failover (`execution-failover.ts`) reuses the same call site.
- Workspace layout: gate `ensureWorkspaceIpcLayout` (`agent-spawn-layout.ts`) on runtime — skip workspace/IPC dirs, keep the sessions log dir (`session-log-writer` transcripts).

### Loop lanes

- **Claude lane**: in-process `query()` multi-turn with tools (pattern: `apps/core/src/adapters/llm/anthropic-claude-agent/memory-query.ts`). Core Gantry tools via an in-process SDK MCP server (`createSdkMcpServer`); remote MCP as native `http`/`sse` `mcpServers` entries; credentials via gateway base URL + run-scoped `gtw_` token. Verify long-session compaction (worker lane has `sessionCompactionPrompt` hooks; inline `query()` self-manages).
- **Deepagents lane**: in-process `createDeepAgent`, PostgresSaver (reuse `apps/core/src/adapters/llm/deepagents-langchain/checkpoint-setup.ts`), core tools as langchain tools, remote MCP via MCP adapters, model via gateway.
- Core tool implementations: extract shared handler logic from `runner/mcp/tools/*` + `jobs/ipc-*-handlers.ts` so inline calls application services directly; reuse `tool-gate-core.ts` gating.
- **Egress mitigation**: all inline remote-MCP/HTTP traffic uses the DNS-pinned fetch policy from `apps/core/src/application/mcp/mcp-tool-proxy-network.ts` — inline must not bypass MCP egress policy.

### Accepted v1 gaps vs worker (do not build)

Skills (deepagents in-memory projection is the later unlock), browser tools, capability self-service tools, agent-created jobs, library-internal subagents. Profile disk mirrors N/A (profile is DB-backed and still compiled into the inline prompt via `prompt-profile-service.ts`).

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | New inline execution path; worker path untouched. |
| `settings.yaml` | Additive | Per-agent `runtime` field; reader version bump. |
| Postgres | Additive | Reuse existing tables (runs, turns, pending_interactions, checkpoints); no schema change expected. |
| Control API | Changed | New `/llm/v1/*` routes + `llm:invoke` scope; OpenAPI updated. |
| SDK/contracts | Additive | New routes in OpenAPI; `AgentOutput` unchanged. |
| CLI | Unchanged v1 | Agent registration accepts the new field via settings. |
| Gantry MCP tools | Changed internally | Core tool handlers shared between IPC and inline paths. |
| Channel/provider adapters | Unchanged | Live-turn event parity is the contract. |
| Model gateway | Changed | New API-key token scope. |
| Docs | Changed | Capability-management doc gains runtime tiers + LLM API. |
| Tests | Changed | New unit/integration coverage below. |

## Acceptance Criteria

- Official Anthropic SDK and OpenAI SDK pointed at Gantry via `baseURL` complete streaming and non-streaming calls; per-key usage rows recorded; invalid key → 401; unregistered model → 4xx.
- Inline agent registration with skills/stdio-MCP/fs grants fails with an error naming each offending capability; `worker → inline` flip enforces the same rule; `inline → worker` succeeds.
- An inline agent (one Claude-model, one OpenAI-compatible) completes a session turn via `POST /v1/sessions/{id}/messages` with a stub streamable-HTTP MCP server: tool round-trip, `send_message`/`ask_user_question`, permission prompt round-trip with durable `pending_interactions`, run/turn records persisted.
- Event-parity snapshot: inline and worker runs of the same turn emit the same live-turn event types/order.
- Inline run is stoppable via the existing stop path; abort produces the same terminal semantics as worker abort.
- Inline scheduled job completes without tripping the heartbeat-stall monitor; forced model error triggers the existing failover chain.
- Inline agent spawns a subagent task targeting an inline agent (in-process) and a worker agent (subprocess); both produce run records.
- Gateway tokens minted for inline runs and API calls are revoked at run/request end; no phantom-run attribution.
- Architecture check remains clean.

## Focused Verification

```bash
npm run build
npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Use disposable Postgres for DB-backed tests. Run unit + control-route suites locally (scheduler/control mock convention: import from source modules, not re-exports).

## Runtime Smoke

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.gantry
launchctl print gui/$(id -u)/com.gantry
gantry status
```

Then: register an inline agent, drive one channel turn end-to-end, and run one direct LLM API call with each SDK shape. Run the Knacklabs lead gen smoke through the product runtime (`gantry jobs list/trigger/events`) and confirm a successful terminal result. Capture exact blockers if setup/auth blocks any step — do not claim green without it.

## PR Closeout

Stage only goal-related files; update the existing PR if one exists for the branch. Final pipeline section must include: implementation summary, cleanup evidence, verification commands + results, build/launchctl evidence, Knacklabs smoke result, autoreview clean result (`python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local`, rerun until clean), remaining risks.

## Bounded Write Scope

- `apps/core/src/control/server/{routes/llm.ts,index.ts,openapi-routes-extended.ts}` and touched shared control helpers
- `apps/core/src/shared/control-api-keys.ts`, gateway token validation modules (`gantry-model-gateway*.ts`)
- `apps/core/src/config/**` (agent schema + reader version)
- `apps/core/src/runtime/{agent-inline.ts,agent-spawn.ts,agent-spawn-admission.ts,agent-spawn-layout.ts,group-agent-runner.ts,group-queue*.ts,live-turn-authority.ts}` (branch points and handle abstraction only)
- `apps/core/src/jobs/{execution.ts,execution-heartbeat-monitor.ts}` (inline branch + heartbeat exemption only)
- Shared tool-handler extraction from `apps/core/src/runner/mcp/tools/*` / `apps/core/src/jobs/ipc-*-handlers.ts`
- New inline lane modules under `apps/core/src/adapters/llm/**`
- Tests + docs for the above. Nothing else.
