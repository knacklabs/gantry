# MyClaw

## What This Repo Is

MyClaw is becoming a provider-neutral and channel-neutral agent runtime platform.
Personal Telegram/WhatsApp usage is one deployment mode; enterprise Slack, Teams, and WebUI integration is another deployment mode.
The architecture must treat channels, LLM providers, storage, CLI, and control HTTP as replaceable adapters around stable application and domain concepts.

Primary surfaces today:

- `apps/core/src/index.ts`: package/runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts`: runtime wiring and lifecycle
- `apps/core/src/runtime/group-queue.ts`: per-group queue and retry behavior
- `apps/core/src/runtime/agent-spawn.ts`: host execution path
- `apps/core/src/session/session-commands.ts`: host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/`: Postgres persistence for groups, messages, jobs, control events, and memory

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
- Treat cleanup as part of replacement work: remove obsolete active repositories, schemas, runtime paths, tests, docs, exports, and factory wiring in the same PR, or deliberately retain them with an owner, reason, and removal condition.
- Before resolving PR review threads or marking cutover work complete, search for old type names, table names, imports, and runtime entrypoints affected by the change. Document any remaining matches and prove they are inactive, historical docs, or intentionally retained exceptions.
- Do not add test-only or local-checkout branches to production code.
- Classify every new config value before implementation: non-secret configuration belongs in `settings.yaml`, runtime-owned secrets belong behind `RuntimeSecretProvider`, and agent-accessed credentials belong behind `AgentCredentialBroker`.
- Wrong-lane credential/config values must fail loudly. Raw model/provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` must never be accepted from MyClaw `.env` or process env.

## Docs Rules

- User-facing and project-facing docs must use `MyClaw` naming.
- Do not reintroduce legacy branding in active docs or instructions.
- Avoid fork/upstream framing in active guidance. Prefer neutral repo, branch, or shared-remote wording.
- Prefer local repo docs over speculative external docs links unless the external target is verified current.
- For every major architectural change, update `docs/architecture/` or `docs/decisions/`.
- When docs policy changes, update this file in the same PR.

## Verification Rules

- Discover and document exact verification commands before changing implementation behavior.
- Run the smallest relevant checks after each change.
- Run full checks at the end of a phase.
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
- Do not track generated artifacts from local runs or hooks, including `__pycache__`, `*.pyc`, coverage output, validation reports, active `.factory/` run artifacts, or package tarballs.
- Background maintenance timers must be stoppable so tests and CI can exit cleanly.

## Hard Gates

Before merge or release:

1. `npm run build`
2. `npm test`
3. `python3 .codex/scripts/verify.py`
4. `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`

If running full factory mode:

1. `python3 .codex/scripts/validate_work.py`
2. Required artifacts must exist for decomposition, testing, and review.
3. `python3 .codex/scripts/pr_ready.py` must pass.
