# Canonical Domain Model

This document defines the product vocabulary MyClaw code should converge on.
It is intentionally provider-neutral and channel-neutral. Current
implementation names such as registered group, group folder, main group, JID,
and Claude session id are legacy implementation details unless they are
explicitly mapped to one of the concepts below.

## Model Summary

```text
App
  Agent
    AgentConfigVersion
    LlmProfile
    AgentChannelBinding
      ChannelInstallation
        ChannelProvider
        Conversation
          ConversationThread
          Message
            MessagePart
            MessageAttachment
    AgentSession
      ProviderSession
    AgentRun
      AgentRunEvent
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

- Domain identity uses MyClaw ids, not provider ids.
- Provider ids are stored as external references on adapter-owned records.
- Domain records are scoped by `appId` unless explicitly global.
- Channel-specific payloads must be normalized before they reach application
  use cases.
- Model-provider session tokens are attached to `ProviderSession`, not used as
  the only source of runtime continuity.

## Core Ownership

| Concept               | Owner                    | Meaning                                                                                                                                                                            |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App`                 | Domain                   | A runtime namespace for agents, users, memory, policies, channels, jobs, and SDK/API access.                                                                                       |
| `Agent`               | Domain                   | A configured agent inside an app. It owns prompt profile lineage, model profile selection, tools, skills, memory visibility, and channel bindings.                                 |
| `AgentConfigVersion`  | Domain                   | An immutable version of agent behavior: prompt profile, model selection, tool/skill catalog references, workspace defaults, permission policy references, and runtime limits.      |
| `LlmProfile`          | Domain                   | Provider-neutral model intent such as purpose, model alias, budget, thinking mode, embedding usage, and credential-broker reference. Concrete SDK names live in provider adapters. |
| `ChannelProvider`     | Adapter catalog          | A channel adapter type such as Telegram, WhatsApp, Slack, Teams, or Web UI. It describes capabilities and normalization rules.                                                     |
| `ChannelInstallation` | Application plus adapter | An installed provider for an app, including workspace/team/bot/account identity, runtime-owned secrets, webhook/socket config, and enablement state.                               |
| `Conversation`        | Domain                   | A provider-neutral communication container. It can be a DM, group, channel, chat, SDK conversation, or Web UI chat.                                                                |
| `ConversationThread`  | Domain                   | A sub-conversation within a conversation, such as Slack `thread_ts`, Telegram forum topic, Teams reply chain, or a Web UI branch.                                                  |
| `AgentChannelBinding` | Domain                   | The relationship that says an agent is present in a conversation or thread with trigger, routing, permissions, memory scope, and workspace projection.                             |
| `User`                | Domain                   | A human or service actor known to an app. Provider-specific user ids are aliases.                                                                                                  |
| `Message`             | Domain                   | A normalized inbound, outbound, system, or tool-visible communication event within a conversation or thread.                                                                       |
| `MessagePart`         | Domain                   | A typed part of a message, such as text, markdown, image, file reference, tool result, form response, or structured data.                                                          |
| `MessageAttachment`   | Domain plus adapter      | Binary or external media attached to a message. The domain owns metadata and trust classification; adapters own download and upload mechanics.                                     |
| `AgentSession`        | Domain                   | Canonical continuity state for an agent in an app, conversation, thread, job, or run context. It survives provider swaps.                                                          |
| `ProviderSession`     | Adapter                  | A provider-specific resume token or transcript pointer, such as a Claude session id. It is attached to an `AgentSession`.                                                          |
| `AgentRun`            | Domain/application       | One execution attempt by an agent for a message, job, control request, or manual trigger.                                                                                          |
| `AgentRunEvent`       | Domain/application       | A durable event emitted during a run: queued, started, model event, tool request, permission decision, output chunk, completed, failed, or canceled.                               |
| `MemorySubject`       | Domain                   | A memory boundary for app, agent, user, group/team, conversation, thread, or common shared memory.                                                                                 |
| `Job`                 | Domain/application       | Scheduled, recurring, or manual work that creates agent runs under explicit app, agent, session, and permission context.                                                           |
| `ToolCatalogItem`     | Domain catalog           | A tool capability exposed to agents with name, input contract, risk classification, permission requirements, and adapter binding.                                                  |
| `SkillCatalogItem`    | Domain catalog           | A reusable behavior package or prompt/tool bundle that can be attached to agent config versions.                                                                                   |
| `PermissionPolicy`    | Domain                   | A named policy attached to an app, agent, binding, tool, job, or sandbox profile.                                                                                                  |
| `PermissionRule`      | Domain                   | A deterministic rule inside a policy. It can allow, deny, require approval, or require a sandbox lease.                                                                            |
| `PermissionDecision`  | Domain/application       | The audited result of evaluating a request against policy and runtime context.                                                                                                     |
| `SandboxProfile`      | Domain/application       | A named execution environment policy: filesystem, network, process, browser, credential, timeout, and approval behavior.                                                           |
| `SandboxLease`        | Runtime/application      | A time-bounded grant to execute work under a sandbox profile for a specific run or tool call.                                                                                      |
| `WorkspaceSnapshot`   | Runtime/application      | A stable view of workspace files, mounts, prompt profile inputs, and generated runtime context used for an agent run.                                                              |
| `BrowserProfile`      | Domain/application       | A named browser identity with storage state, auth markers, allowed usage, and ownership policy.                                                                                    |

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

