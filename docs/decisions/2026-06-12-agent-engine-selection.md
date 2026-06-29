# Agent Engine Selection

> **Status: SUPERSEDED by
> [Agent Harness Selection (2026-06-14)](./2026-06-14-agent-harness-selection.md).**
> The active public contract is durable user intent `agentHarness`
> (`agent_harness` in `settings.yaml`) with values `auto`, `anthropic_sdk`, and
> `deepagents`. `agentEngine` is now the effective read-only diagnostic after
> harness/model/credential resolution, and `executionProviderId` remains
> internal/read-only diagnostic. The 2026-06-13 provider-derived-only decision
> and the older user-selectable engine decision below are historical context.

## Superseding decision (2026-06-13): provider-derived engine + OpenRouter caching

> Historical note: this provider-derived-only decision is superseded by
> [Agent Harness Selection (2026-06-14)](./2026-06-14-agent-harness-selection.md).
> Its derivation rules remain the behavior of `agentHarness: auto`.

### Why supersede

The capability boundary is the deciding factor: **only the Anthropic Claude Agent
SDK can perform Claude OAuth/subscription auth** — DeepAgents/LangChain cannot. So
once a model's provider is known, its engine is fully determined; a separate
user-facing engine choice adds a selector with exactly one valid value per
provider and a class of "incompatible pairing" errors that can only arise from
the selector existing. Removing the selector removes that error class and the
now-dead Claude-on-DeepAgents lanes, and folds OpenRouter into the
DeepAgents/OpenAI-compatible lane (which is what enables clean OpenRouter
caching). This is a clean-cut change (pre-users; no shims).

### Decision

The **agent engine is derived, read-only**. The user picks the model (alias ->
provider -> engine); the engine follows the resolved model's provider:

| provider | derived engine | credential modes |
| --- | --- | --- |
| `anthropic` (Claude) | `anthropic_sdk` | `api_key` + `claude_code_oauth` |
| `openai` | `deepagents` | `api_key` |
| `openrouter` | `deepagents` (was `anthropic_sdk`) | `api_key` |
| future (Groq/xAI/DeepSeek/Gemini/…) | `deepagents` unless Claude-native | `api_key` |

- Single derivation point: `deriveAgentEngineForProvider(providerId)` in
  `apps/core/src/shared/model-execution-route.ts`. Each provider declares one
  derived `executionRoute` (engine + `executionProviderId`); `resolveExecutionRoute`
  takes no `agentEngine` input. The engine x provider incompatibility branch and
  its locked rejection copies are removed (they can no longer occur).
- **Retired user-facing selectors (clean cut):** `defaults.agent_engine` +
  `agents.<id>.agent_engine`, the `gantry agent engine <id> <engine>` CLI verb,
  the `PATCH /v1/agents/:id` `agentEngine` write, and the `AGENT_ENGINE_CHANGED`
  audit event. `memory.engine` and the `MEMORY_ENGINE_CHANGED` audit are retired
  too (the `memory.engine` key is now rejected at settings validation); the memory
  LLM transport lane derives purely from the memory LLM model's response family
  (`memoryTransportLaneForResponseFamily`): anthropic -> Claude SDK memory client;
  openai/openrouter -> OpenAI-compatible chat-completions memory client. The
  now-dead Claude-on-DeepAgents memory client (`anthropic-memory-direct`) and the
  `memory-engine-matrix` are removed.
- **Kept as derived read-only diagnostics:** `agentEngine` on agent read
  responses, `gantry model why`/agent list/show cell, model preview
  `target: 'agent'`, and resolved-run audit (`agent_engine`/`execution_provider_id`)
  — all computed from the resolved model's provider.
- **Defensive backstop retained:** a `claude_code_oauth` credential can only ever
  project to `anthropic_sdk`; the DeepAgents lane fails closed if it ever receives
  one (`apps/core/src/adapters/llm/deepagents-langchain/credential-validation.ts`).
  `anthropic_sdk` remains a provider-boundary sentinel exported from
  `apps/core/src/shared/agent-engine.ts`.

### Library-driven model construction

