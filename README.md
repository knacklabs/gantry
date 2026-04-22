<p align="center">
  A personal AI assistant runtime that stays small enough to understand and is meant to be customized in code.
</p>

---

## What MyClaw Is

MyClaw is a single-process Node.js assistant runtime. Messages come in from one or more channels, get stored in the configured runtime database, and are routed to host-managed agents through a host runtime process.

The project is intentionally small. The goal is not to be a framework with every feature built in. The goal is to give one person a secure, understandable base they can shape to fit their own workflow.

## Quick Start

```bash
npx myclaw
```

The first run is a guided CLI flow that collects setup choices first, then runs final doctor verification before marking the runtime ready.

### NPM Install First-Run Flow

If you install from npm and want the fastest path to a working bot:

```bash
npx myclaw
# or
npm i -g myclaw && myclaw
```

Then follow this order:

1. Run `myclaw` with no args.
2. Confirm runtime home and storage (`SQLite` is the supported runtime database in this release).
3. Choose your first provider: `Telegram` or `Slack`.
4. Follow the in-CLI provider guide, paste credentials, and pick a discovered chat/channel (or enter an ID manually).
5. Choose credential mode (`env-only` by default), then set Claude auth (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) when that mode needs local credentials.
6. Choose main model (`Sonnet` recommended, `Opus` optional).
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
myclaw memory status
myclaw memory embeddings <off|openai>
myclaw memory dreaming <on|off>
myclaw start
myclaw telegram connect
myclaw slack connect
myclaw service install
myclaw service start
myclaw service stop
```

Defaults in v1:

- runtime home: `~/myclaw`
- runtime settings file: `~/myclaw/settings.yaml` (validated before `start`/`restart`)
- setup flow: guided multi-channel first run (choose Telegram or Slack)
- storage provider: `sqlite`; Postgres is not exposed until runtime persistence is provider-backed end to end
- storage SQLite path: `store/myclaw.db`
- memory: on
- embeddings: off (unless OpenAI key is provided and enabled)
- dreaming: on in guided setup; disable with `myclaw memory dreaming off`
- sender allowlist: `channels.<provider>.sender_allowlist` in `settings.yaml`

Runtime home is a single-cut contract. MyClaw reads `~/myclaw` by default unless `--runtime-home` or `MYCLAW_HOME` is set.

Canonical runtime settings live in `~/myclaw/settings.yaml`:

```yaml
storage:
  provider: sqlite
  sqlite:
    path: store/myclaw.db

memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: true
```

### Channel Setup

MyClaw supports multiple channels. You can connect Telegram and/or Slack:

```bash
myclaw telegram connect
myclaw slack connect
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN`; create it in Telegram by chatting with `@BotFather` and sending `/newbot`.
- For Telegram groups, add the bot to the group and send a message before discovery; if MyClaw must see every group message, make the bot an admin or disable Group Privacy in BotFather with `/setprivacy`.
- `myclaw telegram connect` auto-discovers recent chats and can register one without manual chat ID copy/paste.
- Manual Telegram chat IDs like `tg:-1001234567890` are still supported as fallback.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`); create a Slack app, add a bot user/scopes, enable Socket Mode, generate the app-level token, install/reinstall the app, then invite it to the target channel or DM it once.
- `myclaw slack connect` auto-discovers accessible conversations and can register one directly.
- Manual Slack IDs like `sl:C0123456789` are still supported as fallback.
- Slack UX uses native Slack surfaces (threads, streaming updates, actions).

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

Continuity is the runtime context that helps the agent pick up where it left off:

- current task state
- relevant remembered facts
- prior decisions
- recent work context
- open loops once commitment tracking is enabled
- dream lifecycle status (enabled/schedule/last run outcome)

Embeddings are off by default. Memory search and context injection still work without embeddings; embeddings only improve ranking when enabled.

Host runtime now injects a fresh memory/continuity block for every agent run (message and scheduler), so baseline recall does not depend on the agent deciding to call memory tools first. The block is sent as a separate structured untrusted data message, with a system-level boundary policy that forbids treating memory records as instructions or tool-use authority.

Scope defaults:

- `user` for personal preferences and per-user corrections
- `group` for active channel/chat memory (default)
- `global` only for explicitly cross-chat knowledge
- when `thread_id` exists, injected group/global memory is filtered to records saved with the same `topic_id`/`thread_id`

Runtime state storage defaults to `~/myclaw/store/myclaw.db`.
Memory data uses `~/myclaw/memory/.cache/memory.db` by default (derived from `memory.root`).
Memory artifacts (journal, sessions, optional mirrors) remain under `memory.root`.

## Runtime

MyClaw currently supports a single runtime mode: host execution.
Use `npm run dev` for local development and `npm start` for production start.

## Repository Development

Use this only when you are working on the source code:

```bash
git clone https://github.com/qwibitai/myclaw.git
cd myclaw
npm install
npm run build
# local testing entrypoint (equivalent CLI flow)
node index.js
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

Skills are agent instructions bundled into the npm package and synced into `~/myclaw/.claude/skills/`.

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
/model claude-opus-4-1-20250805
/model default
```

- `/new` resets the current group session and archives the previous transcript.
- `/model <value>` switches the group model override only when validation succeeds.

## Project Layout

Key paths:

- `apps/core/src/index.ts` - orchestrator loop and runtime wiring
- `apps/core/src/runtime/group-queue.ts` - per-group queueing and retries
- `apps/core/src/runtime/agent-spawn.ts` - host agent execution path
- `apps/core/src/session/session-commands.ts` - host-managed slash commands
- `apps/core/src/storage/db.ts` - runtime persistence
- `~/myclaw/agents/shared/CLAUDE.md` - static shared prompt guidance
- `~/myclaw/agents/*/SOUL.md` - per-agent personality prompt
- `~/myclaw/agents/*/CLAUDE.md` - static group-specific prompt guidance
- `~/myclaw/store/myclaw.db` - default app storage database
- `~/myclaw/memory/.cache/memory.db` - default memory database
- `~/myclaw/memory/sessions/` - archived session summaries used for continuity recap
- `~/myclaw/memory/dreams/` - dream/refinement artifacts
- `~/myclaw/memory/.journal/` - memory journal files

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

Reusable guided workflows can be added as skills under `~/myclaw/.claude/skills/`.

## Contributing

Contributions should keep the core runtime small and maintainable. Bug fixes, simplifications, docs improvements, and reusable skills are good fits. Broad feature creep in the default runtime is not.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy and branch-based skill model.

## Documentation

Project docs live in [`docs/`](docs/README.md). Product intent, architecture notes, and decisions live in-repo so planning and review can stay self-contained.
For npm users, start with [`docs/npm-cli-onboarding.md`](docs/npm-cli-onboarding.md).