### Channels, Conversations, And Bindings

`ChannelProvider` describes adapter capabilities. Examples include Telegram,
WhatsApp, Slack, Teams, and Web UI. It is catalog metadata, not an installed
runtime account.

`ChannelInstallation` is an app's installed provider instance. For Slack it may
represent a workspace app installation. For Telegram it may represent a bot
token. For Teams it may represent a tenant/app installation. For Web UI it may
represent the app-owned web channel. Secrets belong behind
`RuntimeSecretProvider`.

`Conversation` is the canonical message container. Provider ids such as
Telegram chat id, WhatsApp chat id, Slack channel id, Teams chat id, or SDK
conversation id are external aliases on a conversation.

`ConversationThread` exists only when a provider or UI creates a nested reply,
topic, branch, or thread boundary. Thread ids are external aliases under the
conversation.

`AgentChannelBinding` connects one agent to one conversation or thread. It owns
trigger behavior, routing, allowlists, admin capabilities, memory subject
selection, default workspace projection, and permission policy selection. A
group folder is only one possible workspace projection of this binding.

### Users And Messages

`User` is a canonical actor in an app. Channel providers contribute aliases,
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

`ProviderSession` stores provider-specific resume state for an `AgentSession`.
Claude session id is one provider session field. Other providers may use a
thread id, response id, transcript pointer, or no provider resume token.
Provider sessions are optimizations only. When the current provider matches the
latest active provider session, the runtime may attempt native resume. When the
provider session is missing, expired, stale, or from a different provider, the
runtime resumes from Postgres by replaying the latest session summary plus
recent messages, memory records, and run summaries.

`AgentSessionSummary` stores an extractive checkpoint for long conversations.
It records the summarized message/run range and lets hydration use summary plus
last N messages instead of replaying the full conversation on every run.

`AgentRun` is one execution attempt. It has a cause, app, agent, config version,
session, conversation/thread context, permission context, sandbox lease,
workspace snapshot, provider profile, status, timestamps, and result summary.

`AgentRunEvent` is the observable event stream for a run. SDK streams, Web UI,
webhooks, channel progress, audit trails, and debugging should read run events
instead of scraping provider stdout.

### Memory And Jobs

`MemorySubject` is the visibility boundary for durable memory. Valid subject
shapes include app-wide common memory, agent memory, user memory, group/team
memory, conversation memory, and thread memory. Channel provider names do not
change the meaning of the boundary.

`Job` belongs to an app and runs through the same agent/session/run path as a
message-triggered run. Jobs can target an agent binding, a session, a
conversation, a thread, or a service context. Job execution must not bypass
permission policy or sandbox lease rules.

### Tools, Skills, Permissions, And Sandboxes

`ToolCatalogItem` describes a capability before it is invoked. It should include
input schema, output schema, risk category, default policy, required sandbox
profile, credential broker needs, and adapter binding.

`SkillCatalogItem` describes a reusable behavior package. It may provide prompt
sections, tools, workflows, docs, or setup hooks. Attaching a skill to an agent
requires an `AgentConfigVersion` change.

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

## Channel Mapping

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

- A provider conversation id is never the only MyClaw identity. Store it as an
  alias under `ChannelInstallation`.
- Threads are optional. A provider without threads maps all messages directly
  to `Conversation`.
- Web UI must choose one mapping during implementation and document it in the
  Web UI adapter contract.
- Channel adapters must preserve enough provider metadata to reply correctly,
  but application behavior should use canonical ids.

## Current Implementation Mapping

These mappings describe current code so future refactors know what to replace:

| Current implementation             | Canonical target                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Registered group                   | `AgentChannelBinding` plus `Conversation` and optional `ConversationThread`                 |
| Group JID/chat JID                 | Provider alias for `Conversation`                                                           |
| Group folder                       | Workspace projection for `AgentChannelBinding` and `WorkspaceSnapshot`                      |
| Main group                         | Admin `AgentChannelBinding` governed by `PermissionPolicy`                                  |
| Sender allowlist/control allowlist | `PermissionPolicy` and `PermissionRule` inputs                                              |
| Claude session id                  | `ProviderSession` attached to `AgentSession`                                                |
| Group queue key                    | Queue key derived from canonical app, agent, conversation, thread, session, and run context |
| Host runner process                | Runtime execution adapter governed by `SandboxProfile` and `SandboxLease`                   |
| Control events                     | `AgentRunEvent` plus API-visible event projections                                          |

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
- translate provider stream events into `AgentRunEvent`
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
- main group specific behavior as a primary architecture concept
- provider-specific session as the only resume mechanism
- direct tool execution on host
- CLI-owned business logic
- control routes directly mutating persistence

Do not add compatibility shims for old local state unless a later decision
explicitly approves them.
