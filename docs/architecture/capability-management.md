# Capability Management

Gantry uses one generic access model for every agent-visible extension:

- Source: what exists, such as a skill, MCP server, local CLI, adapter,
  browser implementation, or Gantry built-in.
- Capability: a reviewed action that a source can perform.
- Grant / Allowed Capability: the target agent is allowed to use that reviewed
  capability.
- Requirement: a job declares needed capabilities and inherits the target
  agent's allowed capabilities at run time.

The common rule is request, review, approval or denial, durable audit, new
config version, and next-run activation.

Agents must not mutate capability state directly. They must not run dependency
install commands, edit provider skill folders, edit `.mcp.json`, edit provider
permission settings, edit Gantry settings, or change generated runtime config.
When a user asks for a new skill, MCP server, dependency, SDK tool, host tool,
or channel capability, the agent calls the matching Gantry request tool.

The user-facing permission model is `Agent -> Capability -> Grant`.
Raw permission ids, command hashes, scoped `RunCommand(...)` rules, sandbox
profiles, and executable paths are implementation details that belong in
Details/audit surfaces. Skills, MCP servers, local CLIs, adapters, SDK tools,
host tools, browser tools, provider-native channel tools, and conversation
bindings keep typed source metadata, but they feed the same reviewed capability
and grant lifecycle.

## Semantic Tool Capabilities

Semantic capabilities are stable user-facing grants generated from reviewed
tool, skill, MCP server, adapter, or CLI manifests. The durable settings
representation is readable:

```yaml
agents:
  main_agent:
    sources:
      skills:
        - name: linkedin-posting
          id: 'skill:266c421f-a072-44f7-9cb0-43c52eba8ad9'
      mcp_servers:
        - id: linkedin
          tools: [read_*]
      tools:
        - id: browser
          kind: builtin

    capabilities:
      - id: acme.records.append
        version: 1
      - id: browser.use
        version: builtin
      - id: repo.tests.run
        version: 1
```

Each semantic capability record includes:

- `capabilityId`, `displayName`, `category`, `risk`, and optional
  `accountLabel`
- `can` and `cannot` user-facing scope statements
- `credentialSource`: implementation metadata such as `configured_access`,
  `local_cli`, or `none`
- low-level implementation bindings such as exact Gantry tool facades, scoped
  `RunCommand(<template>)`, MCP tools, adapter refs, or local CLI command templates
- optional preflight metadata, protected credential/config paths, redaction
  policy, and sandbox needs

Runtime expands a selected semantic capability to deterministic low-level
rules for the current run, but management and prompts keep the semantic name
primary. For example, `capability:acme.records.append` may project to a
provider-neutral adapter, MCP tool, skill action, or local CLI command template
while the approval prompt uses the reviewed capability display name.

Internally, that expansion produces typed `CapabilityRuntimeAccess` entries:
`local_cli`, `skill_action`, `mcp_server`, `builtin_tool`, and
`configured_adapter`. The same selected capability projects the same access for
DM/private runs, group/channel runs, Slack/Teams threads, Telegram topics,
recurring jobs, one-time jobs, and manually triggered jobs. Threads and topics
select routing, approval delivery, and audit metadata only; they do not create a
second durable permission scope.

Core code must not hardcode product, provider, or CLI capability ids. Unknown
business tools are not accepted as ad hoc raw commands. They must be promoted
through a reviewed semantic capability first.

## Skill Action Capabilities

Approved skills may declare reviewed action permissions in
`gantry.skill.json`. This manifest is skill metadata, not authority by itself:
installing or selecting a skill creates source inventory only. The target
agent owns the allowed capability, jobs inherit that agent authority, and the skill
only declares the trusted label, scoped command templates, and credential names
that may be projected after the matching action capability is selected.

Example:

```json
{
  "actions": [
    {
      "id": "publish",
      "capabilityId": "skill.publisher.publish",
      "displayName": "Publisher publish",
      "risk": "write",
      "can": "Publish prepared content through the approved skill action.",
      "cannot": "Read unrelated accounts or receive raw credentials.",
      "requiredEnvVars": ["PUBLISHER_ACCESS_TOKEN"],
      "commandTemplates": [
        "python3 ${skillRoot}/publish.py --file /tmp/content.md"
      ],
      "networkHosts": ["api.publisher.com:443", "www.publisher.com:443"]
    }
  ]
}
```

Optional `networkHosts` declare the outbound hosts the action command is
expected to reach. Each entry is an exact `host` or `host:port`; the manifest
parser rejects URLs, schemes, paths, credentials, wildcards, invalid ports, and
localhost/private/loopback targets, then lowercases, strips trailing dots, and
dedupes. Declared hosts are reviewed inventory and audit metadata, not an
operational allowlist: once the action capability is approved, its command uses
normal outbound internet through the egress gateway. Gantry projects this as a
provider-neutral `toolNetworkEnv` for approved skill, local CLI, script, and
MCP stdio subprocesses; execution adapters map that same contract into their
runner-specific tool environment. The selected capability still projects the
declared hosts into the run so egress audit and transient sandbox network gates
can attribute traffic to the reviewed capability, but a host the action did not
declare is not failed closed simply for being undeclared. Enforcement lives in
the global denylist, not the declaration.

