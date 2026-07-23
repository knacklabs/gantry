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

The Control API is part of the main Gantry runtime process. On macOS, the
`launchctl` service starts that runtime, so the API comes up with the same
LaunchAgent.

Control API settings are read from process env and from `~/gantry/.env`:

```env
GANTRY_CONTROL_API_KEYS_JSON=[{"kid":"local-admin","token":"replace-with-a-generated-token","appId":"default","scopes":["sessions:read","sessions:write","jobs:read","jobs:write","providers:read","providers:admin","conversations:read","conversations:admin","messages:read","agents:admin","skills:read","skills:admin","mcp:read","mcp:admin","webhooks:read","webhooks:write","ingresses:read","ingresses:write","memory:read","memory:admin","llm:invoke"]}]
GANTRY_CONTROL_PORT=8787
GANTRY_CONTROL_HOST=127.0.0.1
```

`GANTRY_CONTROL_PORT` is optional. Without it, the local SDK and CLI use the
Unix socket at `~/gantry/run/control.sock`. Do not put control API secrets in
the launchd plist; keep the plist limited to `GANTRY_HOME`, `HOME`, and `PATH`.
Every Control API token must be listed in `GANTRY_CONTROL_API_KEYS_JSON` with
an explicit `kid`, `token`, `appId`, and `scopes` array.
Generate the `token` value with a password manager or `openssl rand -base64 32`;
do not copy the placeholder into a shared or hosted deployment.
`GANTRY_CONTROL_HOST` defaults to `127.0.0.1`; set it to `0.0.0.0` only for a
hosted deployment that protects the Control API with bearer tokens and platform
network controls.

When the control server is reachable over TCP, interactive API documentation is
available at `GET /docs` and the machine-readable Swagger/OpenAPI document is
available at `GET /openapi.json`. For the default Unix socket transport, fetch
the same spec with:

```sh
curl --unix-socket ~/gantry/run/control.sock http://localhost/openapi.json
```

## Operational endpoints

Three unversioned operational endpoints exist for liveness, readiness, and
metrics. They are **unauthenticated by design** and carry no `/v1` prefix:

| Endpoint       | Returns                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | `200 {"status":"ok"}` — process is up.                                                                                                                                                       |
| `GET /readyz`  | `200` when DB-migrated, settings loaded, and not draining; `503` with `{ status, checks, failing }` while starting or draining. Carries a top-level `role` and role-specific checks (below). |
| `GET /metrics` | Prometheus text exposition (`text/plain; version=0.0.4`).                                                                                                                                    |

They are internal-only and **must not be exposed on the public ALB listener**.
In the fleet shape the ALB routes `/v1/*` to the control pool and `/webhooks/*`
to the live pool; verify health from inside the VPC against a member's control
port (the ASG health check and the on-instance drain hook consume `/readyz`). See
the [AWS Terraform runbook](../deployment/aws-terraform.md) health-verification
step.

These ops endpoints are the only routes worker roles (`live-worker`,
`job-worker`) serve besides the read-only `GET /v1/status`, `GET /v1/health`, and
`GET /v1/doctor`; every admin/mutation `/v1/*` route 404s on a worker role. SDK
admin/session calls go to the control role.

**Role-aware `/readyz`.** On top of the shared `database`/`migrations`/`settings`/
`draining` checks, `/readyz` carries a top-level `role`
(`all|control|live-worker|job-worker`) and role-specific checks:

- `control` adds `api_auth` (control API keys configured).
- `live-worker` adds `worker_registered` and `live_capacity`
  (`"available"|"saturated"`). Saturation is **reported, never failed** — a busy
  live worker stays ready.
- `job-worker` adds `worker_registered` and `scheduler` (the scheduler loop is
  claiming).
- `all` carries only the shared checks.

**Role/live gauges on `/metrics`** (alongside the existing `gantry_*` gauges):
`gantry_process_role{role}`, `gantry_live_turns_active`,
`gantry_live_slots_used_cluster`, `gantry_live_slots_used_local`,
`gantry_live_slots_capacity_local`,
`gantry_live_warm_spare`, `gantry_live_turns_recoverable`,
`gantry_live_oldest_waiting_seconds`, `gantry_live_admission_backlog`,
`gantry_live_admission_backlog_oldest_seconds`,
`gantry_background_job_slots_used`, and
`gantry_background_job_slots_capacity`.

The authenticated `GET /v1/health` and `GET /v1/doctor` (`sessions:read`) — which
the SDK exposes as `client.health()` and `client.doctor()` — are served by every
role (read-only). `GET /v1/health` carries `processRole` so a client can confirm
which role answered.

## Settings

