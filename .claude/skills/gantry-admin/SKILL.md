---
name: gantry-admin
description: |
  Gantry self-administration reference for current host runtime operations:
  CLI commands, settings.yaml runtime settings, .env credential keys, agent
  management, scheduler tools, memory tools, browser tools, diagnostics, and
  service control. Use when asked to manage Gantry itself.
user_invocable: false
---

# Gantry Administration Reference

Gantry is a host-runtime personal assistant. The CLI binary is `gantry`.
Runtime home defaults to `~/gantry`; pass `--runtime-home <path>` to target a
different runtime home.

Host runtime is the only supported runtime mode. Treat `settings.yaml` as the
source of truth for runtime behavior. Treat `.env` as the place for
runtime-owned secrets and process-specific launch values; agent-accessed model
and tool credentials must go through OneCLI or the selected credential broker,
not raw runtime env.

## Current CLI Surface

Core:

```bash
gantry
gantry setup
gantry doctor
gantry status
gantry start
gantry stop
gantry restart
gantry logs
```

Local services:

```bash
gantry local setup
gantry local status
gantry local doctor
```

Service:

```bash
gantry service install
gantry service start
gantry service stop
gantry service restart
```

Channels:

```bash
gantry channel connect telegram
gantry channel connect slack
gantry channel connect teams
gantry channel list
gantry channel doctor
```

Agent, channel, session, and DM administration:

```bash
gantry agent list
gantry agent info <agentId>
gantry agent create --name <name>
gantry agent edit <agentId> [--name <name>] [--disabled|--active]
gantry agent capabilities <agentId> --tools <ids> --skills <ids> --mcp <ids>
gantry agent dm-access <agentId> --provider <provider> --allow <userId,userId> --admin <userId>
gantry agent audit <agentId>

gantry channel onboard <slack|teams|telegram> --external-id <id> --title <name>
gantry channel list
gantry channel info <channelId>
gantry channel agents <channelId> --agents <agentId,agentId> [--default <agentId>]
gantry conversation approvers <conversationId> --allow <userId,userId>
gantry channel archive <channelId>
gantry channel doctor <channelId>

gantry session create <channelId> [--external-thread-id <id>] [--title <name>]
gantry session list <channelId>
gantry session info <sessionId>
gantry session archive <sessionId>
gantry session test <sessionId>
```

Skill drafts:

```bash
gantry skill draft upload <skill.zip> [--agent <agentId>] [--created-by <id>]
```

Uploaded skill zips must contain `SKILL.md`. Gantry parses skill metadata from
that file, stores the files in artifact storage, and records draft lifecycle
state in Postgres. Drafts are not active until approved and bound through the
AgentAdministration service or channel approval flow.

Administration source of truth:

- `AgentAdministration` replaces an agent's selected tools, skills, and MCP
  servers together. Do not manage a separate channel tool list.
- `CapabilityCatalog` lists central Tool, Skill, and MCP Server catalog items.
  Browser is a normal tool catalog item.
- `Channel` is the public term for Slack channels, Teams channels, and Telegram
  groups. Slack/Teams threads and Telegram topics are Sessions under a Channel.
- Agent DM access is a provider-neutral allowlist; do not mix it with channel
  membership, channel control approvers, or agent capabilities. Each agent can
  set one DM approval admin per provider; DM access users are not approvers
  unless explicitly configured as that provider admin. If the same agent is
  bound in Slack and Teams, configure the Slack DM admin with a Slack user id
  and the Teams DM admin with a Teams user id.
- Channel control allowlist is separate from DM access. It is per Channel,
  applies to all agents bound there, and approvers must be verified Channel
  members before save. A Slack channel approver does not approve Teams channel
  requests unless the matching Teams user id is also configured on that Teams
  Channel.
- CLI calls application services directly for local/admin operations. Public
  API is for owner/admin automation. Gantry MCP request tools are for
  agent-requested reviewed changes.
