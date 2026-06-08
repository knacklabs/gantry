# Canonical Domain Model

This document defines the product vocabulary Gantry code should converge on.
It is intentionally provider-neutral and channel-neutral. Current
implementation names such as registered group, group folder, JID, and Claude
session id are implementation details unless they are
explicitly mapped to one of the concepts below.

## Model Summary

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
    ToolCatalogItem
    SkillCatalogItem
    PermissionPolicy
      PermissionRule
      PermissionDecision
    SandboxProfile
      SandboxLease
    WorkspaceSnapshot
    BrowserProfile
```

Identity rules:

- Domain identity uses Gantry ids, not provider ids.
- Provider ids are stored as external references on adapter-owned records.
- Domain records are scoped by `appId` unless explicitly global.
- Provider-specific payloads must be normalized before they reach application
  use cases.
- Model-provider session tokens are attached to `ProviderSession`, not used as
  the only source of runtime continuity.

## Core Ownership

| Concept                    | Owner                    | Meaning                                                                                                                                                                                                    |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App`                      | Domain                   | A runtime namespace for agents, users, memory, policies, conversations, jobs, and SDK/API access.                                                                                                          |
| `Agent`                    | Domain                   | A configured agent inside an app. It owns prompt profile lineage, model profile selection, tools, skills, memory visibility, and conversation bindings.                                                    |
| `AgentConfigVersion`       | Domain                   | An immutable version of agent behavior: prompt profile, model selection, tool/skill catalog references, workspace defaults, permission policy references, and runtime limits.                              |
| `LlmProfile`               | Domain                   | Provider-neutral model intent such as purpose, model alias, budget, thinking mode, embedding usage, and credential-broker reference. Concrete SDK names live in provider adapters.                         |
| `Provider`                 | Adapter catalog          | A chat adapter type such as Telegram, WhatsApp, Slack, Teams, or Web UI. It describes capabilities and normalization rules.                                                                                |
| `ProviderConnection`       | Application plus adapter | An installed provider connection for an app, including workspace/team/bot/account identity, runtime-owned secrets, webhook/socket config, and enablement state.                                            |
| `Conversation`             | Domain                   | A provider-neutral communication container. It can be a DM, group, channel, chat, SDK conversation, or Web UI chat.                                                                                        |
| `ConversationThread`       | Domain                   | A sub-conversation within a conversation, such as Slack `thread_ts`, Telegram forum topic, Teams reply chain, or a Web UI branch.                                                                          |
| `AgentConversationBinding` | Domain                   | The relationship that says an agent is present in a conversation or thread with trigger, routing, permissions, memory scope, and workspace projection.                                                     |
| `User`                     | Domain                   | A human or service actor known to an app. Provider-specific user ids are aliases.                                                                                                                          |
| `Message`                  | Domain                   | A normalized inbound, outbound, system, or tool-visible communication event within a conversation or thread.                                                                                               |
| `MessagePart`              | Domain                   | A typed part of a message, such as text, markdown, image, file reference, tool result, form response, or structured data.                                                                                  |
| `MessageAttachment`        | Domain plus adapter      | Binary or external media attached to a message. The domain owns metadata and trust classification; adapters own download and upload mechanics.                                                             |
| `AgentSession`             | Domain                   | Canonical continuity state for an agent in an app, conversation, thread, job, or run context. It survives provider swaps.                                                                                  |
| `ProviderSession`          | Adapter                  | A provider-specific resume token or transcript pointer, such as a Claude session id. It is attached to an `AgentSession`.                                                                                  |
| `AgentRun`                 | Domain/application       | One execution attempt by an agent for a message, job, control request, or manual trigger.                                                                                                                  |
| `RuntimeEvent`             | Application/storage      | The durable observable runtime stream for run, job, session, SSE/wait, SDK listing, and outbound webhook delivery events. Audit records remain in their owning modules.                                    |
| `ExternalIngress`          | Application/storage      | A signed inbound authority record for external systems. It derives app scope, protects nonce replay, records invocations, and dispatches only to approved session, conversation, job, or template targets. |
| `MemorySubject`            | Domain                   | A memory boundary for app, agent, user, group/team, conversation, or common shared memory.                                                                                                                 |
| `Job`                      | Domain/application       | Scheduled, recurring, or manual work that creates agent runs under explicit app, agent, session, and permission context.                                                                                   |
| `ToolCatalogItem`          | Domain catalog           | A tool capability exposed to agents with name, input contract, risk classification, permission requirements, and adapter binding.                                                                          |
| `SkillCatalogItem`         | Domain catalog           | A reusable behavior package or prompt/tool bundle that can be attached to agent config versions.                                                                                                           |
| `PermissionPolicy`         | Domain                   | A named policy attached to an app, agent, binding, tool, job, or sandbox profile.                                                                                                                          |
| `PermissionRule`           | Domain                   | A deterministic rule inside a policy. It can allow, deny, require approval, or require a sandbox lease.                                                                                                    |
| `PermissionDecision`       | Domain/application       | The audited result of evaluating a request against policy and runtime context.                                                                                                                             |
| `SandboxProfile`           | Domain/application       | A named execution environment policy: filesystem, network, process, browser, credential, timeout, and approval behavior.                                                                                   |
| `SandboxLease`             | Runtime/application      | A time-bounded grant to execute work under a sandbox profile for a specific run or tool call.                                                                                                              |
| `WorkspaceSnapshot`        | Runtime/application      | A stable view of workspace files, mounts, prompt profile inputs, and generated runtime context used for an agent run.                                                                                      |
| `BrowserProfile`           | Domain/application       | A named browser identity with storage state, auth markers, allowed usage, and ownership policy.                                                                                                            |

