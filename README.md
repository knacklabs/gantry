<p align="center">
  <strong>Gantry</strong> — The enterprise agent runtime by CAW.
</p>
<p align="center">
  A gantry holds a rocket upright, fuels it, runs diagnostics, and swings away at launch.<br/>
  It does everything <em>except</em> fly — it exists so the rocket can.<br/><br/>
  What a gantry is to a rocket, <strong>Gantry</strong> is to an AI agent.
</p>

<p align="center">
  <img src="docs/assets/gantry-readme-hero.png" alt="A launch gantry supporting an AI agent capsule with diagnostics, cables, storage, and control systems" width="100%" />
</p>

---

## What Gantry Is

Gantry is an enterprise-grade agent runtime: the host process that gives AI agents a controlled place to run, people or applications to respond to, tools to use, durable memory, and an immutable audit trail. It is not a chatbot. It is not an LLM wrapper. It is not a workflow engine.

The runtime sits between five worlds and brokers work between them:

- **Human chat surfaces** — Slack, Microsoft Teams, Telegram, plus a first-class web/SDK channel for in-product chat.
- **Customer applications** — backend services (NestJS, Next.js, workers) that embed Gantry through the SDK.
- **Signed application events** — external systems (CRMs, monitoring tools, schedulers) that push work in through scoped ingress credentials.
- **Approved business tools** — internal APIs, databases behind approved connectors, browser automation, CRM tools, and MCP-connected services.
- **Durable foundation** — Postgres-backed runtime state, secret providers, artifacts, and audit records.

Three abstractions make the runtime composable: **stateless agents** as versioned configurations, **scoped memory** tied to app/agent/conversation context, and a **flexible interaction surface** where the same runtime can serve realtime chat, async jobs, and application action requests.