The global `permissions.egress.denylist` is the durable egress control: a
denylisted host is blocked even when a selected action declares it, with a clear
policy error naming the host. Review and prompt surfaces show the declared hosts
as a `Network:` line beside the reviewed action display name; that line is
informational review metadata, not a promise that only those hosts will work.

Runtime normalizes `${skillRoot}` to the stable readable skill directory,
for example `skills/publisher`, rejects generated runtime paths such as
`.llm-runtime/claude/skills/...`, rejects shell environment assignments and
secret-like command parts, and records the installed skill id on the semantic
capability definition. A persistent approval stores
`capability:skill.publisher.publish` on the agent and projects the
underlying scoped `RunCommand(...)` only while that installed skill remains
selected. Skill credentials follow the same authority boundary: attached skills
do not receive `requiredEnvVars` unless the matching reviewed action capability
is selected for the agent.

Permission prompts use the trusted manifest display name, for example
`Allow Publisher publish?`, while buttons remain short: `Allow once`,
`Allow 5 min`, `Always allow`, and `Cancel`. Raw free-form request text cannot
create a trusted action label; raw command fallback remains visible as exact
command access.

## Local CLI Capabilities

`local_cli` is a first-class credential source for authenticated CLIs.
User-defined local CLI capabilities require the runtime local-CLI gate to verify the pinned
executable, version/hash, denied environment overrides, preflight, and
protected paths before projecting scoped command authority.

A durable local CLI capability must pin:

- absolute executable path
- executable version and hash when practical
- scoped command templates, never broad `cli *`
- denied environment override patterns for token, credential, config, proxy,
  keychain/keyring, CA, and authority variables
- auth/preflight command and non-secret account label
- protected credential/config paths that approved CLIs can read and agents
  cannot write
- safe command preview/hash rules and mapped scoped enforcement rules

Default-denied environment overrides include token and secret keys, credential
file/config directory keys, proxy keys, keychain/keyring overrides, and CA/proxy
authority keys unless the capability explicitly models them.

Example user-defined capability:

```yaml
agents:
  main_agent:
    sources:
      tools:
        - id: acme
          kind: local_cli
    capabilities:
      - id: acme.invoices.read
        version: 1
```

The reviewed definition pins `/usr/local/bin/acme`, allows only
`/usr/local/bin/acme invoices read *`, runs
`/usr/local/bin/acme auth status` as preflight, protects `~/.config/acme`, and
shows `Acme invoices read` in prompts and management views. Once selected and
verified, runtime projects only the reviewed scoped command rules, mounts declared
credential directories as readable SDK additional directories, keeps those
directories write-denied, and records command-bound network host bindings for
scheduled-job SDK network prompt correlation.

## Third-Party MCP Network Hosts

Third-party MCP server definitions carry reviewed `networkHosts` alongside
`allowedToolPatterns` and `credentialRefs`. Approved tool patterns are the
operation-granular authority: approving one MCP operation does not grant
unrelated ones. Declared hosts are reviewed and audit metadata, not an
operational egress allowlist — an approved MCP operation's outbound traffic uses
normal egress, gated by the global denylist. Declared hosts use the same exact
`host`/`host:port` parser as
skill actions (no URLs, schemes, paths, credentials, wildcards, invalid ports,
or localhost/private targets). This applies to third-party MCP servers only, not
Gantry's built-in MCP tools.

- Remote `http`/`sse` servers execute through the MCP proxy over a **DNS-pinned
  transport**: the hostname is resolved once, validated to be public-routable,
  and the connection is pinned to that address while TLS SNI and certificate
  validation stay bound to the hostname (no DNS-rebinding window). The configured
  URL host is added to reviewed metadata when omitted so prompts and audit have a
  useful network line. The proxy validates the connection host against the global
  `permissions.egress.denylist` at connection establishment, reusing the shared
  egress denylist policy, and rejects redirects. A denylisted host fails closed:

  ```text
  Network access denied: MCP server <name> host <host>:<port> matches the egress
  denylist.
  ```

  Remote servers may still make their own downstream calls that are outside
  local sandbox visibility; the review UX states this.

- `stdio_template` servers carry the declared hosts as reviewed inventory into
  the materialized capability, but current-session stdio execution remains
  **fail-closed**: Gantry has no OS-level sandbox to spawn an arbitrary
  `node`/`npx` MCP subprocess safely, so the proxy refuses stdio execution rather
  than run it unsandboxed. When a sandboxed stdio runtime exists, its outbound
  traffic uses normal egress through the gateway, gated by the global denylist;
  the declared hosts stay reviewed metadata rather than a run-scoped allowlist.
  This is a deliberate security boundary, not a missing wire-up.

The global `permissions.egress.denylist` always wins over MCP declarations.
`request_mcp_server` review, `gantry mcp list`/`show`, and the MCP definition API
expose the declared hosts for review.

### Per-agent MCP tool scope

MCP operations are granular like skill actions: adding an MCP server to an agent
does not grant every tool. Each agent binding carries an optional
`allowedToolPatterns` subset of the server definition's reviewed patterns, so the
same server can be read-only for one agent and read+write for another without
duplicating the definition. An empty subset inherits the definition's full set; a
binding can only narrow, never widen beyond what was reviewed. The scope is
stored in desired-state revisions and rendered into `settings.yaml` under the
agent's `mcp_servers` source ref (`tools: [read_*]`), reconciled into the
Postgres binding and intersected at materialization so the proxy only exposes
the agent's allowed operations. Set it with
`gantry mcp connect --agent-tool <pattern>` or the agent access API.

