<p align="center">
  A personal AI assistant that runs agents in isolated containers, stays small enough to understand, and is meant to be customized in code.
</p>

---

## What MyClaw Is

MyClaw is a single-process Node.js assistant runtime. Messages come in from one or more channels, get stored in SQLite, and are routed to Codex-driven agents that usually run inside their own Linux containers.

The project is intentionally small. The goal is not to be a framework with every feature built in. The goal is to give one person a secure, understandable base they can shape to fit their own workflow.

## Quick Start

```bash
npx myclaw
```

The first run is a guided CLI flow (doctor + setup) that gets you to a Telegram-ready state without repo steps.

### CLI Commands

```bash
myclaw
myclaw setup
myclaw doctor
myclaw status
myclaw start
myclaw telegram connect
myclaw service install
myclaw service start
myclaw service stop
```

Defaults in v1:

- runtime home: `~/myclaw`
- first channel: Telegram only
- memory: on
- embeddings: off (unless OpenAI key is provided and enabled)
- dreaming: off

## Philosophy

- Small enough to understand. One process, a small set of core files, and straightforward data flow.
- Secure by isolation. Agents run in containers by default, so shell access stays inside the sandbox instead of touching your host machine.
- Customized in code. If you want different behavior, change the code instead of stacking on configuration.
- Skills over core bloat. Reusable capabilities should be delivered as skills or narrowly scoped branches, not piled into the default runtime.
- AI-native operations. Setup, debugging, and maintenance should be easy to drive from Claude Code or Codex.

## What It Supports

- Multi-channel messaging
- Per-group context and memory
- Scheduled jobs
- Web access and browser automation
- Container-first execution with optional host runtime
- Skill-driven extensions and channel installation

## Runtime Modes

MyClaw supports two runtime modes:

- `AGENT_RUNTIME=container` for the default isolated workflow
- `AGENT_RUNTIME=host` when you explicitly want host-level tool access

Container mode is the default and the safer choice. Host mode is available, but it intentionally trades isolation for direct machine access.

### Runtime Commands

```bash
npm run dev:container
npm run start:container

npm run dev:host
npm run start:host
```

## Repository Development

Use this only when you are working on the source code:

```bash
git clone https://github.com/qwibitai/myclaw.git
cd myclaw
npm install
npm run build
npm run dev:container
```

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
- `/runtime` shows the active runtime mode and health details.
- `/model <value>` switches the group model override only when validation succeeds.

## Project Layout

Key paths:

- `apps/core/src/index.ts` - orchestrator loop and runtime wiring
- `apps/core/src/runtime/group-queue.ts` - per-group queueing and retries
- `apps/core/src/runtime/container-runner.ts` - container execution path
- `apps/core/src/runtime/container-runtime.ts` - runtime selection and health checks
- `apps/core/src/session/session-commands.ts` - host-managed slash commands
- `apps/core/src/storage/db.ts` - SQLite persistence
- `apps/core/groups/*/` - tracked group templates and baseline working files

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
