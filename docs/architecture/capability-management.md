# Capability Management

MyClaw treats every agent-visible extension as an app-scoped and agent-scoped
capability. A capability can be an SDK tool, a built-in MyClaw MCP tool, a
third-party MCP server, a skill, a browser lifecycle/action capability, or a
channel-native tool. The common rule is request, review, approval or denial,
durable audit, new config version, and next-run activation.

Agents must not mutate capability state directly. They must not run dependency
install commands, edit `.claude/skills`, edit `.mcp.json`, edit Claude
permission settings, edit MyClaw settings, or change generated runtime config.
When a user asks for a new skill, MCP server, dependency, SDK tool, host tool,
or channel capability, the agent calls the matching MyClaw request tool.

The user-facing permission model is `Agent -> Capability -> Access level`.
Raw permission ids, command hashes, scoped Bash rules, sandbox profiles, and
executable paths are implementation details that belong in Details/audit
surfaces. The model is intentionally typed. Skills, MCP servers, semantic tool
capabilities, SDK tools, host tools, browser tools, provider-native channel
tools, and conversation bindings have separate schemas and validation rules.
They share lifecycle, policy, audit, and config-version activation, but they
are not collapsed into one untyped blob.

## Semantic Tool Capabilities

Semantic capabilities are stable user-facing grants such as
`google.sheets.write`, `gmail.read`, or `acme.invoices.read`. The durable
settings representation is readable:

```yaml
agents:
  main_agent:
    tools:
      - capability:google.sheets.write
      - Browser
      - Bash(npm test *)
```

Each semantic capability record includes:

- `capabilityId`, `displayName`, `category`, `risk`, and optional
  `accountLabel`
- `can` and `cannot` user-facing scope statements
- `credentialSource`: `onecli`, `external_broker`, `local_cli`, or `none`
- low-level implementation bindings such as exact tools, scoped
  `Bash(<template>)`, MCP tools, adapter refs, or local CLI command templates
- optional preflight metadata, protected credential/config paths, redaction
  policy, and sandbox needs

Runtime expands a selected semantic capability to deterministic low-level
rules for the current run, but management and prompts keep the semantic name
primary. For example, `capability:google.sheets.write` may project to a scoped
OneCLI command rule while the approval prompt says `Allow Google Sheets write?`.

Built-ins cover common brokered app capabilities such as Google Sheets read,
Google Sheets write, and Gmail read. Unknown business tools are not accepted as
ad hoc raw commands. They must be promoted through a reviewed user-defined
semantic capability first.

## Local CLI Capabilities

`local_cli` is a first-class credential source for authenticated CLIs such as
`gog`, `gws`, `gh`, `gcloud`, or a company CLI. User-defined local CLI
capabilities are reviewable drafts until the runtime local-CLI gate can verify
the pinned executable, version/hash, denied environment overrides, preflight,
and protected paths at execution time. They must not project to runnable Bash
authority before that gate exists.

A durable local CLI capability must pin:

- absolute executable path
- executable version and hash when practical
- scoped command templates, never broad `cli *`
- denied environment override patterns for token, credential, config, proxy,
  keychain/keyring, CA, and authority variables
- auth/preflight command and non-secret account label
- protected credential/config paths that agents cannot write
- safe command preview/hash rules and mapped scoped enforcement rules

Default-denied environment overrides include token and secret keys, credential
file/config directory keys, proxy keys, keychain/keyring overrides, and CA/proxy
authority keys unless the capability explicitly models them.

Example user-defined capability:

```yaml
agents:
  main_agent:
    tools:
      - capability:acme.invoices.read
```

The reviewed definition pins `/usr/local/bin/acme`, allows only
`/usr/local/bin/acme invoices read *`, runs
`/usr/local/bin/acme auth status` as preflight, protects `~/.config/acme`, and
shows `Acme invoices read` in prompts and management views. Until runtime
enforcement exists, approval records the reviewed draft only; it does not create
durable runnable authority or an SDK `Bash(...)` projection.

## Administration Model

The deterministic ownership rule is:

- Agents own `selectedToolIds`, `selectedSkillIds`, and
  `selectedMcpServerIds`.
- Local `settings.yaml` is the user-visible durable source for those selected
  agent capabilities. Postgres stores the runtime projection, catalog rows,
  artifact metadata, audit, and execution state.
