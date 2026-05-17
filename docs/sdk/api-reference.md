# SDK API Reference

## Client

```ts
createClient({
  apiKey,
  socketPath?, // preferred local transport
  baseUrl?,    // optional loopback TCP or remote proxy
  timeoutMs?,
})
```

## Local Service Transport

The Control API is part of the main MyClaw runtime process. On macOS, the
`launchctl` service starts that runtime, so the API comes up with the same
LaunchAgent.

Control API settings are read from process env and from `~/myclaw/.env`:

```env
MYCLAW_CONTROL_API_KEYS_JSON=[{"kid":"local-admin","token":"dev-key","appId":"default","scopes":["sessions:read","sessions:write","jobs:read","jobs:write","providers:read","providers:admin","conversations:read","conversations:admin","messages:read","agents:admin","skills:read","skills:admin","mcp:read","mcp:admin","webhooks:read","webhooks:write","ingresses:read","ingresses:write","memory:read","memory:admin"]}]
MYCLAW_CONTROL_PORT=8787
```

`MYCLAW_CONTROL_PORT` is optional. Without it, the local SDK and CLI use the
Unix socket at `~/myclaw/run/control.sock`. Do not put control API secrets in
the launchd plist; keep the plist limited to `MYCLAW_HOME`, `HOME`, and `PATH`.
Every Control API token must be listed in `MYCLAW_CONTROL_API_KEYS_JSON` with
an explicit `kid`, `token`, `appId`, and `scopes` array.

## Settings

The typed settings API is diagnostic/read-only for local personal mode. It
exposes the public non-secret desired-state view but does not accept runtime
configuration mutations. Human operators may use CLI commands or edit
`settings.yaml` directly; agents must use selected MyClaw admin tools such as
`settings_desired_state` and `request_settings_update` so changes are reviewed,
validated, synced, and audited.

```ts
client.settings.get();
```

`PATCH /v1/settings` returns `409 SETTINGS_READ_ONLY`.

## Capability Requests

Agents and SDK clients must use MyClaw request surfaces for capability changes.
Do not edit generated Claude config, `.mcp.json`, `.claude/skills`, settings, or
permission files directly.

Owner/admin automation uses the reduced public API:

```http
GET    /v1/agents
POST   /v1/agents
GET    /v1/agents/:agentId
PATCH  /v1/agents/:agentId
GET    /v1/agents/:agentId/admin
GET    /v1/agents/:agentId/capabilities
PUT    /v1/agents/:agentId/capabilities

GET    /v1/capability-catalog

GET    /v1/providers
GET    /v1/provider-connections
POST   /v1/provider-connections
GET    /v1/provider-connections/:providerConnectionId
PATCH  /v1/provider-connections/:providerConnectionId
POST   /v1/provider-connections/:providerConnectionId/discover-conversations
GET    /v1/conversations
GET    /v1/conversations/:conversationId
GET    /v1/conversations/:conversationId/approvers
PUT    /v1/conversations/:conversationId/approvers
GET    /v1/agents/:agentId/conversation-bindings
PUT    /v1/agents/:agentId/conversation-bindings/:conversationId
PATCH  /v1/agents/:agentId/conversation-bindings/:conversationId
DELETE /v1/agents/:agentId/conversation-bindings/:conversationId
```

Agents own exactly `selectedToolIds`, `selectedSkillIds`, and
`selectedMcpServerIds`. Conversations own sender policy, trigger policy, bound
agents, sessions, and control approvers. Control approvers must be members of
the Conversation and are used for both direct/private and group/channel
approval flows. There is no conversation-scoped tool selection field, and
Browser is one normal catalog tool.
Agent-requested changes use MyClaw MCP request tools, not public API request
approval endpoints.

Agent-facing tools:

- `send_message`: progress updates or direct channel messages while the agent is still running.
- `ask_user_question`: structured choices with options, single-select, multi-select, preview/details, and channel-native buttons.
- `request_skill_install`: provider skill install requests such as `clawhub:<slug>@<version>`.
- `request_skill_proposal`: agent-created or modified skill file bundles for review.
- `request_skill_dependency_install`: dependency requests for npm, brew, go, uv, or downloads required by a skill.
- `request_mcp_server`: third-party MCP server requests with transport, origin, tool patterns, credential needs, and reason.
- `request_permission`: SDK, host, browser, scheduler, memory, service, MCP, semantic capability, or provider/channel capability permission requests.
- `capability_search`: search built-in semantic capabilities such as `google.sheets.write`.
- `request_capability`: request a named semantic capability for the current agent.
- `propose_local_cli_capability`: propose a user-defined authenticated local CLI capability draft with pinned executable, command templates, preflight, protected paths, and account label. Drafts do not become runnable durable authority until runtime local-CLI enforcement exists.
- `manage_capability`: view/change/revoke/test/audit guidance for selected capabilities.
- `capability_status`: current tool access, semantic capability tools, readable configured rules, selected skills, selected MCP servers, and request arguments for missing admin tools.
- `settings_desired_state`: selected-capability read of current local desired state.
- `request_settings_update`: selected-capability reviewed edit to non-secret `settings.yaml` desired state.
- `mcp_list_tools` / `mcp_call_tool`: list and call approved third-party MCP tools through the MyClaw proxy.
- `service_restart`: selected-capability restart after approved changes that require host restart.
- `register_agent`: selected-capability binding of a channel conversation to an agent.

Every persistent capability change follows request, validation, review,
decision, durable audit, new config version, and next-run activation.
Persistent agent tool grants are mirrored into `settings.yaml` as readable
`agents.<id>.tools` entries: semantic capabilities such as
`capability:google.sheets.write`, canonical `Browser`, exact MyClaw admin
tools, or scoped Bash rules such as `Bash(npm test *)`. Durable
`request_permission` does not mint broad exact SDK/native tools or exact
third-party MCP tools; those must be represented by selected semantic
capabilities or reviewed MCP server bindings. Jobs inherit the target agent's
tools, skills, and MCP servers at run time;
`toolAccess` in job responses reports that inherited effective projection and
any runtime-only projected tools.
Agent capability updates are bidirectional: settings-side changes reconcile
Postgres immediately, and API/admin-side capability writes export the readable
projection back into `settings.yaml` before returning.
Permission prompts use the simple choices `Allow once`, `Allow 5 min`,
`Always allow`, or `Cancel`.
Same-conversation review binds the request to the originating chat or thread;
it does not bypass the configured conversation approvers. Raw request ids,
command hashes, scoped Bash rules, executable paths, and sandbox details are
Details/advanced data, not the primary permission prompt.

Capability catalog response:

```json
{
  "tools": [
    {
      "id": "tool:capability:google.sheets.write",
      "name": "capability:google.sheets.write",
      "kind": "host",
      "provider": "myclaw",
      "displayName": "Google Sheets write",
      "category": "productivity",
      "risk": "high",
      "semanticCapability": {
        "capabilityId": "google.sheets.write",
        "displayName": "Google Sheets write",
        "credentialSource": "configured_access"
      }
    }
  ],
  "skills": [],
  "mcpServers": []
}
```

Agent capability replacement:

```http
PUT /v1/agents/agent:main_agent/capabilities
Content-Type: application/json

{
  "selectedToolIds": ["tool:capability:google.sheets.write", "tool:Browser"],
  "selectedSkillIds": [],
  "selectedMcpServerIds": []
}
```

The route validates catalog ownership, mirrors readable entries into
`settings.yaml`, reconciles the Postgres projection, and returns `toolAccess`.

## Skills

MyClaw exposes the reviewable lifecycle for agent-created skill drafts. The SDK
does not expose hosted skill version management; hosted promotion uses the
Anthropic SDK behind the MyClaw Anthropic adapter and stores only provider refs.

```ts
client.skillDrafts.upload({
  agentId?,
  createdBy?,
  zip, // Uint8Array containing application/zip bytes
})
client.skillProviders.search({ provider: 'clawhub', query?, limit? })
client.skillProviders.import({
  ref: 'clawhub:<slug>@<version>',
  agentId?,
  requestedBy?,
})
client.skillDrafts.list({ agentId? })
client.skillDrafts.approve(skillId, { approvedBy?, target? }) // local | hosted
client.skillDrafts.reject(skillId, { rejectedBy? })

client.skills.files.list(skillId)
client.skills.files.get(skillId, path)

client.agents.skills.list(agentId)
client.agents.skills.enable(agentId, skillId)
client.agents.skills.disable(agentId, skillId)
```

