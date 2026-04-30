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
- Host runner sync code must work with npm workspace hoisting and installed package layouts; do not assume `packages/agent-runner/node_modules` exists.
- Files under `apps/core/src/app/bootstrap/` own composition and wiring only; runtime behavior must live in `runtime/`, `jobs/`, `session/`, `platform/`, `messaging/`, `memory/`, or infrastructure modules.
- Keep the architecture simple, do not over complicate
- Search Anthropic SDK in node modules and do not reinvent what already exists.
