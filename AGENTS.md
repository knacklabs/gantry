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

- First-run channel setup creates one default user-facing agent named by `settings.yaml agent.name`; chat IDs and `main_agent` are internal routing conventions, not privilege surfaces.
- `/new` clears persisted session state but preserves the group model override.
- Transcript archive during `/new` is best-effort and must not block reset success.
- Durable memory lives under the configured memory root; do not load `~/myclaw/agents/<folder>/memory/`.
- Live channel turns must persist the provider SDK session ID as soon as the runner streams it. Do not wait for runner shutdown; launchd restarts can kill an active run before final completion.
- Progress/status messages for long-lived live runs are per user-visible turn: reset elapsed timers and progress generations when continuation input is piped, and do not send follow-up progress from the polling loop.
- Scheduler notification routes are lifecycle/outcome routes. Do not stream or fallback-deliver raw assistant output to them; send one concise terminal outcome message unless the job is silent.
- Scheduler maintenance must periodically full-sync active jobs so expired leases are released even when no new pg-boss job fires.
- Scheduler terminal states must leave durable user-visible evidence: persist a `JobRun`, emit terminal runtime events, send a concise outcome notification when routes exist, and persist `notified_at` after successful delivery.
- Jobs paused for missing capabilities must surface one clear user action in job list/status metadata, such as approving `Browser`; do not require users to inspect logs to discover the blocker.
- Outbound durable delivery recovery startup must claim due items across app scopes; do not hard-code startup recovery claims to `appId: 'default'`.
- Jobs must use canonical `execution_context` and `notification_routes` for runtime execution/delivery targeting; do not add or mirror legacy job-notification alias fields.
- Postgres `pgcrypto` must be installed in `public` schema for shared test/runtime databases; schema-scoped extension installs break `digest()` lookups under per-schema `search_path`.
- When using Drizzle Postgres upserts, do not assume `onConflictDoUpdate.target` supports SQL expressions; expression-index identities require explicit insert + unique-violation update flows.

## Architecture Rules

