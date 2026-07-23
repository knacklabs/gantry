# Anthropic Claude Adapter Materialization

Anthropic Claude provider files are generated per run by the Anthropic adapter.
They are compatibility inputs for the Claude SDK, not Gantry source of truth or
the general Gantry runtime model.

## Generated Per Run

The Anthropic Claude adapter creates a temporary `CLAUDE_CONFIG_DIR` for each
run. The directory contains:

- `settings.json` rendered by Gantry
- `skills/` materialized from the active skill source
- `projects/<project>/` as an SDK scratch directory for the current run

The temp directory is removed after the run.

The Claude Agent SDK exposes `settingSources` and `skills` as separate session
inputs. An empty `settingSources` list loads no filesystem settings, while
`user`, `project`, and `local` opt into user settings, project settings, and
`settings.local.json`. The `skills` option is the live SDK skill allowlist:
omitting it does not disable skills, `[]` disables all skills, and a string
array enables only those named skills. Gantry uses the generated per-run
`CLAUDE_CONFIG_DIR` as the SDK user settings root and does not opt into the
`local` settings source for enterprise runtime.

## Durable Sources

Durable state stays outside Claude runtime files:

- Postgres owns apps, agents, config versions, tools, skills, memory policy,
  permission policy, sessions, messages, and runs.
- `FileArtifactStore` owns durable agent file bytes by storage ref; Postgres
  stores metadata, ownership, virtual path, scope, version, hash, and policy.
- `SkillArtifactStore` owns installed skill source bytes by storage ref;
  Postgres stores metadata, status, storage pointers, bindings, and credential
  refs.
- Postgres owns current MCP server definitions, agent bindings, Gantry
  Credential reference names, and audit events. Claude SDK `mcpServers` is a
  per-run projection, not durable truth.
- Package or configured local skill folders provide file-based Claude skills.
- Gantry may add runtime-installed skills into the generated per-run config
  when they are part of host-owned capability wiring. The local Claude browser
  path uses this for `gantry-browser`.
- Hosted Anthropic managed skills are referenced by provider skill ids and are
  resolved through the Anthropic SDK adapter, not through local files.

The runtime-home Claude directory is not an enterprise runtime source of truth.

## Settings

`settings.json` is rendered from canonical runtime inputs such as effective
agent config, LLM/provider profile, runtime settings, and provider-safe
adapter options. It must not contain raw provider secrets.

The materialized Claude settings do not install memory hooks. Fresh runs put the
Gantry durable-memory boundary policy in the Agent SDK system prompt append with
dynamic sections excluded; memory facts are passed as untrusted first
user-message content. Active chat continuity comes from the live SDK
streaming-input session. Claude hook output and provider JSONL transcripts are
not runtime state.

Claude settings are not permission policy. Host-side
`ToolExecutionPolicyService`, permission policy, and sandbox policy remain
authoritative for tool execution. The Claude SDK `PreToolUse` hook and
`canUseTool` callback are adapter projections of that canonical decision path,
not separate policy engines.

`settings.local.json` is ignored in enterprise runtime because local Claude
settings are not Gantry policy.

## Skills

Local Claude skills are files. Durable Gantry skill identity is the exact
catalog id (`skill:<id>`). Settings and API source views may show the skill
name beside that id for readability, but the name is only a display hint and
per-run SDK directory name. The materializer copies valid skill folders or
installed skill artifacts containing `SKILL.md` into the temp `skills/`
directory for that run. The adapter then passes the exact materialized skill
names to `query({ options: { skills } })`. Memory and slash helper queries pass
`skills: []` so they cannot inherit filesystem or Claude-native skills.
Filesystem materialization, `skillOverrides`, and SDK native-skill disable
environment variables are defense in depth, not the authority boundary.

For each persona with browser capability, Gantry also materializes a pinned
runtime-installed `gantry-browser` skill into that same temp directory. It is not
stored under the repo-bundled `.agents/skills` tree and does not require user
`.claude` edits. The skill always points the model at the projected public
Browser gateway tools: `browser_status`, `browser_open`, `browser_inspect`,
`browser_act`, and `browser_close`. Private browser backend tools must not
appear in model-visible MCP handoff, requestable capability lists, or persisted
tool rules; browser actions are handled by the host-owned browser driver behind
the projected Gantry gateway.

Durable user-installed files under the runtime-home Claude skills directory are
not read or copied by enterprise runtime.

Gantry-owned skill names must not collide with Claude-native reserved names
such as `commands`, `init`, `review`, `security-review`, `schedule`, `loop`, or
`update-config`. The materializer rejects those names before writing skill
files. It also rejects a skill whose `SKILL.md` frontmatter `name:` would
materialize to a different SDK skill name than the Gantry catalog name; the
catalog name, temp directory, and declared SDK skill name must agree.

