<p align="center">
  A personal AI assistant runtime that stays small enough to understand and is meant to be customized in code.
</p>

---

## What MyClaw Is

MyClaw is a single-process Node.js assistant runtime. Messages come in from one or more channels, get stored in SQLite, and are routed to Codex-driven agents through a host runtime process.

The project is intentionally small. The goal is not to be a framework with every feature built in. The goal is to give one person a secure, understandable base they can shape to fit their own workflow.

## Quick Start

```bash
npx myclaw
```

The first run is a guided CLI flow (doctor + setup) that gets you to a working first channel without repo steps.

### CLI Commands

```bash
myclaw
myclaw setup
myclaw doctor
myclaw status
myclaw memory status
myclaw memory provider <sqlite|qmd|noop|none>
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
- setup flow: Telegram-first (Slack can be added with `myclaw slack connect`)
- memory: on
- memory provider: `sqlite` by default; `qmd` adds a markdown audit mirror
- embeddings: off (unless OpenAI key is provided and enabled)
- dreaming: off
- sender allowlist: `channels.telegram.sender_allowlist` / `channels.slack.sender_allowlist` in `settings.yaml`

Canonical memory settings live in `~/myclaw/settings.yaml`:

```yaml
memory:
  enabled: true
  provider: sqlite
  sqlite_path: store/memory.db
  qmd_root: agent-memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
```

### Channel Setup

MyClaw supports multiple channels. You can connect Telegram and/or Slack:

```bash
myclaw telegram connect
myclaw slack connect
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN` and a chat ID like `tg:-1001234567890`.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`), then registers chats like `sl:C0123456789`.
- Slack UX uses native Slack surfaces (threads, streaming updates, actions).

## Philosophy

- Small enough to understand. One process, a small set of core files, and straightforward data flow.
- Secure by explicit trust boundaries. The current runtime executes on host, so security depends on host controls, scoped mounts, and clear operational safeguards.
- Customized in code. If you want different behavior, change the code instead of stacking on configuration.
- Skills over core bloat. Reusable capabilities should be delivered as skills or narrowly scoped branches, not piled into the default runtime.
- AI-native operations. Setup, debugging, and maintenance should be easy to drive from Claude Code or Codex.

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

Embeddings are off by default. Memory search and context injection still work without embeddings; embeddings only improve ranking when enabled.

Provider model:

- `sqlite`: simple local SQLite database, no markdown mirror
- `qmd`: SQLite plus human-readable markdown mirror under `~/myclaw/agent-memory`

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
npm run dev
```

## Shipped Chat Skills

Skills are agent instructions bundled into the npm package and synced into `~/myclaw/.claude/skills/`.

| Skill | Purpose |
| ----- | ------- |
| `/commands` | List available chat commands and installed skill packs |
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
- `apps/core/src/storage/db.ts` - SQLite persistence
- `~/myclaw/agents/shared/CLAUDE.md` - static shared prompt guidance
- `~/myclaw/agents/*/SOUL.md` - per-agent personality prompt
- `~/myclaw/agents/*/CLAUDE.md` - static group-specific prompt guidance
- `~/myclaw/store/memory.db` - default SQLite memory database
- `~/myclaw/agent-memory/` - QMD markdown mirror when `settings.yaml memory.provider=qmd`

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
