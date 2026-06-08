# Durable State Boundary

Gantry durable state has two categories.

Canonical runtime state lives in Postgres. This includes apps, agents,
conversations, threads, messages, sessions, provider session metadata, runs,
memory, jobs, permissions, tools, skills, browser profiles, and control events.

FileArtifacts hold durable agent-owned files and future transcript exports.
Claude JSONL files are not runtime continuation state, canonical conversation
records, or durable export artifacts.

Skill artifacts are normalized files from uploaded skill zips stored behind
`SkillArtifactStore`. Postgres records parsed skill metadata, lifecycle status,
storage ref, ownership, bindings, and hosted Anthropic provider refs. The bytes
are not stored inline in skill catalog rows.

Claude runtime files are temporary materializations. `settings.json` and local
`skills/` are generated inside a per-run `CLAUDE_CONFIG_DIR` from canonical
config, configured local skill folders, and installed bound skill artifacts.

## Allowed Durable Stores

- Postgres for canonical runtime state and artifact metadata
- Local filesystem artifact root for FileArtifact bytes
- Local filesystem artifact root for installed skill source bytes
- Object storage for future multi-node FileArtifact bytes

## Disallowed Durable State

Runtime code must not persist or replay Claude/provider JSONL directly under
the runtime home Claude directory, `DATA_DIR/sessions`, or any ad hoc durable
path. Claude SDK files may exist only in a temporary run directory while the
provider adapter is executing.

Runtime code must also not treat runtime-home Claude settings, local settings,
or skills directories as enterprise source of truth. `settings.local.json` is a
Claude-local concept, not Gantry policy.

Agent-created capability changes must enter through Gantry-owned request
flows. The Claude Agent SDK `PreToolUse` hook denies direct writes to skill
files, MCP configuration, and permission settings so local Claude files cannot
become hidden durable state. Agents submit skills through
`mcp__gantry__request_skill_proposal` and MCP servers through
`mcp__gantry__request_mcp_server`; both route to same-channel review before
future-run activation.

Gantry owns skill artifact durability and request approval state. Installed
skills are reviewed local `SKILL.md` packages materialized per run; Gantry does
not keep catalog, URL, GitHub, or hosted-provider refs as skill authority.

Existing local JSONL files are not imported automatically. Operators can remove
unsupported local session files after confirming no runtime version needs them.
