# Gantry

## What This Repo Is

Gantry is a provider-neutral and channel-neutral agent runtime platform.
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

## Execution Standards

- Always choose the best proven performance technique for the task and context.
- Do not use laid-back approaches or loose thinking; reason precisely and verify assumptions.
- Do the work, critique the work, and make sure the task is completed properly end-to-end.
- Do not take shortcuts. Keep work well-structured, neat, and clean.
- Do not overcomplicate. Make a plan, seal the flaws, and execute that plan through completion.
- Do not bias toward the user's ideas or the agent's first idea. Be logical, push back when warranted, and prefer the simplest correct solution.

## Runtime Modes

- Host runtime is the only supported runtime mode in this repo today.
- The local launchd service label is `com.gantry`; use it for build/restart/status workflows.

Important constraints:

- First-run channel setup creates one default user-facing agent named by `settings.yaml agent.name`; chat IDs and `main_agent` are internal routing conventions, not privilege surfaces.
- `/new` clears persisted session state but preserves the group model override.
- Transcript archive during `/new` is best-effort and must not block reset success.
- Durable memory lives under the configured memory root; do not load `~/gantry/agents/<folder>/memory/`.
- Live channel turns must persist the provider SDK session ID as soon as the runner streams it. Do not wait for runner shutdown; launchd restarts can kill an active run before final completion.
- An Anthropic SDK live turn that completes with zero SDK messages/results is not a successful empty answer; if it resumed a provider session, expire and retry without resume, otherwise surface a real turn failure instead of showing only progress done.
- Provider terminal frames close the current content stream, not the host run; keep cancellability active until the spawned agent process resolves, but do not render Telegram Stop buttons.
- Restored Telegram progress handles can be stale after a launchd restart; a fresh live-turn progress or todo update may replace a restored higher generation for the same chat key.
- In macOS `sandbox_runtime`, Node file watches need `com.apple.FSEvents` Mach lookup; a denied lookup can surface as `EMFILE: too many open files, watch`, so confirm sandbox logs before treating it as a descriptor-limit problem.
- Progress/status messages for long-lived live runs are per user-visible turn: reset elapsed timers and progress generations when continuation input is piped, and do not send follow-up progress from the polling loop.
- Live interactive acknowledgement is agent-authored: host may react `seen` to the triggering message, but must not send static `Working` or elapsed status messages; agents send one short natural acknowledgement with `send_message` and keep multi-step progress in `todo_update`.
- Slack live progress belongs in thread status, not chat text; start with synthetic status, then clear the status at terminal completion so no `Generating response`, gathering/thinking copy, or `Done.` remains after the assistant reply.
- User-visible output must be extracted from provider-supported text deltas/blocks at the adapter boundary. Do not rely on text-prefix filters for reasoning/thinking; omit or ignore provider reasoning blocks before channel delivery and persistence.
- Scheduler notification routes are lifecycle/outcome routes. Do not stream or fallback-deliver raw assistant output to them; send one concise terminal outcome message unless the job is silent.
- Scheduler maintenance must periodically full-sync active jobs so expired leases are released even when no new pg-boss job fires.
- Scheduler execution uses the worker claim protocol: the scheduler creates runnable work, and a registered worker instance claims the run/job lease transactionally (`run_leases` lease token + monotonic fencing version). A worker may not execute without a confirmed claim, and completion/failure/terminal writes are token-fenced — a stale worker whose lease was recovered must drop its writes.
- Startup recovery must not release live leases. Stale recovery only releases leases whose heartbeat/lease expiry has lapsed; a recovered run is retried under a higher fencing version and emits the "Run recovered: previous worker lost its lease; Gantry safely retried this run." notification.
- Scheduler run concurrency slots are cluster-wide `run_slots` rows with expiry (advisory-locked acquire, renewable, reclaimable after holder crash), not process-local Maps.
- Permission and question prompts must create a durable `pending_interactions` row (idempotency-keyed) before the provider prompt renders; provider callbacks resolve that record. Transient approvals are run-lease-scoped `transient_grants` rows that die with the lease and are never durable authority.
- Runner-control events are append-only `runner_control_events` rows, idempotent and replay-protected via `runner_control_nonces`; events are persisted before being exposed externally.
- Scheduler terminal states must leave durable user-visible evidence: persist a `JobRun`, emit terminal runtime events, send a concise outcome notification when routes exist, and persist `notified_at` after successful delivery.
- Jobs paused for missing capabilities must surface one clear user action in job list/status metadata, such as approving `Browser`; do not require users to inspect logs to discover the blocker.
- Scheduler job access metadata must stay runtime-neutral. Put business-specific sheet ids, document ids, accounts, ranges, URLs, and workflow details in the job prompt or job-owned manifest; keep canonical `access_requirements` targets, preflight commands, and setup actions scoped to generic provider/tool readiness such as an installed CLI, auth presence, command template, protected paths, and reviewed capability id.
- Outbound durable delivery recovery startup must claim due items across app scopes; do not hard-code startup recovery claims to `appId: 'default'`.
- Jobs must use canonical `execution_context` and `notification_routes` for runtime execution/delivery targeting; do not add or mirror legacy job-notification alias fields.
- Postgres `pgcrypto` must be installed in `public` schema for shared test/runtime databases; schema-scoped extension installs break `digest()` lookups under per-schema `search_path`.
- Postgres `settings_revisions` is the durable desired-state authority in managed workstation/personal and fleet modes. `settings.yaml` remains the canonical human-readable copy and bootstrap/import/export surface; managed writes must append a revision before syncing the file.
- Deployment entrypoints run the explicit Postgres migrator with `GANTRY_DATABASE_URL` before starting runtime; runtime only asserts migrations are current and must not apply them itself.
- When using Drizzle Postgres upserts, do not assume `onConflictDoUpdate.target` supports SQL expressions; expression-index identities require explicit insert + unique-violation update flows.