## Agent Runtime Tiers

Each configured agent has one execution tier: `runtime: worker` or
`runtime: inline`. Omitted `runtime` defaults to `worker`. The tier changes how
the agent loop executes, not the agent's identity, conversation bindings, model
selection, durable memory, run/turn persistence, or permission authority.

- `worker` executes in the existing worker subprocess and supports the full
  reviewed worker capability projection and sandbox boundary.
- `inline` executes the provider loop in the Gantry host process. Its built-in
  surface is limited to `send_message`, `ask_user_question`, `memory_search`,
  `memory_save`, `delegate_task`, `task_get`, `task_list`, `task_cancel`, and
  `task_message`, as declared in
  `apps/core/src/runtime/core-tools/registry.ts`. Approved remote `http` and
  `sse` MCP operations are connected in-process through the same per-agent tool
  scope, permission checks, audit, and DNS-pinned egress policy.

Cross-agent delegation requires `AgentDelegation`, may target only an agent
bound to the current conversation, and runs under the target agent's selected
capabilities.

Settings parse/apply and pre-spawn admission hard-reject `runtime: inline` when
the agent has an attached skill, a `local_cli` source or runtime access, a
`stdio_template` MCP source, a skill-action runtime access, or a selected tool
rule that projects filesystem access (`FileSearch`, `FileRead`, `FileEdit`, or
`FileWrite`) or `RunCommand(...)`. The configuration error lists every detected
worker-only source, capability, or rule. The same validation applies when an
existing worker agent is changed to inline; changing an inline agent to worker
does not have this inline-only restriction.

V1 inline loops also do not expose browser tools, capability self-service
tools, agent-created-job tools, or provider-library internal subagents. Gantry's
task lifecycle remains available, including delegation to inline or worker
agents. Inline scheduled runs use the existing job persistence, heartbeat, and
failover paths.

Inline loops are turn-bounded: the optional per-agent `max_turns` setting caps
provider-loop iterations, and when unset a built-in default cap applies
(`DEFAULT_INLINE_AGENT_MAX_TURNS` in
`apps/core/src/adapters/llm/inline-lane-dispatcher.ts`). Hitting the cap
produces a terminal error naming the cap. Session messages to inline agents may
carry a per-message `response_schema` (JSON Schema) enforced by the selected
lane; see the Direct LLM API section for the passthrough equivalent.

### Agent control knobs

Per-agent model-control settings apply on every runtime tier and are validated
against the model catalog's capability metadata at settings parse/apply —
a knob the selected model cannot honor is a configuration error naming the
field and model, never a silent no-op:

- `effort` (`low|medium|high|xhigh|max`) maps to the provider's
  effort/reasoning parameter on the Claude and DeepAgents lanes, worker and
  inline alike.
- `thinking` (`off`, `on`, or `{mode: on, budget_tokens: <positive int>}`)
  maps to provider thinking configuration where the model supports it.
- `max_output_tokens` (positive int) sets the per-call output cap on
  DeepAgents-engine agents. Claude-engine agents reject the field at
  settings-apply — the claude-agent-sdk has no per-query output-token option;
  `effort` is the Claude-side spend lever.

Session message sends accept the same three fields (`effort`, `thinking`,
`max_output_tokens`) as per-request overrides. An override is persisted on the
message record, survives replay, and wins over the agent's configured default
for that turn. On the Claude worker path the conversation-level `/thinking`
command override continues to win over both.

Two spend guards complement the knobs. A per-agent `max_run_tokens` setting
bounds cumulative normalized usage across a run: the budget is checked at turn
boundaries and exceeding it terminates the run with an error naming the budget
and observed total (no mid-turn cutoff). On the direct LLM API, an optional
per-API-key `maxTokens` ceiling rejects requests whose `max_tokens` /
`max_completion_tokens` exceed the key's limit with a shaped `400`
`MAX_TOKENS_EXCEEDED` — requests are never silently clamped.

## Administration Model

The deterministic ownership rule is:

- Desired-state revisions expose two separate agent views in the canonical YAML
  copy: `sources` and `capabilities`.
- `sources` lists attached, reviewed resources such as skills, MCP servers,
  built-in tools, adapters, and local CLIs. A source is visible inventory for
  the agent, not execution authority.
- `capabilities` is the only durable grant list. Runtime projects selected
  approved capability versions into typed execution access.
- Manual settings edits may attach approved sources or select approved
  capabilities only. They must not include raw secrets, MCP configs, command
  bodies, generated manifests, or provider credentials.
- Runtime rejects legacy agent grant fields such as `tools`, `skills`,
  old direct tool/skill/MCP id lists and nested legacy capability buckets.
- Postgres stores desired-state revisions, the runtime projection, catalog rows,
  artifact metadata, audit, and execution state. `settings.yaml` is the readable
  copy for desired-state fields, not an independent authority.
- Conversations own bound agents, default/routing metadata, sessions, sender
  policy, trigger policy, and control approver allowlists.
- Conversation sender policy is separate from conversation membership and
  control approvers. It controls who may send messages into that conversation.
- Control approvers must be verifiable members of the Conversation and apply to
  every agent bound to that Conversation, including direct/private sessions.