The DeepAgents runner no longer sniffs env to infer the endpoint family. The host
projects the resolved model's provider string (`GANTRY_DEEPAGENTS_MODEL_PROVIDER`)
beside the model id and a single loopback gateway base-URL + run-scoped `gtw_`
token. The runner
(`apps/core/src/adapters/llm/deepagents-langchain/runner/model-factory.ts`) builds
the LangChain instance from the provider string:

- `openai` (and any other `initChatModel` provider):
  `await initChatModel("openai:<id>", { apiKey, configuration: { baseURL } })`.
- `openrouter`: `new ChatOpenRouter({ model: <id>, apiKey, baseURL: <gateway>/v1 })`
  from `@langchain/openrouter` (`initChatModel` does not know `openrouter`).
- The built `BaseChatModel` instance is passed to `createDeepAgent({ model })`.
  Loopback-URL + `gtw_`-token guards and the runtime `model.profile` read are kept.
- `anthropic` is not a DeepAgents provider (Claude is SDK-only); the builder throws.

### OpenRouter as the DeepAgents lane (gateway + caching)

OpenRouter is now OpenAI-chat-completions-compatible end to end:

- **Gateway projection:** `openrouter` projects the DeepAgents/OpenAI-family
  gateway env (`OPENAI_BASE_URL`/`OPENAI_API_KEY`, loopback base-URL + `gtw_`
  token) and the `openrouter` provider string. The old Anthropic `/v1/messages`
  OpenRouter projection is removed (OpenRouter is OpenAI-compatible only).
- **Path allowlist + auth:** the gateway allows `/v1/chat/completions` for
  DeepAgents-engine providers and keeps `bearer` auth (correct for OpenRouter);
  `ChatOpenRouter` -> loopback `/openrouter` -> `openrouter.ai/api/v1/chat/completions`.
- **Cache accounting (also fixes the OpenAI gpt lane):** the stream-normalizer
  reads `prompt_tokens_details.cached_tokens` / `cache_write_tokens` off the final
  usage chunk (with a LangChain `usage_metadata.input_token_details.cache_read`
  fallback) and computes `cacheReadTokens` / `cacheWriteTokens` /
  `totalBillableInputTokens` / `cacheProvider` / `cacheStatus` + the `contextUsage`
  cache fields, replacing the previous hardcoded zeros.
- **Sticky routing:** `ChatOpenRouter` receives a stable `session_id` (the durable
  session id) so OpenRouter routes follow-up turns of the same conversation to the
  same upstream provider and prompt-cache hits persist across turns. The OpenAI
  lane has no `session_id` concept and is unaffected.
- **Gated `cache_control` breakpoints:** the host projects
  `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL` (`automatic` | `explicit` | `none`) from
  the resolved model's cache descriptor. On `explicit` the runner injects ephemeral
  `cache_control: { type: 'ephemeral' }` on the stable prefix (system prompt +
  memory block content parts, <= 4 breakpoints). **Automatic-prefix providers
  (Kimi/Moonshot via OpenRouter, OpenAI gpt) need no request shaping** and inject
  nothing — explicit breakpoints are only for Anthropic/Gemini/Qwen sub-models
  (none shipped today). The `openrouter` `cacheSupport` descriptor is corrected to
  automatic provider-prefix caching to match.
- **Library limitation note:** `@langchain/openrouter` 0.3.0 surfaces cache
  *reads* but not *writes* on streamed chunks; the normalizer captures writes from
  raw usage if a later version exposes them.

### Surface impact (superseding change)

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Engine derived from the resolved model provider; no engine selector at spawn. |
| `settings.yaml` | Changed | `defaults.agent_engine`, `agents.<id>.agent_engine`, and `memory.engine` removed (the latter now rejected at validation). |
| Postgres/runtime projection | Read-only/observable | Run diagnostics still carry the derived `agent_engine`/`execution_provider_id`; no settable projection. |
| Control API | Changed | Agent records expose derived `agentEngine` (read-only); `PATCH /v1/agents/:id` no longer accepts it. |
| SDK/contracts | Changed | `UpdateAgentRequestSchema` drops `agentEngine`; `AgentResponseSchema` keeps it as a derived read-only field. |
| CLI | Changed | `gantry agent engine` verb removed; engine cell/`why`/preview remain read-only derived. |
| Channel/provider adapters | Read-only/observable | Channels render the same approvals/receipts and gain no channel-specific authority. |
| Docs/prompts | Changed | README, credential-management, AGENTS model vocabulary, adapter AGENTS, HANDOFF, this ADR. |
| Audit/events | Changed | `AGENT_ENGINE_CHANGED` + `MEMORY_ENGINE_CHANGED` removed; resolved-run engine diagnostics retained. |
| Tests/verification | Changed | Provider-derived resolution, library-driven factory, OpenRouter gateway + caching, retired-selector rejection coverage. |

