# Provider-Neutral Agent Execution Adapter

## Context

Gantry runtime execution previously named Claude runner files, Claude config
directories, Anthropic environment variables, and Claude SDK session behavior
inside host spawn orchestration. That conflicted with the platform decision that
Claude and Anthropic SDKs are LLM provider adapters, not runtime architecture.

## Decision

Runtime host orchestration depends on the application-owned
`AgentExecutionAdapter` contract at
`apps/core/src/application/agent-execution/agent-execution-adapter.ts`. The
contract receives canonical Gantry run context and returns a prepared child
process projection:

- agent/conversation/run inputs from `AgentInput`
- resolved catalog model and provider entry
- broker-returned credential projection
- workspace, sandbox, IPC, browser, memory, permission, skill, and MCP context
- adapter-owned protected filesystem paths and cleanup

The adapter result is deliberately narrow: adapters may return provider-owned
child process details and model credential environment, but they may not rewrite
host-owned authority or continuity fields after runtime validation.

The Anthropic Claude Agent SDK is implemented by
`apps/core/src/adapters/llm/anthropic-claude-agent/`. Its runner, SDK query
loop, materialized config, model environment variables, OpenRouter
Anthropic-compatible projection, permission callback translation, tool
projection, usage normalization, and provider-session handling are adapter
artifacts.

`AgentSession` remains Gantry continuity. `ProviderSession` is adapter metadata
attached to an `AgentSession`. Live interactive runs may use provider resume
handles through the adapter, while scheduled jobs must remain durable through
Gantry job/session state and not depend on provider resume as source of truth.

Memory LLM calls use a provider-neutral memory LLM port. Runtime bootstrap
registers the current Anthropic adapter implementation explicitly; memory
extraction and dreaming code no longer imports the Anthropic SDK directly or
uses a hidden dynamic provider fallback.

Memory LLM calls are an explicit egress-policy exception for this adapter
phase: they run in the host process through the model credential broker lane
instead of the child runner's loopback egress gateway. The exemption is limited
to memory extraction/dreaming traffic, does not expose agent tool subprocess
environment, and must be removed by adding an application-level memory LLM
egress port before any non-broker direct model transport is introduced.

## Consequences

- Runtime orchestration can launch the current Claude behavior without importing
  the Anthropic SDK or naming Claude runner internals.
- Direct Anthropic SDK imports are legal only inside the Anthropic adapter and
  focused adapter tests.
- OpenRouter remains an Anthropic-compatible adapter projection for this phase;
  it is not a core runtime branch.
- Some pre-existing layering debt remains around runtime/config access from
  adapter composition and is tracked by architecture exceptions with removal
  phases.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Spawn now asks an execution adapter to prepare the child process. |
| `settings.yaml` | Unchanged by design | No settings shape changes; model aliases and broker config stay current. |
| Postgres/runtime projection | Changed | AgentRun records now persist execution provider metadata and ProviderSession rows are normalized to the adapter id; ProviderSession remains adapter metadata attached to AgentSession. |
| Control API | Changed | Run list/detail responses omit provider-native session/run handles; runtime events remain the diagnostic surface. |
| SDK/contracts | Changed | Public tool catalog contracts no longer expose provider-native SDK tool kinds; provider runner details remain adapter-private. |
| CLI | Unchanged by design | Existing model and credential commands keep behavior. |
| Gantry MCP tools/admin skill | Changed | Durable authority remains canonical; provider-native SDK tools are removed from selected catalog state while Gantry MCP/browser tools stay runtime projections. |
| Channel/provider adapters | Changed | Anthropic is now the explicit LLM execution adapter owner. |
| Docs/prompts | Changed | Runtime docs now describe provider-neutral execution. |
| Audit/events | Read-only/observable | Existing runtime events and usage records remain the observable surface. |
| Tests/verification | Changed | Focused adapter, runtime, memory, and architecture checks cover the boundary. |