## Relationships And Lifecycle

### App, Agent, And Config

`App` is the top-level tenant or namespace. Personal mode seeds one local app,
usually `personal`. Enterprise mode creates apps for teams, products, or
customer-owned deployments.

`Agent` belongs to exactly one app. An app may own multiple agents. Agents do
not belong to a Telegram group, Slack channel, or folder.

`AgentConfigVersion` is immutable. Changing prompt profile, tools, skills,
model intent, workspace defaults, or permission policy creates a new version.
`AgentRun` records the config version used so past runs remain explainable.

`LlmProfile` describes model intent and policy in provider-neutral terms. It may
resolve to Claude, OpenAI, Gemini, a local model, or a future provider through
an adapter. The domain must not import provider SDKs or provider model
registries.

### Providers, Conversations, And Bindings

`Provider` describes adapter capabilities. Examples include Telegram, WhatsApp,
Slack, Teams, and Web UI. It is catalog metadata, not an installed runtime
account.

`ProviderConnection` is an app's installed provider instance. For Slack it may
represent a workspace app providerConnection. For Telegram it may represent a bot
token. For Teams it may represent a tenant/app providerConnection. For Web UI it may
represent the app-owned web surface. Secrets belong behind
`RuntimeSecretProvider`.

`Conversation` is the canonical message container. Provider ids such as
Telegram chat id, WhatsApp chat id, Slack channel id, Teams chat id, or SDK
conversation id are external aliases on a conversation.

`ConversationThread` exists only when a provider or UI creates a nested reply,
topic, branch, or thread boundary. Thread ids are external aliases under the
conversation.

`AgentConversationBinding` connects one agent to one conversation or thread. It
owns trigger behavior, routing, sender policy, memory subject selection,
default workspace projection, and permission policy selection. A group folder
is only one possible workspace projection of this binding. Conversation
approvers belong to the conversation, while conversation approvers belong to an agent's
private/direct conversation policy.

### Users And Messages

`User` is a canonical actor in an app. Providers contribute aliases,
display names, and membership facts. A message sender should map to a `User`
when the provider exposes a stable user identity. Service actors and app
backends can also be users.

`Message` is the durable normalized event. It should store direction, app,
conversation, optional thread, sender user, provider alias, timestamp, and
trust classification. Provider raw payloads can be archived by adapters, but
application logic should use normalized message fields.

