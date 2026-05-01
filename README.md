<p align="center">
  A personal AI assistant runtime that stays small enough to understand and is meant to be customized in code.
</p>

---

## What MyClaw Is

MyClaw is a single-process Node.js assistant runtime. Messages come in from one or more channels, get stored in the configured runtime database, and are routed to host-managed agents through a host runtime process.

The project is intentionally small. The goal is not to be a framework with every feature built in. The goal is to give one person a secure, understandable base they can shape to fit their own workflow.

## Quick Start

```bash
npm i -g myclaw
myclaw
```

The first run is a guided CLI flow that collects setup choices first, then runs final doctor verification before marking the runtime ready.

### NPM Install First-Run Flow

If you install from npm and want the fastest path to a working bot:

```bash
npm i -g myclaw
myclaw
```

Then follow this order:

1. Run `myclaw` with no args.
2. Choose `Use local Postgres URL` if you started the provided Compose stack, or choose hosted/existing Postgres and paste those URLs.
3. Choose your first channel: `Telegram` or `Slack`.
4. Follow the in-CLI channel guide, choose the main agent name, paste channel credentials, and pick a discovered chat/channel (or enter an ID manually). This first chat becomes the user-facing main agent; channel IDs and runtime folders stay internal.
5. Connect Model Access for agent model calls. MyClaw and OneCLI can share one Postgres database with separate schemas; agents never receive the database URLs or raw Claude credentials.
6. Choose main model by friendly alias (`opus` recommended; `sonnet`, `haiku`, or broker-backed `kimi` optional).
7. Confirm memory settings (memory on, embeddings off, dreaming on by default).
8. Choose whether to install/start a background service.
9. Review the final summary and choose `Create Runtime`; before this point Back, Resume Later, and Cancel are transactional.
10. Let setup write config, register the group, run final doctor verification, and show the ready screen.
11. Finish setup. The default is to exit cleanly; choose `Start MyClaw now` only if you want the runtime to begin listening immediately.

### CLI Commands

```bash
myclaw
myclaw setup
myclaw doctor
myclaw status
myclaw start
myclaw stop
myclaw restart
myclaw logs
myclaw local setup|start|stop|status|logs|doctor
myclaw model list
myclaw model set-default chat|one-time|recurring <alias>
myclaw model doctor
myclaw channel connect telegram
myclaw channel connect slack
myclaw channel connect teams
myclaw channel list
myclaw channel doctor
myclaw agent list
myclaw agent add <jid|chat-id> [--name <name>] [--main]
myclaw service install|start|stop|restart
```

Defaults in v1:

- runtime home: `~/myclaw`
- runtime settings file: `~/myclaw/settings.yaml` (validated before `start`/`restart`)
- setup flow: guided multi-channel first run (choose Telegram or Slack)
- storage: Postgres through `MYCLAW_DATABASE_URL`; guided setup validates URLs but does not create Docker containers
- memory: on
- embeddings: off by default; external embedding providers require brokered Model Access and are not configured through MyClaw `.env`
- dreaming: on in guided setup; disable with `myclaw memory dreaming off`
- sender allowlist: `channels.<provider>.sender_allowlist` in `settings.yaml`
- session/admin allowlist: `channels.<provider>.control_allowlist` in `settings.yaml`

Runtime home is a single-cut contract. MyClaw reads `~/myclaw` by default unless `--runtime-home` or `MYCLAW_HOME` is set.

Canonical runtime settings live in `~/myclaw/settings.yaml`:

```yaml
storage:
  postgres:
    url_env: MYCLAW_DATABASE_URL
    schema: myclaw

agent:
  name: Main Agent
  default_model: opus
  one_time_job_default_model: ""
  recurring_job_default_model: ""

credential_broker:
  mode: onecli
  onecli:
    url: http://localhost:10254
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
    enabled: true
```

