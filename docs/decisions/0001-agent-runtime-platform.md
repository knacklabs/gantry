# Agent Runtime Platform

## Context

Gantry is moving from an early Claude-backed local implementation toward a
provider-neutral and channel-neutral agent runtime platform. The existing code
and older docs still expose several implementation concepts as if they were the
product architecture:

- workspace folders tied to a single chat
- privileged group administration as a product model
- Claude session ids as the only resume mechanism
- host tool execution as a direct runner capability
- CLI and control routes that own business behavior
- channel-specific identifiers used as runtime identity

Those concepts helped bootstrap the local personal runtime, but they should not
define the platform. Personal Telegram and WhatsApp usage is one seeded local
deployment mode. Enterprise Slack, Teams, Web UI, SDK, and control API usage is
another deployment mode. Both must use the same canonical app, agent,
conversation, message, session, run, memory, permission, sandbox, workspace, and
browser concepts.

Maintainer automation must stay outside runtime assumptions.

## Decision

Gantry's canonical product architecture is an agent runtime platform built
around this model:

```text
App
  Agent
    AgentConfigVersion
    LlmProfile
    AgentConversationBinding
      ProviderConnection
        Provider
        Conversation
          ConversationThread
          Message
            MessagePart
            MessageAttachment
    AgentSession
      ProviderSession
    AgentRun
      RuntimeEvent
    MemorySubject
    Job
    PermissionPolicy
      PermissionRule
      PermissionDecision
    SandboxProfile
      SandboxLease
    WorkspaceSnapshot
    BrowserProfile
```

Core rules:

- `App`, `Agent`, `Conversation`, `ConversationThread`, `Message`,
  `AgentSession`, and `AgentRun` are product concepts.
- `Provider`, `ProviderConnection`, and `AgentConversationBinding` adapt
  external networks into those product concepts.
- `LlmProfile` and `ProviderSession` adapt model providers into the product
  session and run model.
- Claude and Anthropic SDKs are one LLM provider adapter. They are not the
  runtime architecture.
- Personal usage seeds a local `App`, default `Agent`, local settings, memory
  roots, and one or more provider connections.
- Enterprise usage integrates through Web UI, control API, SDK, and channel
  providerConnections. Enterprise applications must not import runtime internals.
- Permissions are deterministic runtime decisions, not provider callback
  behavior. Tool execution must go through `PermissionPolicy`,
  `PermissionRule`, `PermissionDecision`, `SandboxProfile`, and `SandboxLease`.
- CLI and control HTTP are adapters. They call application use cases and must
  not directly own business logic or mutate persistence.

## Boundary Direction

Future code movement must follow these dependencies:

```text
adapters -> application -> domain
runtime -> application -> domain
control-http -> application -> domain
cli -> application -> domain
```

`domain` must remain provider-free and channel-free. It may define entities,
value objects, policy decisions, ports, and repository contracts.

`application` coordinates use cases and depends on domain and ports, not on
concrete providers.

`runtime` composes application use cases into long-running queues, sessions,
runs, sandboxes, IPC, and lifecycle supervision. It should not accumulate
channel-specific or provider-specific branching.

`adapters` implement ports for channels, model providers, credential brokers,
Postgres, control HTTP, CLI, Web UI, sandbox providers, browser providers, and
external orchestration integrations.

## Replacements For Later Code Movement

This decision does not refactor implementation. It sets the target for later
changes.

Replace or delete:

- old chat-folder model as domain identity
- privileged group-specific behavior as a primary architecture concept
- provider-specific session as the only resume mechanism
- direct tool execution on host
- CLI-owned business logic
- control routes directly mutating persistence

Replacement direction:

- Workspace folders are storage projections of
  `AgentConversationBinding`, not the identity of an agent, app, or conversation.
- Privileged group permissions become deterministic permission policy and conversation approver checks.
- Claude session ids and other provider resume tokens become `ProviderSession`
  records attached to canonical `AgentSession` records.
- Host execution becomes one sandbox implementation governed by
  `SandboxProfile`, `SandboxLease`, and deterministic permission decisions.
- CLI and control HTTP route commands into application services, which validate
  intent and call repositories through ports.

## Alternatives Considered

- Keep the personal group model as the core model: rejected because Telegram
  groups, Slack channels, Teams conversations, Web UI chats, and SDK sessions do
  not share the same semantics.
- Make Claude sessions the canonical session model: rejected because model
  providers use different resume semantics and some deployments may not expose a
  provider session at all.
- Treat enterprise as a separate product architecture: rejected because personal
  and enterprise modes should differ by seeding, providerConnection, policy, and UI,
  not by runtime domain.
- Keep privileged main-group behavior as the administrative model: rejected
  because enterprise administration needs explicit user, role, conversation binding,
  and policy decisions.

## Consequences

- Future architecture docs and implementation work should use canonical product
  terms first and mention workspace projections or provider sessions only as current
  implementation details.
- Existing personal setup docs can remain user-facing, but they must not imply
  that personal channels are the only runtime model.
- Provider adapters can be added or replaced without changing domain entities.
- Channel adapters normalize provider payloads into canonical messages,
  conversations, threads, and users before application behavior runs.
- Security and permission work can be reasoned about outside provider-specific
  SDK callbacks.

## Rollback Or Migration Notes

There is no runtime migration in this docs-only decision. Later implementation
phases should perform clean-cut migrations, not compatibility shims, because
Gantry is still early-stage.

If this decision is replaced, update this ADR and the canonical architecture
docs before moving source files. Do not introduce new provider- or
channel-specific branches in core runtime while the decision is active.
