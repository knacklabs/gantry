# Capability Management

Gantry treats every agent-visible extension as an app-scoped and agent-scoped
capability. A capability can be an SDK tool, a built-in Gantry MCP tool, a
third-party MCP server, a skill, a browser lifecycle/action capability, or a
channel-native tool. The common rule is request, review, approval or denial,
durable audit, new config version, and next-run activation.

Agents must not mutate capability state directly. They must not run dependency
install commands, edit `.claude/skills`, edit `.mcp.json`, edit Claude
permission settings, edit Gantry settings, or change generated runtime config.
When a user asks for a new skill, MCP server, dependency, SDK tool, host tool,
or channel capability, the agent calls the matching Gantry request tool.

The user-facing permission model is `Agent -> Capability -> Access level`.
Raw permission ids, command hashes, scoped `RunCommand(...)` rules, sandbox profiles, and
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
    sources:
      skills:
        - id: linkedin-posting
          version: 3
      mcp_servers:
        - id: linkedin
          version: 1
      tools:
        - id: browser
          kind: builtin

    capabilities:
      - id: google.sheets.write
        version: builtin
      - id: browser.use
        version: builtin
      - id: repo.test.run
        version: 1
```

Each semantic capability record includes:

- `capabilityId`, `displayName`, `category`, `risk`, and optional
  `accountLabel`
- `can` and `cannot` user-facing scope statements
- `credentialSource`: implementation metadata such as `configured_access`,
  `onecli`, `external_broker`, `local_cli`, or `none`
- low-level implementation bindings such as exact Gantry tool facades, scoped
  `RunCommand(<template>)`, MCP tools, adapter refs, or local CLI command templates
- optional preflight metadata, protected credential/config paths, redaction
  policy, and sandbox needs

Runtime expands a selected semantic capability to deterministic low-level
rules for the current run, but management and prompts keep the semantic name
primary. For example, `capability:google.sheets.write` may project to a
provider-neutral configured-access adapter while the approval prompt says
`Allow Google Sheets write?`.

Built-ins cover common brokered app capabilities such as Google Sheets read,
Google Sheets write, and Gmail read. Unknown business tools are not accepted as
ad hoc raw commands. They must be promoted through a reviewed user-defined
semantic capability first.

## Skill Action Permissions

Approved skills may declare reviewed action permissions in
`gantry.skill.json`. This manifest is skill metadata, not authority by itself:
installing or selecting a skill does not grant its risky action. The target
agent owns the durable permission, jobs inherit that agent grant, and the skill
only declares the trusted label and scoped command templates.

Example:

```json
{
  "actions": [
    {
      "id": "publish",
      "capabilityId": "skill.linkedin-posting.publish",
      "displayName": "LinkedIn posting",
      "risk": "write",
      "can": "Publish a prepared LinkedIn post through the approved script.",
      "cannot": "Read unrelated accounts or receive raw LinkedIn credentials.",
      "requiredEnvVars": ["LINKEDIN_ACCESS_TOKEN"],
      "commandTemplates": ["python3 ${skillRoot}/post.py --file /tmp/post.md"]
    }
  ]
}
```

Runtime normalizes `${skillRoot}` to the materialized readable skill directory,
for example `skills/linkedin-posting`, rejects shell environment assignments
and secret-like command parts, and records the approved skill id plus content
hash on the semantic capability definition. A persistent approval stores
`capability:skill.linkedin-posting.publish` on the agent and projects the
underlying scoped `RunCommand(...)` only for the current/future run after the
selected skill hash still matches. If the approved skill package changes, the
old durable grant stops projecting and the user must approve the changed action
again.

Permission prompts use the trusted manifest display name, for example
`Allow LinkedIn posting?`, while buttons remain short: `Allow once`,
`Allow 5 min`, `Always allow`, and `Cancel`. Raw free-form request text cannot
create a trusted action label; raw command fallback remains visible as exact
command access.

## Local CLI Capabilities

`local_cli` is a first-class credential source for authenticated CLIs such as
`gog`, `gws`, `gh`, `gcloud`, or a company CLI. User-defined local CLI
capabilities require the runtime local-CLI gate to verify the pinned
executable, version/hash, denied environment overrides, preflight, and
protected paths before projecting scoped command authority.

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
shows `Acme invoices read` in prompts and management views. Until runtime
enforcement exists, approval records the reviewed draft only; it does not create
durable runnable authority or a harness command-tool projection.

## Administration Model

The deterministic ownership rule is:

- `settings.yaml` exposes two separate agent views: `sources` and
  `capabilities`.
- `sources` lists attached, reviewed resources such as skills, MCP servers,
  built-in tools, adapters, and local CLIs. A source is visible inventory for
  the agent, not execution authority.
- `capabilities` is the only durable grant list. Runtime projects selected
  approved capability versions into typed execution access.
- Manual settings edits may attach approved sources or select approved
  capabilities only. They must not include raw secrets, MCP configs, command
  bodies, generated manifests, or provider credentials.
- Runtime rejects legacy agent grant fields such as `tools`, `skills`,
  `mcp_servers`, `tool_ids`, `skill_ids`, `mcp_server_ids`, and nested
  `capabilities.tool_ids`, `capabilities.skill_ids`, or
  `capabilities.mcp_server_ids`.
- Postgres stores the runtime projection, catalog rows, artifact metadata,
  audit, and execution state. It is not the durable source of truth for fields
  represented in `settings.yaml`.
- Conversations own bound agents, default/routing metadata, sessions, sender
  policy, trigger policy, and control approver allowlists.
- Conversation sender policy is separate from conversation membership and
  control approvers. It controls who may send messages into that conversation.
- Control approvers must be verifiable members of the Conversation and apply to
  every agent bound to that Conversation, including direct/private sessions.
- Agent identity is shared across provider bindings, but approval authority is
  configured on each provider conversation surface.

There is no channel-scoped tool selection field and no separate browser
capability list. Browser is represented by a semantic capability such as
`browser.use`; provider or channel flags describe adapter support and are
metadata, not authorization.

API, CLI, and MCP are adapters over the same application services:

- Public control API is for owner/admin automation and Web/SDK admin UX.
- CLI is for local/admin setup, provider connect/validate, service
  start/stop/restart/logs, doctor commands, and local imports.
- Gantry MCP tools are for agent-requested reviewed changes and safe runtime
  interactions. They create reviewable requests rendered through
  `InteractionDescriptor`.

Skills, MCP servers, and tools are central catalog objects. V1 does not version
skills; approved catalog items are disabled and replaced rather than edited in
place.

## Tool Matrix

| Tool                               | Use                                                                                                                                                                                                          | Never use for                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `send_message`                     | Progress updates or direct channel messages while the agent is still running.                                                                                                                                | Persistent capability changes.                                                                                  |
| `ask_user_question`                | Structured choices with content, options, single-select, multi-select, preview/details, and channel-native buttons.                                                                                          | Open-ended chat or approval of persistent capabilities.                                                         |
| `request_skill_install`            | Reviewed skill installs using either staged `SKILL.md` package files or an installer command such as `npx ... install <skill>` that produces a `SKILL.md` package in host-controlled staging.                | Installing silently, editing skill directories directly, or requiring a second approval after approval.         |
| `request_skill_proposal`           | Agent-created or modified `SKILL.md` bundles for review.                                                                                                                                                     | Writing directly to `.claude/skills`, `.agents/skills`, or agent-local `skills/`.                               |
| `request_skill_dependency_install` | npm, brew, go, uv, or download dependencies needed by a reviewed skill.                                                                                                                                      | Running dependency commands from the agent.                                                                     |
| `request_mcp_server`               | Third-party MCP server drafts with transport, origin, allowed tool patterns, credential needs, and reason.                                                                                                   | Editing `.mcp.json` or Claude `mcpServers`.                                                                     |
| `request_permission`               | One-off exact access, Browser, exact Gantry admin tools, provider/channel permissions, or scoped `RunCommand` fallback when no reviewed semantic capability fits.                                            | Semantic capability grants, capability proposals, broad raw commands, or changing permission settings directly. |
| `capability_search`                | Finds built-in semantic capabilities by id, provider/app, risk, or allowed action.                                                                                                                           | Guessing raw command rules or provider-specific implementation names.                                           |
| `propose_capability`               | Requests an approved semantic capability when the id already exists, or proposes a reviewed `local_cli` capability with pinned executable, command templates, preflight, account label, and protected paths. | Running the implementation directly or approving broad raw commands as a substitute.                            |
| `manage_capability`                | Presents view/change/revoke/test/audit guidance for existing semantic capabilities.                                                                                                                          | Silent DB-only edits, raw token inspection, or bypassing settings sync.                                         |
| `capability_status`                | Lists current tool access, readable configured rules, selected skills, selected MCP servers, default tools, gated tools, semantic capability tools, and unavailable-but-requestable admin tools.             | Guessing hidden admin tools or requesting broad Gantry MCP wildcards.                                           |
| `settings_desired_state`           | Selected-capability reading of the current local desired-state settings before proposing a reviewed config change.                                                                                           | Unselected access, mutating settings, or exposing raw secrets.                                                  |
| `request_settings_update`          | Selected-capability reviewed host-side edits to non-secret local `settings.yaml` desired state.                                                                                                              | Unselected access, direct file edits, raw provider secrets, skill source injection, or MCP definitions.         |
| `service_restart`                  | Selected-capability restart after approved config or capability changes that require host restart.                                                                                                           | Restarting to activate unapproved changes.                                                                      |
| `register_agent`                   | Selected-capability binding of a new channel conversation to an agent.                                                                                                                                       | Letting an unselected agent bind arbitrary chats.                                                               |

## Capability Types

| Type             | Durable truth                                                                     | Runtime projection                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill            | Skill catalog row, readable files, provider ref, hash, binding.                   | Per-run Claude `skills/<slug>/...` folder and `Skill` tool exposure.                                                                                                            |
| Skill dependency | Dependency spec, approval decision, execution result, audit.                      | Optional per-skill tools directory or approved host package; never direct agent shell.                                                                                          |
| Third-party MCP  | Definition, reviewed version, Gantry Secret refs, allowed tool patterns, binding. | SDK `mcpServers` for host-safe stdio transports plus exact allowed MCP tool names. Remote HTTP/SSE requires host DNS-pinned transport before projection.                        |
| SDK tool         | Tool catalog entry, risk, permission policy, sandbox profile, binding.            | Durable grants use Gantry facade names; provider-native SDK names in `allowedTools` are only per-run harness projections, and command access is never projected as bare `Bash`. |
| Host tool        | Built-in Gantry MCP tool entry, risk, binding, audit behavior.                    | Exact `mcp__gantry__<tool>` name.                                                                                                                                               |
| Browser tool     | Canonical `Browser` capability and sandbox policy.                                | Gated Gantry-owned gateway tools with Gantry-owned schemas.                                                                                                                     |
| Channel tool     | Provider capability enum, scopes, affected conversations, binding.                | Provider adapter enables only the named Slack/Telegram/Teams/Web capability.                                                                                                    |
| Channel binding  | Agent-to-conversation/thread binding and control policy.                          | Message routing, trigger handling, and same-channel approval target.                                                                                                            |

## Durable Model

`settings.yaml` owns the durable local list of user-manageable agent sources
and capabilities under `agents.<agent>.sources` and
`agents.<agent>.capabilities`. Settings-side changes are validated, written,
reconciled into Postgres by replacement, and reloaded immediately where safe;
they do not rely only on the file watcher.

Postgres is the runtime capability projection and catalog store. It owns
definitions, reviewed versions, agent bindings, config-version links,
Gantry Secret reference names, encrypted capability secret values, permission
decisions, audit events, and disablement state.

Agent-owned persistent grants are mirrored into `settings.yaml` as readable
`agents.<id>.capabilities` entries. Prefer semantic capabilities such as
`google.sheets.write` for app workflows. `request_permission` durable fallback
is intentionally narrow and should be converted into an approved capability
version when it needs to survive beyond a one-off exact tool rule. Broad exact
SDK/native tools such as `Read`, `Write`, `Edit`, `WebFetch`, `LS`, exact
third-party MCP tools, secret-bearing command rules, shell-control command
rules, and `SandboxNetworkAccess` are not durable authority. Do not expose
opaque permission-rule hashes in settings. Settings reconciliation resolves
selected capability versions back into Postgres catalog rows and agent bindings
immediately and after restart.

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
must export the readable Postgres projection back into `settings.yaml`, then
validate, reconcile, and reload. Persistent `Always allow` permission approvals
must fail closed if settings cannot be updated; any new active binding is rolled
back so DB-only persistent grants do not survive as hidden authority. Empty
non-authoritative settings may continue to observe preexisting DB-only
capabilities, but any declared settings capability list replaces stale active
Postgres tool, skill, and MCP bindings for that agent.

Jobs are scheduled runs of the target agent. They inherit that agent's selected
capabilities and attached sources at execution time, never carry a separate
job-scoped grant surface, and expose the canonical `toolAccess` object instead
of parallel count or legacy tool fields. Job `capability_requirements` are
readiness assertions, not grants. A job may require multiple capabilities or a
reviewed composite capability, but approval updates the target agent's
`capabilities` list, not a job-local permission list.

When an autonomous job fails because a capability is missing, recovery output
uses the same reviewed request tools as interactive agents:

```text
propose_capability { "capabilityId": "google.sheets.write", "reason": "This scheduled job writes the weekly status sheet." }
request_permission { "permissionKind": "tool", "toolName": "RunCommand", "rule": "npm test *", "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }
request_mcp_server { "name": "github", "transport": "http", "reason": "This autonomous run needs the github MCP server capability." }
```

Approved requests update the target agent's durable selected capabilities or
attached sources and export the readable projection to `settings.yaml`.
Tool permission approval can resume the blocked active tool call immediately:
`Allow once` is current-run only and does not create durable semantic
authority, while `Always allow` stores either the approved semantic capability,
canonical `Browser`, exact Gantry file/web facade, exact Gantry admin tool, or scoped `RunCommand(...)` rule for the active
run and future runs. New skill or MCP materialization occurs on the next
scheduled run or a manual rerun. Browser remains a single public `Browser` tool
capability; projected browser gateway tools and admin Gantry MCP tools are not
job-local grants.

Direct writes to `settings.json`, `settings.local.json`, `.mcp.json`,
generated provider MCP directories, and skill capability files are protected
wholesale. Provider settings files are not partially parsed for "safe" keys;
agents must use reviewed Gantry request tools because future provider settings
can become execution or permission policy.

Readable skill bytes live outside catalog rows:

```text
skills/<skill-slug>/SKILL.md
skills/<skill-slug>/...
skill-drafts/<request-id>/<skill-slug>/SKILL.md
skill-drafts/<request-id>/<skill-slug>/...
```

The database stores metadata, source type, content hash, binding, and audit
only. Skill files remain readable for review. Catalog, URL, CLI-command, and
uploaded installs all converge into the same reviewed local skill package after
approval.

Local storage uses the same readable layout as object storage. Object storage
keys must remain human-readable and API-readable; hashes are metadata, not path
names. A local skill can be inspected with normal filesystem tools, and the API
can list/read individual files under `skills:read`.

Claude settings, `CLAUDE_CONFIG_DIR`, MCP handoff files, and FileArtifacts
are per-run projections. They are compatibility inputs for a provider adapter,
not durable Gantry truth.

## Lifecycle

1. Request: admin API/SDK/CLI or an agent request tool creates a pending request.
2. Validate: Gantry checks app scope, agent scope, transport, origin chat,
   Gantry Secret refs, sandbox profile, tool patterns, and provider metadata.
3. Review: same-channel review renders the request, but authority still comes
   from configured admin/control policy.
4. Decide: setup, scheduler, admin, and capability flows show `Allow once`, `Always allow`, or `Cancel`; live interactive SDK prompts may also show `Allow 5 min`. Details and audit records carry the durable authority shape, such as a semantic capability, canonical `Browser`, exact Gantry file/web facade, exact `mcp__gantry__<admin_tool>`, or scoped `RunCommand(<pattern>)`.
5. Bind: approval creates or updates the agent binding and a new config version.
6. Same-session handoff: approved skill installs and proposals are returned to the running
   agent as reviewed skill files; approved MCP servers are reachable through the
   Gantry `mcp_list_tools` / `mcp_call_tool` proxy.
7. Materialize: only approved enabled skill bindings project into future agent
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
2. Host validates package safety, requires `SKILL.md`, computes content hashes,
   and stages readable draft files under `skill-drafts/<request-id>/<slug>/`.
3. Channel UX shows the skill summary, files, hashes, declared dependencies,
   risk, and activation timing.
4. Approval installs to `skills/<slug>/...`, records audit, binds the skill,
   exports readable settings, returns reviewed files to the running agent, and
   materializes it for future runs. There is no second approval after the user
   approves the install request. Installer-command requests run the exact argv
   in a temporary host-controlled staging directory with a scrubbed environment
   plus any named `requiredEnvVars` resolved from Gantry Secrets, then import
   and approve the produced `SKILL.md` package through the same path.

If the skill declares npm, brew, go, uv, or download dependencies, those are
separate dependency requests. The skill approval does not run them.

Skill and MCP capability credentials use Gantry Secrets, not runtime `.env` or
model broker profiles. Operators set them with `gantry secrets set <NAME>` or
`gantry secrets import-env <NAME>`, optionally adding repeated
`--allow <capabilityId>` scopes such as `mcp:github`, a concrete MCP definition
id, a concrete skill id, or `skill:<name>`. Secret values are encrypted in
Postgres and only projected into the current runner or MCP subprocess when an
approved selected capability declares the matching required env var or
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
projected only from approved reviewed versions and active bindings. Their
`allowedToolPatterns` form the enforced tool allowlist. Any
`autoApproveToolPatterns` must be a subset of the allowed set.

Skills are projected only when approved and bound. Draft, denied, disabled, or
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
to expose because they create drafts or reviews only. Approved skill proposals
and MCP servers are the exception to "future only": the host returns reviewed
skill files to the running agent, and approved third-party MCP servers are
callable through the approved Gantry MCP proxy tools in both current and future
runs. Direct third-party `mcp__server__tool` names are not exposed.

## Cleanup Rules

Replacement work must remove stale active references to direct shell installs,
global Claude folders, direct `.mcp.json` mutation, group-tied skill state, and
base64 artifact transport. Historical migration references may remain only when
they are clearly historical and not active guidance.

Before calling a cutover complete, run targeted searches for:

- `mcp__gantry__*`
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
   `/usr/local/bin/gog sheets write *`. Do not approve `RunCommand(gog *)`,
   `RunCommand(gog sheets *)`, or other raw command grants as a substitute for a
   semantic local CLI capability.
4. Configure auth preflight, for example
   `/usr/local/bin/gog auth status`, and protect credential/config paths such
   as `~/.config/gog` from writes.
5. Submit `propose_capability` with `source: local_cli`, the definition, and
   reason.
6. After review, run `capability_status` to confirm the draft is visible. Do
   not enable recurring-job reuse until runtime local-CLI enforcement verifies
   executable identity, preflight, protected paths, and denied env overrides.

## Scheduler Capability Requirements

Agents creating jobs should declare needed app/tool access with
`scheduler_upsert_job.capability_requirements` when the job depends on a
semantic capability such as Google Sheets write access. Requirements are stored
with the job, included in the confirmation token, and projected into
`tool_access_requirements` as `capability:<id>` so readiness checks and runtime permission
evaluation use the same durable authority model.

Use `implementation.kind: configured_access` when Gantry should use an existing
reviewed provider-neutral capability. Use `implementation.kind: local_cli` when
the job must use a specific authenticated local CLI such as `gog`; it must
include an absolute `executablePath`, a narrow `commandTemplate` that starts
with that exact executable path, and any `authPreflight` must also start with
the same path. It must also include pinned executable version and hash so setup
can ask for one reviewed local CLI capability instead of a raw command grant.
It is not a job-owned grant. User-defined semantic `local_cli` capability
proposals require executable identity, command templates, protected paths, and
denied environment overrides before runtime projects scoped command authority.
Do not replace the reviewed capability with a broad `RunCommand(gog *)` grant.

Examples:

- Google Sheets through configured access: request `propose_capability` with
  `capabilityId=google.sheets.write`. The prompt shows `Google Sheets write`;
  concrete implementation details such as OneCLI, `gog`, command rules, and
  hashes stay out of the primary prompt and belong in audit/details surfaces.
- Google Sheets through `gog` for a scheduler job: declare
  `implementation.kind: local_cli`, `name: gog`,
  `executablePath: /usr/local/bin/gog`, pinned `executableVersion`,
  pinned `executableHash`, and a narrow `commandTemplate` such as
  `/usr/local/bin/gog sheets append <sheet_id> ...`. Setup must request a
  reviewed `local_cli` capability for the target agent, not a job-local
  permission or the generic configured access capability
  `google.sheets.write`.
- Reusable user-defined local CLI capability: propose a `local_cli` capability
  with pinned `/usr/local/bin/gog`, command template
  `/usr/local/bin/gog sheets write *`, auth preflight
  `/usr/local/bin/gog auth status`, and protected `~/.config/gog`. This is a
  reviewed draft until the runtime gate can enforce it; do not approve
  `RunCommand(gog *)` as a substitute.
- Unknown business CLI: propose `capabilityId=acme.invoices.read`,
  display name `Acme invoices read`, command template
  `/usr/local/bin/acme invoices read *`, and a non-secret account label.
- Revoking or changing an existing permission: use the capability management
  API/admin surface to remove `<capability id>@<version>` from the agent
  capability list or replace it with a different account-specific capability, then sync
  `settings.yaml` and the Postgres projection.

Do not use raw token env, `RunCommand(cli *)`, broad proxy injection, direct
credential-store writes, raw provider model credentials, raw browser backend
tools, or `SandboxNetworkAccess` as durable authority.