`GET /v1/settings` is the typed, read-only effective-settings view
(`agents:admin`). It exposes the public non-secret runtime settings but does not
accept mutations: `PATCH /v1/settings` returns `409 SETTINGS_READ_ONLY`. Human
operators change settings through CLI commands or by editing `settings.yaml`
directly; agents must use selected Gantry admin tools such as
`settings_desired_state` and `request_settings_update` so changes are reviewed,
validated, synced, and audited.

```ts
client.settings.get();
```

To mutate desired state programmatically (the fleet surface), use the
desired-state endpoints below.

## Desired state

Fleet deployments distribute configuration as a versioned, typed JSON settings
document through the control API instead of a file each worker watches
([Settings Authority](../decisions/0025-settings-authority.md)). Both
surfaces — the workstation `settings.yaml` auto-importer and this API — run the
same schema validation and produce the same document-path-level errors.

The document is the **full snake_case settings document** — the same shape
`settings_revisions` stores as jsonb. YAML never appears on the API wire; it is
only the workstation file and the CLI `--file` edge.

```ts
client.settings.getDesiredState();
client.settings.updateDesiredState({ settings, expectedRevision?, note? });
client.settings.listRevisions();
```

Both endpoints require `agents:admin`.

`GET /v1/settings/desired-state` returns the current revision and document:

```json
{
  "revision": 7,
  "minReaderVersion": 3,
  "settings": { "runtime": { "deployment_mode": "fleet" } },
  "createdBy": "control-api:fleet-admin",
  "note": "raise live concurrency",
  "updatedAt": "2026-06-11T00:00:00.000Z"
}
```

Before the first revision is seeded the response is
`{ "revision": 0, "settings": null, "updatedAt": null }`.

`PUT /v1/settings/desired-state` (also accepts `POST`) takes
`{ settings, expectedRevision?, note? }` and appends a revision:

- `400 INVALID_REQUEST` — `settings` missing or not a document object, or
  `expectedRevision` not an integer.
- `400 INVALID_SETTINGS` — the document failed to decode or failed validation;
  validation failures carry document-path-level `errors` in the response
  `details`.
- `409 REVISION_CONFLICT` — `expectedRevision` did not match the current
  revision (optimistic concurrency); the response carries `expectedRevision` and
  `actualRevision`.
- `200` — `{ "revision": <new revision> }`.

Optimistic concurrency: read the current revision, mutate the document, and pass
it back as `expectedRevision`. A concurrent writer that landed first makes the
write fail with `409` rather than clobbering their change.

```ts
const current = await client.settings.getDesiredState();
const next = applyChange(current.settings ?? {});
await client.settings.updateDesiredState({
  settings: next,
  expectedRevision: current.revision,
  note: 'raise live concurrency',
});
```

`client.settings.listRevisions()` returns recent revision summaries
(`revision`, `minReaderVersion`, `createdBy`, `note`, `createdAt`) for audit and
skew inspection.

## Capability Requests

Agents and SDK clients must use Gantry request surfaces for capability changes.
Do not edit generated provider config, `.mcp.json`, provider skill folders,
settings, or permission files directly.

Owner/admin automation uses the reduced public API:

```http
GET    /v1/agents
POST   /v1/agents
GET    /v1/agents/:agentId
PATCH  /v1/agents/:agentId
GET    /v1/agents/:agentId/admin
GET    /v1/inventory
GET    /v1/capabilities
GET    /v1/capabilities/:capabilityId
GET    /v1/agents/:agentId/access
PUT    /v1/agents/:agentId/access

GET    /v1/providers
GET    /v1/provider-accounts
POST   /v1/provider-accounts
GET    /v1/provider-accounts/:providerAccountId
PATCH  /v1/provider-accounts/:providerAccountId
POST   /v1/provider-accounts/:providerAccountId/discover-conversations
GET    /v1/conversations
GET    /v1/conversations/:conversationId
GET    /v1/conversations/:conversationId/approvers
PUT    /v1/conversations/:conversationId/approvers
GET    /v1/agents/:agentId/conversation-installs
PUT    /v1/agents/:agentId/conversation-installs/:conversationId
PATCH  /v1/agents/:agentId/conversation-installs/:conversationId
DELETE /v1/agents/:agentId/conversation-installs/:conversationId
```

Agents expose `sources` and `capabilities` as separate API surfaces.
`sources` lists attached installed resources such as skills, MCP servers,
built-in tools, adapters, and local CLIs. `capabilities` is the only durable
grant list and contains selected capability ids.
Conversations own sender policy, trigger policy, bound agents, sessions, and
control approvers. Control approvers must be members of the Conversation and
are used for both direct/private and group/channel approval flows. There is no
conversation-scoped tool selection field, and Browser is represented by a
readable `browser.use` capability id that projects to the canonical runtime
`Browser` tool rule.
Agent-requested changes use Gantry MCP request tools, not public API request
approval endpoints.