MyClaw uses Postgres for runtime state, jobs, events, memory, semantic search, and lexical search. Runtime readiness expects `pgvector`, `pg_trgm`, and `pg-boss` schema readiness. The supported deployment model is one database with separate schemas and roles: `myclaw` for runtime state, `onecli` for broker state, and `pgboss` for job queue internals. `MYCLAW_DATABASE_URL` and `ONECLI_DATABASE_URL` must use different Postgres users.

No Postgres or Model Access service installed? Use the provided Compose file, then paste the resulting URLs during setup:

```bash
docker compose --env-file ~/myclaw/.env up -d
myclaw setup
```

The Compose file hardcodes the local ports, schema names, and non-secret role names. `~/myclaw/.env` only needs local passwords, `SECRET_ENCRYPTION_KEY`, and the runtime connection URLs. MyClaw setup does not start Docker or create containers; it asks for `MYCLAW_DATABASE_URL` and `ONECLI_DATABASE_URL`, then writes the non-secret OneCLI gateway URL to `settings.yaml` as `credential_broker.onecli.url`.

If an older local `.env` still contains settings-owned keys such as
`MYCLAW_CREDENTIAL_MODE`, `ONECLI_URL`, `ANTHROPIC_MODEL`, or
`SLACK_PERMISSION_APPROVER_IDS`, move those values into `settings.yaml` and
remove them from `.env` before starting the runtime.

MyClaw intentionally does not expose a destructive database-reset command in
the runtime CLI. If you need to start over during development, stop MyClaw,
reset your local Postgres outside the agent-facing CLI, then run
`myclaw channel connect telegram` or `myclaw channel connect slack` to
re-register chats.

For hosted Postgres, use Neon, Supabase, or another provider that supports `vector` and `pg_trgm`, then paste two URLs during setup: one MyClaw-role URL with `sslmode=require`, and one OneCLI-role URL for the same database with `sslmode=require` and `schema=onecli`.

### Channel Setup

MyClaw supports multiple channels. You can connect Telegram, Slack, or Teams:

```bash
myclaw channel connect telegram
myclaw channel connect slack
myclaw channel connect teams
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN`; create it in Telegram by chatting with `@BotFather` and sending `/newbot`.
- For Telegram groups, add the bot to the group and send a message before discovery; if MyClaw must see every group message, make the bot an admin or disable Group Privacy in BotFather with `/setprivacy`.
- `myclaw channel connect telegram` auto-discovers recent chats and can register one without manual chat ID copy/paste. The human sender from the selected discovery message is added to `control_allowlist`, so `/new`, `/model`, `/dream`, and `/memory-status` work immediately.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`); create a Slack app, add a bot user/scopes, enable Socket Mode, generate the app-level token, install/reinstall the app, then invite it to the target channel or DM it once.
- `myclaw channel connect slack` auto-discovers accessible conversations and can register one directly.
- Slack tool permission approvals are deny-by-default until approvers are listed in `channels.slack.control_allowlist` in `settings.yaml`. Guided setup asks for comma-separated Slack member IDs like `U0123456789`; these users can approve tool permissions and answer interactive prompts.
- Slack UX uses native Slack surfaces (threads, streaming updates, actions).
- Teams setup uses Microsoft Teams app auth through `RuntimeSecretProvider`
  (`TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`), discovers
  Teams channels through Microsoft Graph, and registers `teams:` conversation
  IDs. Live Teams message transport remains behind the `TeamsSdkClient` adapter
  seam; this checkout includes tested normalization and Adaptive Card approval
  scaffolding, but not a concrete Bot Framework transport.

### Capability Management

Skills, MCP servers, SDK tools, host tools, browser tools, and channel-native
tools are approved agent capabilities. Agents must not run dependency install
commands, edit `.claude/skills`, edit `.mcp.json`, edit settings, or mutate
generated Claude config directly. They use MyClaw request tools instead:

- `send_message`
- `ask_user_question`
- `request_skill_install`
- `request_skill_proposal`
- `request_skill_dependency_install`
- `request_mcp_server`
- `request_tool_enable`
- `request_channel_tool_enable`
- `service_restart`
- `register_agent`

Capability changes are request, review, approval or denial, durable audit, new
config version, and next-run activation. Skill source is stored as readable
skill folders with `SKILL.md` plus supporting files; Postgres stores metadata,
source, hash, provider refs, binding, and audit records. ClawHub is the default
provider-backed skill source, but provider verification never bypasses approval.

## Philosophy

- Small enough to understand. One process, a small set of core files, and straightforward data flow.
- Secure by explicit trust boundaries. The current runtime executes on host, so security depends on host controls, scoped mounts, and clear operational safeguards.
- Customized in code. If you want different behavior, change the code instead of stacking on configuration.
- Skills over core bloat. Reusable capabilities should be delivered as skills or narrowly scoped branches, not piled into the default runtime.
- AI-native operations. Setup, debugging, and maintenance should be easy to drive from Claude Code.

## What It Supports

- Multi-channel messaging
- Per-group context and memory
- Scheduled jobs
- Web access and browser automation
- Host runtime execution
- Skill-driven extensions and channel installation

## Memory And Continuity

Memory stores durable knowledge the agent should remember later:

- preferences
- decisions
- facts
- corrections
- constraints
- reusable procedures

Continuity is explicit runtime resume/current-work state. Durable memory is
separate and is retrieved only when it matches the current query:

- provider session resume state
- query-relevant remembered facts
- query-relevant prior decisions
- user/group preferences that match the current request
- open loops once commitment tracking is enabled
- dream lifecycle status (enabled/schedule/last run outcome)

Embeddings are off by default. Memory search and context injection still work without embeddings; embeddings only improve ranking when enabled.

Host runtime injects a memory-only block when a fresh chat runner or scheduled
job starts. Follow-up chat messages continue through the same live Claude SDK
stream while the runner is alive, so MyClaw does not replay summaries, recent
messages, or recent run summaries into every prompt. The memory block is sent
as structured untrusted data with a system-level boundary policy that forbids
treating memory records as instructions or tool-use authority.

Memory boundaries:

- `appId` and `agentId` are mandatory for every memory record.
- `user`, `group`, and `channel` subjects isolate application, team, and channel context.
- `common` is app-wide shared memory and is write-restricted to admin/service flows.
- `threadId` narrows recall without crossing app, agent, user, group, or channel boundaries.

Runtime state and memory records are stored in Postgres through `MYCLAW_DATABASE_URL`.
See [docs/MEMORY.md](docs/MEMORY.md) for the app developer memory model and dreaming lifecycle.

## Runtime

MyClaw currently supports a single runtime mode: host execution.
Use `npm run dev` for local development and `npm start` for production start.

## Sidecar Integrations

Backend apps can use `@myclaw/sdk` to ensure a session, send a message, and wait
or stream durable runtime events. Normal SDK calls derive `appId` from the API
key; request-body `appId` is only an optional assertion.

External systems that should not hold a control API key use signed external
ingress records under `/v1/ingresses`. Ingress supports session messages,
existing job triggers, and constrained one-time job templates. Each ingress
record has an explicit target policy, so its secret only authorizes configured
sessions, conversations, jobs, or templates. `/v1/webhooks` remains outbound
callback delivery for runtime events.

## Repository Development

Use this only when you are working on the source code:

```bash
git clone https://github.com/qwibitai/myclaw.git
cd myclaw
npm install
npm run build
# local testing entrypoint (equivalent CLI flow)
node dist/cli/index.js
```

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

## Shipped Chat Skills

Skills are agent instructions bundled into the npm package or uploaded as
reviewable skill zips. Runtime copies approved skills into a temporary per-run
Claude config directory; runtime-home `.claude/skills` is not the durable source
of truth.

| Skill          | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `/commands`    | List available chat commands and installed skill packs                |
| `myclaw-admin` | Internal administration reference used by agents when managing MyClaw |

Session commands are handled by the host runtime, not bundled skills:

```text
/compact
/new
/model
/model <value>
/models
/status
/model default
```

Optional skill packs like [gstack](https://github.com/garrytan/gstack) can be installed for additional capabilities (code review, QA, design review, security audits, and more). Run `/commands` after installing to see what's available.

## Session Commands

Use these as standalone chat messages:

```text
/compact
/new
/model
/model opus
/model sonnet
/model kimi 2.6
/models
/status
/model default
```

- `/new` resets the current provider conversation and archives the previous transcript. It preserves durable memory, approved skills, MCP bindings, model choices, and agent configuration; the next user message starts fresh and drives memory retrieval.
- `/models` lists the curated model catalog with aliases, provider label, context window, cache support, and default badges.
- `/model <value>` switches the group model override through the catalog. Friendly aliases are case/punctuation-insensitive; raw provider model IDs are rejected.
- `/status` shows the current model source, context window, max output, current/cumulative input/output/cache tokens, cache hit state, and estimated cost when reported.
- Session commands require `is_from_me` or explicit `control_allowlist` membership. `sender_allowlist: "*"` allows interaction; it does not grant admin/session-command rights.

## Model Policy

MyClaw uses a provider-neutral catalog. Normal users choose aliases; provider slugs are adapter details.

- Default session model: `opus` (Opus 4.7)
- Anthropic choices: `opus`, `opus-4.6`, `sonnet`, `haiku`
- OpenRouter choices: `kimi` / `kimi 2.6` for Kimi K2.6
- Job defaults: `agent.one_time_job_default_model` and `agent.recurring_job_default_model` inherit `agent.default_model` when empty
- Memory LLM API defaults: extractor Haiku 4.5, dreaming Sonnet 4.6, consolidation Sonnet 4.6
- The generated Claude settings JSON includes `model`, `availableModels`, and memory hooks.

The model catalog is centralized in `apps/core/src/shared/model-catalog.ts`. OpenRouter uses the Anthropic SDK route at `https://openrouter.ai/api`; its API key must come from `AgentCredentialBroker` as child-process `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` explicitly blank for that run.