## Architecture Rules

- Normalize channel-specific behavior into canonical app, agent, conversation, thread, message, and session concepts.
- Do not add more provider-specific behavior to core runtime.
- Hide LLM and model-provider behavior behind provider ports.
- Route all risky tool execution through deterministic permission evaluation and sandbox policy.
- SDK-managed Bash/file/MCP execution must receive an enforcing sandbox boundary with fail-closed availability and protected-path write denies. In `direct` runner mode this is the Claude SDK sandbox; in `sandbox_runtime` mode this is the whole-runner OS sandbox, because nested SDK/Seatbelt sandboxing is not reliable on macOS. Mark the Claude Code child as already sandboxed in this mode and prefer the resolved `claude` executable on `PATH` when present. The outer sandbox uses broad reads except explicit protected read denies, and must let the generated Claude config directory, per-run temp directory, and Claude Code's uid-scoped temp directory keep SDK session/cache/tool state while protecting stable config files and skill/MCP definitions from writes. On macOS, Go-based approved CLIs need sandbox-runtime's weaker network isolation so TLS verification can reach `com.apple.trustd.agent`; keep that scoped to `sandbox_runtime`. Direct host-owned scheduler scripts are not supported.
- When `NODE_EXTRA_CA_CERTS` is present in the model credential lane, the SDK process may derive neutral TLS trust aliases (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`, `AWS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, and `DENO_CERT`). Already-approved Bash, skill, local CLI, script, and MCP stdio tool calls receive networking only through Gantry's provider-neutral `toolNetworkEnv`; do not pass broker proxies or provider tokens into tool subprocesses.
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
- Every meaningful feature or fix plan must include a Surface Impact Matrix. Classify runtime behavior, `settings.yaml`, Postgres/runtime projection, control API, SDK/contracts, CLI, Gantry MCP tools/admin skill, channel/provider adapters, docs/prompts, audit/events, and tests/verification as `Changed`, `Read-only/observable`, `Unchanged by design`, `Deferred`, or `Not applicable`.
- Every `Deferred` or `Unchanged by design` Surface Impact Matrix entry must include a short reason. Do not leave API, CLI, MCP tools, database projection, docs, or tests implicit.
- For settings-owned config changes, explicitly state whether the change writes `settings.yaml`, reconciles Postgres/runtime projection, and updates API/CLI/MCP/admin-tool surfaces.
- For permission and capability changes, explicitly state whether the change affects transient approval, persistent capability selection, or both.
- Gantry is early-stage: prefer deleting legacy code over compatibility shims because no users are live yet.
- Do not add migration compatibility commands, auto-migration flows, cleanup shims, or runtime branches that exist only to support old local state.
- Remove obsolete code paths in the same change when introducing a breaking replacement.
- Treat cleanup as part of replacement work: remove obsolete active code, schemas, tests, docs, exports, and wiring in the same PR, or retain them with owner, reason, and removal condition.
- Before resolving PR review threads or marking cutover complete, search for old type names, table names, imports, and entrypoints; document why any matches remain.
- Do not add test-only or local-checkout branches to production code.
- Classify every new config value first: non-secrets in `settings.yaml`, runtime secrets behind `RuntimeSecretProvider`, and agent credentials behind `AgentCredentialBroker`.
- New model credential modes must update the provider registry, gateway auth
  hook, CLI/setup prompts, Control API OpenAPI schema, redaction expectations,
  credential docs, and focused tests in the same change. AWS, Google, Azure, or
  other hosted-identity modes are not simple API-key additions: keep signing,
  token minting, and secret-manager resolution inside the Gantry Model Gateway.