Drafts are durable across restart because metadata lives in Postgres and file
bytes live as readable skill folders (`skills/<skill-slug>/...` or
`skill-drafts/<request-id>/<skill-slug>/...`) in the selected file/object
backend. The database stores metadata, source, hashes, provider refs, bindings,
and audit only. Draft, rejected, and disabled skills are not materialized into
per-run `CLAUDE_CONFIG_DIR/skills`. Skill name and description are parsed from
`SKILL.md`; upload requests only carry context such as the proposing agent or
creator. Provider imports, including ClawHub, still create reviewable drafts;
provider verification improves review context but does not bypass approval.

## MCP Servers

MCP servers are managed as reviewed agent capabilities. The SDK creates drafts,
admins approve or reject them, and approved versions can be bound to agents.
Agent-requested MCP servers remain drafts until an admin approves and binds
them.

```ts
client.mcpServers.drafts.create({
  name,
  transport, // http | sse; stdio_template is control API/SDK only
  config,
  credentialRefs?,
  allowedToolPatterns?,
  autoApproveToolPatterns?,
})
client.mcpServers.drafts.list({ limit?, cursor? })
client.mcpServers.drafts.approve(serverId, { approvedBy? })
client.mcpServers.drafts.reject(serverId, { rejectedBy?, reason? })
client.mcpServers.list({ status?, limit?, cursor? })
client.mcpServers.test(serverId, { testedBy? })
client.mcpServers.disable(serverId, { disabledBy?, reason? })

client.agents.mcpServers.list(agentId, { limit?, cursor? })
client.agents.mcpServers.enable(agentId, serverId, { required?, permissionPolicyIds? })
client.agents.mcpServers.update(agentId, serverId, { required?, permissionPolicyIds? })
client.agents.mcpServers.disable(agentId, serverId)
```

MCP definitions store credential reference names only. Broker-injected values
are projected into a private per-run config file with `0600` permissions and
deleted by the runner after startup and by the host on early spawn failures;
they are not saved in Claude config, FileArtifacts, or Postgres rows.
`allowedToolPatterns` is the enforced SDK allowlist for third-party MCP tool
names. `autoApproveToolPatterns` is session auto-allow scope and must be a
subset of `allowedToolPatterns` when an explicit allowlist is present.
Agent-requested MCP credential needs are labels, not raw broker ref selectors;
the host projects them into a server-scoped `MCP_<SERVER>_<NEED>_REF` reference
before any approved next-run materialization.
Remote MCP URLs must use HTTPS and cannot target local, private, link-local, or
metadata hosts. MyClaw resolves remote MCP hostnames during approval, testing,
and each materialization pass and rejects any A/AAAA record in private,
loopback, link-local, multicast, unspecified, documentation, or metadata ranges.
Runtime materialization uses a short in-process validation cache for same-batch
coalescing only; it must not be treated as durable DNS trust.
Stdio-template MCP servers require an approved sandbox profile and are not
available from agent-requested or CLI draft creation in this version. The
`npx-package` template accepts exactly one safe npm package argument. MCP server
bindings are agent-wide in this version. Chat approvals are sent only to the
trusted originating chat/thread registered for the requesting agent. Conversation
or thread scoping is not accepted until the runtime materialization path
supports it end to end.

## Sessions

```ts
client.sessions.ensure({
  conversationId,
  appId?, // optional assertion; defaults to API key app scope
  title?,
  responseMode?, // sse | webhook | both | none
  webhookId?,
})

client.sessions.sendMessage({
  sessionId,
  message,
  senderId?,
  senderName?,
  threadId?,
  correlationId?,
  responseMode?,
  webhookId?,
})

client.sessions.listEvents(sessionId, afterEventId?)
client.sessions.stream(sessionId, { afterEventId?, signal? })
client.sessions.wait(sessionId, { afterEventId?, timeoutMs? })
```

`client.sessions.sendMessage` resolves after the runtime accepts and persists the
inbound session message. The response shape is:

```ts
{
  accepted: boolean;
  messageId: string;
  acceptedEventId: number;
}
```

`accepted: true` and `acceptedEventId` mean the message was durably accepted
into the session event stream and queued for runtime processing. They do not
mean the model run has completed, a provider accepted outbound delivery, or the
user-facing channel has received a response synchronously. Observe delivery and
model progress through `client.sessions.stream`, `client.sessions.wait`,
`client.sessions.listEvents`, or the configured outbound webhook events.

Read-only history endpoints are available over the control API. SDK helpers are
not exposed for these endpoints yet.

```http
GET /v1/sessions/:sessionId
GET /v1/sessions/:sessionId/messages?limit=100
GET /v1/sessions/:sessionId/runs?limit=100
```