Agent-facing tools:

- `send_message`: progress updates or direct channel messages while the agent is still running.
- `ask_user_question`: structured choices with options, single-select, multi-select, preview/details, and channel-native buttons.
- `continuity_summary`: inspect current durable continuity, staged memory candidates, reviewed memory state, and last injected context for the trusted subject.
- `file`: list, read, write, or promote Gantry FileArtifacts by virtual scope/path; host filesystem paths and storage refs stay hidden.
- `request_skill_install`: reviewed skill install requests with staged package files or an installer command that produces a `SKILL.md` package in host-controlled staging.
- `request_skill_proposal`: agent-created or modified skill file bundles for review.
- `request_skill_dependency_install`: dependency requests for npm, brew, go, uv, or downloads required by a skill.
- `request_mcp_server`: third-party MCP server requests with a reviewed `stdio_template`, sandbox profile, tool patterns, credential needs, and reason.
- `request_access`: request an approved reviewed semantic capability by id.
- `request_access`: request a scoped `RunCommand` fallback when no reviewed capability fits.
- `request_access`: source install/connect stays separate; use `request_skill_install`, `request_skill_proposal`, or `request_mcp_server` for sources.
- `settings_desired_state`: selected-capability read of current local desired state.
- `request_settings_update`: selected-capability reviewed edit to non-secret `settings.yaml` desired state.
- `admin_permission_list`: selected-capability list of current-agent persistent Gantry MCP grants.
- `admin_permission_revoke`: selected-capability revocation of a current-agent persistent Gantry MCP grant.
- `mcp_list_tools` / `mcp_describe_tool` / `mcp_call_tool`: search connected third-party MCP source inventory, fetch one tool schema/detail, and call approved tools through the Gantry proxy.
- `service_restart`: selected-capability restart after approved changes that require host restart.
- `register_agent`: selected-capability binding of a channel conversation to an agent.

Every persistent capability change follows request, validation, review,
decision, durable audit, new config version, and next-run activation.
Persistent agent grants are mirrored into `settings.yaml` as readable
`agents.<id>.access.selections` entries such as a reviewed app capability,
`browser.use`, or a reviewed composite capability version. The `browser.use`
entry projects to the canonical runtime `Browser` tool rule. Sources are
mirrored under `agents.<id>.access.sources` and do not create execution authority by
themselves. Durable `request_access` does not mint broad exact SDK/native
tools or exact third-party MCP tools; those must be represented by selected
semantic capabilities or reviewed MCP server bindings. Jobs inherit the target
agent's capabilities and sources at run time; `toolAccess` in job responses
reports that inherited effective projection and any runtime-only projected
tools.
Agent capability updates are bidirectional: settings-side changes reconcile
Postgres immediately, and API/admin-side capability writes export the readable
projection back into `settings.yaml` before returning.
Permission prompts use `Allow once`, `Allow for future` when a persistent
suggestion exists, or `Cancel`.
Same-conversation review binds the request to the originating chat or thread;
it does not bypass the configured conversation approvers. Raw request ids,
command hashes, scoped `RunCommand(...)` rules, executable paths, and sandbox details are
Details/advanced data, not the primary permission prompt.

Inventory response:

```json
{
  "inventory": {
    "tools": [{ "id": "browser", "kind": "builtin", "displayName": "Browser" }],
    "skills": [],
    "mcpServers": []
  }
}
```

Capability catalog response:

```json
{
  "capabilities": [
    {
      "id": "acme.records.append",
      "version": "1",
      "displayName": "Acme records append",
      "category": "Acme",
      "risk": "write",
      "source": "local_cli"
    }
  ]
}
```

Agent access replacement (sources and selections in one document):

```http
PUT /v1/agents/agent:main_agent/access
Content-Type: application/json

{
  "sources": {
    "skills": [
      {
        "name": "linkedin-posting",
        "id": "skill:266c421f-a072-44f7-9cb0-43c52eba8ad9"
      }
    ],
    "mcpServers": [{ "id": "linkedin" }],
    "tools": [{ "id": "browser", "kind": "builtin" }]
  },
  "selections": [
    { "id": "acme.records.append", "version": "1" },
    { "id": "browser.use", "version": "builtin" }
  ]
}
```

Agent access responses include the visible sources, selected capabilities,
and projected runtime access:

```json
{
  "agentId": "agent:main_agent",
  "sources": {
    "skills": [
      {
        "name": "linkedin-posting",
        "id": "skill:266c421f-a072-44f7-9cb0-43c52eba8ad9"
      }
    ],
    "mcpServers": [{ "id": "linkedin" }],
    "tools": [{ "id": "browser", "kind": "builtin" }]
  },
  "selections": [
    { "id": "acme.records.append", "version": "1" },
    { "id": "browser.use", "version": "builtin" }
  ],
  "toolAccess": {
    "configuredTools": ["capability:acme.records.append", "Browser"],
    "defaultTools": [],
    "availableButGatedTools": ["RunCommand", "FileEdit", "FileWrite"],
    "requestableAdminTools": [
      {
        "tool": "mcp__gantry__settings_desired_state",
        "toolId": "tool:mcp__gantry__settings_desired_state",
        "requestPermission": "target.kind=capability target.id=\"<reviewed admin capability id>\" temporaryOnly=false reason=\"<why this agent needs settings_desired_state>\""
      }
    ],
    "source": "Postgres agent_tool_bindings projected from settings.yaml"
  },
  "updatedAt": "2026-05-21T00:00:00.000Z"
}
```

The route validates catalog ownership, mirrors readable entries into
`settings.yaml`, reconciles the Postgres projection, and returns `toolAccess`.

## Skills

Gantry exposes installed skill packages. Admin setup installs a package
directly; agent-requested installs remain pending review until approval, then
use the same install-and-bind service path.

```ts
client.skills.install({
  agentId?,
  createdBy?,
  zip, // Uint8Array containing application/zip bytes
})
client.skills.list({ agentId? })

client.agents.skills.list(agentId)
client.agents.skills.enable(agentId, skillId)
client.agents.skills.disable(agentId, skillId)
```

Installed skill metadata lives in Postgres and file bytes live in the selected
local or object artifact backend. Disabled skills are not materialized into
per-run `CLAUDE_CONFIG_DIR/skills`. Skill name and description are parsed from
`SKILL.md`; upload, catalog, URL, and CLI-command installs all become the same
installed local skill package after review.

Agent source responses include a readable skill `name` when the catalog row is
available, but `id` is the only durable selection authority. Source replacement
requests may include `name` for round-trip readability; the service ignores it
for authorization and returns the current catalog name on the next read/export.

## MCP Servers

MCP servers are managed as connected agent resources. Admin setup connects the
current server definition directly. Agent-requested MCP servers remain pending
review until approval, then use the same connect-and-bind service path.

```ts
client.mcpServers.connect({
  name,
  transport, // stdio_template is runtime-projectable today; http/sse fail closed until DNS-pinned remote transport lands.
  config,
  credentialRefs?,
  allowedToolPatterns?,
  autoApproveToolPatterns?,
})
client.mcpServers.list({ status?, limit?, cursor? })
client.mcpServers.get(serverId)
client.mcpServers.test(serverId, { testedBy? })
client.mcpServers.disable(serverId, { disabledBy?, reason? })

client.agents.mcpServers.list(agentId, { limit?, cursor? })
client.agents.mcpServers.enable(agentId, serverId, { required?, permissionPolicyIds? })
client.agents.mcpServers.update(agentId, serverId, { required?, permissionPolicyIds? })
client.agents.mcpServers.disable(agentId, serverId)
```

MCP definitions store Gantry Credential reference names only. Resolved values are
projected into a private per-run config file with `0600` permissions and
deleted by the runner after startup and by the host on early spawn failures;
they are not saved in Claude config, FileArtifacts, or MCP definition rows.
`allowedToolPatterns` is the enforced SDK allowlist for third-party MCP tool
names. `autoApproveToolPatterns` is session auto-allow scope and must be a
subset of `allowedToolPatterns` when an explicit allowlist is present.
Agent-requested MCP credential needs are labels, not raw secret values. The host
normalizes them to Gantry Credential env names such as `GITHUB_TOKEN` before any
current-run or next-run materialization.
Remote MCP URLs must use HTTPS and cannot target local, private, link-local, or
metadata hosts. Gantry resolves remote MCP hostnames during approval, testing,
and each materialization pass and rejects any A/AAAA record in private,
loopback, link-local, multicast, unspecified, documentation, or metadata ranges.
Runtime materialization uses a short in-process validation cache for same-batch
coalescing only; it must not be treated as durable DNS trust.
Stdio-template MCP servers require an approved sandbox profile and are
available from agent-requested and CLI connect commands in this version. The
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

### Structured output (`response_schema`)

Sessions bound to an inline-runtime agent accept an optional JSON Schema on the
message-send payload. The selected inline lane enforces the schema and the turn
result carries the validated JSON. The field is typed on
`client.sessions.sendMessage` via the generated OpenAPI types and available on
the raw HTTP payload (`POST /v1/sessions/:sessionId/messages`).

```http
POST /v1/sessions/:sessionId/messages
{
  "message": "Summarize open incidents",
  "response_schema": { "type": "object", "properties": { ... }, "required": [ ... ] }
}
```