Agent-created or admin-uploaded skills enter Gantry as packages containing
`SKILL.md`. Gantry parses display metadata from that file and stores the
normalized installed package in the configured `SkillArtifactStore`; the local
backend uses runtime-home `artifacts/skills/<skill-directory>/`. Admin
CLI/API installation installs immediately. Agent requests create a same-channel
review request; a positive decision installs the current package and binds it
to the requesting agent, while rejection records only the request outcome.
Settings and Control API source selections render the readable skill name beside
the exact `skill:<id>` catalog id; the id is the authority and the name is
display-only. A reinstall of the same materialized skill directory replaces the
current package instead of creating another installed skill row.

The canonical tool execution policy, projected through the Claude Agent SDK
`PreToolUse` hook, blocks direct agent edits to skill capability files such as
`SKILL.md`, runtime-home provider skill folders, and agent-local `skills/`
folders.
Agents must use
`mcp__gantry__request_skill_install` for reviewed skill installs or
`mcp__gantry__request_skill_proposal` for skill file bundles. Admins/users can
also use the skill install API or CLI. All paths persist the installed package
outside temporary Claude config before next-run activation.

An agent can also use `request_skill_proposal` to update a skill currently
selected for that agent. The proposal must contain the complete replacement
package and should identify the selected skill id and current content hash from
the projected skill context. Gantry renders an update-specific approval in the
originating channel, accepts a decision only from a configured conversation
approver, rechecks the installed hash under the materialization lock, and then
replaces the package. A denied or stale request leaves the installed skill
unchanged; a failed replacement restores the prior package and binding.

Installation plus selected agent capability makes the artifact eligible for
per-run materialization. Gantry does not keep catalog, URL, GitHub, or
hosted-provider refs as skill authority; every install path converges into the
current local `SKILL.md` package and one binding decision.

## MCP Servers

The built-in `gantry` MCP server is internal runtime wiring. It is always
included by the runner, cannot be disabled by admin catalog records, and must be
reported as connected by Claude init before a run is trusted.

Third-party MCP servers are managed as connected resources plus selected agent
capabilities. Admins connect one current Postgres MCP definition and bind it to
an agent in the same service path. Only active definitions with enabled
bindings are projected into Agent SDK `mcpServers` for the next run. Disabled,
cross-app, or unbound MCP definitions are not rendered into Claude settings,
FileArtifacts, or allowed tools.

Agents can request an MCP server through the built-in Gantry MCP tool, but that
request only creates a pending review item. A positive decision connects the
current server definition and binds it to the requesting agent; rejection records
only the request outcome.

The same canonical policy blocks direct agent edits to MCP capability
configuration such as `.mcp.json`, MCP server settings, permission settings,
and `claude mcp add/remove/reset*` shell commands. Bash policy is target-based:
issue text or command arguments that merely mention protected terms are not
denied unless the command mutates a protected target. Agent-created MCP
capabilities must go through `mcp__gantry__request_mcp_server`,
same-conversation review, binding, and next-run materialization.

Same-conversation MCP prompts are only a delivery surface. The deciding user
must still be listed as a conversation approver for the origin conversation and
must be a current member when they click approve or reject. Normal chat
participants cannot grant persistent capabilities. The runner includes the
origin conversation/thread in IPC, and the host rejects the request before review
if that conversation is not registered to the requesting agent folder or if the
request tries to route approval to another bound conversation.

Remote third-party MCP servers must use HTTPS and cannot target loopback,
private, link-local, local, or cloud metadata hosts. Gantry also resolves
remote MCP hostnames during approval, test, and materialization; every returned
A/AAAA address must be publicly routable so DNS rebinding cannot turn an
approved endpoint into runtime-local or metadata access. Runtime materialization
uses a short in-process TTL cache for same-batch coalescing only; the cache is
not durable trust and must not extend the DNS rebinding window across runs.
Stdio-template MCP servers require an explicit sandbox profile and are control
API/SDK-only in v1; agent requests and simple CLI connect flows only advertise
HTTP/SSE. The `npx-package` template accepts exactly one safe npm package
argument; other v1 stdio templates do not accept caller-supplied args.

MCP credentials are Gantry Credential env names such as `GITHUB_TOKEN`. Raw tokens,
API keys, OAuth values, runtime secrets, and database URLs must not be stored in
MCP definitions or inherited by third-party MCP processes. Runtime
materialization resolves only the reviewed credential refs for selected MCP
servers from the encrypted capability secret store, not arbitrary host
environment keys or model gateway profiles. Resolved MCP credentials are handed
to the runner through a private per-run config file with `0600` permissions, and
the runner deletes that file after reading it. The host also removes the
handoff file during spawn cleanup so early runner failures do not leave
credential artifacts on disk.

`allowedToolPatterns` is the enforced SDK allowlist for tools exposed by a
third-party MCP server. `autoApproveToolPatterns` is narrower session-only
auto-allow scope and must be inside the allowed set when an explicit allowlist
exists. Agent-requested credential needs are labels; the host maps them to
normalized Gantry Credential names like `GITHUB_TOKEN` rather than letting the
agent submit raw values.

## Provider Artifacts

Claude JSONL/session files are not runtime continuation state. Gantry does not
restore provider transcript artifacts before a run and does not capture SDK
session files after a run. Active chat continuity comes from the live SDK
streaming-input session while the runner is alive; fresh runs restore only
durable Gantry memory.