- Model selection must go through the provider-neutral catalog and friendly aliases. Public live vocabulary is `modelAlias`, durable `agentHarness` (`auto`, `anthropic_sdk`, or `deepagents`), `responseFamily` (`anthropic` or `openai`), diagnostic `modelRoute`, read-only `executionProviderId`, and `credentialProfileRef`; `settings.yaml` uses `agent_harness`. OpenRouter is its own provider on the DeepAgents/OpenAI-compatible lane, not an Anthropic-family alias. `auto` preserves provider-derived behavior (Claude -> `anthropic_sdk`; OpenAI/OpenRouter/Bedrock/Vertex/future OpenAI-compatible providers -> `deepagents`), while explicit `anthropic_sdk` or `deepagents` is user intent and must fail before runner spawn when the selected model is incompatible. Do not accept raw provider model IDs at user/API/job/MCP boundaries unless they are registered aliases; job defaults inherit interactive defaults before falling back to system `opus`, and jobs/conversations inherit the bound agent harness instead of selecting a job- or conversation-level harness. Do not reintroduce public `agentEngine`, legacy Claude model registries, or runner-ID defaults in public config paths.
- Claude OAuth/subscription credentials are Anthropic-SDK-only. DeepAgents raw authority remains Gantry-owned and wrapped: raw `execute`, raw local filesystem access, raw `.mcp.json`, and raw provider credentials must remain impossible; expose Gantry facades, approvals, sandbox policy, audit, and runtime details instead.
- Native Agent and DeepAgents subagents are internal execution primitives, not a user dashboard or mission-control UI. Users see approvals, final answers, audit/runtime detail, and high-level evidence receipts with exact lines `Completed: <short outcome>`, `Used: <tools/capabilities>`, `Changed: <files/accounts/channels or none>`, `Delegated: yes/no`, and `Needs attention: <blocker or none>`.
- Wrong-lane config must fail loudly. Raw provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` must never be accepted from Gantry `.env` or process env.
- Agent-requested third-party MCP servers use same-channel approval until real admin RBAC exists. Host must verify the origin chat belongs to the requesting agent; approval only decides that pending draft, binds only that agent, and activates next run.
- Treat third-party MCP servers as approved agent capabilities. Durable MCP truth belongs in Postgres definitions, versions, bindings, credential refs, and audit events; Claude SDK `mcpServers` is only a per-run adapter projection.
- Use typed capability catalogs for skills, MCP servers, SDK tools, host tools, browser tools, provider-native channel tools, and conversation bindings; provider or channel flags are metadata, not authorization.
- Skill names are display labels only. Durable settings/API source selections show readable `name` beside exact `skill:<id>` catalog references, but the id is the only authority. Selected skills may materialize only one active runtime directory per agent, `.llm-runtime` skill folders are scratch projections, and the configured `SkillArtifactStore` is durable reviewed history (`artifacts/skills` only for the local backend).
- Agent administration source of truth is the latest `settings_revisions` desired state plus application services, with `settings.yaml` synced as the canonical readable copy. Agents own identity, model/persona defaults, attached `sources`, and selected durable `capabilities`. Conversations own sender policy, trigger policy, control approvers, and agent bindings. Do not add channel-scoped tool selections, per-agent direct-message policy, per-agent direct-message approvers, or any separate browser capability list.
- First-party non-admin Gantry MCP tools are default agent capabilities and must stay visible to ToolSearch/mcp_list_tools even if a stale runner projection is missing them. Gate admin MCP tools such as service restart, settings desired-state/update, and agent registration through selected capabilities plus server-side checks.
- Conversation approvers are the only user-facing approval policy. Direct/private conversations and group/channel conversations both use `sender_policy`, `requires_trigger`, and `control_approvers`; approvers must be verified members of that Conversation and authorize permission prompts for all agents bound there.
- Public admin API, local CLI, and Gantry MCP tools are separate adapters over the same services. API is for owner/admin automation, CLI is for local service and setup operations, and MCP tools are for agent-requested reviewed changes.
- Local desired-state configuration belongs in `settings.yaml` and is mediated by `SettingsDesiredStateService`. CLI commands and approved Gantry admin tools write the file; only agents with selected `settings_desired_state` or `request_settings_update` capabilities may use those tools, and agents must not edit the file or DB directly.
- Revision-owned sync rule: `settings_revisions` is the restart source of truth for agent identity/defaults, attached `sources`, selected durable `capabilities`, provider connections, conversations, sender policies, control approvers, triggers, `requires_trigger`, and agent-conversation bindings. Any Control API, CLI, approved agent/admin-tool path, or accepted `settings.yaml` edit that mutates those fields must append a revision, update runtime projection, and sync `settings.yaml` in the same operation or go through `request_settings_update`.
- Capability sync is bidirectional and immediate: settings-side `sources` and `capabilities` replace stale active Postgres projections, while DB/admin-side capability writes must export readable attached sources and selected approved capabilities back into `settings.yaml` before reporting success.
- In personal/local mode, Postgres indexes runtime state, audit, artifacts, execution data, and desired settings. `settings.yaml` is not the durable authority for fields represented under `desired_state.*`, `agents.*`, provider connections, conversations, or bindings after `settings_revisions` exists.
- Use Provider for Slack/Teams/Telegram/Web/App, Provider Connection for an installed workspace/bot/tenant/app connection, Conversation for Slack channels/DMs, Teams channels/chats, and Telegram groups/DMs, and Thread/Topic for Slack threads, Teams reply chains, and Telegram forum topics. Conversation approvers govern approvals for both direct/private and group/channel conversations.
- Verify provider-specific discovery and runtime behavior against official online provider docs before changing adapters. Slack `users.conversations` supports `exclude_archived`, pagination, and type filters but not a server-side text query, so search text locally after fetching allowed conversations. Microsoft Graph channel listing is setup/discovery only; Teams live channel messaging requires a Teams bot transport. Telegram membership checks should use Bot API primitives such as `getChatMember` and respect their bot-admin limitations.
- Runtime persistence dependencies should use narrow ports such as message, job, session, router-state, chat-metadata, and conversation-route repositories. Keep any all-method storage bundle at the composition root or Postgres adapter boundary; do not reintroduce a monolithic domain/application ops repository.
- Keep live route projection separate from durable `AgentConversationBinding` records. Route-projection rows in shared storage must be explicitly identified and filtered, control API binding enable/update must project whole-conversation routes through a live-only runtime path, and thread-scoped bindings must never register the parent conversation as a whole-conversation route.
- Remote MCP hostname fetches must fail closed until the runtime has a DNS-pinned outbound transport or dispatcher. A single public DNS validation before `fetch(hostname)` is not enough because it can be bypassed by DNS rebinding.
- Render approvals, questions, files, dependencies, audit summaries, and final decisions through a channel-neutral `InteractionDescriptor` before Slack, Telegram, Teams, or Web/API adapters format them.
- Teams is a first-class channel. Use `teams:` conversation IDs, Teams runtime secrets through `RuntimeSecretProvider`, and Adaptive Card `Action.Execute` approval flows.
- Runtime bootstrap code must not call `getRuntimeStorage()` while constructing wiring objects before `runStartup()` initializes storage. Pass lazy repository accessors or instantiate storage-backed services inside request handlers after startup.
- Runtime queue concurrency and retry policy belongs under `runtime.queue` in `settings.yaml` and should be injected into `GroupQueue`; tests should not depend on hard-coded queue timing or concurrency defaults.
- Agents must use `send_message`, `ask_user_question`, `continuity_summary`, `file`, `request_skill_install`, `request_skill_proposal`, `request_skill_dependency_install`, `request_mcp_server`, `request_access`, `agent_profile_read`, `request_agent_profile_update`, `mcp_list_tools`, `mcp_call_tool`, and selected admin tools such as `settings_desired_state`, `request_settings_update`, `admin_permission_list`, `admin_permission_revoke`, `service_restart`, and `register_agent` instead of direct installs, config edits, or raw tool-enable guidance. Profile files (`SOUL.md`, `AGENTS.md`) are edited only through `request_agent_profile_update`, never the generic `file` tool. Durable semantic capability changes use `request_access` (`target.kind=capability`) for reviewed semantic capabilities, Browser, or provider/channel permissions; exact Gantry facade/admin tool changes use `request_access` (`target.kind=tool`) with durable tool names such as `AgentDelegation` or `mcp__gantry__request_settings_update`; and `request_access` (`target.kind=run_command`) requests a scoped `RunCommand(<literal argv pattern>)` fallback when no reviewed semantic capability fits. Permission prompts use `Allow once`, `Allow for future` when a persistent suggestion exists, and `Cancel`. Broad exact SDK/native tools, exact third-party MCP tools, bare persistent `Bash`, `RunCommand`, `Bash(*)`, `RunCommand(*)`, and leading-wildcard command scopes are not durable `request_access` authority. User-defined `local_cli` capabilities require pinned executable identity, preflight, protected paths, denied environment overrides, and reviewed command templates before they project to scoped command authority.
- Agent-facing guidance should positively describe the mounted Gantry tools, such as `todo_update`, `send_message`, `ask_user_question`, `render_*`, scheduler tools, or skill request tools depending on the job. Do not add self-referential negative guidance about nonexistent tools to agent prompts; it can leak into user-visible replies.
- Tool and capability lifecycle is agent-owned. When a live agent is blocked on permission approval or capability selection, do not bypass the flow by editing `settings.yaml`, mutating Postgres, or calling owner/admin Control API endpoints to grant the tool on the agent's behalf. Diagnose logs and code, fix broken approval/persistence/runtime projection paths, and let the agent request the capability from the user through the product flow. Only undo an earlier accidental bypass when explicitly correcting that mistake.
- Prefer semantic capability requests (`request_access` with `target.kind=capability`) for app/tool access. Capabilities must come from reviewed tool, skill, MCP server, adapter, or CLI manifests; do not add source-code hardcoded capability ids for specific products, providers, or CLIs. Use `target.kind=tool` only for exact Gantry facade/admin tools; fall back to raw scoped `RunCommand(...)` only for one-off exact commands or when no reviewed semantic capability exists.
- Scheduler job `local_cli` requirements must include an absolute `executablePath`; `commandTemplate` and any `authPreflight` must start with that exact executable path. Runtime setup may request the generated scoped command rule for that job, but must not convert a CLI implementation binding into a hardcoded semantic capability or broad CLI rule.
- `SandboxNetworkAccess` is an SDK-internal defense-in-depth prompt, never durable authority. Suppress it only with a short-lived run-local token created by an already-approved tool call with a matching parent tool-use id. For scheduled jobs, suppress only when a parentless SDK network prompt arrives immediately after the same principal's approved Bash/RunCommand invocation and matches a host hash derived from that latest run-local token. Persist only the scoped `RunCommand(...)` rule, canonical Browser capability, exact Gantry file/web facade, exact admin MCP tool, or semantic capability instead.
- `permissions.yolo_mode` is the settings-owned denylist backstop for auto-approval paths. Shipped command and path rules merge with user entries. A match must emit a `permission.yolo_denylist_hit` audit event, skip auto-approval, and return to normal explicit approval where the runner can prompt; otherwise deny explicitly. `enabled: false` disables this backstop.
- Egress policy is runtime-owned and provider-neutral. Model provider calls use the Gantry loopback model gateway, while approved outbound tool traffic uses the Gantry loopback egress gateway through `toolNetworkEnv`; `permissions.egress.denylist` is an optional hostname-glob denylist, default egress is allow, and every CONNECT decision must be audited.
- In `sandbox_runtime`, pass Gantry egress to sandbox-runtime as `network.parentProxy`; do not set `network.httpProxyPort` to a host Gantry port, because that bypasses sandbox-runtime's in-sandbox proxy bridge and makes sandboxed children connect to unreachable host loopback ports. Runner-local checkpointer/database access should use the proxy env injected inside the sandbox.
- Browser grants are selected in `settings.yaml` and the public capabilities API as `browser.use`, then translated to the canonical runtime `Browser` tool rule. Runtime projects that capability into Gantry-owned gateway tools (`browser_status`, `browser_open`, `browser_inspect`, `browser_act`, and `browser_close`) with Gantry-owned schemas. Private browser backend details are internal implementation details. Do not persist or expose per-action browser tool names as durable authority.
- The control API is part of the runtime process. launchd/systemd service definitions should stay secret-free; `GANTRY_CONTROL_API_KEYS_JSON`, `GANTRY_CONTROL_PORT`, and `GANTRY_CONTROL_SOCKET_PATH` belong in process env or the runtime `.env`. Control API keys must include explicit `kid`, `token`, `appId`, and `scopes`.
- Production or remote startup must fail closed when runtime secret material is missing or weak. Local-only fallbacks such as ephemeral IPC auth or auto-accept flags must never apply when `NODE_ENV=production`, an explicit remote/production deployment mode is set, or TCP control binds to a non-loopback host.
- Control plane owns authority. Workers, providers, model output, harness settings, browser backends, MCP inventory, and skill inventory are untrusted evidence or execution surfaces; they must not create, widen, persist, or revoke permissions without a Gantry-owned policy decision.
- Don't fight errors! Whenever you encounter the same error twice, research the web and find 3-5 possible ways to fix it. Then choose the most efficient solution and implement it.

## Docs Rules

- User-facing and project-facing docs must use `Gantry` naming.
- Public GitHub repository metadata and clone URLs must use
  `https://github.com/cawstudios/Agent.Gantry`, not old moved repository URLs.