- Conversations own bound agents, default/routing metadata, sessions, sender
  policy, trigger policy, and control approver allowlists.
- Conversation sender policy is separate from conversation membership and
  control approvers. It controls who may send messages into that conversation.
- Control approvers must be verifiable members of the Conversation and apply to
  every agent bound to that Conversation, including direct/private sessions.
- Agent identity is shared across provider bindings, but approval authority is
  configured on each provider conversation surface.

There is no channel-scoped tool selection field and no separate browser
capability list. Browser is a normal catalog tool. Channel-provider flags
describe adapter support; they are metadata, not authorization.

API, CLI, and MCP are adapters over the same application services:

- Public control API is for owner/admin automation and Web/SDK admin UX.
- CLI is for local/admin setup, provider connect/validate, service
  start/stop/restart/logs, doctor commands, and local imports.
- MyClaw MCP tools are for agent-requested reviewed changes and safe runtime
  interactions. They create reviewable requests rendered through
  `InteractionDescriptor`.

Skills, MCP servers, and tools are central catalog objects. V1 does not version
skills; approved catalog items are disabled and replaced rather than edited in
place.

## Tool Matrix

| Tool                               | Use                                                                                                                                                                                              | Never use for                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `send_message`                     | Progress updates or direct channel messages while the agent is still running.                                                                                                                    | Persistent capability changes.                                                                          |
| `ask_user_question`                | Structured choices with content, options, single-select, multi-select, preview/details, and channel-native buttons.                                                                              | Open-ended chat or approval of persistent capabilities.                                                 |
| `request_skill_install`            | Provider-backed skill installs such as `clawhub:<slug>@<version>`.                                                                                                                               | Downloading or installing the skill directly.                                                           |
| `request_skill_proposal`           | Agent-created or modified `SKILL.md` bundles for review.                                                                                                                                         | Writing directly to `.claude/skills`, `.agents/skills`, or agent-local `skills/`.                       |
| `request_skill_dependency_install` | npm, brew, go, uv, or download dependencies needed by a reviewed skill.                                                                                                                          | Running dependency commands from the agent.                                                             |
| `request_mcp_server`               | Third-party MCP server drafts with transport, origin, allowed tool patterns, credential needs, and reason.                                                                                       | Editing `.mcp.json` or Claude `mcpServers`.                                                             |
| `request_permission`               | SDK, host, browser, scheduler, memory, service, MCP, or provider/channel capability permission requests.                                                                                         | Changing permission settings directly or treating provider SDK permissions as already approved.         |
| `capability_search`                | Finds built-in semantic capabilities by id, provider/app, risk, or allowed action.                                                                                                               | Guessing raw command rules or provider-specific implementation names.                                   |
| `request_capability`               | Requests a named semantic capability such as `google.sheets.write` for review and durable agent binding.                                                                                         | Requesting raw provider tokens, broad Bash, or unrelated app access.                                    |
| `propose_local_cli_capability`     | Requests a reviewed user-defined local CLI capability with pinned executable, command templates, preflight, account label, and protected paths.                                                  | Running the CLI directly or approving `Bash(cli *)`.                                                    |
| `manage_capability`                | Presents view/change/revoke/test/audit guidance for existing semantic capabilities.                                                                                                              | Silent DB-only edits, raw token inspection, or bypassing settings sync.                                 |
| `capability_status`                | Lists current tool access, readable configured rules, selected skills, selected MCP servers, default tools, gated tools, semantic capability tools, and unavailable-but-requestable admin tools. | Guessing hidden admin tools or requesting broad MyClaw MCP wildcards.                                   |
| `settings_desired_state`           | Selected-capability reading of the current local desired-state settings before proposing a reviewed config change.                                                                               | Unselected access, mutating settings, or exposing raw secrets.                                          |
| `request_settings_update`          | Selected-capability reviewed host-side edits to non-secret local `settings.yaml` desired state.                                                                                                  | Unselected access, direct file edits, raw provider secrets, skill source injection, or MCP definitions. |
| `service_restart`                  | Selected-capability restart after approved config or capability changes that require host restart.                                                                                               | Restarting to activate unapproved changes.                                                              |
| `register_agent`                   | Selected-capability binding of a new channel conversation to an agent.                                                                                                                           | Letting an unselected agent bind arbitrary chats.                                                       |