Responses are scoped by the API key's app access. Session history is backed by
Postgres `AgentSession`, `Message`, `AgentRun`, and `ProviderSession` records.

## External Ingress

```ts
const ingress = await client.ingresses.create({
  name: 'scraper',
  metadata: {
    targetPolicy: {
      allowedTargetKinds: ['session_message', 'job_template'],
      conversationIds: ['scraper-task-42'],
      templateIds: ['captcha_resolution'],
    },
    templates: {
      captcha_resolution: {
        name: 'Resolve captcha',
        sessionId,
        prompt: 'Resolve task {{taskId}} at {{url}}',
        allowedVariables: ['taskId', 'url'],
      },
    },
  },
});

client.ingresses.list();
client.ingresses.get(ingress.ingressId);
client.ingresses.update(ingress.ingressId, { enabled: false });
client.ingresses.rotate(ingress.ingressId);
client.ingresses.delete(ingress.ingressId);
```

Runtime calls sign the exact HTTP method, path, timestamp, nonce, body hash, and
raw body using the ingress secret.

Ingress records are scoped capabilities. A signed caller can only invoke target
kinds and concrete sessions, conversations, jobs, or templates listed in
`metadata.targetPolicy`; omitted policy fields deny access by default.

```ts
import { signIngressRequest } from '@myclaw/sdk';

const path = `/v1/ingresses/${ingressId}/invoke`;
const rawBody = JSON.stringify({
  target: {
    kind: 'session_message',
    conversationId: 'scraper-task-42',
    message: 'Captcha solved: 1234',
  },
});
const timestamp = String(Date.now());
const nonce = crypto.randomUUID();
const signature = signIngressRequest({
  secret,
  method: 'POST',
  path,
  timestamp,
  nonce,
  rawBody,
});
```

## Jobs

```ts
client.jobs.create({
  name,
  prompt,
  executionContext: {
    conversationJid,
    threadId,  // null for whole-conversation jobs
    groupScope,
    sessionId, // required canonical app session id
  },
  notificationRoutes?, // defaults to primary execution context route
  kind?, // manual | once | recurring
  runAt?, // once
  schedule?, // recurring
  modelAlias?,    // friendly catalog alias, e.g. opus, sonnet, kimi
  modelProfileId?,
  dryRun?,        // preview model plus runtime context without scheduling
})

client.jobs.list()
client.jobs.get(jobId)
client.jobs.update(jobId, {
  name?,
  prompt?,
  executionContext?: {
    conversationJid,
    threadId,
    groupScope,
    sessionId, // required when executionContext is provided
  },
  notificationRoutes?,
  status?,
  modelAlias?,    // use null to clear back to inherited defaults
  modelProfileId?,
})
client.jobs.delete(jobId)
client.jobs.pause(jobId)
client.jobs.resume(jobId)
client.jobs.trigger(jobId)
client.jobs.wait(triggerId, timeoutMs?)
```

Use `client.models.list()` to inspect supported model aliases, context windows,
cache policy, and provider labels. API job creation rejects raw provider model
IDs unless they are registered catalog aliases.

Job create and dry-run responses include `runtimeContext`: source conversation,
resolved `executionContext`, resolved `notificationRoutes`, resolved persona,
and conversation-scoped browser profile. Jobs created from a DM/channel inherit
that place's context; API or CLI callers should pass a session id for the
conversation that should receive job notifications and permission issues.

Job definitions, job instances, run history, and notification routes are
runtime Postgres state. They are not written to `settings.yaml`.

## Runs

```ts
client.runs.list(jobId?)
client.runs.get(runId)
```

Read-only run event history is available over the control API:

```http
GET /v1/runs/:runId/events
```

## Providers And Conversations

Provider and conversation APIs are app-bound by the API key. Provider credentials are stored as
`runtimeSecretRefs`; raw tokens and secrets are rejected by the control API.
Use `Conversation` for Slack channels/DMs, Teams channels/chats, and Telegram groups/DMs. Slack
and Teams threads plus Telegram forum topics inherit approvers from the parent conversation.

```ts
client.providers.list()

client.providerConnections.create({
  appId,
  providerId, // app | telegram | slack
  label,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})

client.providerConnections.list()
client.providerConnections.get(providerConnectionId)
client.providerConnections.update(providerConnectionId, {
  label?,
  status?,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})
client.providerConnections.delete(providerConnectionId)
client.providerConnections.discoverConversations(providerConnectionId, {
  query?,
  limit?,
  includeArchived?,
})

client.conversations.list({ providerConnectionId? })
client.conversations.get(conversationId)
client.conversations.getApprovers(conversationId)
client.conversations.setApprovers(conversationId, userIds)
client.conversations.messages(conversationId, {
  threadId?,
  after?,
  limit?,
})
```