`response_schema` must be a compilable JSON Schema — it is compiled at
admission and an invalid schema returns a shaped `400` before any model call.
The lane output is validated against it; a structurally invalid response
triggers one corrective retry with the validation error fed back to the model,
and retry exhaustion returns a structured failure carrying the last candidate
text. Worker-runtime agents reject the field. Direct LLM API callers use
provider-native structured output in the provider-shaped payload instead (see
Direct LLM API below).

### Per-request model controls

Session message sends also accept per-request overrides of the agent's
configured model controls. They apply to that turn only, win over the agent's
settings defaults, are persisted with the message, and survive replay:

```http
POST /v1/sessions/:sessionId/messages
{
  "message": "...",
  "effort": "high",
  "thinking": { "mode": "on", "budget_tokens": 8192 },
  "max_output_tokens": 2048
}
```

- `effort` — `low | medium | high | xhigh | max`
- `thinking` — `"off"`, `"on"`, or `{ "mode": "on", "budget_tokens": <positive int> }`
- `max_output_tokens` — positive integer; DeepAgents-engine agents only
  (Claude-engine agents reject it; use `effort` there)

Overrides are validated against the target agent's model capabilities; an
unsupported combination is rejected with a `400` naming the field. All of
these fields are typed on `client.sessions.sendMessage` via the generated
OpenAPI types.

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
  name: 'ops-ingress',
  metadata: {
    targetPolicy: {
      allowedTargetKinds: [
        'conversation_message',
        'session_message',
        'job_template',
      ],
      conversationIds: ['conversation:ops-room'],
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

Use `conversation_message` when an external system needs to talk to an existing
Telegram, Slack, Teams, or App/Web conversation. The caller uses Gantry ids from
`GET /v1/conversations` and `GET /v1/conversations/:id/threads`; raw provider
ids such as Telegram chat ids or Slack channel ids are not accepted by the
ingress contract.

```ts
import { conversationMessageTarget, signIngressRequest } from '@gantry/sdk';

const path = `/v1/ingresses/${ingressId}/invoke`;
const rawBody = JSON.stringify({
  target: conversationMessageTarget({
    conversationId: 'conversation:ops-room',
    threadId: 'thread:ops-room:daily',
    message: 'Build finished; summarize the failure.',
    senderId: 'ci-worker',
    senderName: 'CI Worker',
  }),
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

`conversation_message` is asynchronous. `/invoke` returns durable acceptance
with `invocationId`, `duplicate`, `targetKind`, `conversationId`, optional
`threadId`, `messageId`, and `acceptedEventId`. It never exposes internal queue
or transport details (`enqueue`, `queueKey`, raw provider chat ids).

Ingress is **inbound invocation** (an external system addressing a Gantry
conversation); outbound webhooks are **outbound observation** of the resulting
runtime events. The same logical message applies to every provider — a client
can present acceptance as:

> Message queued to `<conversation label>`/`<delivery label>`. Replies appear in
> the provider conversation and outbound webhook events.

`<delivery label>` is a provider-neutral rendering term derived from the
conversation and thread — for example `Telegram group`/`Telegram topic`,
`Telegram chat`, `Slack channel`/`Slack thread`, `Slack DM`,
`Teams conversation`/`Teams reply thread`, or `App conversation`/`App session`.
These labels are display terms only; they carry no routing authority. Gantry
`conversationId`/`threadId` remain the only addressing the contract accepts.

The agent response is delivered through the configured conversation adapter,
and the `conversation.message.inbound` and `conversation.message.outbound`
runtime events can be observed through outbound webhook delivery.

## Jobs

```ts
client.jobs.create({
  name,
  prompt,
  executionContext: {
    conversationJid,
    threadId,  // null for whole-conversation jobs
    workspaceKey,
    sessionId, // required canonical app session id
  },
  notificationRoutes?, // defaults to primary execution context route
  accessRequirements?, // readiness assertions for capabilities, MCP sources, or scoped RunCommand fallback
  kind?, // manual | once | recurring
  runAt?, // once
  schedule?, // recurring
  modelAlias?,    // friendly catalog alias, e.g. opus, sonnet, kimi
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
    workspaceKey,
    sessionId, // required when executionContext is provided
  },
  notificationRoutes?,
  accessRequirements?,
  status?,
  modelAlias?,    // use null to clear back to inherited defaults
})
client.jobs.delete(jobId)
client.jobs.pause(jobId)
client.jobs.resume(jobId)
client.jobs.trigger(jobId)
client.jobs.wait(triggerId, timeoutMs?)
```

Job create, update, list, get, and trigger responses include `toolAccess` plus
display-only `ownerLabel`, `deliveryLabel`, `setupLabel`, and `nextActionLabel`
so callers can show the inherited target-agent projection without parsing raw
runtime ids. The arrays above are readiness assertions; they do not create tool
access for the job. Use selected agent capabilities, attached sources, or the
reviewed Gantry MCP request tools to change authority.

Use `client.models.list()` to inspect supported model aliases, response family,
route metadata, capabilities, context windows, cache policy, and supported
workloads. Each `ModelRecord` carries an `executionRoutes` array
(`{ harness, executionProviderId }`) that is read-only diagnostic. The active
API exposes `agentHarness` as the public selector and keeps
`executionProviderId` internal/read-only diagnostic. The 2026-06-14 harness contract in
[`docs/decisions/0028-agent-harness-selection.md`](../decisions/0028-agent-harness-selection.md)
defines the agent-level `agentHarness` (`auto`, `anthropic_sdk`, or
`deepagents`) and the `settings.yaml` key `agent_harness`. DeepAgents-lane entries omit the static
`contextWindowTokens`/`maxOutputTokens` limits because those are reported at
runtime from the engine's model profile.
API job creation rejects raw provider model IDs unless they are registered
catalog aliases.

Use `client.models.defaults.get()` to inspect configured and effective chat,
job, and memory LLM defaults. Use `client.models.defaults.update()` or
`PATCH /v1/models/defaults` to set chat/job aliases (including the `oneTime`
and `recurring` job slots) or reset an area back to inherited or
provider-managed defaults:

```ts
await client.models.defaults.update({
  chat: 'opus-4.8',
  jobs: 'inherit',
  memory: null,
});
```

The defaults route writes `settings.yaml`; provider credentials remain in Model
Access and are projected privately by the runtime adapter.

PATCH preflight is limited to the model slots affected by the request. Omitted
Memory defaults are neither changed nor credential-checked when updating Chat
or Jobs. `memory: null` explicitly re-derives the extractor, dreaming, and
consolidation aliases from the effective Chat provider; it never deletes or
repartitions Gantry's centralized durable memory.

Use `POST /v1/models/preview` for "why" checks before a run. `target: "chat"`
can include `conversationJid` or `workspaceKey` to expose live session `/model`
overrides; `target: "job"` with `jobId` distinguishes explicit job aliases from
inherited defaults. `target: "agent"` with `agentId` resolves a `modelAlias`
against the selected `agentHarness` and returns `credentialProfile` plus
diagnostic `executionProviderId`. Explicit harness/model incompatibility fails
before runner spawn with
`Model <alias> cannot run with agent harness <harness>.`
DeepAgents with Claude OAuth/subscription credentials fails with `DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.`

```ts
await client.models.preview({
  target: 'job',
  jobId,
});

await client.models.preview({
  target: 'agent',
  agentId,
  modelAlias: 'opus',
});

await client.models.preview({
  target: 'memory',
  task: 'dreaming',
});
```

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

Run events are projections of persisted runtime events:

```ts
{
  id: string;
  appId: string;
  runId: string;
  type:
    | 'queued'
    | 'started'
    | 'diagnostic'
    | 'model_event'
    | 'tool_request'
    | 'permission_decision'
    | 'output_chunk'
    | 'completed'
    | 'failed'
    | 'canceled';
  payload: unknown;
  createdAt: string;
  metadata: { runtimeEventType: string };
}
```

Notable runtime event types include:

- `task.started`, `task.progress`, and `task.updated`: provider-neutral task
  lifecycle observations. Persisted text fields are length-bounded and omit raw
  prompts, output paths, provider handles, credentials, and stack traces.
- `mcp.tool_activity`: MCP proxy attempt, denial, success, or failure audit
  evidence. Arguments and errors are summarized/redacted; raw MCP tool result
  values are not persisted in the activity event.
- `run.startup_diagnostic`: count/timing startup diagnostics from host or
  runner setup. The public run event projection exposes these as
  `type: 'diagnostic'`.

These events are observable history only. They do not create permissions, alter
selected capabilities, or prove provider/channel delivery by themselves.

The current run event API exposes read-only runtime history. Evidence receipts
are adaptive: pure chat answers do not need a receipt, work with no tools,
changes, delegation, or blocker may use only `Completed: <short outcome>`, and
impactful work uses the full receipt:

```text
Completed: <short outcome>
Used: <tools/capabilities>
Changed: <files/accounts/channels or none>
Delegated: yes/no
Needs attention: <blocker or none>
```

## Providers And Conversations

Provider and conversation APIs are app-bound by the API key. Provider credentials are stored as
`runtimeSecretRefs`; raw tokens and secrets are rejected by the control API.
Use `Conversation` for Slack channels/DMs, Teams channels/chats, and Telegram groups/DMs. Slack
and Teams threads plus Telegram forum topics inherit approvers from the parent conversation.

```ts
client.providers.list()

client.providerAccounts.create({
  appId,
  providerId, // app | telegram | slack
  agentId,
  label,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})

client.providerAccounts.list()
client.providerAccounts.get(providerAccountId)
client.providerAccounts.update(providerAccountId, {
  label?,
  status?,
  config?,
  externalRef?,
  runtimeSecretRefs?,
  enabled?,
})
client.providerAccounts.delete(providerAccountId)
client.providerAccounts.discoverConversations(providerAccountId, {
  query?,
  limit?,
  includeArchived?,
})

client.conversations.list({ providerAccountId? })
client.conversations.get(conversationId)
client.conversations.getApprovers(conversationId)
client.conversations.setApprovers(conversationId, userIds)
client.agents.conversationInstalls.enable(agentId, conversationId, {
  providerAccountId?,
  threadId?,
})
client.agents.conversationInstalls.list(agentId)
client.agents.conversationInstalls.disable(agentId, conversationId, { threadId? })
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
GET    /v1/models/defaults                         sessions:read
POST   /v1/models/preview                          sessions:read or jobs:read; stored job previews require jobs:read
PATCH  /v1/models/defaults                         agents:admin
GET    /v1/credentials/models                      credentials:read
PUT    /v1/credentials/models/:providerId          credentials:admin
PATCH  /v1/credentials/models/:providerId          credentials:admin
DELETE /v1/credentials/models/:providerId          credentials:admin

GET    /v1/agents                                  agents:admin
POST   /v1/agents                                  agents:admin
GET    /v1/agents/:id                              agents:admin
PATCH  /v1/agents/:id                              agents:admin
GET    /v1/agents/:id/admin                        agents:admin
GET    /v1/inventory                               agents:admin
GET    /v1/capabilities                            agents:admin
GET    /v1/capabilities/:id                        agents:admin
GET    /v1/agents/:id/access                       agents:admin
PUT    /v1/agents/:id/access                       agents:admin

GET    /v1/providers                               providers:read
POST   /v1/provider-accounts                       providers:admin
GET    /v1/provider-accounts                       providers:read
GET    /v1/provider-accounts/:id                   providers:read
PATCH  /v1/provider-accounts/:id                   providers:admin
DELETE /v1/provider-accounts/:id                   providers:admin
POST   /v1/provider-accounts/:id/discover-conversations providers:admin

GET    /v1/conversations                           conversations:read
GET    /v1/conversations/:id                       conversations:read
GET    /v1/conversations/:id/approvers             conversations:read
PUT    /v1/conversations/:id/approvers             conversations:admin
GET    /v1/conversations/:id/threads               conversations:read
GET    /v1/conversations/:id/messages              messages:read

GET    /v1/agents/:agentId/conversation-installs                 conversations:read
PUT    /v1/agents/:agentId/conversation-installs/:conversationId agents:admin + conversations:admin
PATCH  /v1/agents/:agentId/conversation-installs/:conversationId agents:admin + conversations:admin
DELETE /v1/agents/:agentId/conversation-installs/:conversationId agents:admin + conversations:admin
```

`GET /v1/agents/:id/admin` returns Agent admin state, including
provider-neutral `boundConversationPolicies` and read-only `boundConversations` summaries with
the provider, conversation kind, display name, and current conversation
approver user ids. Direct/private and group/channel approvals are configured
through the conversation approver endpoints below; agents do not expose a
separate direct-message policy API.

`GET /v1/agents/:id`, `POST /v1/agents`, and `PATCH /v1/agents/:id` agent
records expose durable `agentHarness` (`auto`, `anthropic_sdk`, or
`deepagents`). `executionProviderId` stays internal/read-only diagnostic and
must not be writable. Jobs and conversations inherit the bound agent's
`agentHarness`; there is no job- or conversation-level harness selector.

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

## Conversation Installs

```ts
client.agents.conversationInstalls.list(agentId)
client.agents.conversationInstalls.enable(agentId, conversationId, {
  providerAccountId?,
  threadId?,
  displayName?,
  memoryScope?, // user | conversation | agent | app
  memorySubject?,
  workspaceSnapshotId?,
  permissionPolicyIds?,
})
client.agents.conversationInstalls.update(agentId, conversationId, patch)
client.agents.conversationInstalls.disable(agentId, conversationId, { threadId? })
```

Install writes require `agents:admin` plus `conversations:admin`. `disable()`
marks the install disabled; it does not delete the row.

## Agent Skill Bindings

Prefer `PUT /v1/agents/:agentId/access` for deterministic replacement of
attached skills and selected capability ids. Selecting a skill source does not create risky skill action access;
those actions require selected reviewed capabilities in the same access document. The routes below remain specialized
skill install/file lifecycle routes.

```http
GET    /v1/skills                                 skills:read
POST   /v1/skills/install                         skills:admin
GET    /v1/skills/:skillId/files                 skills:read
GET    /v1/skills/:skillId/files/:path           skills:read
GET    /v1/agents/:agentId/skills                skills:read
PUT    /v1/agents/:agentId/skills/:skillId       skills:admin
DELETE /v1/agents/:agentId/skills/:skillId       skills:admin
```

An enabled binding only affects runtime when the skill is installed.
Installed skills are unpacked into the per-run Claude config from Gantry-owned
skill artifacts.

## Agent MCP Server Bindings

Prefer `PUT /v1/agents/:agentId/access` for deterministic replacement of
attached MCP servers and selected capability ids. Selecting an MCP source does not create execution access by
itself; callable MCP actions must be projected from selected reviewed
capabilities. The routes below remain specialized MCP validation and
disable lifecycle routes.

```http
POST   /v1/mcp-servers                           mcp:admin
GET    /v1/mcp-servers?status=&limit=&cursor=    mcp:read
GET    /v1/mcp-servers/:id                       mcp:read
POST   /v1/mcp-servers/:id/test                  mcp:admin
POST   /v1/mcp-servers/:id/disable               mcp:admin
GET    /v1/agents/:agentId/mcp-servers?limit=&cursor= mcp:read
PUT    /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
PATCH  /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
DELETE /v1/agents/:agentId/mcp-servers/:id       mcp:admin + agents:admin
```

An enabled MCP binding affects runtime only when the server definition is
active. The built-in `gantry` MCP server is internal and is not managed by
these routes. Conversation or thread scoped MCP bindings are not part of this
API version.

## Memory

Memory APIs are app-bound by the API key. Pass stable `appId`, `agentId`,
`userId`, `groupId`, and `channelId` when your application has them. Provider
topic/thread ids are routing metadata and do not partition durable memory.
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

`reference` memory is reserved for procedure/knowledge-source flows instead of
direct `memory_save` payloads.

## Direct LLM API

Provider-shaped raw model calls through the Gantry Model Gateway — no agent
loop, no agent tools. Streaming and non-streaming both pass through. There is
no SDK helper; point the official provider SDK at Gantry instead:

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Anthropic Messages shape → POST {base}/llm/v1/messages
const anthropic = new Anthropic({
  apiKey: process.env.GANTRY_CONTROL_API_KEY!,
  baseURL: 'http://127.0.0.1:3939/llm',
});

// OpenAI Chat Completions shape → POST {base}/llm/v1/chat/completions
const openai = new OpenAI({
  apiKey: process.env.GANTRY_CONTROL_API_KEY!,
  baseURL: 'http://127.0.0.1:3939/llm/v1',
});
```

- `POST {base}/llm/v1/messages/count_tokens` (Anthropic shape) is also
  mounted for context-window budgeting, with the same auth, scope, and model
  rules as the messages route.
- The API key must carry the `llm:invoke` scope. Missing/invalid key → `401`;
  valid key without the scope → `403`.
- `model` must be a registered Gantry model alias for the endpoint's response
  family; raw provider model ids are rejected with `400`.
- An API key may carry an optional `maxTokens` ceiling. Limited keys must send
  an explicit `max_tokens` / `max_completion_tokens` at or below the limit
  (`n` choices are multiplied in on chat completions); violations are rejected
  with `400 MAX_TOKENS_EXCEEDED` naming the limit — never silently clamped.
  Keys without the field are unlimited.
- Client-side tools, structured outputs, `max_tokens`, and thinking/effort
  parameters pass through to the provider unchanged. Provider-hosted execution
  surfaces (Anthropic server tools, remote MCP, containers; OpenAI hosted
  tools, attachments, file references) are rejected with `400
  UNSUPPORTED_FIELD` naming the field.
- Usage is attributed to the API key in the request log; the gateway credential
  is request-scoped and revoked when delivery ends.

## Usage

Aggregated token usage across live agent turns, scheduled jobs, and Direct LLM
API calls, from one normalized event stream (recorded from deployment forward;
streaming passthrough responses are not measured in v1):

```ts
client.usage.query({
  from, // ISO timestamp, required
  to,   // ISO timestamp, required
  agentId?, apiKeyId?, runId?, jobId?, model?,
  group_by?, // 'agent' | 'api_key' | 'model' | 'day'
})
```

Requires the `usage:read` scope; results are scoped to the API key's app
access. Missing/invalid time range → `400`; missing scope → `403`.

## Webhooks

```ts
client.webhooks.register({ name, url, secret?, enabled?, eventTypes?, agentId?, sessionId?, jobId? })
client.webhooks.list()
client.webhooks.update(webhookId, { name?, url?, secret?, enabled?, eventTypes?, agentId?, sessionId?, jobId? })
client.webhooks.delete(webhookId)
client.webhooks.test(webhookId)
client.webhooks.replayDeadLetter(webhookId)
client.webhooks.purgeDeadLetter(webhookId)
```