## Capability Types

| Type             | Durable truth                                                                  | Runtime projection                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill            | Skill catalog row, readable files, provider ref, hash, binding.                | Per-run Claude `skills/<slug>/...` folder and `Skill` tool exposure.                                                                                     |
| Skill dependency | Dependency spec, approval decision, execution result, audit.                   | Optional per-skill tools directory or approved host package; never direct agent shell.                                                                   |
| Third-party MCP  | Definition, reviewed version, credential refs, allowed tool patterns, binding. | SDK `mcpServers` for host-safe stdio transports plus exact allowed MCP tool names. Remote HTTP/SSE requires host DNS-pinned transport before projection. |
| SDK tool         | Tool catalog entry, risk, permission policy, sandbox profile, binding.         | Exact non-Bash SDK tool names in `allowedTools`; scoped `Bash(<pattern>)` is enforced only in `canUseTool` and never projected as bare `Bash`.           |
| Host tool        | Built-in MyClaw MCP tool entry, risk, binding, audit behavior.                 | Exact `mcp__myclaw__<tool>` name.                                                                                                                        |
| Browser tool     | Canonical `Browser` capability and sandbox policy.                             | Gated MyClaw-owned gateway tools with MyClaw-owned schemas.                                                                                              |
| Channel tool     | Provider capability enum, scopes, affected conversations, binding.             | Provider adapter enables only the named Slack/Telegram/Teams/Web capability.                                                                             |
| Channel binding  | Agent-to-conversation/thread binding and control policy.                       | Message routing, trigger handling, and same-channel approval target.                                                                                     |

## Durable Model

`settings.yaml` owns the durable local list of user-manageable agent
capabilities under `agents.<agent>.tools`, `agents.<agent>.skills`, and
`agents.<agent>.mcp_servers`. Settings-side changes are validated, written,
reconciled into Postgres by replacement, and reloaded immediately where safe;
they do not rely only on the file watcher.

Postgres is the runtime capability projection and catalog store. It owns
definitions, reviewed versions, agent bindings, config-version links,
credential reference names, permission decisions, audit events, and disablement
state.

Agent-owned persistent tool grants are also mirrored into `settings.yaml` as
readable `agents.<id>.tools` entries. Prefer semantic capability entries such
as `capability:google.sheets.write` for app workflows. `request_permission`
durable fallback is intentionally narrow: canonical `Browser`, exact selected
MyClaw admin tools, and scoped Bash rules such as `Bash(npm test *)`. Broad
exact SDK/native tools such as `Read`, `Write`, `Edit`, `WebFetch`, `LS`, exact
third-party MCP tools, secret-bearing Bash, shell-control Bash, and
`SandboxNetworkAccess` are not durable `request_permission` authority. Do not
expose opaque permission-rule hashes in settings. Settings
reconciliation resolves those readable names back into Postgres tool catalog
rows and agent bindings
immediately and after restart.

Scoped Bash rules match parsed argv leaves, not whole shell strings. Compound
commands require every safe, stateless leaf to match a separate durable rule;
state-changing leaves such as `cd` are one-time approval only because they
change the trust context for later leaves. Matching is positional:
`Bash(curl https://api.example.com/*)` does not cover
`curl -sSf https://api.example.com/x`; approve
`Bash(curl -sSf https://api.example.com/*)` or an explicit argv wildcard such
as `Bash(curl * https://api.example.com/*)`. Unsupported shell grammar,
environment assignments, command substitution, background execution, shell
keywords, meta-executors such as `sh -c`, stateful shell builtins, broad
interpreter wildcard scopes, and destructive redirects are one-time approval
only and must not be synthesized as durable Bash rules.

Control API capability replacement and other DB/admin-side capability writes
must export the readable Postgres projection back into `settings.yaml`, then
validate, reconcile, and reload. Persistent `Always allow` permission approvals
must fail closed if settings cannot be updated; any new active binding is rolled
back so DB-only persistent grants do not survive as hidden authority. Empty
non-authoritative settings may continue to observe preexisting DB-only
capabilities, but any declared settings capability list replaces stale active
Postgres tool, skill, and MCP bindings for that agent.

Jobs are scheduled runs of the target agent. They inherit that agent's selected
tools, skills, and MCP servers at execution time, never carry a separate
job-scoped grant surface, and expose the canonical `toolAccess` object instead
of parallel count or legacy tool fields.

