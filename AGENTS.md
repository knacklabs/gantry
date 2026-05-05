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
- Live channel turns must persist the provider SDK session ID as soon as the runner streams it. Do not wait for runner shutdown; launchd restarts can kill an active run before final completion.

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
- Use the right search tool for the question instead of relying only on text search:
  - Use `rg` first for exact symbols, strings, imports, config keys, docs, and broad impact checks.
  - Use `ccc` when you do not know the exact symbol name, need concept-level discovery, or need to find behavior across renamed/moved code.
  - Use `ast-grep` for structural TypeScript/JavaScript searches such as constructor injection, method calls regardless of receiver, nested calls, missing wrappers, unsafe patterns, and dead-code/refactor candidates where text search is too noisy or misses multiline shape.
  - For dead-code cleanup, combine all three: `ccc` for intent/ownership, `rg` for references and public exports, and `ast-grep` for call sites, instantiations, inheritance, decorators, and object-shape usage before deleting.
- Every meaningful feature or fix plan must include a Surface Impact Matrix. Classify runtime behavior, `settings.yaml`, Postgres/runtime projection, control API, SDK/contracts, CLI, MyClaw MCP tools/admin skill, channel/provider adapters, docs/prompts, audit/events, and tests/verification as `Changed`, `Read-only/observable`, `Unchanged by design`, `Deferred`, or `Not applicable`.
- Every `Deferred` or `Unchanged by design` Surface Impact Matrix entry must include a short reason. Do not leave API, CLI, MCP tools, database projection, docs, or tests implicit.
- For settings-owned config changes, explicitly state whether the change writes `settings.yaml`, reconciles Postgres/runtime projection, and updates API/CLI/MCP/admin-tool surfaces.
- For permission and capability changes, explicitly state whether the change affects transient approval, persistent capability selection, or both.
- MyClaw is early-stage: prefer deleting legacy code over compatibility shims because no users are live yet.
- Do not add migration compatibility commands, auto-migration flows, cleanup shims, or runtime branches that exist only to support old local state.
- Remove obsolete code paths in the same change when introducing a breaking replacement.
- Treat cleanup as part of replacement work: remove obsolete active code, schemas, tests, docs, exports, and wiring in the same PR, or retain them with owner, reason, and removal condition.
- Before resolving PR review threads or marking cutover complete, search for old type names, table names, imports, and entrypoints; document why any matches remain.
- Do not add test-only or local-checkout branches to production code.
- Classify every new config value first: non-secrets in `settings.yaml`, runtime secrets behind `RuntimeSecretProvider`, and agent credentials behind `AgentCredentialBroker`.
- Model selection must go through the provider-neutral catalog and friendly aliases. Do not accept raw provider model IDs at user/API/job/MCP boundaries unless they are registered aliases; job defaults inherit interactive defaults before falling back to system `opus`. Do not reintroduce legacy Claude model registries or runner-ID defaults in public config paths.
- Native Agent subagents inherit the parent run model by default. Any subagent model override must resolve through the same catalog and stay on the parent provider backend; use a separate session or job for cross-provider delegation.
- Wrong-lane config must fail loudly. Raw provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` must never be accepted from MyClaw `.env` or process env.
- Agent-requested third-party MCP servers use same-channel approval until real admin RBAC exists. Host must verify the origin chat belongs to the requesting agent; approval only decides that pending draft, binds only that agent, and activates next run.
- Treat third-party MCP servers as approved agent capabilities. Durable MCP truth belongs in Postgres definitions, versions, bindings, credential refs, and audit events; Claude SDK `mcpServers` is only a per-run adapter projection.
- Use typed capability catalogs for skills, MCP servers, SDK tools, host tools, browser tools, provider-native channel tools, and conversation bindings; provider or channel flags are metadata, not authorization.
- Agent administration source of truth is Postgres plus application services. Agents own `selectedToolIds`, `selectedSkillIds`, `selectedMcpServerIds`, provider-neutral DM access, and one optional DM approval admin per provider; channels own bound agents, sessions, and control approver allowlists. Do not add channel-scoped tool selections or any separate browser capability list.
- Keep agent DM access, agent DM admins, and conversation approvers distinct. DM access may name any external provider users allowed to DM an agent from Slack, Teams, Telegram, Web, or local surfaces; a DM admin can approve permission prompts only for that agent's direct/private DM sessions on that provider; conversation approvers must be verified members of that Conversation and authorize permission prompts for all agents bound there.
- Public admin API, local CLI, and MyClaw MCP tools are separate adapters over the same services. API is for owner/admin automation, CLI is for local service and setup operations, and MCP tools are for agent-requested reviewed changes.
- Local desired-state configuration belongs in `settings.yaml` and is mediated by `SettingsDesiredStateService`. CLI commands and approved MyClaw admin tools write the file; only agents with selected `settings_desired_state` or `request_settings_update` capabilities may use those tools, and agents must not edit the file or DB directly.
- In personal/local mode, Postgres indexes runtime state, audit, artifacts, and execution data. It is not the source of truth for fields represented under `desired_state.*` or `agents.*` once those settings are present.
- Use Provider for Slack/Teams/Telegram/Web/App, Provider Connection for an installed workspace/bot/tenant/app connection, Conversation for Slack channels/DMs, Teams channels/chats, and Telegram groups/DMs, and Thread/Topic for Slack threads, Teams reply chains, and Telegram forum topics. Conversation approvers govern group/channel approvals; agent DM admins govern only private/direct agent administration.
- Render approvals, questions, files, dependencies, audit summaries, and final decisions through a channel-neutral `InteractionDescriptor` before Slack, Telegram, Teams, or Web/API adapters format them.
- Teams is a first-class channel. Use `teams:` conversation IDs, Teams runtime secrets through `RuntimeSecretProvider`, and Adaptive Card `Action.Execute` approval flows.
- Runtime bootstrap code must not call `getRuntimeStorage()` while constructing wiring objects before `runStartup()` initializes storage. Pass lazy repository accessors or instantiate storage-backed services inside request handlers after startup.
- Agents must use `send_message`, `ask_user_question`, `request_skill_install`, `request_skill_proposal`, `request_skill_dependency_install`, `request_mcp_server`, `request_permission`, `service_restart`, and `register_agent` instead of direct installs, config edits, or legacy tool-enable guidance. Permission decisions are `Allow once`, `Always allow <granular rule>`, or `Cancel`.
- The control API is part of the runtime process. launchd/systemd service definitions should stay secret-free; `MYCLAW_CONTROL_API_KEY(S)_JSON`, `MYCLAW_CONTROL_APP_ID`, `MYCLAW_CONTROL_PORT`, and `MYCLAW_CONTROL_SOCKET_PATH` belong in process env or the runtime `.env`.

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

## Important

- Add or Update AGENTS.md in respective folder with the learnings and corrections