Control API scopes:

```http
GET    /v1/settings                                agents:admin
GET    /v1/models                                  sessions:read

GET    /v1/agents                                  agents:admin
POST   /v1/agents                                  agents:admin
GET    /v1/agents/:id                              agents:admin
PATCH  /v1/agents/:id                              agents:admin
GET    /v1/agents/:id/admin                        agents:admin
GET    /v1/agents/:id/capabilities                 agents:admin
PUT    /v1/agents/:id/capabilities                 agents:admin

GET    /v1/capability-catalog                      agents:admin

GET    /v1/providers                               providers:read
POST   /v1/provider-connections                    providers:admin
GET    /v1/provider-connections                    providers:read
GET    /v1/provider-connections/:id                providers:read
PATCH  /v1/provider-connections/:id                providers:admin
DELETE /v1/provider-connections/:id                providers:admin
POST   /v1/provider-connections/:id/discover-conversations providers:admin

GET    /v1/conversations                           conversations:read
GET    /v1/conversations/:id                       conversations:read
GET    /v1/conversations/:id/approvers             conversations:read
PUT    /v1/conversations/:id/approvers             conversations:admin
GET    /v1/conversations/:id/threads               conversations:read
GET    /v1/conversations/:id/messages              messages:read

GET    /v1/agents/:id/conversation-bindings        conversations:read
PUT    /v1/agents/:id/conversation-bindings/:conversationId agents:admin
PATCH  /v1/agents/:id/conversation-bindings/:conversationId agents:admin
DELETE /v1/agents/:id/conversation-bindings/:conversationId agents:admin
```

`GET /v1/agents/:id/admin` returns Agent admin state, including
provider-neutral `boundConversationPolicies` and read-only `boundConversations` summaries with
the provider, conversation kind, display name, and current conversation
approver user ids. Direct/private and group/channel approvals are configured
through the conversation approver endpoints below; agents do not expose a
separate direct-message policy API.

`GET /v1/conversations/:id/approvers` returns the Conversation approver list.
`PUT /v1/conversations/:id/approvers` replaces it with
`{ "userIds": ["..."] }` and fails when any user cannot be verified as a
member of the Conversation. Slack, Telegram, Teams, and App/Web conversations
use the same API shape; Teams validation uses Microsoft Graph membership for
chat or team-channel members. Conversation sender policy remains independent
from control approvers; allowed senders are not conversation approvers unless
they are also listed on the conversation. A Slack approver can approve only Slack-origin
conversation requests; the corresponding Teams user id must be listed on the
Teams conversation to approve Teams-origin requests.

`teams` is a built-in provider for setup and discovery with Microsoft
Teams app auth through `RuntimeSecretProvider`, Microsoft Graph channel
discovery, `teams:` conversation ids, and `teams_` agent folders. Runtime send
and receive still depend on a concrete `TeamsSdkClient` adapter; this checkout
includes tested normalization and Adaptive Card approval scaffolding. `whatsapp`
is still returned as an unavailable placeholder until its adapter is
implemented.

## Agent Conversation Bindings

```ts
client.agents.conversationBindings.list(agentId)
client.agents.conversationBindings.enable(agentId, conversationId, {
  providerConnectionId?,
  threadId?,
  displayName?,
  triggerMode?, // always | mention | keyword | manual | webhook
  triggerPattern?,
  requiresTrigger?,
  memoryScope?, // user | conversation | thread | agent | app
  memorySubject?,
  workspaceSnapshotId?,
  permissionPolicyIds?,
})
client.agents.bindings.update(agentId, conversationId, patch)
client.agents.bindings.disable(agentId, conversationId, { threadId? })
```

Binding writes require `agents:admin`. `disable()` marks the binding disabled;
it does not delete the row.

## Agent Skill Bindings

Prefer `PUT /v1/agents/:agentId/capabilities` for deterministic replacement of
all selected skills together with tools and MCP servers. The routes below remain
specialized skill draft/file lifecycle routes.