Gantry is distributed as an obfuscated npm package through [CAW's GitHub Package Registry](https://github.com/orgs/AventCaw/packages). Client deployments pull the package and run it with their agent prompt configurations.

## Quick Start

```bash
npm i -g @caw/gantry
gantry
```

The package is private. If a deployment host cannot access CAW's package
registry, clone this repository on the host, run `npm ci && npm run build`, and
use the built CLI entrypoint from that checkout instead of a global npm install.

The first run is a guided CLI flow with a single path: runtime home, database, model access, channel connection, agent, conversation binding, then final doctor verification before the ready screen. Memory, the background service, and extra providers are optional and configured after the runtime is ready.

### NPM Install First-Run Flow

```bash
npm i -g @caw/gantry
gantry
```

Then follow this order:

1. Run `gantry` with no args and confirm the runtime home (default `~/gantry`).
2. Choose `Use local Postgres URL` if you started the provided Compose stack, or choose hosted/existing Postgres and paste those URLs.
3. Connect Model Access once for agent, subagent, and scheduled job model calls. Gantry stores provider keys in encrypted Postgres rows and projects only loopback gateway tokens to the model SDK; agents select catalog model aliases and never receive database URLs or raw provider credentials.
4. Choose your first channel (`Telegram` or `Slack`).
5. Choose the default agent name, main model alias, and agent harness. Anthropic defaults to `opus`; OpenRouter defaults to `kimi`. `agent_harness` accepts `auto`, `anthropic_sdk`, or `deepagents`; `auto` preserves provider-derived behavior.
6. Follow the in-CLI channel guide, paste channel credentials, and pick a discovered Conversation. Channel IDs and runtime folders stay internal.
7. Review the summary and choose `Create Runtime`; before this point Back, Resume Later, and Cancel are transactional. Setup writes config, binds that Conversation to the default Agent, and runs final doctor verification.
8. On the ready screen, finish setup (the default exits cleanly) or choose `Start Gantry now` to begin listening immediately.

Optional, post-ready: memory is on by default (`gantry memory ...` to adjust), install a background service with `gantry service install`, and add more providers with `gantry provider connect`.

### Linux Host Prerequisites

For Ubuntu EC2 and other Linux hosts, install the runtime prerequisites before
building or starting Gantry:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git libatomic1 bubblewrap socat ripgrep
```

Use Node `>=24 <26`. On small instances, add swap and build with a larger Node
heap if TypeScript runs out of memory:

```bash
export NODE_OPTIONS=--max-old-space-size=1536
npm run build
```

`sandbox_runtime` requires `bubblewrap`, `socat`, and `ripgrep`; `gantry doctor`
fails closed when they are missing. `libatomic1` is required by newer Node
Linux binaries on some minimal images.

### CLI Commands

```bash
gantry
gantry setup
gantry doctor
gantry status
gantry start
gantry stop
gantry restart
gantry logs
gantry local setup|start|stop|status|logs|doctor
gantry model list
gantry model status
gantry model chat|jobs|memory
gantry model use-preset anthropic|openrouter
gantry model set chat <alias>
gantry model set jobs inherit|<alias>
gantry model reset chat|jobs|memory
gantry model why chat [group-scope|conversation-id]
gantry model why jobs|memory|job <id>
gantry model doctor
gantry credentials model status|set|rotate|disable|doctor
gantry credentials access list|set|import-env|unset
gantry credentials browser status
gantry provider connect telegram
gantry provider connect slack
gantry provider connect discord
gantry provider connect teams
gantry provider list
gantry provider doctor
gantry conversation approvers <conversation-id> [--allow <userId,userId>]
gantry agent list
gantry agent add <jid|chat-id> [--name <name>]
gantry agent access show <jid|folder>
gantry agent access apply <jid|folder> --file <path|->
gantry settings validate
gantry service install|start|stop|restart
```

### Sandbox Modes

`runtime.sandbox.provider` is the only v1 execution-mode setting.

- `direct`: easiest personal laptop setup; compatibility mode with no outer OS sandbox.
- `sandbox_runtime`: recommended for organisation or safe-host use; wraps runner work in the enforcing OS sandbox when `gantry doctor` confirms support.
- Docker or cloud sandboxes are future optional backends, not required for v1.

Browser stays host-managed through Gantry IPC. Stdio MCP servers, local CLIs, skills, jobs, and native subagents follow the configured sandbox provider. The sandbox does not install tools: missing CLI or MCP dependencies are setup blockers, not permission grants. In `sandbox_runtime`, networked tools must use standard proxy-aware clients (`HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`); tools that bypass those proxies fail closed.

To switch modes, edit `~/gantry/settings.yaml`:

```yaml
runtime:
  sandbox:
    provider: sandbox_runtime
```

Then verify and restart:

```bash
gantry settings validate
gantry service restart
gantry doctor
gantry status
```

Defaults in v1:

- runtime home: `~/gantry`
- runtime settings file: `~/gantry/settings.yaml` (validated before `start`/`restart`)
- setup flow: guided multi-channel first run (choose Telegram or Slack)
- storage: Postgres through `GANTRY_DATABASE_URL`; guided setup validates URLs but does not create Docker containers
- memory: on
- embeddings: off by default; external embedding providers require brokered Model Access and are not configured through Gantry `.env`
- dreaming: on by default; disable with `gantry memory dreaming off`
- provider connections, conversations, bindings, and conversation approvers live under `providers`, `provider_connections`, `conversations`, and `bindings` in `settings.yaml`
- conversation approvers approve direct/private and group/channel actions only when listed on that conversation and currently a member
- the same agent can be bound across providers, but admin user ids stay provider-scoped: Slack approvers are Slack member ids and Teams approvers are Teams user ids

Runtime home is a single-cut contract. Gantry reads `~/gantry` by default unless `--runtime-home` or `GANTRY_HOME` is set.

Human-editable runtime settings live in `~/gantry/settings.yaml`. Validate edits with `gantry settings validate`; it performs strict schema parsing without requiring Postgres, provider credentials, or runtime preflight checks. The common shape is compact and only includes values users normally change:

```yaml
defaults:
  name: Default Agent
  model: opus
  jobs:
    one_time_model: haiku
    recurring_model: sonnet

providers:
  telegram:
    enabled: true
    bot_token_env: TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: Default Agent
    persona: generalist
    access:
      sources:
        skills: []
        mcp_servers: []
      selections:
        - id: browser.use
          version: builtin

memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  dreaming:
    enabled: true

permissions:
  yolo_mode:
    enabled: true
    denylist:
      - npm run nuke
    denylist_paths:
      - /opt/danger/*
  egress:
    denylist:
      - '*.blocked.example.com'

conversations:
  main_dm:
    provider: telegram
    id: '5759865942'
    type: dm
    approvers: ['5759865942']
    agent: main_agent
    trigger: '@Default Agent'
```

### Settings Ownership

`settings.yaml` is desired state. Users and admins may edit it directly, but
the safer path is setup, local CLI commands, Control API admin calls, or the
reviewed Gantry MCP settings tools. Agents do not mutate it by themselves; they
can request reviewed changes, and Gantry writes the file only after the
appropriate user/admin approval.

| Setting area                                                    | Who changes it                              | Purpose                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults`                                                      | User/admin                                  | Global agent name, default model, and job model defaults.                                                                                                                       |
| `providers`                                                     | Setup or user/admin                         | Enable channel providers and point them at runtime secret env refs.                                                                                                             |
| `provider_connections`                                          | Setup or advanced user/admin                | Explicit workspace/bot/tenant/provider connection records when compact provider settings are not enough.                                                                        |
| `conversations`                                                 | Setup or user/admin                         | Conversation ids, display names, sender policy, approvers, bound agent, trigger, and per-conversation model override.                                                           |
| `bindings`                                                      | Advanced user/admin                         | Explicit route bindings when one compact `conversations.<id>.agent` field is not expressive enough.                                                                             |
| `agents.<id>.name`, `persona`, `model`, `jobs`, `agent_harness` | User/admin                                  | Agent identity, default model, job model, and harness behavior.                                                                                                                 |
| `agents.<id>.access.sources`                                    | User/admin or approved install/connect flow | Attached inventory such as skills, MCP servers, built-ins, adapters, and local CLIs. Sources are not authority.                                                                 |
| `agents.<id>.access.selections`                                 | User/admin or approved access flow          | Durable allowed capability ids and versions. Agents request reviewed capability ids with `request_access target.kind=capability`; scoped `RunCommand` is the only raw fallback. |
| `memory`                                                        | User/admin                                  | Memory, embeddings, dreaming, LLM, and maintenance settings.                                                                                                                    |
| `permissions`                                                   | User/admin                                  | YOLO-mode denylist additions and egress hostname denylist.                                                                                                                      |
| `browser`                                                       | User/admin                                  | Browser usage policy and per-site limits.                                                                                                                                       |
| `runtime.queue`                                                 | User/admin                                  | Runtime concurrency and retry tuning. Restart after changing it.                                                                                                                |
| `storage`                                                       | Advanced user/admin                         | Postgres URL env key and schema. Secrets stay in `.env` or credential stores.                                                                                                   |
| `model_access`                                                  | Advanced user/admin                         | Gantry model gateway enablement and loopback bind host. Model provider credentials stay in Credential Center.                                                                   |
| `desired_state`                                                 | Admin/export flow                           | Reconcile/export mode switch for settings-owned desired state.                                                                                                                  |

Optional runtime queue tuning:

```yaml
runtime:
  queue:
    max_message_runs: 3
    max_job_runs: 4
    max_retries: 5
    base_retry_ms: 5000
```

Do not put runtime facts in `settings.yaml`: message history, job runs, audit
events, memory records, generated runtime directories, artifact hashes,
Postgres projection rows, raw provider secrets, and capability secret values
belong in their runtime stores.

For the same agent across Slack and Teams, configure approvers on each conversation:

```yaml
agents:
  main_agent:
    name: Default Agent

conversations:
  sales_slack:
    provider: slack
    id: 'C123'
    type: channel
    approvers: ['U123']
    agent: main_agent

  sales_teams:
    provider: teams
    id: '19:channel@thread.tacv2'
    type: channel
    approvers: ['8:orgid:abc']
    agent: main_agent
```

Advanced storage and credential broker overrides stay supported, but setup keeps them out of `settings.yaml` unless you change them from defaults.

Gantry uses Postgres for runtime state, jobs, events, memory, semantic search, lexical search, and encrypted model credentials. Runtime readiness expects `pgvector`, `pg_trgm`, and `pg-boss` schema readiness. The supported deployment model is one database role and schema for Gantry runtime state, plus pg-boss internals.

No Postgres or Model Access service installed? Use the provided Compose file, then paste the resulting URLs during setup:

```bash
docker compose --env-file ~/gantry/.env up -d
gantry setup
```

On WSL/Docker Desktop amd64 hosts, use the additive WSL override instead of
editing the default Compose file:

```bash
docker compose --env-file ~/gantry/.env -f docker-compose.yml -f docker-compose.wsl.yml up -d
```

The WSL override keeps the repo default unchanged, uses the multi-platform
Postgres image tag, and keeps the default Postgres host port `5432`. If another
local Postgres is already using that port, stop it before starting the Gantry
Compose stack. For example, on a systemd-enabled WSL distro:

```bash
sudo systemctl stop postgresql
```

Then keep the runtime URLs pointed at the default host port:

```env
GANTRY_DATABASE_URL=postgresql://gantry_app:gantry_app_password@127.0.0.1:5432/gantry?schema=gantry
SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-secret>
```

The Compose file hardcodes the local ports, schema names, and non-secret role names. `~/gantry/.env` only needs local passwords, `SECRET_ENCRYPTION_KEY`, and the runtime connection URL. Gantry setup does not start Docker or create containers; it asks for `GANTRY_DATABASE_URL`, enables `model_access`, and uses encrypted Postgres model credential rows for Model Access.

Gantry intentionally does not expose a destructive database-reset command in the runtime CLI. If you need to start over during development, stop Gantry, reset your local Postgres outside the agent-facing CLI, then run `gantry provider connect telegram` or `gantry provider connect slack` to re-register chats.

For hosted Postgres, use Neon, Supabase, or another provider that supports
`vector` and `pg_trgm`, then paste the Gantry-role URL with `sslmode=require`
during setup.

Hosted Postgres checklist:

1. Use a database endpoint reachable from the host. On IPv4-only EC2 hosts,
   prefer your provider's IPv4-capable pooler endpoint if the direct database
   hostname resolves only to IPv6.
2. Enable required extensions in the target database:

   ```sql
   create extension if not exists vector;
   create extension if not exists pg_trgm;
   create extension if not exists pgcrypto with schema public;
   ```

3. Create a runtime role and schema owned by that role. Keep Gantry runtime
   tables and pg-boss internals in schemas that the runtime role can create,
   read, write, and migrate:

   ```sql
   create role gantry_app login password '<strong-password>';
   create schema if not exists gantry authorization gantry_app;
   create schema if not exists pgboss authorization gantry_app;
   grant connect on database postgres to gantry_app;
   grant usage, create on schema gantry to gantry_app;
   grant usage, create on schema pgboss to gantry_app;
   ```

4. Use the runtime role URL with an explicit schema and SSL mode:

   ```env
   GANTRY_DATABASE_URL=postgresql://gantry_app:<password>@<host>:5432/postgres?schema=gantry&sslmode=require
   ```

5. If Node reports `self-signed certificate in certificate chain`, install the
   provider CA bundle on the host and point Gantry at it:

   ```env
   NODE_EXTRA_CA_CERTS=/home/ubuntu/gantry/certs/provider-root-ca.pem
   ```

If the deployment contains another Gantry-adjacent service that also uses the
same hosted Postgres database, give that service a separate database role and
schema. Do not reuse the Gantry runtime role for independent services.

### Provider And Conversation Setup

Gantry supports multiple providers. You can connect Telegram, Slack, Discord, or Teams and then bind an agent into a conversation:

```bash
gantry provider connect telegram
gantry provider connect slack
gantry provider connect discord
gantry provider connect teams
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN`; create it in Telegram by chatting with `@BotFather` and sending `/newbot`.
- For Telegram groups, add the bot to the group and send a message before discovery; if Gantry must see every group message, make the bot an admin or disable Group Privacy in BotFather with `/setprivacy`.
- `gantry provider connect telegram` auto-discovers recent chats and can register one without manual chat ID copy/paste. The human sender from the selected discovery message is added as a conversation approver, so `/new`, `/model`, `/dream`, and `/memory-status` work immediately.
- Telegram registers `/gantry` for command discovery. Direct `/stop` and `!stop` remain the fast stop path, and active progress messages include a Stop action where Telegram supports inline callbacks. Approval prompts stay in the originating conversation today so restart recovery can still resolve the pending interaction.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`); create a Slack app, add a bot user/scopes, enable Socket Mode, generate the app-level token, install/reinstall the app, then invite it to the target channel or DM it once.
- Slack bot scopes for normal channel and DM operation are: `chat:write`, `app_mentions:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, and `mpim:history`. Reinstall the Slack app after any scope change.
- For Slack DMs, open the Slack app configuration, go to App Home, enable the Messages Tab, and enable the setting that lets users send messages from the messages tab. Without this, Slack can show "Sending messages to this app has been turned off" even when Socket Mode is connected.
- `gantry provider connect slack` auto-discovers accessible conversations and can register one directly.
- Slack registers `/gantry` for command discovery. Direct `/stop` and `!stop` remain the fast stop path, and active progress messages include a Stop action.
- Slack tool permission approvals are deny-by-default until approvers are listed on the target conversation in `settings.yaml`. Guided setup asks for comma-separated Slack member IDs like `U0123456789`; these users must be members of that conversation to approve tool permissions and answer interactive prompts. Gantry sends approval prompts ephemerally to configured approvers when Slack accepts that surface and falls back to the conversation prompt otherwise.
- Slack UX uses native Slack surfaces: threads, streaming updates, ephemeral prompts, and actions.
- Discord setup uses `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID`, discovers guild text channels through Discord REST, registers `dc:` conversation IDs plus a guild `/gantry` command, and runs the Discord Gateway/REST transport for live messages and Stop actions.
- Teams setup uses Microsoft Teams app auth through `RuntimeSecretProvider` (`TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`), discovers Teams channels through Microsoft Graph, and registers `teams:` conversation IDs. Live Teams message transport remains behind the `TeamsSdkClient` adapter seam; this checkout includes tested normalization and Adaptive Card approval scaffolding, but not a concrete Bot Framework transport.

### Capability Management

Skills, MCP servers, SDK tools, host tools, browser tools, local CLIs, and channel-native tools are approved agent capabilities. Normal agent guidance is action-first: use an available action, request the reviewed capability when the action is missing, and request source setup only when the underlying source is not connected. Agents must not run dependency install commands, edit provider skill folders, edit `.mcp.json`, edit settings, or mutate generated provider config directly. Gantry keeps the source-specific tools below as reviewed setup/proxy surfaces, not as durable authority by themselves:

- `send_message`
- `ask_user_question`
- `continuity_summary`
- `file`
- `request_skill_install`
- `request_skill_proposal`
- `request_skill_dependency_install`
- `request_mcp_server`
- `request_access`
- `mcp_list_tools`
- `mcp_describe_tool`
- `mcp_call_tool`
- `settings_desired_state`
- `request_settings_update`
- `admin_permission_list`
- `admin_permission_revoke`
- `service_restart`
- `register_agent`

Capability changes follow a strict lifecycle: **request → review → approval or cancellation → durable audit → new config version → next-run activation**. Durable semantic capability changes use `request_access target.kind=capability` with reviewed capability ids from the agent access summary. `request_access target.kind=run_command` is the only raw fallback and must be scoped to an exact command pattern. Interactive fallback permission prompts present simple decisions: `Allow once`, `Allow 5 min`, `Always allow`, or `Cancel`. Privileged admin tools such as `settings_desired_state`, `request_settings_update`, `admin_permission_list`, `admin_permission_revoke`, `service_restart`, and `register_agent` require exact selected capabilities.

Persistent agent authority is visible in `settings.yaml` under `agents.<id>.access.selections` as readable capability ids and immutable versions, such as `browser.use`. Agent attachments live separately under `agents.<id>.access.sources`; sources can attach skills, MCP servers, built-in tools, adapters, or local CLIs, but do not create execution authority by themselves.

Durable SDK and host tool grants use Gantry names, not provider-native harness names. Exact web, file, and delegation facades are `WebSearch`, `WebRead`, `FileSearch`, `FileRead`, `FileEdit`, `FileWrite`, and `AgentDelegation`; command access is a scoped `RunCommand(<argv pattern>)` rule. Provider-native names such as `Read`, `Write`, `Edit`, `WebFetch`, `Bash`, and `Agent` are adapter projections and are rejected as persistent Gantry authority.

Browser authority is selected in `settings.yaml` and the public capabilities API as `browser.use`, then translated to the canonical runtime `Browser` tool rule. When selected, the runtime projects it to Gantry-owned gateway tools: `browser_status`, `browser_open`, `browser_inspect`, `browser_act`, and `browser_close`. `browser_act` includes `action: "file_attach"` for upload inputs and accepts `bytes`, Gantry `artifact`, or allowlisted `path` sources through host-owned staging.

Jobs are scheduled agent runs and inherit the target agent's selected capabilities and attached sources at execution time. Job `accessRequirements` entries are readiness and preflight assertions, not job-local authority. The canonical `toolAccess` view in MCP, CLI, SDK, and Control API responses shows the inherited agent capability projection. Skill source is stored as readable skill folders with `SKILL.md` plus supporting files; Postgres stores metadata, source type, hash, binding, and audit records. Skills installed from catalogs, URLs, CLI commands, or uploads all become the same reviewed local skill package after approval.

Capability-owned secrets for selected skills and MCP servers use Gantry Credential Center rather than runtime `.env` or model credentials. From the host/admin shell, use `gantry credentials access set <NAME>`, `gantry credentials access import-env <NAME>`, `gantry credentials access list`, and `gantry credentials access unset <NAME>`; add `--allow <capabilityId>` to scope a secret to a specific MCP definition, `mcp:<name>`, skill id, or `skill:<name>`. Agents should report missing credentials as setup blockers, not run the credential CLI themselves.

`permissions.yolo_mode` controls the denylist applied only to the 5-minute
all-tools timed grant. Gantry ships defaults for destructive commands such as
`sudo *`, `rm -rf /`, force-pushes to `main` or `master`, fork bombs, and
protected system paths such as `/etc/*`, `/System/*`, `/usr/*`, `/bin/*`, and
`/sbin/*`. User `denylist` and `denylist_paths` entries are additive and merge
with those shipped defaults. When a denylist rule matches during an active timed
grant, Gantry skips the bypass, records an audit event, and shows the normal
permission prompt with the matched rule. Set `enabled: false` only when YOLO
mode should be total. Edit the value directly in `settings.yaml`, through
local CLI settings commands, or via the reviewed `settings_desired_state` /
`request_settings_update` admin tools. The typed `/v1/settings` API is
read-only.

## Design Principles

Gantry was designed from the ground up as infrastructure for enterprise AI deployments. Every design decision follows from one belief: **agents that operate inside a business need the same operational discipline as the business itself.**

- **Security-first.** Every conversation is its own security perimeter. Every tool call passes through a two-axis gate: who is asking, and what is being asked. Agents cannot grant themselves approval.
- **Stateless agents.** An agent is a versioned configuration, not a running process. The runtime spawns a fresh runner, executes work, and tears down. No hidden state drifting between runs. Capability changes are config changes, not model rewrites.
- **Scoped memory, not a shared brain.** Memory is keyed to app, agent, and subject. The runtime physically cannot return records across boundaries. Privacy is enforced at the data layer, not asked nicely of the prompt.
- **Composable, not monolithic.** Skills over core bloat. Reusable capabilities are delivered as skills or narrowly scoped packages, not piled into the default runtime.
- **Observable.** Every action — tool calls, approvals, memory promotions, config changes — is audit-logged. The answer to "why did the agent do that?" is always traceable.
- **Provider-neutral.** One agent definition works across Slack, Teams, Telegram, and in-product SDK channels. The team writes the agent once.
- **Embeddable.** Gantry is a runtime, not a SaaS product. The SDK gives product teams one mental model, one auth model, and one set of contracts.

## What It Supports

- Multi-channel messaging (Slack, Teams, Telegram, Web/SDK)
- Per-conversation security perimeters with approval flows
- Stateless versioned agent configurations
- Scoped, auditable memory with dreaming lifecycle
- Scheduled and triggered async jobs
- Web access and browser automation
- MCP server integration with per-tool allowlists
- Signed external ingress for third-party system events
- Outbound webhooks with HMAC-signed delivery
- Host runtime execution
- Skill-driven extensions and provider connections

## Memory And Continuity

Memory stores durable knowledge the agent should retain across sessions:

- preferences
- decisions
- facts
- corrections
- constraints
- reusable procedures

Each memory record is scoped by `appId`, `agentId`, and subject (`user`, `group`, `channel`, `conversation`, or `common`). The runtime enforces these boundaries at the data layer — cross-boundary leakage is structurally impossible, not just policy-discouraged.

Continuity is explicit runtime resume/current-work state. Durable memory is separate and is retrieved only when it matches the current query:

- canonical session digests and current-work evidence
- query-relevant remembered facts
- query-relevant prior decisions
- user/group preferences that match the current request
- open loops once commitment tracking is enabled
- dream status (enabled/schedule/last run outcome)

Embeddings are off by default. Memory search and context injection work without embeddings through lexical search and keyword fallback. When embeddings are enabled and backfilled, recall uses hybrid lexical plus pgvector ranking with lexical fallback if query embedding is unavailable, paused, or over its live deadline.

Host runtime injects a digest-first memory context block when a fresh chat runner or scheduled job starts: recent session digests (when persisted), then active durable memory items. Follow-up chat messages continue through the same live Claude SDK stream while the runner is alive, so Gantry does not replay raw message history or run logs into every prompt. The memory block is sent as structured untrusted data with a system-level boundary policy that forbids treating memory records as instructions or tool-use authority.

Automatic boundaries such as `/new`, manual `/compact`, and observed SDK compact boundaries capture continuation digests and extraction evidence. `/new` resets scoped provider-session state first and finalizes the previous session's digest in the background, so a slow extractor cannot block starting fresh. Durable memory auto-promotion remains dreaming-only.

### Memory Dreaming

Background dreaming cycles turn raw conversational evidence into curated, high-confidence durable memory. Three stages run in sequence:

1. **Light Sleep** — sweeps recent evidence (messages, tool outputs, user corrections) and proposes candidate memories. Candidates start staged; they are not yet durable.
2. **REM** — cross-checks candidates against existing memory and flags contradictions. If the user said X yesterday and not-X today, the conflict is surfaced rather than silently overwritten.
3. **Deep Sleep** — high-confidence candidates promoted to durable memory. Low-confidence or contradicted candidates held back. Duplicates merged. Obsolete facts retired. Destructive changes are policy-gated.

Embedding work runs during dreaming promotion/update passes and the resumable embedding backfill. Runtime recall and context injection use active memory items through full-text (lexical plus keyword) search by default; semantic recall is layered in as an optional enhancement only when embeddings are enabled and indexed, and falls back to full-text if a query embedding is unavailable, paused, or over its live deadline.

### Memory Boundaries

- `appId` and `agentId` are mandatory for every memory record.
- Direct/private agent conversations default to user memory. Channel conversations, including Slack channels, Teams channels/chats, Telegram groups, and Telegram topics, default to conversation memory.
- `user`, `group`, and `channel` subjects isolate application, team, and channel context.
- `common` is app-wide shared memory and is write-restricted to admin/service flows.
- `threadId` narrows recall without crossing app, agent, user, group, or channel boundaries.

Runtime state and memory records are stored in Postgres through `GANTRY_DATABASE_URL`.
See [docs/MEMORY.md](docs/MEMORY.md) for the app developer memory model and dreaming lifecycle.

## Three Interaction Patterns

Gantry supports three product patterns. They are not alternatives; most real products use all three, and they share the same agent runtime, memory, policy, and event model.

1. **Realtime chat through a trusted product backend.** A user types in a chat UI; the customer's backend opens a session, sends the message, and streams the agent's response back over Server-Sent Events.
2. **Async jobs from schedules or external systems.** A schedule, CRM, monitoring tool, or backend service fires a scoped request that triggers a job. The caller can get a trigger ID immediately, wait through the SDK, or rely on a configured webhook when the result is ready.
3. **Application action requests.** A product sends a plain-language instruction such as "draft a follow-up for this lead" or "summarize the last 24 hours of incidents." The agent acts through approved tools, within the selected capability and policy boundary.

All three patterns hit the same security gate, the same scoped memory, and the same audit trail.

## SDK And Integration

Backend apps can use `@caw/gantry-sdk` to ensure a session, send a message, and wait or stream durable runtime events. Normal SDK calls derive `appId` from the API key; request-body `appId` is only an optional assertion.

The runtime also serves Swagger docs for the Control API. Use `/docs` for the
interactive view and `/openapi.json` for the machine-readable spec when the
control server is exposed over `GANTRY_CONTROL_PORT`. TCP binding defaults to
loopback; set `GANTRY_CONTROL_HOST=0.0.0.0` only for an authenticated hosted
deployment such as Render.

External systems that should not hold a control API key use signed external ingress records under `/v1/ingresses`. Ingress supports app/API session messages, provider-neutral conversation messages, existing job triggers, and constrained one-time job templates. `conversation_message` targets use Gantry `conversationId` and optional `threadId` values from the Conversations API, then Gantry resolves provider routing internally. Each ingress record has an explicit target policy, so its secret only authorizes configured sessions, conversations, jobs, or templates. `/v1/webhooks` remains outbound callback delivery for runtime events.

## Runtime

Gantry currently supports a single runtime mode: host execution.
Use `npm run dev` for local development and `npm start` for production start.

Gantry deploys three ways from one image — **workstation** (single machine),
**fleet** (role-differentiated pools behind an ALB), and the **locked support
stack**. In a fleet, the deployment-owned env `GANTRY_PROCESS_ROLE` selects what a
process runs: `control` (admin/settings API), `live-worker` (distributed live
chat execution), or `job-worker` (scheduler + bakes); `all` (the workstation
default) does everything. See
[deployment profiles](docs/architecture/deployment-profiles.md) and the
[AWS Terraform runbook](docs/deployment/aws-terraform.md).

## Client Deployment Model

Gantry is published as an obfuscated and minified npm package on CAW's GitHub Package Registry.

Client agent projects follow the naming convention `<Client>.<Project>.Agent` (e.g., `Hunger.Boondi.Agent`, `Flamingo.Operon.Agent`, `Manipal.Tender.Agent`). These are monorepos. If the agent includes a web interface (e.g., Manipal's Tender CoPilot, Operon Contact Center), the web app and backend live in the same repo.

Inside each monorepo, the `apps/` folder contains the agent prompt folder(s) — the persona, skills, and configuration that define the agent's behavior.

The deployment pipeline pulls Gantry from the private package registry onto an EC2 instance or VM and runs it with the client's prompt configurations.

### Capcom (Control Panel)

Capcom is the mission control web application for managing Gantry agents. It provides observability, cost tracking, prompt tuning, and configuration management from a single pane.

Capcom can be deployed co-located on the same machine as the agent (single-agent enterprise deployment) or as a standalone instance managing multiple Gantry deployments from one interface.

## Repository Development

Use this only when you are working on the Gantry source code:

```bash
git clone https://github.com/AventCaw/Agent.Gantry.git
cd Agent.Gantry
npm install
npm run build
npm link
gantry status
```

`npm link` exposes this checkout's built CLI as `gantry`; rerun
`npm run build` after source changes before restarting or validating the
service.

## Testing

Test and harness files must live outside production source trees.

Approved test layout:

- `apps/core/test/unit/**`
- `apps/core/test/integration/**`
- `apps/core/test/e2e/**`
- `apps/core/test/harness/**`
- `packages/contracts/test/unit/**`

Do not add `*.test.ts` files under `apps/core/src/**` or `packages/*/src/**`.

Common commands:

```bash
npm run test:unit
npm run test:integration
npm test
npm run test:e2e
```

- `npm test` runs contracts build + unit + integration tests.
- `npm run test:e2e` runs hermetic end-to-end runtime flows without external service credentials.

## Shipped Chat Surfaces

Gantry ships host-managed chat commands and in-house skill surfaces. Skills are bundled into the npm package under `.agents/skills` or installed as reviewed skill zips. Runtime copies installed skills into a temporary per-run provider config directory; runtime-home provider skill folders are not the durable source of truth.

| Surface        | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `/commands`    | Host-managed command that lists available chat commands               |
| `gantry-admin` | Internal administration reference used by agents when managing Gantry |

Session commands are handled by the host runtime, not bundled skills:

```text
/compact
/commands
/new
/stop
/dream
/memory-status
/save-procedure "<title>"
/model
/model <value>
/models
/status
/model default
/thinking
/thinking <value>
/thinking default
```

Optional skill packs can be installed for additional capabilities through the reviewed skill/capability flow. `/commands` lists host-managed chat commands; installed skills remain governed by agent capability selection.

## Session Commands

Use these as standalone chat messages:

```text
/compact
/commands
/new
/stop
/dream
/memory-status
/save-procedure "<title>"
/model
/model opus
/model sonnet
/model kimi
/models
/status
/model default
/thinking
/thinking high
/thinking default
```

- `/commands` lists the host-managed commands available in chat. It is direct Gantry runtime behavior, not a Claude SDK skill.
- `/new` resets the current Gantry session boundary and captures best-effort boundary memory/digests. It preserves durable memory, installed skills, MCP bindings, model choices, and agent configuration; the next user message starts fresh and drives memory retrieval. Transcript export is an explicit debug/export workflow, not provider continuity.
- `/models` lists the curated model catalog with aliases, provider label, context window, cache support, and default badges.
- `/model <value>` switches the group model override through the catalog. Friendly aliases are case/punctuation-insensitive; raw provider model IDs are rejected.
- `/status` shows the current model source, context window usage percentage, cache hit percentage, top context contributors when the SDK reports them, current/cumulative input/output/cache tokens, and estimated cost when reported.
- Session commands require `is_from_me` or explicit conversation approver membership. `sender_policy.allow: "*"` allows interaction; it does not grant admin/session-command rights.

## Model Policy

Gantry uses a provider-neutral catalog. Normal users choose model aliases;
provider slugs, SDK environment variables, and runner ids are adapter details.

The public execution selector is `agentHarness` / `agent_harness`, with values
`auto`, `anthropic_sdk`, and `deepagents`. `auto` chooses the compatible harness
from the selected model provider: Claude/Anthropic models use
`anthropic_sdk`, while OpenAI-compatible providers including OpenAI,
OpenRouter, Bedrock, and Vertex use `deepagents` through the Gantry Model
Gateway. Explicit incompatible harness/model pairings fail before runner spawn.

Harness-selection work is documented in [Agent Harness Selection](docs/decisions/2026-06-14-agent-harness-selection.md).

- `gantry agent list` and `gantry agent info <id>` display the selected
  `agentHarness`; `gantry model why <alias> --agent <id>` shows the model
  alias, response family, credential profile, selected harness, diagnostic
  `modelRoute`, and internal diagnostic `executionProviderId`.
- Claude OAuth/subscription credentials are Anthropic-SDK-only. A defensive
  backstop at the credential boundary still guarantees those credentials never
  reach the DeepAgents lane.
- For DeepAgents-lane chat models, the catalog declares identity and route only;
  the runner receives only a loopback gateway URL and `gtw_` token. Model
  construction is library-driven: the DeepAgents runner builds OpenAI-compatible
  providers via LangChain `initChatModel("openai:<id>", ...)` and uses
  `@langchain/openrouter` `ChatOpenRouter` for OpenRouter, rather than exposing
  raw provider credentials to the runner.
- DeepAgents raw authority remains Gantry-owned and wrapped. Raw `execute`, raw
  local filesystem access, raw `.mcp.json`, and raw provider credentials are not
  exposed; tool use goes through Gantry facades, approvals, sandbox policy, and
  audit.
- DeepAgents subagents are internal execution primitives, not a user-facing
  mission-control UI. Evidence receipts are adaptive: pure chat answers do not
  need a receipt, work with no tools, changes, delegation, or blocker may use
  only `Completed: <short outcome>`, and impactful work uses the full receipt:

  ```text
  Completed: <short outcome>
  Used: <tools/capabilities>
  Changed: <files/accounts/channels or none>
  Delegated: yes/no
  Needs attention: <blocker or none>
  ```

- Anthropic preset: chat `opus`; job defaults inherit chat; memory uses preset-managed extractor `haiku`, dreaming `sonnet`, consolidation `sonnet`
- OpenRouter preset: chat defaults to `kimi`; job defaults inherit chat; memory extractor, dreaming, and consolidation use `kimi`
- Catalog choices include Anthropic `opus`/`sonnet`/`haiku`, OpenRouter `kimi`, OpenAI `gpt`, OpenAI-compatible providers such as `groq`, `deepseek`, and `gemini`, plus the region-aware Bedrock alias `bedrock-oss` and Vertex aliases `vertex` / `vertex-flash-3.5`.
- Job defaults: `agent.one_time_job_default_model` and `agent.recurring_job_default_model` inherit `agent.default_model` when empty
- Memory task defaults are preset-managed. Use `gantry model memory` to inspect them and `gantry model reset memory` or `PATCH /v1/models/defaults` with `memory: null` to reapply preset-managed defaults.
- Memory (extraction, dreaming, consolidation) has no engine setting either (the retired `memory.engine` key is now rejected at settings validation). The memory transport lane is derived from the memory model's provider: an Anthropic memory model uses the Claude Agent SDK memory client; OpenAI and OpenRouter memory models use the OpenAI-compatible chat-completions memory client. Choose OpenAI/OpenRouter memory model aliases and memory runs with no Anthropic models. `gantry model memory` shows the derived `Memory engine: <label>`.
- Use `gantry model chat|jobs|memory` and `gantry model why ...` to preview what will actually run before changing defaults. SDK and Control API callers use `client.models.defaults.get()`, `client.models.defaults.update()`, and `client.models.preview()` over `GET /v1/models/defaults`, `PATCH /v1/models/defaults`, and `POST /v1/models/preview`.
- The generated agent SDK settings JSON includes `model` and `availableModels`; memory hooks are not installed in runtime materialization.

The model catalog is centralized in `apps/core/src/shared/model-catalog.ts`. OpenRouter is selected by provider or catalog alias and runs on the DeepAgents/OpenAI-compatible lane: `ChatOpenRouter` reaches OpenRouter via the brokered Gantry loopback gateway (`/v1/chat/completions`, bearer auth) with Model Access credentials. OpenRouter supports prompt caching — automatic-prefix providers such as Kimi cache without request shaping, and the runner accounts cache reads/writes from the streamed usage and uses sticky session routing so cache hits persist across turns.

## Project Layout

Key paths:

- `apps/core/src/index.ts` — package/runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts` — orchestrator lifecycle and runtime wiring
- `apps/core/src/runtime/group-queue.ts` — per-group queueing and retries
- `apps/core/src/runtime/agent-spawn.ts` — host agent execution path
- `apps/core/src/session/session-commands.ts` — host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/` — Postgres runtime, control-plane, job, and memory persistence
- Prompt defaults are compiled from built-in runtime/persona/capability/operating guidance plus protected per-agent FileArtifacts
- Prompt FileArtifact path `<agent-folder>/SOUL` plus `.md` suffix — per-agent personality prompt
- Prompt FileArtifact path `<agent-folder>/CLAUDE` plus `.md` suffix — stable agent-specific prompt guidance
- `GANTRY_DATABASE_URL` — Postgres runtime and memory database
- `SECRET_ENCRYPTION_KEY` — stable generated base64-encoded 32-byte deployment secret for Gantry credential encryption

## Factory Mode

This repo also supports a doc-driven factory workflow for planning, decomposition, testing, review, and PR readiness.

Start with:

```bash
python3 .codex/scripts/stage_orchestrator.py
```

Then read:

- [WORKFLOW.md](WORKFLOW.md)
- [docs/FACTORY.md](docs/FACTORY.md)
- [docs/QUALITY.md](docs/QUALITY.md)
- [docs/getting-started.md](docs/getting-started.md)

## Customizing

Gantry agents are configured through prompt folders, not code changes to the runtime. Each agent's behavior is defined by its persona, skills, and tool configuration in `settings.yaml` and the corresponding prompt files under `~/gantry/agents/`.

For client deployments, agent prompt folders live in the `apps/` directory of the client monorepo. The runtime reads these at startup.

Reusable guided workflows can be uploaded as skill zips with `SKILL.md`, then approved and bound to agents.

## Contributing

Contributions should keep the core runtime small and maintainable. Bug fixes, simplifications, docs improvements, and reusable skills are good fits. Feature creep in the default runtime is not.

All contributions go through the standard CAW PR review process. Gantry is a shared runtime powering client deployments, so stability, clean replacement, and clear migration notes matter.

## Documentation

Project docs live in [`docs/`](docs/README.md). Product intent, architecture notes, and decisions live in-repo so planning and review can stay self-contained. For the high-level technical overview, see the [architecture overview](docs/architecture/overview.md).
