# Durable State Boundary

MyClaw durable state has two categories.

Canonical runtime state lives in Postgres. This includes apps, agents,
conversations, threads, messages, sessions, provider session metadata, runs,
memory, jobs, permissions, tools, skills, browser profiles, and control events.

Provider artifacts are explicit export or debug artifacts stored behind
`ProviderArtifactStore`. Claude JSONL files are not runtime continuation state
and are not canonical conversation records.

Skill artifacts are normalized files from uploaded skill zips stored behind
`SkillArtifactStore`. Postgres records parsed skill metadata, lifecycle status,
content hash, storage ref, ownership, bindings, and hosted Anthropic provider
refs. The bytes are not stored inline in skill catalog rows.

Claude runtime files are temporary materializations. `settings.json` and local
`skills/` are generated inside a per-run `CLAUDE_CONFIG_DIR` from canonical
config, configured local skill folders, and approved bound skill artifacts.

## Allowed Durable Stores

- Postgres for canonical runtime state and artifact metadata
- Local filesystem artifact root for explicit provider export/debug bytes
- Local filesystem artifact root for draft and approved skill source bytes
- Object storage for future multi-node provider artifact bytes

## Disallowed Durable State

Runtime code must not persist or replay Claude/provider JSONL directly under
the runtime home Claude directory, `DATA_DIR/sessions`, or any ad hoc durable
path. Claude SDK files may exist only in a temporary run directory while the
provider adapter is executing.

Runtime code must also not treat runtime-home Claude settings, local settings,
or skills directories as enterprise source of truth. `settings.local.json` is a
Claude-local concept, not MyClaw policy.

MyClaw owns draft artifact durability and local approval state. It does not own
hosted skill versioning. Hosted Anthropic skills are provider-managed resources
addressed by opaque provider refs through the Anthropic SDK adapter.

Existing local JSONL files are not imported automatically. Operators can remove
old local session files after confirming no older runtime version needs them.
