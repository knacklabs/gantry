---
name: cap-1-null-undefined-metabug
description: CAP-1 closeout regression = Postgres NULL vs domain-undefined in MCP binding scope; hidden by credential-free verify gate
metadata:
  type: project
---

CAP-1 (capability-authoring closeout) had a real regression the credential-free
`verify.py`/`npm test` gate could not see (postgres/e2e lanes are skipped — the
standing meta-bug, see [[e2e-required-for-merges]]).

**Root cause:** Postgres stores an unscoped agent MCP binding with
`conversationId`/`threadId` = NULL, but the domain type `AgentMcpServerBinding` is
`conversationId?`/`threadId?` (undefined = unscoped) and scope checks test
`=== undefined`. `mapBinding` in `mcp-server-repository.postgres.ts` cast NULL
straight through, so `mcpBindingMatchesRouteScope` saw the null-scoped binding as
conversation-scoped and rejected it → "MCP source not active for this agent" and
empty projected-tool surface. In-memory unit tests pass `undefined` (green); the
Postgres lanes returned `null` (red). Fix: coerce NULL→undefined at the mapBinding
hydration choke point (one place, all consumers). Two tests were fixed by this:
mcp-capability-authoring integration (new) + mcp-client-loop e2e (on main).

**Also:** the integration test read a fire-and-forget review's approval mock
eagerly; fixed with `vi.waitFor` + an `expectPrompt` flag (out-of-scope calls skip
the wait). And a line-budget nudge (prettier reflow) → moved
`MCP_TOOL_PROXY_CLIENT_ADAPTERS` to `mcp-tool-proxy-connection.ts`.

**Diagnosis tip:** the fire-and-forget review `void (async()=>...)` swallows errors;
instrument the `reject()`/gate sites with console.error to surface which gate
fires. `job-lifecycle.agent-e2e` fails locally on near-main too (packaged-runtime
env sensitivity), NOT a CAP-1 regression — gate it on CI.
