# Claude Runtime Materialization

Claude provider files are generated per run. They are compatibility inputs for
the Claude SDK, not MyClaw source of truth.

## Generated Per Run

The Anthropic Claude adapter creates a temporary `CLAUDE_CONFIG_DIR` for each
run. The directory contains:

- `settings.json` rendered by MyClaw
- `skills/` materialized from the active skill source
- `projects/<project>/` as an SDK scratch directory for the current run

The temp directory is removed after the run unless explicit debug retention is
enabled by the caller.

The Claude Agent SDK v0.2.112 exposes `settingSources`; an empty list loads no
filesystem settings, while `user`, `project`, and `local` opt into user
settings, project settings, and `settings.local.json`. MyClaw uses the
generated per-run `CLAUDE_CONFIG_DIR` as the SDK user settings root and does
not opt into the `local` settings source for enterprise runtime.

## Durable Sources

Durable state stays outside Claude runtime files:

- Postgres owns apps, agents, config versions, tools, skills, memory policy,
  permission policy, sessions, messages, and runs.
- `ProviderArtifactStore` owns explicit provider export/debug bytes only.
- `SkillArtifactStore` owns approved or draft local skill source bytes by
  storage ref; Postgres stores metadata, status, hash, bindings, and provider
  refs.
- Postgres owns MCP server definitions, reviewed versions, agent bindings,
  credential reference names, and audit events. Claude SDK `mcpServers` is a
  per-run projection, not durable truth.
- Package or configured local skill folders provide file-based Claude skills.
- MyClaw may add runtime-installed skills into the generated per-run config
  when they are part of host-owned capability wiring. The local Claude browser
  path uses this for `myclaw-browser`.
- Hosted Anthropic managed skills are referenced by provider skill ids and are
  resolved through the Anthropic SDK adapter, not through local files.

The runtime-home Claude directory is not an enterprise runtime source of truth.

## Settings

`settings.json` is rendered from canonical runtime inputs such as effective
agent config, LLM/provider profile, runtime settings, and provider-safe
adapter options. It must not contain raw provider secrets.

The materialized Claude settings do not install memory hooks. Fresh runs receive
only durable MyClaw memory as an untrusted first user-message prefix; active
chat continuity comes from the live SDK streaming-input session. Claude hook
output and provider JSONL transcripts are not runtime state.

Claude settings are not permission policy. Host-side
`ToolExecutionPolicyService`, permission policy, and sandbox policy remain
authoritative for tool execution. The Claude SDK `PreToolUse` hook and
`canUseTool` callback are adapter projections of that canonical decision path,
not separate policy engines.

`settings.local.json` is ignored in enterprise runtime because local Claude
settings are not MyClaw policy.

## Skills

Local Claude skills are files. The materializer copies valid skill folders or
approved skill artifacts containing `SKILL.md` into the temp `skills/`
directory for that run, then the Claude Agent SDK loads them from
`CLAUDE_CONFIG_DIR`.

For each persona with browser capability, MyClaw also materializes a pinned
runtime-installed `myclaw-browser` skill into that same temp directory. It is not
stored under the repo-bundled `.claude/skills` tree and does not require user
`.claude` edits. The skill always points the model at the projected public
Browser gateway tools: `browser_status`, `browser_open`, `browser_inspect`,
`browser_act`, and `browser_close`. Private browser backend tools must not
appear in model-visible MCP handoff, requestable capability lists, or persisted
tool rules; browser actions are handled by the host-owned browser driver behind
the projected MyClaw gateway.

Durable user-installed files under the runtime-home Claude skills directory are
not read or copied by enterprise runtime.

Agent-created or admin-uploaded skills enter MyClaw as zip uploads containing
`SKILL.md`. MyClaw parses display metadata from that file, stores the normalized
skill files as readable folders, and records draft lifecycle state in Postgres.
Pending drafts use `skill-drafts/<request-id>/<skill-slug>/...`; approved local
skills use `skills/<skill-slug>/...`. Drafts survive restart but are not
materialized or attached to hosted agents until approved. Rejected or disabled
skills are retained for history and not used at runtime.

