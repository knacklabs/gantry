# Claude Runtime Materialization

Claude provider files are generated per run. They are compatibility inputs for
the Claude SDK, not MyClaw source of truth.

## Generated Per Run

The Anthropic Claude adapter creates a temporary `CLAUDE_CONFIG_DIR` for each
run. The directory contains:

- `settings.json` rendered by MyClaw
- `skills/` materialized from the active skill source
- `projects/<project>/` used only to restore and capture provider session files

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
- `ProviderArtifactStore` owns provider continuation and export bytes.
- `SkillArtifactStore` owns approved or draft local skill source bytes by
  storage ref; Postgres stores metadata, status, hash, bindings, and provider
  refs.
- Package or configured local skill folders provide file-based Claude skills.
- Hosted Anthropic managed skills are referenced by provider skill ids and are
  resolved through the Anthropic SDK adapter, not through local files.

The runtime-home Claude directory is not an enterprise runtime source of truth.

## Settings

`settings.json` is rendered from canonical runtime inputs such as effective
agent config, LLM/provider profile, runtime settings, memory behavior, and hook
commands. It must not contain raw provider secrets.

Claude settings are not permission policy. Host-side `PermissionPolicyService`
and sandbox policy remain authoritative for tool execution.

`settings.local.json` is ignored in enterprise runtime because local Claude
settings are not MyClaw policy.

## Skills

Local Claude skills are files. The materializer copies valid skill folders or
approved skill artifacts containing `SKILL.md` into the temp `skills/`
directory for that run, then the Claude Agent SDK loads them from
`CLAUDE_CONFIG_DIR`.

Durable user-installed files under the runtime-home Claude skills directory are
not read or copied by enterprise runtime.

Agent-created or admin-uploaded skills enter MyClaw as zip uploads containing
`SKILL.md`. MyClaw parses display metadata from that file, stores the normalized
skill files behind a `storageRef`, and records draft lifecycle state in
Postgres. Drafts survive restart but are not materialized or attached to hosted
agents until approved. Rejected or disabled skills are retained for history and
not used at runtime.

Local approval makes the artifact eligible for per-agent binding and per-run
materialization. Hosted approval uploads the stored files through Anthropic's
native beta skill APIs behind the Anthropic adapter, then stores only opaque
provider refs such as Anthropic skill id and version. MyClaw does not recreate
hosted skill versioning or add a second skill permission prompt.

## Provider Artifacts

Before provider-native resume, MyClaw restores the latest `claude-jsonl`
artifact into the temp project directory. After the run, updated JSONL and
session indexes are captured through `ProviderArtifactStore`, then temp files
are removed.
