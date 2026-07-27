# LAT-1 Bounded Concurrent Remote MCP Startup Plan

## Problem
The DeepAgents inline lane currently connects and lists configured remote MCP
servers one at a time in `connectRemoteMcpTools(...)`. For a turn with multiple
approved remote MCP servers, first visible output waits on the sum of all MCP
connect/list delays instead of the slowest bounded batch.

The response-latency roadmap explicitly scopes Phase 1 to bounded concurrent
remote MCP startup on branch `perf/parallel-inline-mcp-startup`. The task is
runtime behavior, not a broad warm-resource cycle.

Product model: a selected remote MCP source is reviewed per agent, materialized
for the current turn, connected through Gantry's guarded transport, exposed as
deterministically ordered LangChain tools, and closed before the turn exits or
after setup failure.

## Scope / Non-goals
In scope:

- DeepAgents inline lane remote MCP startup only.
- A red-first unit contract proving five configured servers start with local
  concurrency limit 4: the first four starts overlap, the fifth waits, and final
  tool order still follows configured server/tool order.
- Preserve guarded fetch, configured headers, SSE vs Streamable HTTP transport
  selection, host denylist checks, abort checks, reviewed wildcard filtering,
  authorization before tool invocation, tool activity audit, and close-on-success.
- On setup failure, wait for already-started work to settle before cleanup, then
  close every connected client exactly once.

Non-goals:

- Checkpoint pool reuse, reusable warm MCP clients, or any cross-turn resource
  pool.
- Anthropic SDK inline lane changes.
- Spawned DeepAgents runner startup reuse.
- Provider gateway, permission policy, storage schema, Control API, SDK, CLI, or
  channel behavior changes.
- Real remote MCP network dependency in tests.
- Changes to Phase 0 harness files or optional checkpoint-pool experiments.

Bounded write scope for implementation:

- `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`
- `apps/core/test/unit/adapters/deepagents-inline-lane.test.ts`

## Acceptance Criteria
- With five remote MCP servers in a unit test, at most four `Client.connect`
  calls are active at once, and the fifth does not start until one of the first
  four completes.
- The concurrency contract fails against the current serial implementation before
  the production change.
- Final `createDeepAgent({ tools })` ordering remains deterministic: core tools
  first, then remote MCP tools grouped by configured server order and per-server
  `loadMcpTools(...)` order.
- Guarded fetch and configured headers are still passed to both SSE and
  Streamable HTTP transports.
- Denylisted hosts fail before any client is created for that server.
- Abort before a server starts prevents further startup.
- If any connect/list/filter step fails, already-started server work settles and
  every connected client is closed once; no late client leaks after the function
  rejects.
- Remote MCP tool execution semantics are unchanged: reviewed wildcard filtering,
  per-call authorization, attempt/success/failure audit events, and string/JSON
  result normalization continue to pass existing tests.
- No new dependency is added for concurrency limiting.

## Technical Approach
Recommendation: keep the limiter local to `inline-lane/index.ts` and run server
startup tasks with a fixed limit of 4. This is the smallest shape that satisfies
the approved Phase 1 contract without adding a shared utility for one call site.

Implementation outline:

1. Extract the per-server serial body into a small local async helper that returns
   `{ index, clients, tools }` or no tools for unsupported transports.
2. Before each server task starts, preserve the existing checks:
   `signal.throwIfAborted()` and `assertMcpNetworkHostAllowed(...)`.
3. Start tasks through a tiny local limit runner with concurrency 4. Do not add
   `p-limit`; there is no existing dependency and this is a single use.
4. Keep each server's connect and list-tools sequence ordered within that server.
   Concurrency is across servers only.
5. Collect results by original input index and flatten tools in that order. This
   preserves deterministic model-visible tool order even when faster servers
   finish first.
6. Track all clients created by started tasks. If any task rejects, wait for
   started tasks to settle before closing connected clients, then rethrow the
   original failure. This prevents late connections from escaping cleanup.
7. Keep returned `close()` behavior as one close call per connected client.

Rejected simpler shape: `Promise.all(servers.map(...))` is shorter but unbounded,
which violates the Phase 1 limit and can create too many simultaneous outbound
connections. A shared generic concurrency helper is also rejected for now because
there is no second production call site in scope.

## Decisions
- `docs/decisions/0070-client-signoff.md` records accepted LAT-1 client signoff,
  the stacked rebase dependency, the limit-4 startup scope, and the explicit
  non-goals.
- No new technical decisions beyond the LAT-1 signoff. The implementation uses
  existing architecture: DeepAgents owns this adapter seam, Gantry owns remote
  MCP guarded fetch and policy, and no public contract changes.