- Agent identity is shared across provider bindings, but approval authority is
  configured on each provider conversation surface.

There is no channel-scoped tool selection field and no separate browser
capability list. Browser is selected in settings/API as `browser.use` and
translated into the canonical runtime `Browser` tool rule; provider or channel
flags describe adapter support and are metadata, not authorization.

API, CLI, and MCP are adapters over the same application services:

- Public control API is for owner/admin automation and Web/SDK admin UX.
- CLI is for local/admin setup, provider connect/validate, service
  start/stop/restart/logs, doctor commands, and local imports.
- Gantry MCP tools are for agent-requested reviewed changes and safe runtime
  interactions. They create reviewable requests rendered through
  `InteractionDescriptor`.

## Direct LLM API

The Control API exposes provider-shaped raw model calls at
`POST /llm/v1/messages`, `POST /llm/v1/chat/completions`, and
`POST /llm/v1/messages/count_tokens`. Both streaming and
non-streaming responses pass through the Gantry Model Gateway; the control
route does not receive provider credentials or implement provider
authentication. These calls do not run an agent loop or grant access to agent
tools and capabilities.

The passthrough supports ordinary chat and streaming, caller-defined
client-side tools (Anthropic tools with `input_schema` and OpenAI `function`
tools), structured outputs, and thinking or effort parameters. It does not
delegate execution to provider-hosted tools: Anthropic server tools, remote MCP
servers, containers, and execution betas are rejected, as are OpenAI hosted
tools, hosted-tool fields, attachments, and file references. Unsupported
surfaces return `400` with code `UNSUPPORTED_FIELD` and identify the rejected
field or tool type.

Direct LLM callers request provider-native strict JSON-schema output in the
provider-shaped payload, which Gantry passes through to the selected provider.
Inline agent callers instead send `response_schema` with the session message;
the selected inline lane enforces that schema and returns the validated payload
as the turn result.

Clients authenticate with a Control API bearer key carrying `llm:invoke`.
Missing or invalid keys return `401`; a valid key without the scope returns
`403`. The request `model` must be a registered Gantry model alias for the
endpoint's response family. Raw provider model ids and incompatible aliases are
rejected with `400`; the resolved provider model id is used only for the
gateway request. The request log attributes the route, result, model alias,
model route, and request/response sizes to the API key and app. Each request
uses an API-key/request-scoped gateway credential that is revoked when response
delivery ends, including failures.

For official SDK base-URL configuration, the Anthropic Messages route is under
the `/llm` base (`/v1/messages`), while OpenAI Chat Completions is under the
`/llm/v1` base (`/chat/completions`). The active route implementation is
`apps/core/src/control/server/routes/llm.ts`.

The single agent-wide view of what an agent can do is
`GET /v1/agents/{id}/access` (and `gantry agent access show <agent>`): one place
listing the agent's skills, MCP servers with their per-agent operation scope,
attached tools, and selected capabilities. It is keyed by the agent and reflects
authority used in every conversation the agent is added to — direct/private (DM)
and group/channel alike — not a per-conversation list. `--json` emits the
writable `{sources, selections}` document for `gantry agent access apply`.

Skills, MCP servers, and tools are central catalog objects. Skill names are
display labels and unique-alias conveniences only. Durable settings and API
source selections show the readable name beside the exact `skill:<id>` catalog
id, and the id is the only authority. Repeated installs of the same visible
skill name cannot become ambiguous because runtime selection never uses the
display name. V1 does not version skills; installed catalog items are disabled
or removed rather than edited in place.

## Tool Matrix

Normal agent guidance is action-first: use an available action, request a
reviewed capability when the action is missing, and request source setup only
when the underlying skill, MCP server, or local CLI is not yet connected. The
source-specific tools below are setup/proxy implementation surfaces; they do not
become durable authority by themselves.