`MessagePart` supports mixed content without making text the only shape.
Examples are text, markdown, code, image reference, file reference, form
response, structured JSON, tool result, and redacted content.

`MessageAttachment` stores attachment metadata, content type, size, external
provider references, local cache references, scan state, and trust boundary.
Adapters perform provider-specific download and upload.

### Sessions And Runs

`AgentSession` is canonical continuity. It links an agent to an app-level
context such as a conversation, thread, job, user, or manual control request.
`/new` clears the canonical session state for the relevant binding while
preserving the binding's selected model override when policy says so.
The deterministic session key includes app, agent, conversation, thread, user,
and job fields so Slack threads, Telegram topics, and Web UI branches do not
collide inside one conversation.

`ProviderSession` stores provider-specific diagnostic or export state for an
`AgentSession`. Claude session ids, response ids, and transcript pointers are
not Gantry runtime continuation handles. Active chat continuation uses the live
provider stream while it is running; fresh runs restore durable Gantry memory
only.

`AgentSessionSummary` is historical/observability state when present. It is not
injected into runtime prompts and is not a replacement for provider-owned
context-window compaction.

`AgentRun` is one execution attempt. It has a cause, app, agent, config version,
session, conversation/thread context, permission context, sandbox lease,
workspace snapshot, provider profile, status, timestamps, and result summary.

`RuntimeEvent` is the observable runtime delivery stream for SDK event listing,
SSE/wait, outbound webhook projection, run events, job events, and app-channel
session/control output. Run-event responses are projections filtered from
runtime events instead of a separately owned `AgentRunEvent` stream. Audit
histories remain in their owned modules.

`ExternalIngress` is inbound. It is not a webhook callback destination. It
derives app scope from its record and can only invoke configured target kinds:
app/API session messages, provider-neutral conversation messages, existing job
triggers, or constrained one-time job templates. Conversation-message ingress
accepts Gantry `conversationId` and `threadId` values only; provider transport
ids are resolved internally.

### Memory And Jobs

`MemorySubject` is the visibility boundary for durable memory. Valid subject
shapes include app-wide common memory, agent memory, user memory, group/team
memory, and conversation memory. Provider names do not change the meaning of
the boundary. Provider topics, Slack threads, Teams reply chains, Telegram
forum topics, and Web UI branches remain conversation/session routing metadata;
they do not create separate durable memory subjects.

`Job` belongs to an app and runs through the same agent/session/run path as a
message-triggered run. Jobs can target an agent binding, a session, a
conversation, a thread, or a service context. Job execution must not bypass
permission policy or sandbox lease rules.

### Tools, Skills, Permissions, And Sandboxes

`ToolCatalogItem` describes a capability before it is invoked. It should include
input schema, output schema, risk category, default policy, required sandbox
profile, credential broker needs, and adapter binding.

`SkillCatalogItem` describes an installed reusable behavior package. It may
provide prompt sections, tools, workflows, docs, or setup hooks. Attaching a
skill to an agent requires an installed skill and an agent skill binding.
Agent-created skills begin as pending review requests; approval installs and
binds the current package.

`McpServerDefinition` describes a third-party MCP capability before it is
available to an agent. It stores app ownership, reviewed transport shape, risk
classification, credential reference names, status, and audit metadata.
`AgentMcpServerBinding` attaches the current active server definition to an
agent. Provider sessions and Claude config files do not own MCP state; they
only receive a per-run adapter projection.

`PermissionPolicy` groups deterministic rules. It is attached explicitly to an
app, agent, binding, tool catalog item, job, or sandbox profile.

`PermissionRule` evaluates a request using known runtime facts: actor, agent,
binding, message, tool, requested path, credential profile, channel, sandbox,
and risk classification.

`PermissionDecision` is durable and auditable. It records the request, matched
rules, decision, approver when applicable, expiration, and run/tool context.

`SandboxProfile` defines the environment available to a run or tool call. Host
execution is one possible sandbox implementation, not the domain model.

