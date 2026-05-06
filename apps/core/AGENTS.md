# Apps Core

## Scope

- `apps/core/src/` contains the runtime, routing, session, memory, and storage code for MyClaw.

## Rules

- Keep runtime imports aligned with the split domains under `apps/core/src/` rather than rebuilding root wrapper modules.
- Service changes must keep `ops/bootstrap.sh`, `ops/launchd/com.myclaw.plist`, and runtime diagnostics consistent.
- CLI onboarding code in `apps/core/src/cli/` must remain runtime-home based (`MYCLAW_HOME`) and must not assume repo cwd.
- Keep prompt rendering separate from side-effect modules so onboarding behavior stays testable.
- `myclaw` CLI commands should return actionable plain-English recovery guidance instead of raw startup failures.
- When path-sensitive code changes, update the matching tests in `apps/core/src/**/*.test.ts` in the same change.
- Integration tests for runtime features must use shared harnesses under `apps/core/test/harness/`; DB-backed cases must guard on `MYCLAW_TEST_DATABASE_URL` and isolate schemas.
- Run `npm run test:integration:postgres` for DB-backed feature work. A plain `npm run test:integration` is allowed to skip those suites when the local Postgres test URL is absent.
- Claude Agent SDK boundary tests must stay hermetic: mock the SDK provider, assert generated options at the adapter boundary, and never require real Anthropic auth.
- Control HTTP route changes must have route-level coverage for encoded ids, app ownership checks, and pre-mutation authorization.
- Agent admin changes must keep provider-specific DM admins separate from conversation approvers; the same agent can span Slack, Teams, Telegram, or Web, but approval authority stays on provider/conversation ids.
- Persist canonical provider ids (`telegram`, `slack`, `teams`, `app`) in provider connections, messages, and participants. Short tokens such as `tg:` and `sl:` are JID prefixes only; normalize them before permission or membership checks.
- External ingress `session_message` dispatch must register the session group before enqueueing message checks; ingress and control adapters should share the same session interaction intent.
- External ingress target policy must mirror dispatch precedence: when `sessionId` is present, authorize only against `sessionIds`; use `conversationIds` only when no `sessionId` was supplied.
- SSE route writes that wait for backpressure must also unblock on response close/error and release subscriptions/active counters.
- Periodic external ingress retention and recovery sweeps must be bounded per timer tick; do not delete or update an unbounded backlog in one maintenance pass.
- MCP server changes must keep third-party servers behind approved Postgres definitions and agent bindings. Do not load `.mcp.json`, Claude user/project settings, raw stdio commands, or raw credential env as product truth.
- Third-party MCP materialization must fail closed for non-HTTPS/private/local URLs, remote hosts that resolve to private/link-local/loopback/multicast/metadata ranges, unsandboxed stdio templates, and non-broker credential refs.
- Treat MCP `allowedToolPatterns` as an enforced allowlist, not metadata. Auto-approved MCP tools must remain a subset of the allowed tools, and same-channel rebinds must preserve any existing admin permission policies unless an admin explicitly replaces them.
- Agent-requested MCP credential needs are labels only. Never let the agent select arbitrary broker env keys; map them into server-scoped refs before approval and materialization.
- MCP runner handoff files contain resolved credentials. Write them only after spawn preconditions pass and remove them in host cleanup paths; `npx-package` stdio templates may accept only one safe npm package argument.
- Resolved third-party MCP credentials must not be serialized into long-lived process env; use a private per-run handoff and keep SDK tool env sanitized.
- Broker model proxy and CA values belong only in the model SDK credential lane. Keep general runner, script, browser, and MCP env tool-agnostic; `NO_PROXY` is compatibility only, not a safety boundary.
- Model-provider credentials are shared Model Access credentials. Resolve chat runs, subagents, memory, and jobs through the reserved `myclaw-model-access` broker profile with `purpose=model_runtime`; do not add per-agent or `main-agent` fallback model credential bindings. Tool/API credentials must use `purpose=tool_capability` with explicit agent/capability context.
- Autonomous scheduler jobs must never use chat permission IPC during execution. Resolve target-agent tools at run time, merge only approved job-scoped extras from `targetJson.capabilityPolicy.allowedTools`, and fail fast with `tool not on autonomous job allowlist` when a scheduled run requests anything outside that effective set.
- Agent-facing scheduler MCP tools must authorize jobs by both calling agent group and originating conversation (`group_scope` plus `linked_sessions`). Threads/topics are delivery metadata only and must not grant scheduler job visibility or run authority.
- Do not expose scheduler MCP list filters that the host will ignore. If an MCP tool is always scoped to the authenticated conversation, keep agent-facing schemas scoped the same way.
- Host runner sync code must work with npm workspace hoisting and installed package layouts; do not assume `packages/agent-runner/node_modules` exists.
- Files under `apps/core/src/app/bootstrap/` own composition and wiring only; runtime behavior must live in `runtime/`, `jobs/`, `session/`, `platform/`, `messaging/`, `memory/`, or infrastructure modules.
- Channel provider catalog flags must match executable behavior: do not advertise `install` or `discover` unless the CLI/control path can actually perform setup or discovery, and document any remaining runtime adapter seam explicitly.
- Permission approval suggestion synthesis must be tool-agnostic. Preserve exact tool names and infer only one displayed scope from generic request fields; do not special-case Bash, file, web, browser, MCP, or provider-native tools.
- Keep the architecture simple, do not over complicate
- Search Anthropic SDK in node modules and do not reinvent what already exists.