| Tool                                     | Use                                                                                                                                                                      | Never use for                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message`                           | Progress updates or direct channel messages while the agent is still running.                                                                                            | Persistent capability changes.                                                                                                                       |
| `ask_user_question`                      | Structured choices with content, options, single-select, multi-select, preview/details, and channel-native buttons.                                                      | Open-ended chat or approval of persistent capabilities.                                                                                              |
| `continuity_summary`                     | Summarizes current durable continuity, staged memory candidates, reviewed memory state, dreaming status, and last injected context.                                      | Treating memory or continuity content as instruction or tool authority.                                                                              |
| `file`                                   | Lists, reads, writes, or promotes Gantry FileArtifacts by virtual scope/path while hiding host filesystem paths and storage refs; full host tool id `mcp__gantry__file`. | Arbitrary host filesystem reads/writes or bypassing approved file facades.                                                                           |
| `request_skill_install`                  | Skill source setup using staged `SKILL.md` package files or an approved installer command that imports the resulting package in host-controlled staging.                 | Treating skill setup as approval to run risky skill actions, installing silently, or editing skill directories directly.                             |
| `request_skill_proposal`                 | Skill source setup for agent-created or modified `SKILL.md` bundles.                                                                                                     | Treating proposed skill files as durable action authority or writing directly to `.agents/skills`, provider skill folders, or agent-local `skills/`. |
| `request_skill_dependency_install`       | Host-installed dependencies needed by a reviewed skill source.                                                                                                           | Running dependency commands from the agent.                                                                                                          |
| `request_mcp_server`                     | Third-party MCP source setup with a reviewed `stdio_template`, sandbox profile, expected tool patterns, credential needs, and reason.                                    | Treating server connection as approval for every MCP operation, editing `.mcp.json`, or editing Claude `mcpServers`.                                 |
| `request_access target.kind=capability`  | Requests an approved reviewed semantic capability by id.                                                                                                                 | Capability proposals, broad raw commands, or changing permission settings directly.                                                                  |
| `request_access target.kind=run_command` | Requests a scoped temporary exact-command fallback when no reviewed capability fits.                                                                                     | Durable CLI authority, exact SDK/native tools, provider-specific implementation names, Browser internals, or third-party MCP tool ids.               |
| `settings_desired_state`                 | Selected-capability reading of the current local desired-state settings before proposing a reviewed config change.                                                       | Unselected access, mutating settings, or exposing raw secrets.                                                                                       |
| `request_settings_update`                | Selected-capability reviewed host-side edits to non-secret local `settings.yaml` desired state.                                                                          | Unselected access, direct file edits, raw provider secrets, skill source injection, or MCP definitions.                                              |
| `admin_permission_list`                  | Selected-capability inventory of current-agent persistent Gantry MCP grants.                                                                                             | Cross-agent grant discovery, raw secret inspection, or broad admin wildcard discovery.                                                               |
| `admin_permission_revoke`                | Selected-capability revocation of one current-agent persistent Gantry MCP grant.                                                                                         | Revoking grants for another agent or bypassing review for new grants.                                                                                |
| `mcp_list_tools`                         | Refreshes connected third-party MCP source inventory through the Gantry proxy.                                                                                           | Discovering unconnected servers or treating third-party tool names as durable Gantry authority.                                                      |
| `mcp_describe_tool`                      | Fetches untrusted schema/details for one tool from a connected third-party MCP source.                                                                                   | Broad tool discovery, execution authority, or trusting MCP annotations as grants.                                                                    |
| `mcp_call_tool`                          | Backend/proxy call path for connected third-party MCP tools when reviewed current-run capability access covers the exact action.                                         | Direct MCP server execution, raw `.mcp.json` edits, raw third-party MCP tool grants, or unconnected tools.                                           |
| `service_restart`                        | Selected-capability restart after approved config or capability changes that require host restart.                                                                       | Restarting to activate unapproved changes.                                                                                                           |
| `register_agent`                         | Selected-capability binding of a new channel conversation to an agent.                                                                                                   | Letting an unselected agent bind arbitrary chats.                                                                                                    |

## Capability Types

| Type             | Durable truth                                                                   | Runtime projection                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill            | Skill catalog row, readable files, provider ref, and binding.                   | Per-run Claude `skills/<slug>/...` folder and `Skill` tool exposure.                                                                                                            |
| Skill dependency | Dependency spec, approval decision, execution result, audit.                    | Optional per-skill tools directory or approved host package; never direct agent shell.                                                                                          |
| Third-party MCP  | Current definition, Gantry Credential refs, allowed tool patterns, and binding. | SDK `mcpServers` for host-safe stdio transports plus exact allowed MCP tool names. Remote HTTP/SSE requires host DNS-pinned transport before projection.                        |
| SDK tool         | Tool catalog entry, risk, permission policy, sandbox profile, binding.          | Durable grants use Gantry facade names; provider-native SDK names in `allowedTools` are only per-run harness projections, and command access is never projected as bare `Bash`. |
| Host tool        | Built-in Gantry MCP tool entry, risk, binding, audit behavior.                  | Exact `mcp__gantry__<tool>` name.                                                                                                                                               |
| Browser tool     | Canonical `Browser` capability and sandbox policy.                              | Gated Gantry-owned gateway tools with Gantry-owned schemas.                                                                                                                     |
| Channel tool     | Provider capability enum, scopes, affected conversations, binding.              | Provider adapter enables only the named Slack/Telegram/Teams/Web capability.                                                                                                    |
| Channel binding  | Agent-to-conversation/thread binding and control policy.                        | Message routing, trigger handling, and same-channel approval target.                                                                                                            |

## Durable Model

`settings_revisions` owns the durable local list of user-manageable agent
sources and capabilities rendered under `agents.<agent>.sources` and
`agents.<agent>.capabilities` in `settings.yaml`. Settings-side changes are
validated, revisioned, synced to YAML, reconciled into Postgres by replacement,
and reloaded immediately where safe; they do not rely only on the file watcher.

Postgres is the runtime capability projection and catalog store. It owns
definitions, agent bindings, config-version links, Gantry Credential reference
names, encrypted capability secret values, permission decisions, audit events,
and disablement state.

Agent-owned persistent grants are revisioned and mirrored into `settings.yaml`
as readable `agents.<id>.access.selections` entries. Prefer reviewed semantic
capabilities for app workflows. `request_access target.kind=run_command` is intentionally
narrow and should be converted into an approved capability definition when it
needs to survive beyond a one-off command fallback. Durable fallback authority
is limited to semantic capabilities, canonical `browser.use`, exact Gantry file/web
facades, exact selected Gantry admin MCP tools such as
`mcp__gantry__admin_permission_list`, and scoped `RunCommand(...)` rules.
Broad exact SDK/native tools such as `Read`, `Write`, `Edit`, `WebFetch`,
`LS`, exact third-party MCP tools, secret-bearing command rules, shell-control
command rules, and `SandboxNetworkAccess` are not durable authority. Do not
expose opaque permission-rule hashes in settings. Settings reconciliation
resolves selected capability versions back into Postgres catalog rows and agent
bindings immediately and after restart.

Scoped `RunCommand(...)` rules match parsed argv leaves, not whole shell strings. Compound
commands require every safe, stateless leaf to match a separate durable rule;
state-changing leaves such as `cd` are one-time approval only because they
change the trust context for later leaves. Matching is positional:
`RunCommand(curl https://api.example.com/*)` does not cover
`curl -sSf https://api.example.com/x`; approve
`RunCommand(curl -sSf https://api.example.com/*)` or an explicit argv wildcard such
as `RunCommand(curl * https://api.example.com/*)`. Unsupported shell grammar,
environment assignments, command substitution, background execution, shell
keywords, meta-executors such as `sh -c`, stateful shell builtins, broad
interpreter wildcard scopes, and destructive redirects are one-time approval
only and must not be synthesized as durable `RunCommand(...)` rules.

Control API capability replacement and other DB/admin-side capability writes
must append a desired-state revision, export the readable projection back into
`settings.yaml`, then validate, reconcile, and reload. Persistent `Always allow`
permission approvals must fail closed if settings cannot be updated; any new
active binding is rolled back so DB-only persistent grants do not survive as
hidden authority. Empty non-authoritative settings may continue to observe preexisting DB-only
capabilities, but any declared settings access list replaces stale active
Postgres tool, skill, and MCP bindings for that agent.

Jobs are scheduled runs of the target agent. They inherit that agent's selected
capabilities and attached sources at execution time, never carry a separate
job-scoped authority surface, and expose the canonical `toolAccess` object instead
of parallel count or legacy tool fields. Job `access_requirements` are readiness
assertions, not authority. A job may require multiple capabilities or a reviewed
composite capability, but approval updates the target agent's
`access.selections` list, not a job-local permission list.

When an autonomous job fails because a capability is missing, recovery output
uses the same reviewed request tools as interactive agents:

```text
request_access { "target": { "kind": "capability", "id": "acme.records.append" }, "reason": "This scheduled job writes reviewed records." }
request_access { "target": { "kind": "run_command", "argvPattern": "npm test *" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }
request_mcp_server { "name": "github", "transport": "stdio_template", "templateId": "npx-package", "args": ["@modelcontextprotocol/server-github"], "sandboxProfileId": "mcp-stdio", "reason": "This autonomous run needs the github MCP source connected before reviewed action capabilities can be requested." }
```

Approved requests update the target agent's durable selected capabilities or
attached sources in a settings revision and export the readable access
projection to `settings.yaml`.
Tool permission approval can resume the blocked active tool call immediately:
`Allow once` is current-run only and does not create durable semantic
authority, while `Always allow` stores either the approved semantic capability,
canonical `Browser`, exact Gantry file/web facade, exact Gantry admin tool, or
scoped `RunCommand(...)` rule for the active run and future runs. After a
persistent tool approval, Gantry rechecks matching `Setup required` paused jobs
through the shared readiness path. Ready jobs are reactivated and queued; jobs
with remaining setup blockers stay paused and the receipt names the
still-blocked job plus its next action. New skill or MCP materialization occurs
on the next scheduled run or a manual rerun. Browser remains a single public
`Browser` tool capability; projected browser gateway tools and admin Gantry MCP
tools are not job-local authority.

Conversation threads and provider topics are routing details, not separate
permission boundaries. Permission prompts may be delivered in a Slack thread,
Teams reply chain, or Telegram topic, but `Allow 5 min` and `Always allow`
scope to the parent conversation and selected agent capability set. Thread or
topic ids may appear in audit/routing metadata only.

Direct writes to `settings.json`, `settings.local.json`, `.mcp.json`,
generated provider MCP directories, and skill capability files are protected
wholesale. Provider settings files are not partially parsed for "safe" keys;
agents must use reviewed Gantry request tools because future provider settings
can become execution or permission policy.

Installed skill bytes live outside catalog rows. With the local artifact
backend, they use:

```text
artifacts/skills/<skill-directory>/SKILL.md
artifacts/skills/<skill-directory>/...
```

The database stores metadata, source type, storage pointer, binding, and audit
only. Skill files remain readable for review. Catalog, URL, CLI-command, and
uploaded installs all converge into the same installed local skill package after
review.

Object storage mirrors the same readable layout as keys. Object storage keys
must remain human-readable and API-readable; one installed skill name maps to
one readable source folder, for example `skills/linkedin-posting`.
A local skill can be inspected with normal filesystem tools, and the API can
list/read individual files under `skills:read`.

Claude settings, `CLAUDE_CONFIG_DIR`, MCP handoff files, and FileArtifacts
are per-run projections. They are compatibility inputs for a provider adapter,
not durable Gantry truth.

## Lifecycle

1. Request: admin API/SDK/CLI or an agent request tool creates a pending request.
2. Validate: Gantry checks app scope, agent scope, transport, origin chat,
   Gantry Credential refs, sandbox profile, tool patterns, and provider metadata.
3. Review: same-channel review renders the request, but authority still comes
   from configured admin/control policy.
4. Decide: setup, scheduler, admin, and capability flows show `Allow once`, `Always allow`, or `Cancel`; live interactive SDK prompts may also show `Allow 5 min`. Details and audit records carry the durable authority shape, such as a semantic capability, canonical `Browser`, exact Gantry file/web facade, exact `mcp__gantry__<admin_tool>`, or scoped `RunCommand(<pattern>)`.
5. Bind: approval creates or updates the agent binding and a new config version.
6. Same-session handoff: installed skill packages are returned to the running
   agent as reviewed skill files; connected MCP servers are reachable through the
   Gantry proxy, but source inventory is still not action authority.
7. Materialize: only installed enabled skill bindings project into future agent
   runs as native skills. Third-party MCP bindings remain behind the Gantry MCP
   proxy in every run.
8. Execute: tool use still passes permission and sandbox evaluation.
9. Disable: disabled capabilities stop future materialization without deleting
   history.

## Skill Install

Skill install is package approval and binding, not dependency execution.

1. Agent calls `request_skill_install` with staged package files. If package
   files are not available, it may request a reviewed installer command such as
   an `npx` command from a skill catalog.
2. Host validates package safety and requires `SKILL.md`.
3. Channel UX shows the skill summary, files, declared dependencies, risk, and
   activation timing.
4. Approval installs to Gantry-owned skill artifacts, records audit, binds the skill,
   exports readable settings, returns reviewed files to the running agent, and
   materializes it for future runs. There is no second approval after the user
   approves the install request. Installer-command requests run the exact argv
   in a temporary host-controlled staging directory with a scrubbed environment
   plus any named `requiredEnvVars` resolved from capability credentials, then imports
   and installs the produced `SKILL.md` package through the same path.

If the skill declares npm, brew, go, uv, or download dependencies, those are
separate dependency requests. The skill approval does not run them.

Skill and MCP capability credentials use Gantry Credential Center, not runtime
`.env` or model credentials. Operators set them with
`gantry credentials access set <NAME>` or
`gantry credentials access import-env <NAME>`, optionally adding repeated
`--allow <capabilityId>` scopes such as `mcp:github`, a concrete MCP definition
id, a concrete skill id, or `skill:<name>`. Secret values are encrypted in
Postgres and only projected into the current runner or MCP subprocess when an
selected capability declares the matching required env var or
credential ref.

## Dependency Install Policy

Dependency installs are high-risk host actions. The agent must call
`request_skill_dependency_install`; it must not run `npm install`, `brew
install`, `go install`, `uv tool install`, curl, tar, unzip, or equivalent shell
commands directly.

The host validates dependency specs before review:

- Node package specs must be registry package names or scoped package names,
  must not start with `-`, must not use `file:`, `git:`, `http:`, `https:`, or
  shell syntax, and execute as argv with `--ignore-scripts`.
- Default Node installs are local to a per-skill tools directory when possible,
  not global host mutation.
- `brew`, `go`, `uv`, and download installers require explicit admin policy
  before execution.
- Downloads use SSRF protection, content size limits, archive traversal checks,
  and extraction only inside the per-skill tools directory.
- stdout/stderr are audited with secret redaction.

## Runtime Projection

The built-in `gantry` MCP server is host wiring. It is always projected and is
not an admin-managed third-party capability. Third-party MCP servers are
projected only from active current definitions and active bindings. Their
`allowedToolPatterns` form the enforced tool allowlist. Any
`autoApproveToolPatterns` must be a subset of the allowed set.

Skills are projected only when installed and bound. Denied, disabled, or
unbound skill files are never copied into per-run Claude config.

The `Browser` tool manages the agent conversation's persistent browser profile
through the projected Gantry-owned gateway: `browser_status`, `browser_open`,
`browser_inspect`, `browser_act`, and `browser_close`. There is no separate
browser-action run, phrase intent, private browser backend projection, or
durable per-action browser authority.

Provider-native SDK built-in tool names are harness projections, not durable
agent capabilities. Profiles grant Gantry-owned facades such as `FileRead`,
`FileEdit`, `FileWrite`, `WebRead`, and scoped `RunCommand(...)`; the selected
harness maps those to internal names such as `Read`, `Edit`, `Write`,
`WebFetch`, or `Bash` only for that run. If approved, projected tools still pass
through `canUseTool`, `PreToolUse`, sandbox policy, and audit.

The built-in Gantry MCP server is projected with exact tool names. Wildcards
such as `mcp__gantry__*` are not durable authorization. Request tools are safe
to expose because they create pending reviews only. Installed skill proposals
and connected MCP servers are the exception to "future only": the host returns
reviewed skill files to the running agent, and connected third-party MCP
servers are callable through the Gantry MCP proxy tools only when reviewed
current-run access covers that action. Direct third-party `mcp__server__tool`
names are not exposed.

## Cleanup Rules

Replacement work must remove stale active references to direct shell installs,
global Claude folders, direct `.mcp.json` mutation, group-tied skill state, and
base64 artifact transport. Historical migration references may remain only when
they are clearly historical and not active guidance.

Before calling a cutover complete, run targeted searches for:

- `mcp__gantry__*`
- obsolete skill request lifecycle tools outside historical notes
- provider skill folders as runtime truth
- `.mcp.json` mutation instructions
- base64 skill artifact serialization
- direct dependency-install guidance in active docs

## Adding A New Local CLI Capability

1. Discover the executable path and version, for example
   `/usr/local/bin/acme --version`.
2. Hash the executable when practical, then define the semantic capability:
   `capabilityId: acme.records.append`, display name `Acme records append`,
   category `Acme`, risk `write`, and a non-secret account label.
3. Set narrow command templates such as
   `/usr/local/bin/acme records append *`. Do not approve broad CLI command
   grants as a substitute for a
   semantic local CLI capability.
4. Configure auth preflight, for example
   `/usr/local/bin/acme auth status`, and protect credential/config paths from
   writes. The reviewed executable must still be able
   to read those credential files during approved commands.
5. Register the local CLI as reviewed source inventory with its pinned executable
   identity, command templates, preflight, protected paths, and account label.
6. After review, run `request_access target.kind=capability` to confirm the capability is visible and
   selected for the target agent. Recurring jobs inherit that agent capability;
   they must not create job-local authority.

## Scheduler Capability Requirements

Agents creating jobs should declare needed app/tool access with
`scheduler_upsert_job.access_requirements` when the job depends on a semantic
capability, MCP source, or scoped command fallback. Requirements are stored with
the job, included in the confirmation token, and evaluated by readiness checks
without creating job-local authority.

Use `implementation.kind: configured_access` when Gantry should use an existing
reviewed provider-neutral capability. Use `implementation.kind: local_cli` when
the job must use a specific authenticated local CLI; it must
include an absolute `executablePath`, a narrow `commandTemplate` that starts
with that exact executable path, and any `authPreflight` must also start with
the same path. It must also include pinned executable version and hash so setup
can ask for one reviewed local CLI capability instead of raw command authority.
It is not job-owned authority. User-defined semantic `local_cli` capability
definitions require executable identity, command templates, protected paths, and
denied environment overrides before runtime projects scoped command authority.
Do not replace the reviewed capability with a broad CLI command grant.

Examples:

- Configured access: request `request_access target.kind=capability` with the reviewed capability
  id returned by the Agent Access summary. Concrete implementation details such as
  credential stores, command rules, and hashes stay out of the primary prompt
  and belong in audit/details surfaces.
- Local CLI for a scheduler job: declare `implementation.kind: local_cli`,
  `name`, absolute `executablePath`, pinned `executableVersion`, pinned
  `executableHash`, and a narrow `commandTemplate` that starts with the same
  executable path. Setup must request a reviewed capability id for the
  target agent, not job-local authority.
- Reusable user-defined local CLI capability: register a reviewed `local_cli`
  capability definition with pinned executable path, command template, auth
  preflight, and protected credential paths. Runtime enforces it through the
  selected semantic capability; do not approve broad CLI command rules as a
  substitute.
- Unknown business CLI: register `capabilityId=acme.invoices.read`,
  display name `Acme invoices read`, command template
  `/usr/local/bin/acme invoices read *`, and a non-secret account label before
  an agent can request it by id.
- Revoking or changing an existing permission: use the capability management
  API/admin surface to remove `<capability id>@<version>` from the agent
  capability list or replace it with a different account-specific capability, then sync
  `settings.yaml` and the Postgres projection.

Do not use raw token env, `RunCommand(cli *)`, broad proxy injection, direct
credential-store writes, raw provider model credentials, raw browser backend
tools, or `SandboxNetworkAccess` as durable authority.

## Agent Access Summary

`AgentAccessSummary` is a read-only, derived projection of agent-scoped access.
It is not authority and is not stored: it is computed from the existing
`AgentCapabilitiesView` (sources, selections, tool access) plus disabled tool
bindings. `gantry agent access show`, the Control API agent-access response, and
the contracts/openapi schema expose it; raw ids and rule details stay behind
`--json`, audit, and events.

Sections:

- Connected — attached sources (skills, MCP servers with tool scope, tools) used
  in every conversation the agent is added to.
- Allowed — granted access: durable selections (`future access`) and current
  configured tools (`current setup`), with humanized labels (no raw
  `capability:<id>`).
- Needs attention — concrete per-agent blockers present in the summary input. It
  must surface only blockers the projection actually holds; it must never infer a
  blocker from app-wide pending counts.
- Suggested cleanup — conservative, derivable-only removals (currently disabled
  tool bindings). No speculative heuristics such as MCP scope overreach.

### Deferred surface impact

The v1 simplification keeps each surface honest within its current boundary. Two
extensions are explicitly deferred rather than faked:

| Deferred surface                                                                                                | Status   | Reason                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-agent pending/expired requests in `Needs attention` (and the expired-request branch of `Suggested cleanup`) | Deferred | `PendingAccessRequestsRepository` only exposes app-wide `countPendingAccessRequests({ appId })`. Populating these rows needs a new `listPendingForAgent({ appId, agentId })` listing contract on the repository port and its Postgres adapter. Until then the summary passes `pendingRequests` empty and the section renders with no per-agent rows. The summary must never substitute the app-wide count for a per-agent blocker. |
| Reusing `AgentAccessSummary` inside the agent-facing `admin_permission_list` MCP output                         | Deferred | The unified summary is computed in the control/application layer; the runner/MCP tool runs in a separate process boundary and would need the projection fetched or recomputed across it. v1 keeps MCP behavior scoped to its current boundary instead of pretending the same projection exists everywhere.                                                                                                                         |