## Surface Impact
| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Changed | DeepAgents inline remote MCP server startup changes from serial to bounded concurrent setup with deterministic output order. |
| `settings.yaml` | Unchanged by design | No settings keys or deployment knobs are introduced; limit 4 is phase-scoped runtime code. |
| Postgres/runtime projection | Unchanged by design | Existing selected MCP materialization rows are read as before; no schema or repository behavior changes. |
| Control API | Unchanged by design | MCP server catalog, selection, and admin APIs keep the same contract. |
| SDK/contracts | Unchanged by design | No generated SDK or public contract fields change. |
| CLI | Unchanged by design | No CLI commands or setup flows change. |
| Gantry MCP tools/admin skill | Unchanged by design | Gantry MCP tool names, request flows, and permission semantics are unchanged. |
| Channel/provider adapters | Changed | Only the DeepAgents inline provider adapter changes internal startup scheduling; Anthropic SDK and channels are unchanged. |
| Docs/prompts | Changed | Adds LAT-1 signoff, plan, and decomposition artifacts; no product docs or prompt copy changes. |
| Audit/events | Read-only/observable | Existing remote MCP tool activity audit remains; startup concurrency adds no new event type. |
| Tests/verification | Changed | Adds focused unit contracts for concurrency, ordering, cleanup, abort, and existing behavior preservation. |

## Task Decomposition
Stage `LAT-1-RED-CONTRACT`

- Objective: add the failing unit contract before production edits.
- Write scope:
  - `apps/core/test/unit/adapters/deepagents-inline-lane.test.ts`
- Dependencies: none.
- Acceptance criteria:
  - The test configures five HTTP/SSE remote MCP servers.
  - The mocked `Client.connect` barrier proves four starts are active before the
    fifth starts and the fifth waits until one completes.
  - The test asserts deterministic final remote tool ordering by configured
    server order, not completion order.
  - Run the focused unit test and record that it fails on the current serial
    implementation for the concurrency expectation.
- Reviewer focus: test proves the actual critical path and cannot pass on serial
  startup by accident.

Stage `LAT-1-IMPLEMENT-CLEANUP`

- Objective: implement bounded concurrent startup and remove any duplicate serial
  code left by the extraction.
- Write scope:
  - `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`
  - `apps/core/test/unit/adapters/deepagents-inline-lane.test.ts`
- Dependencies:
  - `LAT-1-RED-CONTRACT`
- Acceptance criteria:
  - Limit is exactly 4.
  - Unsupported transports are skipped without occupying final tool order.
  - Denylist and abort remain fail-closed before connect.
  - Failure path waits for started work to settle, closes all connected clients,
    and rethrows the original setup error.
  - Existing remote MCP tests for filtering, authorization, audit, and close pass.
- Reviewer focus: no unbounded `Promise.all`, no new dependency, deterministic
  flattening by input index, no late client leak on reject.

Stage `LAT-1-VALIDATION-CLOSEOUT`

- Objective: run and record the implementation proof required by the factory.
- Write scope:
  - `.factory/tests.json` via `record_test_from_json.py`
  - no production or test source edits
- Dependencies:
  - `LAT-1-IMPLEMENT-CLEANUP`
- Acceptance criteria:
  - Focused unit proof passes.
  - Typecheck/format/architecture checks are either passed or explicitly recorded
    as blocked with exact command output.
  - Runtime PR checkout-bound KnackLabs smoke is run before PR-ready, or the
    blocker is recorded if the environment cannot run it.
- Reviewer focus: evidence matches the runtime-behavior scope and does not claim
  skipped heavy gates as passing.

## Risks
- A naive concurrent implementation can return tools in completion order, making
  model-visible tool order nondeterministic. Mitigation: retain original index
  and flatten sorted results.
- A rejected task can leave later-started clients open if cleanup runs before
  started tasks settle. Mitigation: wait for started work to settle before
  closing tracked clients.
- Unbounded concurrency would move latency but create resource and egress spikes.
  Mitigation: fixed limit 4 and a five-server test proving the fifth waits.
- The branch is stacked on Phase 0. After Phase 0 merges, rebase must preserve
  `0069-client-signoff.md` for LAT-0 and `0070-client-signoff.md` for LAT-1.
- Full deterministic verify may be heavy because `verify.py` runs structural,
  typecheck, and `npm test`. Planning does not run it; implementation must record
  exact blockers if environment limits appear.

## Verify Plan
During implementation:

```bash
npm run test:unit -- apps/core/test/unit/adapters/deepagents-inline-lane.test.ts
npm run test:unit -- apps/core/test/unit/adapters/remote-mcp-provider-proxy.test.ts
npm run format:check
npm run typecheck
npm run check:architecture
```

Before PR-ready:

```bash
/opt/homebrew/bin/python3 .agents/scripts/verify.py
scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e --timeout-sec 900
```

Implementation must record automated test evidence through
`record_test_from_json.py`. Review remains one branch-wide autoreview pass with
quality, performance, and security artifacts; no inline or nested review.
