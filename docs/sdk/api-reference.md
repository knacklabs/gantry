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

## Settings

The typed settings API exposes only allowlisted non-secret runtime settings. It
does not expose raw `settings.yaml`, channel tokens, database URLs, or arbitrary
nested patches.

```ts
client.settings.get()
client.settings.update({
  agent?: {
    name?,
    defaultModel?,
  },
  memory?: {
    enabled?,
    dreaming?: { enabled? },
  },
})
```

`PATCH /v1/settings` persists to `settings.yaml`, returns changed field paths,
and reports `restartRequired`; it does not restart the runtime.

## Capability Requests

Agents and SDK clients must use MyClaw request surfaces for capability changes.
Do not edit generated Claude config, `.mcp.json`, `.claude/skills`, settings, or
permission files directly.

Agent-facing tools:

- `send_message`: progress updates or direct channel messages while the agent is still running.
- `ask_user_question`: structured choices with options, single-select, multi-select, preview/details, and channel-native buttons.
- `request_skill_install`: provider skill install requests such as `clawhub:<slug>@<version>`.
- `request_skill_proposal`: agent-created or modified skill file bundles for review.
- `request_skill_dependency_install`: dependency requests for npm, brew, go, uv, or downloads required by a skill.
- `request_mcp_server`: third-party MCP server requests with transport, origin, tool patterns, credential needs, and reason.
- `request_tool_enable`: SDK or host tool requests such as `Bash`, `Write`, `Edit`, browser tools, scheduler tools, memory tools, and service tools.
- `request_channel_tool_enable`: channel capability requests such as Teams proactive messaging, Slack file access, or Telegram file download behavior.
- `service_restart`: main/admin agent restart after approved changes that require host restart.
- `register_agent`: main/admin agent binding of a channel conversation to an agent.

Every persistent capability change follows request, validation, review, approve
or deny, durable audit, new config version, and next-run activation. Same-channel
review binds the request to the originating chat or thread; it does not bypass
the configured control allowlist.

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
they are not saved in Claude config, provider artifacts, or Postgres rows.
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
  sessionId,
  kind?, // manual | once | recurring
  runAt?, // once
  schedule?, // recurring
  executionMode?, // parallel | serialized
  threadId?,
  model?,
})

client.jobs.list()
client.jobs.get(jobId)
client.jobs.update(jobId, patch)
client.jobs.delete(jobId)
client.jobs.pause(jobId)
client.jobs.resume(jobId)
client.jobs.trigger(jobId)
client.jobs.wait(triggerId, timeoutMs?)
```

## Runs

```ts
client.runs.list(jobId?)
client.runs.get(runId)
```

Read-only run event history is available over the control API:

```http
GET /v1/runs/:runId/events
```

## Channels

Channel installation APIs are app-bound by the API key. Channel credentials are
stored as `runtimeSecretRefs`; raw tokens and secrets are rejected by the
control API.

```ts
client.channels.providers.list()

client.channels.installations.create({
  appId,
  providerId, // app | telegram | slack
  label,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})

client.channels.installations.list()
client.channels.installations.get(installationId)
client.channels.installations.update(installationId, {
  label?,
  status?,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})
client.channels.installations.delete(installationId)
client.channels.installations.discover(installationId, {
  query?,
  limit?,
  includeArchived?,
})

client.channels.conversations.list({ channelInstallationId? })
client.channels.conversations.get(conversationId)
client.channels.conversations.messages(conversationId, {
  threadId?,
  after?,
  limit?,
})
```

Control API scopes:

```http
GET    /v1/settings                                sessions:read
PATCH  /v1/settings                                agents:admin

GET    /v1/channel-providers                       channels:read
POST   /v1/channel-installations                   channels:admin
GET    /v1/channel-installations                   channels:read
GET    /v1/channel-installations/:id               channels:read
PATCH  /v1/channel-installations/:id               channels:admin
DELETE /v1/channel-installations/:id               channels:admin
POST   /v1/channel-installations/:id/discover      channels:admin

GET    /v1/conversations                           conversations:read
GET    /v1/conversations/:id                       conversations:read
GET    /v1/conversations/:id/threads               conversations:read
GET    /v1/conversations/:id/messages              messages:read
```

`teams` is a first-class built-in channel provider with Microsoft Teams app auth
through `RuntimeSecretProvider`, `teams:` conversation ids, `teams_` agent
folders, and Adaptive Card approval flows. `whatsapp` is still returned as an
unavailable placeholder until its adapter is implemented.

## Agent Channel Bindings

```ts
client.agents.bindings.list(agentId)
client.agents.bindings.enable(agentId, conversationId, {
  channelInstallationId?,
  threadId?,
  displayName?,
  triggerMode?, // always | mention | keyword | manual | webhook
  triggerPattern?,
  requiresTrigger?,
  isAdminBinding?,
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
`common` memory is app-wide and requires admin memory scope to write.

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
  kind?,        // fact | preference | decision | correction | constraint | project_fact | reference
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
```

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
