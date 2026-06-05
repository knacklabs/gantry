# Agent Runtime And SDK Control Plane

This document explains what the agent does and what the surrounding runtime does when an app uses `@gantry/sdk`.

## Boundary

The agent is not the control plane.

The runtime owns:

- session lookup
- message persistence
- queueing
- scheduler/job claiming
- webhook delivery
- event storage
- auth and scopes

The agent owns:

- interpreting the prompt
- producing replies
- using runtime-exposed tools
- emitting structured output through normal runtime channels

ACP/ACPS are harness/runtime integration concerns. They are not part of the agent contract.

## Message lifecycle

1. A backend app calls `sessions.ensure()`.
2. The control server maps `(appId, conversationId)` to an `app:` JID and runtime workspace folder.
3. The app calls `sessions.sendMessage()`.
4. The runtime stores the inbound message in Postgres.
5. The runtime enqueues the group for normal processing.
6. The agent runs through the existing host-managed execution path.
7. Outbound replies are sent through the `app` channel adapter.
8. The adapter writes durable `control_events`.
9. Those events are visible through:
   - `sessions.wait()`
   - `sessions.stream()`
   - webhook delivery

## Job lifecycle

```mermaid
sequenceDiagram
  participant App
  participant SDK
  participant Control
  participant Jobs as Job Store
  participant Scheduler
  participant Agent

  App->>SDK: jobs.trigger(jobId)
  SDK->>Control: POST /v1/jobs/:jobId/trigger
  Control->>Jobs: create trigger record + advance next_run
  Scheduler->>Jobs: claim due run
  Scheduler->>Control: bind triggerId to runId
  Scheduler->>Agent: run job prompt
  Scheduler->>Control: emit run completed / failed event
  SDK->>Control: GET /v1/triggers/:id/wait
```

## Why the `app` channel exists

The `app` channel keeps app-originated conversations on the same runtime path as Slack and Telegram:

- same queue semantics
- same session model
- same agent runner
- same output delivery behavior

That avoids a second agent-output path with different behavior.

## Agent Composition

An agent is composed at spawn time, not stored as a single record. The runtime
brings together the persisted `Agent`, its current `AgentConfigVersion`, the
`LlmProfile`, the per-group `AgentConfig` (which carries persona and optional
model override), and the five built-in capability providers.

```mermaid
classDiagram
  class Agent {
    +AgentId id
    +AppId appId
    +string name
    +'active'|'disabled' status
    +AgentConfigVersionId currentConfigVersionId
  }
  class AgentConfigVersion {
    +AgentConfigVersionId id
    +int version
    +string promptProfileRef
    +LlmProfileId llmProfileId
    +ToolId[] toolIds
    +SkillId[] skillIds
    +PermissionPolicyId[] permissionPolicyIds
    +SandboxProfileId? sandboxProfileId
    +WorkspaceSnapshotId? workspaceSnapshotId
  }
  class LlmProfile {
    +'chat'|'planning'|'coding'|'embedding'|'summarization' purpose
    +string modelAlias
    +Thinking? thinking
    +Budget? budget
  }
  class ConversationSenderPolicy {
    +string providerId
    +string externalUserId
  }
  class ConversationApprover {
    +string providerId
    +string externalUserId
  }
  class AgentConfig {
    +AdditionalMount[]? additionalMounts
    +AgentPersona? persona
    +string? model
    +ThinkingOverride? thinking
  }
  class AgentCapabilityContext {
    +string mcpServerPath
    +string conversationId
    +string? threadId
    +string agentFolder
    +AgentPersona? persona
    +McpServerConfigs externalMcpServers
    +string[] selectedCapabilityRules
  }
  class AgentCapabilityProfile {
    +string[] projectedAllowedTools
    +McpServerConfigs mcpServers
    +'default' permissionMode
    +string[] internalSdkToolProjection
  }

  Agent "1" --> "many" AgentConfigVersion : versioned
  AgentConfigVersion --> LlmProfile : llmProfileId
  Agent "1" --> "many" ConversationSenderPolicy : per provider
  Agent "1" --> "many" ConversationApprover : one per provider
  AgentConfig --> Agent : per ConversationRoute
  AgentCapabilityContext --> AgentCapabilityProfile : composeAgentCapabilities()
```

Sources:

- `Agent`, `AgentConfigVersion`, `LlmProfile`, `ConversationSenderPolicy`,
  `ConversationApprover` — `apps/core/src/domain/agent/agent.ts`.
- `AgentConfig` (carrying `persona`, model override, additional mounts) —
  `apps/core/src/domain/types.ts`.
- `AgentPersona` enum and resolver —
  `apps/core/src/shared/agent-persona.ts`.
- `AgentCapabilityContext`, `AgentCapabilityProfile`, and the five built-in
  providers (`sdk-tools`, `permissions`, `gantry-mcp`, `configured-tools`,
  `configured-mcp`) plus `composeAgentCapabilities` —
  `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`.
- Persona compiled into the system prompt —
  `apps/core/src/application/agents/prompt-profile-service.ts` and
  `apps/core/src/runtime/agent-spawn.ts`.
- Skill materialisation into the run env —
  `apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts`,
  imported by `apps/core/src/runtime/agent-spawn.ts`.

### Subagents

Native Anthropic-SDK subagents inherit the parent run by default. Gantry
uses the durable `AgentDelegation` facade to gate subagent delegation; the
Anthropic adapter projects that facade to the SDK-native `Agent` tool inside a
single run. Once `AgentDelegation` is granted, the runtime does not add a
second `subagent_type` allowlist. It still rejects cross-provider models and custom
`tools`/`mcpServers`/`skills` input on the Agent tool call because those mutate
the runner projection instead of using the selected parent-agent capabilities.
When `runtime.sandbox.provider: sandbox_runtime` is configured, native
subagents execute inside the same sandboxed parent runner process. They do not
receive a separate host-spawned sandbox or a separate durable authority surface,
and the Claude Code child is marked already sandboxed for that run.
See `validateAgentModelRequest` and `validateAgentToolInput` in
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/agent-model-selection.ts`.

## Provider And Conversation Onboarding Control Surface

The control API exposes provider and conversation onboarding through
application-layer services:

- provider catalog and provider connection records
- provider discovery into canonical `Conversation` records
- `AgentConversationBinding` enable/update/disable for a conversation
- conversation, thread, and message reads for Web UI and SDK clients

Installation payloads store non-secret provider config and runtime secret
references only. Raw provider tokens stay behind `RuntimeSecretProvider`.
Disabling a binding marks it `disabled` so UI and CLI clients can re-enable it
without losing the binding policy, trigger, memory, or permission settings.