- Use `gantry agent dm-access <agentId> --provider <provider> --allow <ids> --admin <userId>`
  to replace provider-specific DM access and the direct/private DM approval
  admin for an agent. Use
  `gantry conversation approvers <conversationId> --allow <ids>` only for
  group/channel permission approvers.

Config file editing through `.env`:

```bash
gantry config list
gantry config get <KEY> [--raw]
gantry config set <KEY> <VALUE>
gantry config unset <KEY>
```

Memory:

```bash
gantry memory status [--json]
gantry memory reindex
gantry memory embeddings <off|disabled|provider>
gantry memory dreaming <on|off>
gantry memory health journal-status
gantry memory counters
gantry memory model set <extractor|dreaming|consolidation> <model>
gantry memory model profile <cheap|balanced|quality>
```

Runtime continuity injection:

- Host runtime injects a memory/continuity block on every run (message turns and scheduler runs).
- This injection is baseline context. Memory MCP tools are for deeper lookup and explicit writes.
- Dream status metadata is part of the injected brief when available.
- Runtime memory retrieval is lexical plus keyword fallback today. Embeddings can be configured, but vector retrieval is not active until the runtime indexing/query path is enabled.

Runtime memory:

- Host runtime injects durable Gantry memory context at live session or job
  start. It does not replay Postgres transcripts as automatic prompt context.
- Do not configure Claude memory hooks for runtime continuity; provider hook
  output and JSONL transcripts are not Gantry session state.

Runtime Claude settings and skills are generated into a temporary per-run
`CLAUDE_CONFIG_DIR`. Runtime-home `.claude/skills` is not the skill source of
truth. Do not install separate global Claude hooks for Gantry memory. Generated
runtime settings do not install memory hooks.

Capability changes are never direct edits. Agents must not run dependency
install commands, edit `.claude/skills`, edit `.mcp.json`, edit `settings.yaml`,
edit Claude permission settings, or mutate generated capability config. Every
capability change goes through request, review, approval or denial, durable
audit, and a new config version. Tool permission approval can also resume the
blocked active tool call: `Allow once` is current-run only, while `Always allow`
updates the target agent capability binding, mirrors `settings.yaml`, and
applies to future runs too.

Use these Gantry tools for capability work:

| Tool                               | Use                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message`                     | Progress updates or direct channel messages while the agent is still running.                                                                   |
| `ask_user_question`                | Structured choices only; supports content, options, single-select, multi-select, preview/details, and channel-native buttons.                   |
| `request_skill_install`            | Provider-backed skill installs such as `gantryhub:<slug>@<version>`.                                                                              |
| `request_skill_proposal`           | Agent-created or modified skill file bundles for review.                                                                                        |
| `request_skill_dependency_install` | npm, brew, go, uv, or download dependencies required by a skill; never run those commands directly.                                             |
| `request_mcp_server`               | Third-party MCP server requests with transport, origin, tool patterns, credentials, and reason.                                                 |
| `capability_search`                | Find semantic app/tool capabilities such as `google.sheets.write` before asking for raw tool access.                                            |
| `propose_capability`               | Request an approved semantic capability by id, or propose a reviewed `local_cli` capability draft with pinned executable, preflight, and protected paths. |
| `manage_capability`                | View, revoke, change, test, or inspect audit history for semantic capabilities.                                                                 |
| `request_permission`               | One-off exact tool access, scoped Bash fallback, and internal/provider permission requests when no semantic capability fits.                    |
| `service_restart`                  | Main/admin agent only, after approved config or capability changes when host restart is needed.                                                 |
| `register_agent`                   | Main/admin agent only, for binding a new channel conversation to an agent.                                                                      |

Same-channel review is a delivery and origin constraint, not a shortcut around
authorization. The host verifies that the origin chat belongs to the requesting
agent, the deciding user is in the control allowlist, the approval decides only
that pending request, and activation happens on the next run.

Permission selection:

- Use `ask_user_question` only for discrete choices. Set single-select for one
  answer, multi-select when multiple answers are valid, and include concise
  option descriptions so Slack, Telegram, Teams, and Web/API can render native
  controls.
- Use `request_permission` when a low-level one-off or fallback permission is
  needed for provider-neutral tools or provider/channel capabilities such as
  `Bash`, `Write`, `Edit`, the canonical `Browser` tool, scheduler tools,
  memory tools, service tools, Slack file reads, Telegram file downloads, Teams
  proactive messages, Teams card updates, or Web/API file browser access.
- For app/tool workflows such as Google Sheets, Gmail, or business CLIs, call
  `capability_search` first, then `propose_capability` so the user approves a
  semantic capability instead of a raw command.
- Permission prompts offer `Allow once`, `Always allow for this agent/job` for
  semantic capabilities, `Always allow Browser`,
  `Always allow mcp__gantry__<admin_tool>`,
  `Always allow Bash(<literal command prefix pattern>)`, and `Cancel`.
- Use the narrowest useful permission request:
  - Ask for temporary/one-time access when the action is rare, exploratory, or
    risky and does not need to persist.
  - Ask for durable semantic capabilities when the same app/tool operation is
    likely to repeat. The durable readable rule is `capability:<id>`, and raw
    request ids, command hashes, executable paths, and sandbox profiles stay in
    Details/audit.
  - Ask for persistent scoped Bash only when the same bounded shell command is
    likely to repeat, using a literal command prefix such as
    `Bash(npm test *)`. Persistent bare `Bash`, `Bash(*)`, and leading-wildcard
    shell rules are not allowed.
  - Non-Bash persistent fallback grants are limited to canonical `Browser` and
    selected first-party Gantry admin tools. Broad exact SDK/native tools such
    as `Read`, `Write`, `Edit`, `WebFetch`, or `Agent`, exact third-party MCP
    tools, scoped non-Bash rules such as `Edit(/docs/**)`, and durable MCP
    wildcards are not supported.
  - User-defined `local_cli` capabilities are reviewed drafts until runtime
    enforcement verifies executable identity, auth preflight, protected paths,
    and denied environment overrides on each invocation. Do not replace that
    gate with broad `Bash(cli *)`.
  - Browser authority is always the exact canonical `Browser` capability.
    Runtime browser action tool names are projections, not durable grants.
- Browser state is scoped by agent plus conversation. Jobs inherit the target
  agent's selected tools, skills, and MCP servers at run time; jobs do not carry
  job-scoped tool, skill, or MCP grants. If a scheduled job needs a missing tool
  permission, the approval prompt uses the same channel/thread/topic flow as an
  agent run and resumes the blocked tool call after approval. Skill and MCP
  additions are requested through `request_skill_install`,
  `request_skill_proposal`, or `request_mcp_server` and become available after
  the next run materializes those capabilities.
- Browser state is scoped by agent plus conversation. Use `/status` or
  `gantry browser profiles` when a user asks which browser profile, cookies, or
  signed-in state an agent or job will use. Jobs created from a conversation use
  that conversation's browser profile and notify that conversation/thread.
- Use `request_skill_dependency_install` for dependency recipes found in a
  skill. Do not invoke package managers, download tools, archive extractors, or
  equivalent dependency commands from the agent.
- Use `request_skill_install` for provider refs such as
  `gantryhub:github-reviewer@1.2.0`. GantryHub verification is review context, not
  approval.

Channel rendering rules:

- Slack renders approvals and questions with Block Kit, buttons, radio buttons,
  checkboxes or multi-selects, modals for long details, and ephemeral denial for
  unauthorized users.
- Telegram renders concise HTML with inline keyboards. Multi-select toggles
  choices and requires `Done`; long details and file lists are paginated.
- Teams renders Adaptive Cards with `Action.Execute`. Single-select uses action
  buttons, multi-select uses `Input.ChoiceSet` plus Done, and approvals update
  the original card.
- Web/API renders the same interaction descriptor as cards, tables, modals,
  file browsers, and audit timelines.

Global options:

```bash
gantry --runtime-home <path> ...
gantry --help
```

## settings.yaml

Location: `<runtime home>/settings.yaml` (default `~/gantry/settings.yaml`).

`settings.yaml` controls runtime behavior: enabled channels, sender policies,
memory storage location, embedding behavior, dreaming, and memory LLM model
routing.

Local database lifecycle is not owned by Gantry. Use the root `docker-compose.yml` with `docker compose --env-file ~/gantry/.env up -d`, a locally installed Postgres, or hosted Postgres, then paste URLs during setup. Runtime connection state is stored in
`<runtime home>/data/local-postgres.json`. Do not put provisioning state,
container names, ports, or passwords in `settings.yaml`.

Current schema:

```yaml
channels:
  telegram:
    enabled: true
    sender_allowlist:
      default:
        allow: '*'
        mode: trigger
      agents: {}
      log_denied: true
  slack:
    enabled: false
    sender_allowlist:
      default:
        allow: '*'
        mode: trigger
      agents: {}
      log_denied: true
  teams:
    enabled: false
    sender_allowlist:
      default:
        allow: '*'
        mode: trigger
      agents: {}
      log_denied: true

storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: gantry

credential_broker:
  onecli:
    postgres:
      url_env: ONECLI_DATABASE_URL
      schema: onecli

memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
  llm:
    models:
      extractor: claude-haiku-4-5-20251001
      dreaming: claude-sonnet-4-6
      consolidation: claude-sonnet-4-6
```

Rules:

- At least one channel should be enabled for normal operation.
- Enabled channels require matching credentials in `.env`.
- Postgres is the only runtime store. `storage.postgres.url_env` names the `.env` key that contains the actual URL; by default that is `GANTRY_DATABASE_URL`.
- `GANTRY_DATABASE_URL` must point at a Postgres database with pgvector, full-text search support, and pg-boss initialized.
- OneCLI broker state uses the same database with a separate schema and database role. `credential_broker.onecli.postgres.url_env` names the `.env` key that contains that URL; by default that is `ONECLI_DATABASE_URL`.
- `ONECLI_DATABASE_URL` must include `schema=onecli`; OneCLI owns the `onecli` schema and Gantry must not query OneCLI-owned tables.
- `GANTRY_DATABASE_URL` and `ONECLI_DATABASE_URL` must use different Postgres users. A Prisma `schema` URL parameter is not a security boundary by itself.
- `SECRET_ENCRYPTION_KEY` is required for stateless OneCLI restarts. Treat it as a deployment secret, not runtime state.
- `memory.embeddings.provider` is currently `disabled` or `openai`; the settings
  shape is intentionally provider-extensible.
- External embedding providers require brokered Model Access. Do not put provider
  API keys in Gantry `.env`.
- Sender policy `allow` is `"*"` or a string array.
- Sender policy `mode` is `trigger` or `drop`.
- Memory records require `appId` and `agentId`; optional subject IDs
  (`userId`, `groupId`, `channelId`, `threadId`) define visibility.
- Direct/private agent conversations default explicit and automatic memory saves
  to user memory. Channel conversations, including Slack channels, Teams
  channels/chats, Telegram groups, and Telegram topics, default explicit and
  automatic memory saves to conversation memory.
- `common` memory is app-level shared context and must be written only by
  admin/service workflows.

## .env

Location: `<runtime home>/.env` (default `~/gantry/.env`).

Use `.env` for secrets and process-specific values. Do not use `.env` for normal
runtime behavior that belongs in `settings.yaml`.

Common keys:

```bash
TELEGRAM_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
TEAMS_CLIENT_ID=...
TEAMS_CLIENT_SECRET=...
TEAMS_TENANT_ID=...
GANTRY_DATABASE_URL=...
ONECLI_DATABASE_URL=...
SECRET_ENCRYPTION_KEY=<generated base64-encoded 32-byte secret>
GANTRY_IPC_AUTH_SECRET=...
CHROME_PATH=...
LOG_LEVEL=info
```

Use `gantry config list` to inspect configured keys. Use `gantry config get
<KEY> --raw` only when the raw value is required.

Credential broker mode, OneCLI gateway URL, model selection, and provider base
URLs belong in `settings.yaml`, not `.env`. Agent runners receive only
broker-safe model endpoint settings projected from typed runtime settings. Do
not pass proxy, certificate, raw provider key, database URL, or channel-token
values through Model Access.

## Direct Edit Workflow

When setting up local services for personal use:

1. Run `gantry local setup`.
2. Run `gantry local doctor`.
3. Confirm `.env` has `GANTRY_DATABASE_URL`, `ONECLI_DATABASE_URL`, and `SECRET_ENCRYPTION_KEY`; confirm the OneCLI URL is in `settings.yaml`.
4. Continue with `gantry setup` or restart with `gantry restart`.
5. Confirm with `gantry status`.

When switching to a shared hosted database:

1. Create one hosted Postgres database with `vector` and `pg_trgm`.
2. Create schemas `gantry`, `onecli`, and `pgboss`.
3. Create separate database users for Gantry and OneCLI and grant each only the schemas it owns or needs.
4. Set `GANTRY_DATABASE_URL` to the Gantry-role database URL.
5. Set `ONECLI_DATABASE_URL` to the OneCLI-role database URL with `schema=onecli`.
6. Set a stable high-entropy `SECRET_ENCRYPTION_KEY`.
7. Keep `settings.yaml storage.postgres.schema: gantry` and `credential_broker.onecli.postgres.schema: onecli`.
8. Run `gantry doctor`.
9. Restart with `gantry restart` or `gantry service restart`.

When repairing OneCLI broker persistence:

1. Run `gantry doctor`.
2. Check `ONECLI_DATABASE_URL` includes `schema=onecli`.
3. Check `SECRET_ENCRYPTION_KEY` is set and stable across restarts.
4. Confirm OneCLI is started with `DATABASE_URL` sourced from `ONECLI_DATABASE_URL`.
5. Run `gantry doctor` again.

When switching to hosted Postgres:

1. Create a hosted Postgres database that supports `vector` and `pg_trgm`.
2. Follow the shared hosted database workflow above.

When repairing database readiness:

1. Run `gantry local status`.
2. If using the provided Compose stack, run `docker compose logs --tail 160`.
3. Run `gantry local doctor`.
4. If hosted, fix extensions or credentials in the provider dashboard.
5. Run `gantry doctor` again.

When stopping the provided local Compose services:

```bash
docker compose stop
```

When changing runtime behavior:

1. Edit `<runtime home>/settings.yaml`.
2. Run `gantry doctor`.
3. Restart with `gantry restart` or `gantry service restart`.
4. Confirm with `gantry status`.

When changing credentials:

1. Use `gantry config set <KEY> <VALUE>` or edit `<runtime home>/.env`.
2. Run `gantry doctor`.
3. Restart with `gantry restart` or `gantry service restart`.
4. Confirm with `gantry status`.

## Runtime File Layout

```text
<runtime home>/
  settings.yaml
  .env
  data/
    local-postgres.json
    ipc/
    sessions/
    session-archives/
    browser-profiles/
  logs/
    gantry.log
    gantry.error.log
  artifacts/
    provider-sessions/
  skills/
    <skill-slug>/
      SKILL.md
      ...
  skill-drafts/
    <request-id>/
      <skill-slug>/
        SKILL.md
        ...
  agents/
    <agent-folder>/
```

## MCP Tools From Agent Sessions

Messaging and interaction:

- `mcp__gantry__send_message`
- `mcp__gantry__ask_user_question`

Capability requests:

- `mcp__gantry__request_skill_install`
- `mcp__gantry__request_skill_proposal`
- `mcp__gantry__request_skill_dependency_install`
- `mcp__gantry__request_mcp_server`
- `mcp__gantry__request_permission`

Service and agents:

- `mcp__gantry__service_restart`
- `mcp__gantry__register_agent`

Scheduler:

- `mcp__gantry__scheduler_upsert_job`
- `mcp__gantry__scheduler_get_job`
- `mcp__gantry__scheduler_list_jobs`
- `mcp__gantry__scheduler_update_job`
- `mcp__gantry__scheduler_delete_job`
- `mcp__gantry__scheduler_pause_job`
- `mcp__gantry__scheduler_resume_job`
- `mcp__gantry__scheduler_list_runs`
- `mcp__gantry__scheduler_list_events`
- `mcp__gantry__scheduler_wait_for_events`
- `mcp__gantry__scheduler_get_dead_letter`

Memory:

- `mcp__gantry__memory_search`
- `mcp__gantry__memory_save`
- `mcp__gantry__memory_patch`
- `mcp__gantry__memory_source_request`
- `mcp__gantry__memory_source_add`
- `mcp__gantry__memory_source_list`
- `mcp__gantry__memory_source_status`
- `mcp__gantry__memory_source_search`
- `mcp__gantry__memory_source_delete`
- `mcp__gantry__memory_source_ingest`
- `mcp__gantry__procedure_save`
- `mcp__gantry__procedure_patch`

Use Memory Source tools for URLs, files, pasted articles, docs, posts, and
other raw source material. `memory_save` is only for small explicit
preferences, decisions, facts, corrections, and constraints; source ingestion
stores evidence/chunks and stages reviewable candidates instead of writing
active memory directly.

Browser:

- `mcp__gantry__browser_status`
- `mcp__gantry__browser_open`
- `mcp__gantry__browser_inspect`
- `mcp__gantry__browser_act`
- `mcp__gantry__browser_close`

Gantry owns browser lifecycle for the current agent conversation's Chrome
profile. DM sessions, channel/group conversations, and jobs created from them
use separate profiles by default. The runtime installs `gantry-browser` into the
generated per-run Claude config and exposes Gantry-owned browser gateway tools
only when the canonical `Browser` capability is selected. Do not ask the user to
install browser skills or edit `.claude/skills` manually.

## Scheduler Usage

The scheduler supports exactly three schedule types:

- `cron`: cron expression in `schedule_value`, for recurring calendar schedules.
- `interval`: positive millisecond interval in `schedule_value`.
- `once`: ISO timestamp in `schedule_value`, for a one-shot run.

For immediate execution, create or update the job as `once` with an ISO
timestamp that is due now.

Create or update:

```text
mcp__gantry__scheduler_upsert_job(
  job_id?: string,
  name: string,
  prompt: string,
  model?: string,
  schedule_type: "cron" | "interval" | "once",
  schedule_value: string,
  linked_sessions?: string[],
  deliver_to?: string[],
  thread_id?: string,
  silent?: boolean,
  cleanup_after_ms?: number,
  channel_scope?: string,
  timeout_ms?: number,
  max_retries?: number,
  retry_backoff_ms?: number,
  max_consecutive_failures?: number
)
```

Update mutable fields:

```text
mcp__gantry__scheduler_update_job(
  job_id: string,
  name?: string,
  prompt?: string,
  model?: string,
  schedule_type?: "cron" | "interval" | "once",
  schedule_value?: string,
  linked_sessions?: string[],
  deliver_to?: string[],
  thread_id?: string,
  silent?: boolean,
  cleanup_after_ms?: number,
  channel_scope?: string,
  timeout_ms?: number,
  max_retries?: number,
  retry_backoff_ms?: number,
  max_consecutive_failures?: number
)
```

Thread behavior:

- New scheduler jobs created from a Slack thread or Telegram topic default to that current thread/topic.
- Scheduler updates do not retarget an existing job unless `thread_id` is explicitly supplied.
- `thread_id` may only be the current thread/topic for the active agent run; arbitrary cross-thread retargeting is rejected.

Operational controls:

```text
mcp__gantry__scheduler_pause_job(job_id: string)
mcp__gantry__scheduler_resume_job(job_id: string)
mcp__gantry__scheduler_delete_job(job_id: string)
mcp__gantry__scheduler_get_job(job_id: string)
mcp__gantry__scheduler_list_jobs(statuses?: string[], channel_scope?: string)
mcp__gantry__scheduler_list_runs(job_id?: string, limit?: number)
mcp__gantry__scheduler_list_events(job_id?: string, run_id?: string, event_type?: string, since_id?: number, since?: string, limit?: number)
mcp__gantry__scheduler_wait_for_events(job_id?: string, run_id?: string, event_type?: string, since_id?: number, since?: string, limit?: number, timeout_ms?: number)
mcp__gantry__scheduler_get_dead_letter(limit?: number)
```

Scheduler tool arguments use the MCP schema names shown above. The host runtime
converts them into its internal IPC request shape.

## Common Workflows

Onboard a Telegram channel and bind an agent:

```bash
gantry channel onboard telegram --external-id -1001234567890 --title "Team Chat"
gantry channel agents <channelId> --agents <agentId> --default <agentId>
gantry service restart
```

Set agent DM allowlist and DM approval admin:

```bash
gantry agent dm-access <agentId> --provider telegram --allow 5759865942,123456789 --admin 5759865942
gantry service restart
```

Set conversation approvers:

```bash
gantry conversation approvers <conversationId> --allow 5759865942,123456789
gantry service restart
```

Enable Telegram:

```bash
gantry channel connect telegram
gantry channel onboard telegram --external-id <chat-id> --title <name>
gantry channel agents <channelId> --agents <agentId> --default <agentId>
gantry service restart
```

Enable Slack:

```bash
gantry channel connect slack
gantry channel onboard slack --external-id <channel-id> --title <name>
gantry channel agents <channelId> --agents <agentId> --default <agentId>
gantry service restart
```

Enable Teams:

```bash
gantry channel connect teams
gantry channel onboard teams --external-id <conversation-id> --title <name>
gantry channel agents <channelId> --agents <agentId> --default <agentId>
gantry service restart
```

Teams setup notes:

- Teams credentials are runtime secrets resolved through `RuntimeSecretProvider`
  and must not be passed to agent runners.
- Teams conversations use `teams:` provider conversation ids as channel metadata.
- Teams channel approvals must preserve tenant, conversation, and
  reply-chain/thread identity for same-channel checks.
- Teams approval cards use Adaptive Card `Action.Execute`; do not ask the agent
  to call Microsoft Graph or Teams SDK APIs directly for capability approval.

External embedding providers are not enabled through Gantry `.env`. Keep
embeddings off unless brokered embedding-provider support has been configured
through Model Access.

Disable embeddings:

```bash
gantry memory embeddings off
gantry service restart
```

Turn dreaming on or off:

```bash
gantry memory dreaming on
gantry memory dreaming off
gantry service restart
```

Check health:

```bash
gantry doctor
gantry status
gantry memory status
gantry memory health journal-status
```

Restart from an agent session:

```text
mcp__gantry__service_restart()
```

Restart from the host:

```bash
gantry service restart
```

## Troubleshooting

If messages are not processed:

1. Run `gantry status`.
2. Run `gantry doctor`.
3. Check `~/gantry/logs/gantry.log` and `~/gantry/logs/gantry.error.log`.
4. Check that the channel is enabled in `settings.yaml`.
5. Check that matching credentials exist in `.env`.
6. Check `gantry agent list`.
7. Check `gantry conversation info <conversationId>`, `gantry agent dm-access <agentId>`, and `gantry conversation approvers <conversationId>`.
8. Restart with `gantry service restart`.

If scheduler jobs do not run:

1. Use `mcp__gantry__scheduler_list_jobs`.
2. Confirm `schedule_type` is `cron`, `interval`, or `once`.
3. Confirm `schedule_value` is valid for the schedule type.
4. Check `mcp__gantry__scheduler_list_events`.
5. Check `mcp__gantry__scheduler_list_runs`.
6. Check `mcp__gantry__scheduler_get_dead_letter`.
7. Restart with `mcp__gantry__service_restart` if configuration changed.
