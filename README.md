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
- embeddings: off (unless OpenAI key is provided and enabled)
- dreaming: off
- sender allowlist: `channels.telegram.sender_allowlist` / `channels.slack.sender_allowlist` in `settings.yaml`

### Channel Setup

MyClaw supports multiple channels. You can connect Telegram and/or Slack:

```bash
myclaw telegram connect
myclaw slack connect
```

Notes:

- Telegram uses `TELEGRAM_BOT_TOKEN` and a chat ID like `tg:-1001234567890`.
- Slack uses Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`), then registers chats like `sl:C0123456789`.
- Telegram Mini App features are optional and Telegram-specific. Slack UX uses native Slack surfaces (threads, streaming updates, actions).

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

## Built-in Skills

Skills are slash commands the agent responds to inside chat. Run `/commands` to see the full list.

| Skill            | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `/commands`      | List all available slash commands with descriptions            |
| `/setup`         | First-time installation, authentication, service configuration |
| `/customize`     | Adding channels, integrations, changing behavior               |
| `/debug`         | Runtime issues, logs, troubleshooting                          |
| `/update-myclaw` | Bring upstream MyClaw updates into a customized install        |
| `/init-onecli`   | Install OneCLI Agent Vault and migrate `.env` credentials      |

Feature skills (installed via branch merge):

| Skill           | Purpose                      |
| --------------- | ---------------------------- |
| `/add-telegram` | Add Telegram channel support |
| `/add-slack`    | Add Slack channel support    |
| `/add-discord`  | Add Discord channel support  |
| `/add-gmail`    | Add Gmail channel support    |

Optional skill packs like [gstack](https://github.com/garrytan/gstack) can be installed for additional capabilities (code review, QA, design review, security audits, and more). Run `/commands` after installing to see what's available.

## Session Commands

Use these as standalone chat messages:

```text
/compact
/new
/runtime
/model
/model opus
/model claude-opus-4-1-20250805
/model default
```

- `/new` resets the current group session and archives the previous transcript.
- `/runtime` shows runtime health details.
- `/model <value>` switches the group model override only when validation succeeds.

## Project Layout

Key paths:

- `apps/core/src/index.ts` - orchestrator loop and runtime wiring
- `apps/core/src/runtime/group-queue.ts` - per-group queueing and retries
- `apps/core/src/runtime/agent-spawn.ts` - host agent execution path
- `apps/core/src/runtime/runtime-diagnostics.ts` - runtime health checks
- `apps/core/src/session/session-commands.ts` - host-managed slash commands
- `apps/core/src/storage/db.ts` - SQLite persistence
- `~/myclaw/agents/*/` - runtime per-agent working files and memory

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

For guided changes, run `/customize`.

## Contributing

Contributions should keep the core runtime small and maintainable. Bug fixes, simplifications, docs improvements, and reusable skills are good fits. Broad feature creep in the default runtime is not.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy and [docs/skills-as-branches.md](docs/skills-as-branches.md) for the branch-based skill model.

## Documentation

Project docs live in [`docs/`](docs/README.md). Product intent, architecture notes, and decisions live in-repo so planning and review can stay self-contained.
For npm users, start with [`docs/npm-cli-onboarding.md`](docs/npm-cli-onboarding.md).