When an autonomous job fails because a capability is missing, recovery output
uses the same reviewed request tools as interactive agents:

```text
request_capability { "capabilityId": "google.sheets.write", "reason": "This scheduled job writes the weekly status sheet." }
request_permission { "permissionKind": "tool", "toolName": "Bash", "rule": "npm test *", "temporaryOnly": false, "reason": "This scheduled job needs scoped Bash access." }
request_mcp_server { "name": "github", "transport": "http", "reason": "This scheduled job needs the github MCP server capability." }
```

Approved requests update the target agent's durable selected tools, skills, or
MCP server bindings and export the readable projection to `settings.yaml`.
Tool permission approval can resume the blocked active tool call immediately:
`Allow once` is current-run only and does not create durable semantic
authority, while `Always allow` stores either the approved semantic capability,
canonical `Browser`, exact MyClaw admin tool, or scoped Bash rule for the active
run and future runs. New skill or MCP materialization occurs on the next
scheduled run or a manual rerun. Browser remains a single public `Browser` tool
capability; projected browser gateway tools and admin MyClaw MCP tools are not
job-local grants.

Direct writes to `settings.json`, `settings.local.json`, `.mcp.json`,
generated provider MCP directories, and skill capability files are protected
wholesale. Provider settings files are not partially parsed for "safe" keys;
agents must use reviewed MyClaw request tools because future provider settings
can become execution or permission policy.

Readable skill bytes live outside catalog rows:

```text
skills/<skill-slug>/SKILL.md
skills/<skill-slug>/...
skill-drafts/<request-id>/<skill-slug>/SKILL.md
skill-drafts/<request-id>/<skill-slug>/...
```

The database stores metadata, source, content hash, provider refs, binding, and
audit only. Skill files remain readable for review. ClawHub is the default
provider-backed skill source. Provider verification improves review context but
never bypasses approval.

Local storage uses the same readable layout as object storage. Object storage
keys must remain human-readable and API-readable; hashes are metadata, not path
names. A local skill can be inspected with normal filesystem tools, and the API
can list/read individual files under `skills:read`.

Claude settings, `CLAUDE_CONFIG_DIR`, MCP handoff files, and provider artifacts
are per-run projections. They are compatibility inputs for a provider adapter,
not durable MyClaw truth.

## Lifecycle

1. Request: admin API/SDK/CLI or an agent request tool creates a pending request.
2. Validate: MyClaw checks app scope, agent scope, transport, origin chat,
   credential refs, sandbox profile, tool patterns, and provider metadata.
3. Review: same-channel review renders the request, but authority still comes
   from configured admin/control policy.
4. Decide: `Allow once`, `Always allow for this agent/job` for semantic capabilities, `Always allow Browser`, `Always allow mcp__myclaw__<admin_tool>`, `Always allow Bash(<pattern>)`, or `Cancel` is recorded with actor, reason, and audit summary.
5. Bind: approval creates or updates the agent binding and a new config version.
6. Same-session handoff: approved skill proposals are returned to the running
   agent as reviewed skill files; approved MCP servers are reachable through the
   MyClaw `mcp_list_tools` / `mcp_call_tool` proxy.
7. Materialize: only approved enabled skill bindings project into future agent
   runs as native skills. Third-party MCP bindings remain behind the MyClaw MCP
   proxy in every run.
8. Execute: tool use still passes permission and sandbox evaluation.
9. Disable: disabled capabilities stop future materialization without deleting
   history.

## Provider Skill Install

Provider-backed skill install is package retrieval, not dependency execution.
For ClawHub:

1. Agent calls `request_skill_install` with `clawhub:<slug>@<version>` or an
   equivalent structured provider ref.
2. Host resolves provider detail, publisher, verification tier, latest version,
   source/provenance metadata, file list, integrity, and compatibility.
3. Host downloads the zip, validates archive safety, requires exactly one skill
   root with `SKILL.md`, computes a content hash, and stages readable draft
   files under `skill-drafts/<request-id>/<slug>/`.
4. Channel UX shows the skill summary, files, hashes, provider metadata,
   declared dependencies, risk, and activation timing.