The canonical tool execution policy, projected through the Claude Agent SDK
`PreToolUse` hook, blocks direct agent edits to skill capability files such as
`SKILL.md`, runtime-home `.claude/skills`, and agent-local `skills/` folders.
Agents must use
`mcp__myclaw__request_skill_install` for provider-backed imports or
`mcp__myclaw__request_skill_proposal` for skill file bundles. Admins/users can
also use the zip draft upload API. All paths review and persist the change
outside temporary Claude config before next-run activation.

Local approval makes the artifact eligible for per-agent binding and per-run
materialization. Hosted approval uploads the stored files through Anthropic's
native beta skill APIs behind the Anthropic adapter, then stores only opaque
provider refs such as Anthropic skill id and version. MyClaw does not recreate
hosted skill versioning or add a second skill permission prompt.

## MCP Servers

The built-in `myclaw` MCP server is internal runtime wiring. It is always
included by the runner, cannot be disabled by admin catalog records, and must be
reported as connected by Claude init before a run is trusted.

Third-party MCP servers are managed like approved agent capabilities. Admins
create or approve a Postgres MCP definition and immutable reviewed version, then
bind that version to an agent. Only approved, enabled bindings are projected
into Agent SDK `mcpServers` for the next run. Pending, rejected, disabled,
cross-app, or unbound MCP definitions are not rendered into Claude settings,
provider artifacts, or allowed tools.

Agents can request an MCP server through the built-in MyClaw MCP tool, but that
request only creates a pending draft for admin review. It never approves,
binds, or activates the server in the current run.

The same canonical policy blocks direct agent edits to MCP capability
configuration such as `.mcp.json`, MCP server settings, permission settings,
and `claude mcp add/remove/reset*` shell commands. Bash policy is target-based:
issue text or command arguments that merely mention protected terms are not
denied unless the command mutates a protected target. Agent-created MCP
capabilities must go through `mcp__myclaw__request_mcp_server`,
same-conversation review, binding, and next-run materialization.

Same-conversation MCP prompts are only a delivery surface. The deciding user
must still be listed as a conversation approver for the origin conversation and
must be a current member when they click approve or reject. Normal chat
participants cannot grant persistent capabilities. The runner includes the
origin conversation/thread in IPC, and the host rejects the draft before review
if that conversation is not registered to the requesting agent folder or if the
request tries to route approval to another bound conversation.

Remote third-party MCP servers must use HTTPS and cannot target loopback,
private, link-local, local, or cloud metadata hosts. MyClaw also resolves
remote MCP hostnames during approval, test, and materialization; every returned
A/AAAA address must be publicly routable so DNS rebinding cannot turn an
approved endpoint into runtime-local or metadata access. Runtime materialization
uses a short in-process TTL cache for same-batch coalescing only; the cache is
not durable trust and must not extend the DNS rebinding window across runs.
Stdio-template MCP servers require an explicit sandbox profile and are control
API/SDK-only in v1; agent requests and CLI draft creation only advertise
HTTP/SSE. The `npx-package` template accepts exactly one safe npm package
argument; other v1 stdio templates do not accept caller-supplied args.

MCP credentials are reference names resolved through `AgentCredentialBroker`.
Raw tokens, API keys, OAuth values, runtime secrets, and database URLs must not
be stored in MCP definitions or inherited by third-party MCP processes. Runtime
materialization resolves only broker-scoped credential reference names, not
arbitrary host environment keys. Resolved MCP credentials are handed to the
runner through a private per-run config file with `0600` permissions, and the
runner deletes that file after reading it. The host also removes the handoff
file during spawn cleanup so early runner failures do not leave credential
artifacts on disk.

`allowedToolPatterns` is the enforced SDK allowlist for tools exposed by a
third-party MCP server. `autoApproveToolPatterns` is narrower session-only
auto-allow scope and must be inside the allowed set when an explicit allowlist
exists. Agent-requested credential needs are labels; the host maps them to
server-scoped refs like `MCP_GITHUB_TOKEN_REF` rather than letting the agent pick
arbitrary broker environment keys.

## Provider Artifacts

Claude JSONL/session files are not runtime continuation state. MyClaw does not
restore provider transcript artifacts before a run and does not capture SDK
session files after a run. Active chat continuity comes from the live SDK
streaming-input session while the runner is alive; fresh runs restore only
durable MyClaw memory.