---

## Original decision (SUPERSEDED 2026-06-13): user-selected per-agent engine

## Context

Gantry runs agents on the Anthropic Claude Agent SDK behind a provider-neutral
`AgentExecutionAdapter` (see
`docs/decisions/2026-05-18-provider-neutral-agent-execution-adapter.md`). The
product decision is that users must be able to choose between the Anthropic SDK
and DeepAgents per agent, so the runtime can run Claude OAuth/subscription models
on the native SDK lane and OpenAI-endpoint (and Anthropic API-key endpoint)
models through DeepAgents/LangChain.

Model selection previously resolved `modelAlias -> executionProviderId`, which
fixed one adapter per catalog entry and left `openai` as a schema-only response
family. That cannot express "the same catalog set, run under a different
harness," and it has no place to reject an incompatible model/engine pairing.

## Decision

An agent has a durable, user-selected **agent engine** in addition to its
`modelAlias`.

- Public noun: **agent engine**. Public values are `anthropic_sdk` and
  `deepagents`; display labels are `Anthropic SDK` and `DeepAgents`. The single
  source of the engine vocabulary is `apps/core/src/shared/agent-engine.ts`,
  mirrored by `AgentEngineSchema` in contracts.
- Durable scope is per-agent: `agents.<id>.agent_engine` is the override and
  `defaults.agent_engine` is the engine for newly configured agents that do not
  set their own. Conversations and jobs inherit the bound agent's engine in v1;
  there is no job-level or conversation-level engine selector and no public
  `job.harness`. Conversation `/model` overrides and job model defaults may still
  choose `modelAlias`, never engine.

Model resolution changes from `modelAlias -> executionProviderId` to
`modelAlias + agentEngine -> executionRoute`. The model alias chooses the model;
its provider route fixes the endpoint family (`responseFamily`); the agent engine
chooses the harness adapter. Each provider route in the model provider registry
declares an `executionRoutes` array keyed by engine, with the endpoint family,
supported credential modes, supported workloads, and the internal
`executionProviderId`. Resolution lives in
`apps/core/src/shared/model-execution-route.ts`.

Incompatible pairings are rejected before runner spawn and never re-routed to a
different engine, each with locked copy:

- An OpenAI-endpoint model under Anthropic SDK is rejected
  (`... uses the OpenAI endpoint, which is not supported by Anthropic SDK ...`).
- DeepAgents plus Claude OAuth/subscription credentials is rejected
  (`DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.`); Anthropic SDK remains the Claude OAuth/subscription lane.
- Any model whose provider route has no execution route for the selected engine
  is rejected with `Model <alias> cannot run on <harness>. Choose Auto or a compatible model.`

DeepAgents is the API-key engine for supported OpenAI-endpoint and
Anthropic-API-key-endpoint routes, implemented by `deepagents:langchain` under
`apps/core/src/adapters/llm/deepagents-langchain/`. Model credentials reach the
runner only through the Gantry loopback model gateway env allowlist
(`OPENAI_BASE_URL`/`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`);
raw provider credentials are never accepted as Gantry env.

For DeepAgents-lane chat models, catalog entries declare identity and route
only. Context window, output limits, and capability flags are reported at runtime
from the LangChain model profile rather than the static catalog, and pricing is
intentionally not declared.

Raw DeepAgents authority is denied in v1: default `StateBackend` (no `execute`),
deny-all filesystem permissions, no `LocalShellBackend`/`FilesystemBackend`, no
raw `.mcp.json`, no durable DeepAgents memory. A DeepAgents run that requests
shell/`RunCommand`/filesystem authority fails closed with the locked
raw-execute copy before spawn; the enforcing-sandbox requirement sits behind that
guard for the future enablement path. Gantry remains authoritative for memory,
jobs, tools, MCP, skills, browser, permissions, sandbox, sessions, settings, and
audit.