5. Approval installs to `skills/<slug>/...`, records audit, binds the skill,
   returns reviewed files to the running agent, and materializes it for future
   runs.

If the skill declares npm, brew, go, uv, or download dependencies, those are
separate dependency requests. The skill approval does not run them.

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

The built-in `myclaw` MCP server is host wiring. It is always projected and is
not an admin-managed third-party capability. Third-party MCP servers are
projected only from approved reviewed versions and active bindings. Their
`allowedToolPatterns` form the enforced tool allowlist. Any
`autoApproveToolPatterns` must be a subset of the allowed set.

Skills are projected only when approved and bound. Draft, denied, disabled, or
unbound skill files are never copied into per-run Claude config.

The `Browser` tool manages the agent conversation's persistent browser profile
through the projected MyClaw-owned gateway: `browser_status`, `browser_open`,
`browser_inspect`, `browser_act`, and `browser_close`. There is no separate
browser-action run, phrase intent, private browser backend projection, or
durable per-action browser authority.

SDK built-in tools are denied by default unless the profile explicitly grants
them. `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Config` are
not default capabilities. If approved, they still pass through `canUseTool`,
`PreToolUse`, sandbox policy, and audit.

The built-in MyClaw MCP server is projected with exact tool names. Wildcards
such as `mcp__myclaw__*` are not durable authorization. Request tools are safe
to expose because they create drafts or reviews only. Approved skill proposals
and MCP servers are the exception to "future only": the host returns reviewed
skill files to the running agent, and approved third-party MCP servers are
callable through the approved MyClaw MCP proxy tools in both current and future
runs. Direct third-party `mcp__server__tool` names are not exposed.

## Cleanup Rules

Replacement work must remove stale active references to direct shell installs,
global Claude folders, direct `.mcp.json` mutation, group-tied skill state, and
base64 artifact transport. Historical migration references may remain only when
they are clearly historical and not active guidance.

Before calling a cutover complete, run targeted searches for:

- `mcp__myclaw__*`
- obsolete skill draft request tools outside historical notes
- `.claude/skills` as runtime truth
- `.mcp.json` mutation instructions
- base64 skill artifact serialization
- direct dependency-install guidance in active docs

## Adding A New Local CLI Capability

1. Discover the executable path and version, for example
   `/usr/local/bin/gog --version`.
2. Hash the executable when practical, then define the semantic capability:
   `capabilityId: google.sheets.write`, display name `Google Sheets write`,
   category `Google Sheets`, risk `write`, and account label such as
   `ravi@example.com`.
3. Set narrow command templates such as
   `/usr/local/bin/gog sheets write *`. Do not approve `Bash(gog *)`,
   `Bash(gog sheets *)`, or other raw CLI Bash grants as a substitute for a
   semantic local CLI capability.
4. Configure auth preflight, for example
   `/usr/local/bin/gog auth status`, and protect credential/config paths such
   as `~/.config/gog` from writes.
5. Submit `propose_local_cli_capability` with the definition and reason.
6. After review, run `capability_status` to confirm the draft is visible. Do
   not enable recurring-job reuse until runtime local-CLI enforcement verifies
   executable identity, preflight, protected paths, and denied env overrides.

Examples:

- Google Sheets through OneCLI: request `request_capability` with
  `capabilityId=google.sheets.write`. The prompt shows `Google Sheets write`;
  OneCLI broker details and command hashes stay in Details.
- Google Sheets through `gog`: propose a `local_cli` capability with pinned
  `/usr/local/bin/gog`, command template `/usr/local/bin/gog sheets write *`,
  auth preflight `/usr/local/bin/gog auth status`, and protected
  `~/.config/gog`. This is a reviewed draft until the runtime gate can enforce
  it; do not approve `Bash(gog *)` as a substitute.
- Unknown business CLI: propose `capabilityId=acme.invoices.read`,
  display name `Acme invoices read`, command template
  `/usr/local/bin/acme invoices read *`, and a non-secret account label.
- Revoking or changing an existing permission: use the capability management
  API/admin surface to remove `capability:<id>` from the agent tools list or
  replace it with a different account-specific capability, then sync
  `settings.yaml` and the Postgres projection.

Do not use raw token env, `Bash(cli *)`, broad proxy injection, direct
credential-store writes, raw provider model credentials, raw browser backend
tools, or `SandboxNetworkAccess` as durable authority.
