# Agent Engine Selection

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
  (`DeepAgents does not support Claude OAuth/subscription credentials in
  Gantry ...`); Anthropic SDK remains the Claude OAuth/subscription lane.
- Any model whose provider route has no execution route for the selected engine
  is rejected with the generic compatible-aliases copy.

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
gateway resolves the credential mode, with the locked copy `DeepAgents does not
support Claude OAuth/subscription credentials in Gantry. Choose Anthropic SDK or
configure Anthropic API-key Model Access.` The OpenAI gpt catalog entries declare
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
| Channel/provider adapters | Unchanged by design | Channels render canonical status/errors only; no channel-specific engine authority. |
| Docs/prompts | Changed | README, SDK docs, model catalog ADR, credential, sandbox, and AGENTS guidance updated; alias-only/internal harness wording removed. |
| Audit/events | Changed | `AGENT_ENGINE_CHANGED` plus engine/provider/endpoint diagnostics on resolved runs. |
| Tests/verification | Changed | Matrix, adapter, memory, job/live, sandbox guard, and leakage coverage added. |
