# MyClaw

## What This Repo Is

MyClaw is a provider-neutral and channel-neutral agent runtime platform.
Personal Telegram/WhatsApp and enterprise Slack, Teams, and WebUI are deployment modes.
Channels, LLM providers, storage, CLI, and control HTTP are replaceable adapters around stable app concepts.

Primary surfaces:

- `apps/core/src/index.ts`: runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts`: lifecycle wiring
- `apps/core/src/runtime/group-queue.ts`: per-group queue/retry
- `apps/core/src/runtime/agent-spawn.ts`: host execution
- `apps/core/src/session/session-commands.ts`: host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/`: Postgres persistence

## Mandatory Read Order

1. [README.md](README.md)
2. [WORKFLOW.md](WORKFLOW.md)
3. [docs/FACTORY.md](docs/FACTORY.md)
4. [docs/QUALITY.md](docs/QUALITY.md)
5. [docs/architecture/codebase-refactor-principles.md](docs/architecture/codebase-refactor-principles.md)
6. [docs/architecture/current-verification-commands.md](docs/architecture/current-verification-commands.md)

Use `python3 .codex/scripts/stage_orchestrator.py` to get current phase commands and required artifacts.

## Runtime Modes

- Host runtime is the only supported runtime mode in this repo today.
- The repo must work with plain Codex and with ACP/ACPX integrations; do not assume ACP is always present.

Important constraints:

- First-run channel setup creates one user-facing main agent named by `settings.yaml agent.name`; chat IDs and `main_agent` are internal routing.
- `/new` clears persisted session state but preserves the group model override.
- Transcript archive during `/new` is best-effort and must not block reset success.
- Durable memory lives under the configured memory root; do not load `~/myclaw/agents/<folder>/memory/`.

## Architecture Rules

- Normalize channel-specific behavior into canonical app, agent, conversation, thread, message, and session concepts.
- Do not add more provider-specific behavior to core runtime.
- Hide LLM and model-provider behavior behind provider ports.
- Route all risky tool execution through deterministic permission evaluation and sandbox policy.
- Domain must not import adapters, runtime, CLI, HTTP, Postgres, Slack, Telegram, Teams, WhatsApp, Claude, Anthropic SDK, OpenAI, Gemini, or provider-specific packages.
- Application may depend on domain and ports, not provider implementations.
- Adapters implement ports and may depend on external systems.
- CLI and control HTTP are adapters.

## Coding Rules

- Avoid wrapper-only files and broad `common`, `misc`, or `utils` buckets.
- Keep shared utilities narrowly scoped to an owned layer or adapter, such as infrastructure logging or error boundaries.
- Prefer small files with clear responsibility.
- Add tests for new behavior.
- MyClaw is early-stage: prefer deleting legacy code over compatibility shims because no users are live yet.
- Do not add migration compatibility commands, auto-migration flows, cleanup shims, or runtime branches that exist only to support old local state.
- Remove obsolete code paths in the same change when introducing a breaking replacement.
- Treat cleanup as part of replacement work: remove obsolete active code, schemas, tests, docs, exports, and wiring in the same PR, or retain them with owner, reason, and removal condition.
- Before resolving PR review threads or marking cutover complete, search for old type names, table names, imports, and entrypoints; document why any matches remain.
- Do not add test-only or local-checkout branches to production code.
- Classify every new config value first: non-secrets in `settings.yaml`, runtime secrets behind `RuntimeSecretProvider`, and agent credentials behind `AgentCredentialBroker`.
- Wrong-lane config must fail loudly. Raw provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` must never be accepted from MyClaw `.env` or process env.
- Agent-requested third-party MCP servers use same-channel approval until real admin RBAC exists. Host must verify the origin chat belongs to the requesting agent; approval only decides that pending draft, binds only that agent, and activates next run.
- Treat third-party MCP servers as approved agent capabilities. Durable MCP truth belongs in Postgres definitions, versions, bindings, credential refs, and audit events; Claude SDK `mcpServers` is only a per-run adapter projection.

## Docs Rules

- User-facing and project-facing docs must use `MyClaw` naming.
- Do not reintroduce legacy branding in active docs or instructions.
- Avoid fork/upstream framing in active guidance. Prefer neutral repo, branch, or shared-remote wording.
- Prefer local repo docs over speculative external docs links unless the external target is verified current.
- For major arch changes, update `docs/architecture/` or `docs/decisions/`.
- When docs policy changes, update this file in the same PR.

## Verification Rules

- Discover and document exact verification commands before changing implementation behavior.
- Run the smallest relevant checks after each change.
- Run full checks at the end of a phase.
- Before validating `~/myclaw`, build/restart from this checkout, confirm `myclaw status`, and treat older generated logs/state as stale.
- Archive stale generated state under `~/myclaw/cleanup-archive/<timestamp>/`; keep secrets, settings, Postgres, OneCLI data, artifacts, and active agent folders unless reset is requested.
- Architecture exceptions must be time-bounded ratchets with max counts; never relax the checker globally to hide new debt.
- For replacement or cutover work, include a cleanup verification step that searches for stale active references and records the result before final response or PR handoff.
- Use [docs/architecture/current-verification-commands.md](docs/architecture/current-verification-commands.md) as the command reference.

## Codex Harness

- Use relevant local skills under `.codex/skills/` for architecture refactors, permission safety, schema changes, and provider adapters.
- Record new lessons with `python3 .codex/scripts/record_lesson.py` after repeated failures or review findings.
- Run `python3 .codex/scripts/check_task_completion.py` before final response when possible.

## Safety Rules

- Do not read production secrets.
- Do not run destructive filesystem or database commands.
- Do not modify files outside this repository.
- Do not track generated run/hook artifacts: `__pycache__`, `*.pyc`, coverage, validation reports, active `.factory/`, or tarballs.
- Background maintenance timers must be stoppable so tests and CI can exit cleanly.

## Hard Gates

Before merge or release: `npm run build`, `npm test`, `python3 .codex/scripts/verify.py`, and `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`.

Full factory mode also requires `python3 .codex/scripts/validate_work.py`, required decomposition/testing/review artifacts, and `python3 .codex/scripts/pr_ready.py`.