- Existing code identifiers, package names, CLI binaries, environment variables,
  paths, MCP tool names, and database schema names that still contain `gantry`
  are literal implementation names until an explicit rename task changes them.
  Do not rewrite those literals casually in docs or tests.
- Do not reintroduce legacy branding in active docs or instructions.
- Avoid fork/upstream framing in active guidance. Prefer neutral repo, branch, or shared-remote wording.
- Prefer local repo docs over speculative external docs links unless the external target is verified current.
- For major arch changes, update `docs/architecture/` or `docs/decisions/`.
- When docs policy changes, update this file in the same PR.
- When documenting agent-facing Gantry MCP tool surfaces, use
  `apps/core/src/runner/gantry-mcp-tool-surface.ts` and
  `apps/core/src/shared/admin-mcp-tools.ts` as the source of truth before
  copying tool lists into README, SDK, architecture, or security docs.

## Verification Rules

- Discover and document exact verification commands before changing implementation behavior.
- Run the smallest relevant checks after each change.
- Run full checks at the end of a phase.
- For Postgres-backed verification, use a disposable Docker Postgres container
  for each task instead of the developer's persistent `~/gantry/postgres` data.
  The disposable database must enable the same bootstrap extensions as local
  Compose before migrations run: `CREATE EXTENSION IF NOT EXISTS vector;` and
  `CREATE EXTENSION IF NOT EXISTS pg_trgm;`. Point tests at it with
  `GANTRY_TEST_DATABASE_URL`, then stop/remove the container after the check.
- Before validating `~/gantry`, build/restart from this checkout, confirm `gantry status`, and treat older generated logs/state as stale.
- Archive stale generated state under `~/gantry/cleanup-archive/<timestamp>/`; keep secrets, settings, Postgres data, Credential Center rows, artifacts, and active agent folders unless reset is requested.
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