- Normalize channel-specific behavior into canonical app, agent, conversation, thread, message, and session concepts.
- Do not add more provider-specific behavior to core runtime.
- Hide LLM and model-provider behavior behind provider ports.
- Route all risky tool execution through deterministic permission evaluation and sandbox policy.
- SDK-managed Bash/file/MCP execution must receive Claude SDK sandbox settings with fail-closed availability and protected-path `denyWrite` entries; direct host-owned scheduler scripts are not supported.
- When `NODE_EXTRA_CA_CERTS` is present in the Claude SDK model credential lane, the SDK process and already-approved Bash tool calls may receive only neutral TLS trust aliases (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`, `AWS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, and `DENO_CERT`) for that same CA bundle path; do not pass broker proxies or provider tokens into tool subprocesses.
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
- Agent administration source of truth is Postgres plus application services. Agents own identity, model/persona defaults, and selected capability ids (`selectedToolIds`, `selectedSkillIds`, `selectedMcpServerIds`). Conversations own sender policy, trigger policy, control approvers, and agent bindings. Do not add channel-scoped tool selections, per-agent direct-message policy, per-agent direct-message approvers, or any separate browser capability list.
- First-party non-admin MyClaw MCP tools are default agent capabilities and must stay visible to ToolSearch/mcp_list_tools even if a stale runner projection is missing them. Gate admin MCP tools such as service restart, settings desired-state/update, and agent registration through selected capabilities plus server-side checks.
- Conversation approvers are the only user-facing approval policy. Direct/private conversations and group/channel conversations both use `sender_policy`, `requires_trigger`, and `control_approvers`; approvers must be verified members of that Conversation and authorize permission prompts for all agents bound there.
- Public admin API, local CLI, and MyClaw MCP tools are separate adapters over the same services. API is for owner/admin automation, CLI is for local service and setup operations, and MCP tools are for agent-requested reviewed changes.
- Local desired-state configuration belongs in `settings.yaml` and is mediated by `SettingsDesiredStateService`. CLI commands and approved MyClaw admin tools write the file; only agents with selected `settings_desired_state` or `request_settings_update` capabilities may use those tools, and agents must not edit the file or DB directly.
- Restart-owned sync rule: `settings.yaml` is the restart source of truth for agent identity/defaults, selected capabilities (`tools`, `skills`, `mcp_servers`), provider connections, conversations, sender policies, control approvers, triggers, `requires_trigger`, and agent-conversation bindings. Any Control API, CLI, or approved agent/admin-tool path that mutates those fields must update `settings.yaml` in the same operation or go through `request_settings_update`; Postgres/runtime rows are projections and must never be the only durable copy.
- Capability sync is bidirectional and immediate: settings-side capability lists replace stale active Postgres bindings, while DB/admin-side capability writes must export readable tools, skills, and MCP servers back into `settings.yaml` before reporting success.
- In personal/local mode, Postgres indexes runtime state, audit, artifacts, and execution data. It is not the source of truth for fields represented under `desired_state.*` or `agents.*` once those settings are present.
- Use Provider for Slack/Teams/Telegram/Web/App, Provider Connection for an installed workspace/bot/tenant/app connection, Conversation for Slack channels/DMs, Teams channels/chats, and Telegram groups/DMs, and Thread/Topic for Slack threads, Teams reply chains, and Telegram forum topics. Conversation approvers govern approvals for both direct/private and group/channel conversations.
- Verify provider-specific discovery and runtime behavior against official online provider docs before changing adapters. Slack `users.conversations` supports `exclude_archived`, pagination, and type filters but not a server-side text query, so search text locally after fetching allowed conversations. Microsoft Graph channel listing is setup/discovery only; Teams live channel messaging requires a Teams bot transport. Telegram membership checks should use Bot API primitives such as `getChatMember` and respect their bot-admin limitations.
- Runtime persistence dependencies should use narrow ports such as message, job, session, router-state, chat-metadata, and conversation-route repositories. Keep any all-method storage bundle at the composition root or Postgres adapter boundary; do not reintroduce a monolithic domain/application ops repository.
- Keep live route projection separate from durable `AgentConversationBinding` records. Route-projection rows in shared storage must be explicitly identified and filtered, control API binding enable/update must project whole-conversation routes through a live-only runtime path, and thread-scoped bindings must never register the parent conversation as a whole-conversation route.
- Remote MCP hostname fetches must fail closed until the runtime has a DNS-pinned outbound transport or dispatcher. A single public DNS validation before `fetch(hostname)` is not enough because it can be bypassed by DNS rebinding.
- Render approvals, questions, files, dependencies, audit summaries, and final decisions through a channel-neutral `InteractionDescriptor` before Slack, Telegram, Teams, or Web/API adapters format them.
- Teams is a first-class channel. Use `teams:` conversation IDs, Teams runtime secrets through `RuntimeSecretProvider`, and Adaptive Card `Action.Execute` approval flows.
- Runtime bootstrap code must not call `getRuntimeStorage()` while constructing wiring objects before `runStartup()` initializes storage. Pass lazy repository accessors or instantiate storage-backed services inside request handlers after startup.
- Runtime queue concurrency and retry policy belongs under `runtime.queue` in `settings.yaml` and should be injected into `GroupQueue`; tests should not depend on hard-coded queue timing or concurrency defaults.
- Agents must use `send_message`, `ask_user_question`, `request_skill_install`, `request_skill_proposal`, `request_skill_dependency_install`, `request_mcp_server`, `capability_search`, `request_capability`, `propose_local_cli_capability`, `manage_capability`, `request_permission`, `service_restart`, and `register_agent` instead of direct installs, config edits, or legacy tool-enable guidance. Permission decisions are `Allow once`, `Always allow for this agent/job` for semantic capabilities, `Always allow Browser`, `Always allow mcp__myclaw__<admin_tool>`, `Always allow Bash(<literal command prefix pattern>)`, and `Cancel`; broad exact SDK/native tools, exact third-party MCP tools, bare persistent `Bash`, `Bash(*)`, and leading-wildcard Bash scopes are not durable `request_permission` authority. User-defined `local_cli` capabilities are reviewable drafts until runtime enforcement verifies executable identity, preflight, protected paths, and denied environment overrides.
- Prefer semantic capability requests (`capability_search`, `request_capability`, `propose_local_cli_capability`, and `manage_capability`) for app/tool access such as Google Sheets, Gmail, or business CLIs. Fall back to raw scoped `Bash(...)` only for one-off exact commands or when no reviewed semantic capability exists.
- `SandboxNetworkAccess` is an SDK-internal defense-in-depth prompt, never durable authority. Suppress it only with a short-lived run-local token created by an already-approved Bash tool call; persist the scoped Bash rule or semantic capability instead.
- Browser grants persist only as canonical `Browser`. Runtime projects that capability into MyClaw-owned gateway tools (`browser_status`, `browser_open`, `browser_inspect`, `browser_act`, and `browser_close`) with MyClaw-owned schemas. Private browser backend details are internal implementation details. Do not persist or expose per-action browser tool names as durable authority.
- The control API is part of the runtime process. launchd/systemd service definitions should stay secret-free; `MYCLAW_CONTROL_API_KEYS_JSON`, `MYCLAW_CONTROL_PORT`, and `MYCLAW_CONTROL_SOCKET_PATH` belong in process env or the runtime `.env`. Control API keys must include explicit `kid`, `token`, `appId`, and `scopes`.
- Don't fight errors! Whenever you encounter the same error twice, research the web and find 3-5 possible ways to fix it. Then choose the most efficient solution and implement it.

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
- For Postgres-backed verification, use a disposable Docker Postgres container
  for each task instead of the developer's persistent `~/myclaw/postgres` data.
  The disposable database must enable the same bootstrap extensions as local
  Compose before migrations run: `CREATE EXTENSION IF NOT EXISTS vector;` and
  `CREATE EXTENSION IF NOT EXISTS pg_trgm;`. Point tests at it with
  `MYCLAW_TEST_DATABASE_URL`, then stop/remove the container after the check.
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