`SandboxLease` grants a run or tool call permission to use a sandbox profile for
a bounded time and scope. Leases are created only after permission evaluation.

### Workspace And Browser

`WorkspaceSnapshot` captures the workspace view used by an agent run: root,
additional mounts, read/write flags, prompt files, generated context, and
content hashes when available. It makes runs reproducible and auditable.

`BrowserProfile` is a named browser identity owned by an app or agent. It
stores profile metadata, browser state references, auth markers, and usage
policy. Browser profile use still requires permission and sandbox checks.

## Provider Conversation Mapping

| Provider concept                           | Canonical mapping                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telegram DM                                | `Conversation`                                                                                                                                                                 |
| Telegram group                             | `Conversation`                                                                                                                                                                 |
| Telegram forum topic / `message_thread_id` | `ConversationThread`                                                                                                                                                           |
| WhatsApp chat                              | `Conversation`                                                                                                                                                                 |
| Slack DM                                   | `Conversation`                                                                                                                                                                 |
| Slack channel                              | `Conversation`                                                                                                                                                                 |
| Slack `thread_ts`                          | `ConversationThread`                                                                                                                                                           |
| Teams personal chat                        | `Conversation`                                                                                                                                                                 |
| Teams group/channel chat                   | `Conversation`                                                                                                                                                                 |
| Teams thread/conversation reference        | `ConversationThread`                                                                                                                                                           |
| Web UI chat                                | `Conversation` or `ConversationThread`, depending on whether the implementation treats each visible chat as a top-level conversation or a branch inside a larger conversation. |

Mapping rules:

- A provider conversation id is never the only Gantry identity. Store it as an
  alias under `ProviderConnection`.
- Threads are optional. A provider without threads maps all messages directly
  to `Conversation`.
- Web UI must choose one mapping during implementation and document it in the
  Web UI adapter contract.
- Provider adapters must preserve enough provider metadata to reply correctly,
  but application behavior should use canonical ids.

## Current Implementation Mapping

These mappings describe current code so future refactors know what to replace:

| Current implementation      | Canonical target                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Registered group            | `AgentConversationBinding` plus `Conversation` and optional `ConversationThread`            |
| Group JID/chat JID          | Provider alias for `Conversation`                                                           |
| Group folder                | Workspace projection for `AgentConversationBinding` and `WorkspaceSnapshot`                 |
| Legacy sender/control lists | Sender policy and conversation approver inputs                                              |
| Claude session id           | `ProviderSession` attached to `AgentSession`                                                |
| Group queue key             | Queue key derived from canonical app, agent, conversation, thread, session, and run context |
| Host runner process         | Runtime execution adapter governed by `SandboxProfile` and `SandboxLease`                   |
| Control events              | `RuntimeEvent` records projected to SDK lists, SSE/wait, run/job event views, and webhooks  |

## Adapter Boundaries

Channel adapters:

- accept provider payloads
- map provider users, conversations, threads, messages, and attachments to
  canonical records
- render canonical outbound messages, progress, permission prompts, and user
  questions back into provider surfaces
- keep provider SDK types out of domain and application services

LLM provider adapters:

- resolve `LlmProfile` to concrete model/provider calls
- create and update `ProviderSession`
- translate provider stream events into `RuntimeEvent` records through the exchange
- keep provider SDK types out of domain and application services

Storage adapters:

- persist canonical entities through repository ports
- may use Postgres, Drizzle, pg-boss, and indexes internally
- must not expose database row shapes as domain identity

CLI, control HTTP, Web UI, SDK, and ACP/ACPX adapters:

- authenticate and parse external requests
- invoke application use cases
- render responses and events
- must not mutate persistence directly or bypass application policy

## Deletion And Replacement Targets

Future implementation phases should remove or replace:

- old personal group folder model as domain identity
- hard-coded privileged conversation behavior
- provider-specific session as the only resume mechanism
- direct tool execution on host
- CLI-owned business logic
- control routes directly mutating persistence

Do not add compatibility shims for unsupported local state unless a later decision
explicitly approves them.