```http
POST   /v1/skills/drafts/upload                  skills:admin
GET    /v1/skills/drafts                         skills:read
POST   /v1/skills/drafts/:id/approve             skills:admin
POST   /v1/skills/drafts/:id/reject              skills:admin
GET    /v1/skills/:skillId/files                 skills:read
GET    /v1/skills/:skillId/files/:path           skills:read
GET    /v1/skill-providers/clawhub/search        skills:read
POST   /v1/skill-providers/clawhub/import        skills:admin
GET    /v1/agents/:agentId/skills                skills:read
PUT    /v1/agents/:agentId/skills/:skillId       skills:admin
DELETE /v1/agents/:agentId/skills/:skillId       skills:admin
```

An enabled binding only affects runtime when the skill is approved.
Local approved skills are unpacked into the per-run Claude config; hosted
approved skills are represented by Anthropic provider refs.

## Agent MCP Server Bindings

Prefer `PUT /v1/agents/:agentId/capabilities` for deterministic replacement of
selected MCP servers together with tools and skills. The routes below remain
specialized MCP draft, validation, and disable lifecycle routes.

```http
POST   /v1/mcp-servers/drafts                    mcp:admin
GET    /v1/mcp-servers/drafts?limit=&cursor=     mcp:read
GET    /v1/mcp-servers?status=&limit=&cursor=    mcp:read
POST   /v1/mcp-servers/drafts/:id/approve        mcp:admin
POST   /v1/mcp-servers/drafts/:id/reject         mcp:admin
POST   /v1/mcp-servers/:id/test                  mcp:admin
POST   /v1/mcp-servers/:id/disable               mcp:admin
GET    /v1/agents/:agentId/mcp-servers?limit=&cursor= mcp:read
PUT    /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
PATCH  /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
DELETE /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
```

An enabled MCP binding affects runtime only when the server definition is
approved. The built-in `myclaw` MCP server is internal and is not managed by
these routes. Conversation or thread scoped MCP bindings are not part of this
API version.

## Memory

Memory APIs are app-bound by the API key. Pass stable `appId`, `agentId`,
`userId`, `groupId`, `channelId`, and `threadId` when your application has them.
`common` memory is app-wide and requires admin/service authority to write. Agent
MCP/IPC `memory_save` defaults to user or group scope and cannot directly write
common/global memory.

```ts
client.memory.save({
  appId?,
  agentId?,
  userId?,
  groupId?,
  channelId?,
  threadId?,
  subjectType?, // user | group | channel | common
  subjectId?,
  kind?,        // preference | decision | fact | correction | constraint
  key,
  value,
  why?,
  confidence?,
  evidenceText?,
})

client.memory.search({
  appId?,
  agentId?,
  userId?,
  groupId?,
  channelId?,
  threadId?,
  query?,
  limit?,
  includeCommon?,
  subjectTypes?,
})

client.memory.list({ appId?, agentId?, userId?, groupId?, channelId? })
client.memory.patch(memoryId, { appId?, agentId?, expectedVersion?, key?, value?, why?, confidence?, isPinned? })
client.memory.delete(memoryId, { appId?, agentId? })
client.memory.dreaming.trigger({ appId?, agentId?, subjectType?, subjectId?, phase?, dryRun? })
client.memory.dreaming.status({ appId?, agentId? })

client.memory.sources.add({ sourceType: "text", text, title?, appId?, agentId?, userId?, groupId?, channelId?, threadId?, ingest? })
client.memory.sources.list({ appId?, agentId?, userId?, groupId?, channelId?, threadId?, limit? })
client.memory.sources.status(sourceId, { appId?, agentId?, userId?, groupId?, channelId?, threadId? })
client.memory.sources.search({ query, appId?, agentId?, userId?, groupId?, channelId?, threadId?, limit? })
client.memory.sources.delete(sourceId, { appId?, agentId? })
client.memory.sources.ingest(sourceId, { appId?, agentId? })
```

`reference` memory is reserved for procedure/knowledge-source flows instead of
direct `memory_save` payloads.
Blogs, articles, docs, posts, tweets/X content, pasted text, and files should
be added through `client.memory.sources.*`; source ingestion stores
provenance/chunks and stages reviewable candidates, but it does not directly
create active `memory_items`.

## Webhooks

```ts
client.webhooks.register({ name, url, secret?, enabled? })
client.webhooks.list()
client.webhooks.update(webhookId, { name?, url?, secret?, enabled? })
client.webhooks.delete(webhookId)
client.webhooks.test(webhookId)
client.webhooks.replayDeadLetter(webhookId)
client.webhooks.purgeDeadLetter(webhookId)
```