## Project Layout

Key paths:

- `apps/core/src/index.ts` - package/runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts` - orchestrator lifecycle and runtime wiring
- `apps/core/src/runtime/group-queue.ts` - per-group queueing and retries
- `apps/core/src/runtime/agent-spawn.ts` - host agent execution path
- `apps/core/src/session/session-commands.ts` - host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/` - Postgres runtime, control-plane, job, and memory persistence
- `~/myclaw/agents/shared/CLAUDE.md` - static shared prompt guidance
- `~/myclaw/agents/*/SOUL.md` - per-agent personality prompt
- `~/myclaw/agents/*/CLAUDE.md` - static group-specific prompt guidance
- `MYCLAW_DATABASE_URL` - Postgres runtime and memory database
- `ONECLI_DATABASE_URL` - Same Postgres database with a separate OneCLI role and `schema=onecli` for broker persistence
- `SECRET_ENCRYPTION_KEY` - Stable generated base64-encoded 32-byte OneCLI broker encryption secret for stateless restarts

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

The intended workflow is simple: tell Claude Code what you want changed, keep the code readable, and prefer direct code edits over piles of configuration.

Examples:

- "Change the trigger word to `@Bob`."
- "Make scheduled summaries shorter."
- "Add a morning greeting flow."
- "Store weekly conversation summaries."

Reusable guided workflows can be uploaded as skill zips with `SKILL.md`, then
approved and bound to agents.

## Contributing

Contributions should keep the core runtime small and maintainable. Bug fixes, simplifications, docs improvements, and reusable skills are good fits. Broad feature creep in the default runtime is not.

## Documentation

Project docs live in [`docs/`](docs/README.md). Product intent, architecture notes, and decisions live in-repo so planning and review can stay self-contained.
For npm users, start with the Quick Start and first-run flow in this README.
