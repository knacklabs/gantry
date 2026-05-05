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

The model is intentionally typed. Skills, MCP servers, SDK tools, host tools,
browser tools, provider-native channel tools, and conversation bindings have separate schemas and
validation rules. They share lifecycle, policy, audit, and config-version
activation, but they are not collapsed into one untyped blob.

## Administration Model

The deterministic ownership rule is:

- Agents own `selectedToolIds`, `selectedSkillIds`, and
  `selectedMcpServerIds`, plus provider-neutral DM access entries and one
  optional DM approval admin per provider.
- Channels own bound agents, default/routing metadata, sessions, and control
  approver allowlists.
- Agent DM access is separate from conversation membership and conversation approvers
  approvers. It can name provider user ids from Slack, Teams, Telegram, Web,
  or local surfaces. DM access does not grant approval rights by itself.
- Agent DM admins are separate from DM access users. A provider-specific DM
  admin can approve permission prompts only for that agent's direct/private DM
  sessions on that provider.
- Control approvers are separate from DM access. They must be verifiable
  members of the Channel and apply to every agent bound to that Channel.
- Agent identity is shared across provider bindings, but admin authority is not:
  Slack user ids, Teams user ids, Telegram user ids, Web users, and local users
  must be configured on their own provider or conversation surfaces.

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

| Tool                               | Use                                                                                                                     | Never use for                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `send_message`                     | Progress updates or direct channel messages while the agent is still running.                                           | Persistent capability changes.                                                                        |
| `ask_user_question`                | Structured choices with content, options, single-select, multi-select, preview/details, and channel-native buttons.     | Open-ended chat or approval of persistent capabilities.                                               |
| `request_skill_install`            | Provider-backed skill installs such as `clawhub:<slug>@<version>`.                                                      | Downloading or installing the skill directly.                                                         |
| `request_skill_proposal`           | Agent-created or modified `SKILL.md` bundles for review.                                                                | Writing directly to `.claude/skills`, `.agents/skills`, or agent-local `skills/`.                     |
| `request_skill_dependency_install` | npm, brew, go, uv, or download dependencies needed by a reviewed skill.                                                 | Running dependency commands from the agent.                                                           |
| `request_mcp_server`               | Third-party MCP server drafts with transport, origin, allowed tool patterns, credential needs, and reason.              | Editing `.mcp.json` or Claude `mcpServers`.                                                           |
| `request_permission`               | SDK, host, browser, scheduler, memory, service, MCP, or provider/channel capability permission requests.                 | Changing permission settings directly or treating provider SDK permissions as already approved.        |
| `capability_status`                | Lists selected admin MCP tools and unavailable-but-requestable tools with exact `tool:` IDs and `request_permission` arguments. | Guessing hidden admin tools or requesting broad MyClaw MCP wildcards.                                  |
| `settings_desired_state`           | Selected-capability reading of the current local desired-state settings before proposing a reviewed config change.      | Unselected access, mutating settings, or exposing raw secrets.                                        |
| `request_settings_update`          | Selected-capability reviewed host-side edits to non-secret local `settings.yaml` desired state.                         | Unselected access, direct file edits, raw provider secrets, skill source injection, or MCP definitions. |
| `service_restart`                  | Selected-capability restart after approved config or capability changes that require host restart.                      | Restarting to activate unapproved changes.                                                            |
| `register_agent`                   | Selected-capability binding of a new channel conversation to an agent.                                                  | Letting an unselected agent bind arbitrary chats.                                                     |

## Capability Types

| Type             | Durable truth                                                                  | Runtime projection                                                                     |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Skill            | Skill catalog row, readable files, provider ref, hash, binding.                | Per-run Claude `skills/<slug>/...` folder and `Skill` tool exposure.                   |
| Skill dependency | Dependency spec, approval decision, execution result, audit.                   | Optional per-skill tools directory or approved host package; never direct agent shell. |
| Third-party MCP  | Definition, reviewed version, credential refs, allowed tool patterns, binding. | SDK `mcpServers` plus exact allowed MCP tool names.                                    |
| SDK tool         | Tool catalog entry, risk, permission policy, sandbox profile, binding.         | Exact SDK tool name in `allowedTools` and `canUseTool` policy gate.                    |
| Host tool        | Built-in MyClaw MCP tool entry, risk, binding, audit behavior.                 | Exact `mcp__myclaw__<tool>` name.                                                      |
| Browser tool     | Browser lifecycle/action capability and sandbox policy.                        | Browser lifecycle MCP tools and optional action MCP server on next run.                |
| Channel tool     | Provider capability enum, scopes, affected conversations, binding.             | Provider adapter enables only the named Slack/Telegram/Teams/Web capability.           |
| Channel binding  | Agent-to-conversation/thread binding and control policy.                       | Message routing, trigger handling, and same-channel approval target.                   |

## Durable Model

Postgres is the durable capability store. It owns definitions, reviewed
versions, agent bindings, config-version links, credential reference names,
permission decisions, audit events, and disablement state.

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
4. Decide: `Allow once`, `Always allow <granular rule>`, or `Cancel` is recorded with actor, reason, and audit summary.
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

Browser lifecycle tools manage the agent conversation's persistent browser
profile. Browser action tools are a separate runtime-installed capability and
attach only on a later run when that profile's healthy browser is already
running at startup.

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
