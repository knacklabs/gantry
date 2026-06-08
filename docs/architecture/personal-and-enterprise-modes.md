# Personal And Enterprise Modes

Gantry has one canonical runtime model with multiple deployment modes. Personal
usage and enterprise usage differ by seeding, providerConnection, policy, user
surfaces, and operations. They must not become separate product architectures.

## Shared Runtime Model

Both modes use:

- `App` as the namespace
- `Agent` and `AgentConfigVersion` for behavior
- `LlmProfile` for provider-neutral model selection
- `Provider`, `ProviderConnection`, and `AgentConversationBinding` for provider
  presence
- `Conversation` and `ConversationThread` for communication
- `User`, `Message`, `MessagePart`, and `MessageAttachment` for normalized
  events
- `AgentSession`, `ProviderSession`, `AgentRun`, and `RuntimeEvent` for
  continuity and execution
- `MemorySubject` for memory boundaries
- `Job` for scheduled and manual work
- `PermissionPolicy`, `PermissionRule`, and `PermissionDecision` for
  deterministic authorization
- `SandboxProfile`, `SandboxLease`, `WorkspaceSnapshot`, and `BrowserProfile`
  for tool, workspace, browser, and host execution boundaries

Channel/chat providers and model providers adapt into this model. They do not
define it.

## Personal Mode

Personal mode is a seeded local deployment. It is not the core domain model.

Seeded defaults:

- one local `App`, commonly named `personal`
- one default `Agent`
- local `settings.yaml`
- local runtime secret source
- local memory root and Postgres schema
- one or more `ProviderConnection` records for Telegram, WhatsApp, Slack, or
  another personal provider
- `AgentConversationBinding` records for the conversations where the user wants
  the agent present
- local default model alias, backed by Gantry Model Gateway credentials
- conservative default `PermissionPolicy`
- host runtime `SandboxProfile` until stronger isolation is implemented

Personal setup may create folders for workspace projection, prompt profile
files, logs, session artifacts, and browser profiles. Those folders are runtime
storage, not domain identity.

Personal administration should be represented as policy:

- A private DM can seed a conversation approver, and a trusted group/channel can seed
  conversation approvers.
- Admin ability comes from selected capabilities plus conversation approval,
  not from a hard-coded privileged conversation.
- `/new` and related session commands operate on canonical `AgentSession`
  records for the binding while preserving configured model overrides when the
  policy requires it.

Personal mode can stay lightweight and understandable while still using the
same app, agent, conversation, session, run, memory, policy, sandbox, and
workspace model as enterprise mode.

## Enterprise Mode

Enterprise mode uses the same runtime model with different integration
surfaces:

- Web UI for users, administrators, and operators
- control API for backend integrations and administration
- server-side SDK for application developers
- provider connections for Slack, Teams, Web UI, and other providers
- explicit users, roles, app scopes, and policy-managed admin actions
- enterprise credential brokers or secret managers behind the same ports
- deployment-specific sandbox providers
- audit, event, and webhook integrations based on `RuntimeEvent` projections

Enterprise applications should integrate through the SDK, control API, Web UI,
and provider connections. They must not import runtime internals from
`apps/core/src/**`.

Enterprise conversation examples:

- Slack workspace providerConnection creates a `ProviderConnection`.
- A Slack channel creates or maps to a `Conversation`.
- A Slack thread maps to `ConversationThread`.
- A Teams tenant/app providerConnection creates a `ProviderConnection`.
- A Teams personal chat or channel chat maps to `Conversation`.
- A Teams reply chain maps to `ConversationThread`.
- A Web UI can model each chat as a `Conversation`, or model a visible chat as
  a `ConversationThread` inside a larger workspace conversation. The Web UI
  adapter must choose and document one mapping.

## Web UI, Control API, And SDK

Web UI, control API, and SDK are adapters over application use cases.

They may:

- create apps, agents, configs, and provider connections
- bind agents to conversations and threads
- send messages
- stream run events
- manage jobs
- manage memory through scoped APIs
- manage browser profiles and workspace projections
- request or approve permissions when policy allows

They must not:

- directly mutate persistence
- bypass permission evaluation
- treat provider session ids as canonical continuity
- import provider SDK payloads into domain behavior
- assume ACP/ACPX is present

## ACP/ACPX Integration

The repo must work with plain Codex and with ACP/ACPX integrations. ACP/ACPX
are orchestration adapters around the same runtime contracts.

ACP/ACPX may provide:

- persistent issue sessions
- orchestration state
- long-running coordination
- external task graph synchronization

ACP/ACPX must not define:

- canonical app identity
- agent identity
- conversation or thread identity
- permission policy semantics
- provider session behavior
- runtime storage layout

Plain Codex and ACP/ACPX modes must produce the same factory artifacts and use
the same in-repo architecture source of truth.

## Provider Positioning

Claude/Anthropic is one provider adapter. It can be the default local provider
path, but it is not the architecture.

The platform must be able to support:

- Claude/Anthropic through an Anthropic adapter
- OpenAI through an OpenAI adapter
- Gemini through a Gemini adapter
- local or enterprise-hosted models through future adapters

Provider adapters resolve `LlmProfile`, may store provider export/debug
metadata, and publish observable `RuntimeEvent` records through the runtime
exchange. The domain and application layers should not know provider SDK types
or rely on provider session handles for continuity.

## Mode Comparison

| Concern            | Personal mode                                                     | Enterprise mode                                                  |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| App                | Seeded local app                                                  | Explicit app per deployment, team, product, or tenant boundary   |
| Agent              | Default local agent plus optional custom agents                   | Managed agents with versioned configs                            |
| Conversation setup | CLI-guided local provider connections and bindings                | Web UI/control API/SDK-managed provider connections and bindings |
| Admin surface      | Seeded conversation approver/conversation approvers and local CLI | Web UI, control API, SDK, conversation approver bindings         |
| Credentials        | Local runtime secrets plus Gantry Credential Center model/capability credentials | Runtime secret provider plus enterprise-backed Credential Center |
| Permissions        | Conservative defaults with local approvals                        | Explicit policies, roles, audit, and approval flows              |
| Workspace          | Local folders and snapshots                                       | Managed workspace projections and snapshots                      |
| Sessions           | Canonical sessions with provider session attachments              | Same model, often with more audit and retention policy           |
| Runs               | Local run events and logs                                         | API-visible event stream, webhooks, audits, and monitoring       |

## Implementation Guidance

Future code movement should keep personal setup as a convenience layer:

- Seed default records through application services.
- Store local folders as workspace projections.
- Convert group registration flows into provider connection plus binding
  flows.
- Keep administration behavior explicit in conversation approver policy.
- Store provider export/debug metadata only when needed; canonical continuity
  comes from Gantry sessions, memory, digests, messages, jobs, and events.
- Route CLI and control HTTP through application use cases.

Do not create a separate personal-only runtime path. Do not create an
enterprise-only runtime path. Both modes should exercise the same application
and domain contracts.