`executionProviderId` stays internal and read-only diagnostic. Every engine
change and every resolved run is auditable with `modelAlias`, endpoint family,
`agentEngine`, `executionProviderId`, credential mode without secrets, sandbox
provider, permission decision, and egress decision.

## Memory engine (addendum)

Host-side memory (extraction, dreaming, consolidation) is system-owned work with
no agent engine in scope. So that a deployment can run with **no Anthropic models
at all**, memory has its own engine selector, `memory.engine` in `settings.yaml`
(values `anthropic_sdk` default, or `deepagents`; same vocabulary and labels as
`apps/core/src/shared/agent-engine.ts`). One engine governs all three memory
workloads — there is no per-workload engine — for simplicity. Per-workload model
selection stays `memory.llm.models.{extractor,dreaming,consolidation}`.

The lane that speaks to the model gateway is derived purely from the memory
model's `responseFamily` (the engine is no longer a setting; it follows the
model's provider) via
`apps/core/src/shared/model-execution-route.ts` (`memoryTransportLaneForResponseFamily`),
applied at memory query dispatch (`route-aware-memory-llm-client.ts`):

| derived engine | model family | lane |
| --- | --- | --- |
| `anthropic_sdk` | anthropic | Claude Agent SDK memory client |
| `deepagents` | openai | OpenAI direct chat-completions client |

> Superseded: the engine is now derived from the memory model's provider/family,
> not a `memory.engine` setting. The Claude-on-DeepAgents memory lane is removed
> (Claude is SDK-only); see the Packet 7 docs update for the current design.

DeepAgents memory with Claude OAuth/subscription credentials is rejected when the
gateway resolves the credential mode, with the locked copy `DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.` The OpenAI gpt catalog entries declare
the `memory_*` workloads so OpenAI memory models are selectable. Embeddings are
already provider-neutral (`memory-embeddings.ts`) and out of scope. A memory
engine change emits a sibling `MEMORY_ENGINE_CHANGED` audit event (the per-agent
engine change keeps `AGENT_ENGINE_CHANGED`).

## Consequences

- A user sets an agent engine through `settings.yaml`, `gantry agent engine
  <id> <engine>`, `PATCH /v1/agents/:id` `agentEngine`, the SDK, or an approved
  admin tool; the choice rewrites `settings.yaml` and reconciles the runtime
  projection in the same operation.
- Existing Anthropic SDK behavior is unchanged for Anthropic-compatible models.
- The model catalog ADR vocabulary is updated to the
  `modelAlias + agentEngine -> executionRoute` resolution; OpenAI is executable
  on the DeepAgents lane, not schema-only.
- New engines require an `AgentExecutionAdapter`, provider-route execution
  routes, and the matrix/adapter tests before they can be selected.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Spawn resolves `agentEngine + modelAlias` into an execution route and selects the adapter. |
| `settings.yaml` | Changed | Adds `defaults.agent_engine` and `agents.<id>.agent_engine`. |
| Postgres/runtime projection | Changed | Runtime agent config and run diagnostics carry the resolved engine; `JobRun.agent_engine` and run-start events expose it read-only. |
| Control API | Changed | Agent records expose `agentEngine`; `PATCH /v1/agents/:id` accepts it; model preview gains `target: "agent"`. |
| SDK/contracts | Changed | Adds `AgentEngine`, `ModelRecord.executionRoutes`, `ModelPreviewTarget` `'agent'`, and optional DeepAgents-lane limit fields. |
| CLI | Changed | `gantry agent engine`, agent list/show engine cell, and `gantry model why --agent`. |
| Gantry MCP tools/admin skill | Changed | Reviewed engine updates flow through the settings desired-state write path. |
| Channel/provider adapters | Read-only/observable | Channels render the same approvals/receipts and gain no channel-specific authority. |
| Docs/prompts | Changed | README, SDK docs, model catalog ADR, credential, sandbox, and AGENTS guidance updated; alias-only/internal harness wording removed. |
| Audit/events | Changed | `AGENT_ENGINE_CHANGED` plus engine/provider/endpoint diagnostics on resolved runs. |
| Tests/verification | Changed | Matrix, adapter, memory, job/live, sandbox guard, and leakage coverage added. |
