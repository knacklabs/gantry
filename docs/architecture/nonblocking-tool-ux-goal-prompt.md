# Non-Blocking Tool UX Goal Prompt

Use this prompt to implement Gantry-owned async task UX for long-running Bash,
delegated agent, and MCP work without changing the LLM loop into a fake
concurrent thinker.

```text
/goal Implement non-blocking tool UX for Gantry using durable async tasks.

Product contract:
Gantry agents keep short, result-critical tools synchronous, but start
long-running or parallelizable work as durable Gantry tasks. Starting async work
returns a Gantry task id immediately. The user sees one coalesced task-status
surface per task, can continue talking to the main agent, and can inspect or
cancel work through Gantry task tools after compaction or restart.

Current repo truth:
- `async_run_command` already starts approved long-running Bash as
  `agent_async_tasks.kind = async_command`.
- `delegate_task` already starts durable child agent work as
  `agent_async_tasks.kind = delegated_agent`, gated by `AgentDelegation`.
- `task_get`, `task_list`, `task_cancel`, and `task_message` are the shared task
  control tools.
- `mcp_call_tool` is currently synchronous: the runner waits for the MCP result.
- `agent_async_tasks.kind` is plain text in Postgres, so adding a new task kind
  should not need a migration unless implementation discovers a missing field.
- Live channel progress is per visible turn; async task heartbeats must not reset
  the main turn's progress generation.

Locked scope:
- Add a new Gantry MCP tool named `async_mcp_call`.
- Keep `mcp_call_tool` synchronous and behavior-compatible.
- Add `mcp_tool_call` as an `AsyncTaskKind`.
- Reuse `agent_async_tasks`; do not create a parallel task table.
- Reuse the existing task control tools; do not add `async_mcp_get`,
  `async_mcp_cancel`, or `task_update`.
- Do not add a dashboard, mission-control UI, recursive delegation, or new
  `settings.yaml` keys.
- Do not expose provider task ids, MCP client internals, SDK session ids, child
  pids, lease tokens, fencing versions, raw correlation JSON, or raw provider
  async tool names.
- Do not expose DeepAgents raw async tools (`start_async_task`,
  `check_async_task`, `update_async_task`, `cancel_async_task`,
  `list_async_tasks`) or Anthropic raw `Agent`/`Task` as public authority.

Agent behavior contract:
- Use `mcp_call_tool` only when the result is needed before the next answer.
- Use `async_mcp_call`, `async_run_command`, or `delegate_task` for long-running,
  parallelizable, or user-visible background work.
- After starting async work, return control to the user unless useful independent
  work remains.
- Do not immediately poll a task in a loop after starting it.
- Call `task_get` or `task_list` before reporting task status.
- Use `task_message` only for delegated agent tasks.
- The LLM loop remains step-based: think -> tool call(s) -> tool result(s) ->
  think -> response/tool. Multiple async task starts may be emitted in one model
  step and run concurrently, but synchronous tools still block that model step.

Implementation requirements:
1. Extend the task domain with `mcp_tool_call`.
2. Register `async_mcp_call` only when async task support is mounted.
3. Implement `async_mcp_call` by validating the same app, agent,
   conversation/thread, reviewed MCP source/action access, run lease, DNS/egress,
   and audit rules as `mcp_call_tool`.
4. Create the durable `agent_async_tasks` row before invoking the remote MCP
   tool.
5. Execute the MCP call in the background, persist heartbeat/progress, and write
   a host-enforced terminal receipt.
6. Keep MCP task public status bounded and sanitized: server/tool name, short
   argument summary, phase, blocker, heartbeat/elapsed, bounded result/error
   summary, and receipt lines only.
7. Make cancellation honest:
   - If the MCP client path cleanly supports `AbortSignal`, wire it through.
   - Otherwise, mark the Gantry task cancelled, close the cached client when
     possible, and ignore late results through fenced terminal transitions.
   - Never claim a remote side effect stopped unless Gantry actually aborted it.
8. Add host-owned task-status rendering keyed by task id. Coalesce running
   updates, flush `needs_attention` and terminal receipts immediately, and do
   not turn every heartbeat into a chat message.
9. Ensure async task status rendering does not reset live-turn progress
   generation or elapsed timers.
10. Update agent prompt/docs so agents choose sync vs async tools correctly.

Exact UX copy:
- Async MCP start accepted: `Started: <server>.<tool>`
- Status loaded: `Task loaded.`
- List loaded: `Listed <n> async task(s).`
- Cancel before remote work or abort success: `Task was cancelled. Nothing else changed.`
- Cancel after MCP may have started: `Task was cancelled in Gantry. Remote MCP work may have already run; late results will be ignored.`
- Sync MCP still uses existing `mcp_call_tool` result/failure formatting.
- Provider-private detail requested: `Provider task details are internal. Use the Gantry task id to check status or cancel.`
- Terminal receipt lines:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities or none>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: yes/no`
  - `Needs attention: <blocker or none>`

Acceptance criteria:
1. `async_mcp_call` starts a durable `mcp_tool_call` task and returns before the
   MCP tool completes.
2. `mcp_call_tool` remains synchronous and behavior-compatible.
3. `task_get`, `task_list`, and `task_cancel` work for `async_command`,
   `delegated_agent`, and `mcp_tool_call`.
4. Running MCP task status exposes only bounded, sanitized public fields.
5. Cancelled MCP tasks cannot be overwritten by late success or failure results.
6. Async task heartbeats update durable task state and coalesced task status
   surfaces without chat spam.
7. Async task heartbeats do not reset live-turn progress generation.
8. Agents can start multiple async tasks in one model step and inspect each by
   task id later.
9. Raw provider async/subagent names stay out of settings, public API, CLI,
   MCP/admin docs, and user-facing prompts except denylist tests or historical
   architecture context.
10. Plain Codex and ACP/ACPX integrations both work; do not assume ACP is
    present.

Surface Impact Matrix:
- Runtime behavior: Changed. Adds direct async MCP task execution and
  host-rendered task status.
- `settings.yaml`: Unchanged by design. Existing async task mounting and
  selected capabilities are enough.
- Postgres/runtime projection: Changed. Reuses `agent_async_tasks` with new
  `mcp_tool_call` kind; no migration expected.
- Control API: Read-only/observable. Existing task/event read paths may observe
  task state; no new write endpoint in this slice.
- SDK/contracts: Changed. Adds Gantry MCP tool `async_mcp_call` and extends the
  public task DTO kind.
- CLI: Read-only/observable. No CLI task manager in this slice.
- Gantry MCP tools/admin skill: Changed. Tool surface and prompt guidance update.
- Channel/provider adapters: Changed. Render coalesced task status; provider
  internals stay hidden.
- Docs/prompts: Changed. Document sync-vs-async rules, polling rules, and honest
  cancellation.
- Audit/events: Changed. Record async MCP start, progress, terminal, cancel, and
  late-result-ignore evidence.
- Tests/verification: Changed. Add focused task, MCP, progress, cancellation,
  prompt, and cleanup-search coverage.

Capability task decomposition:
1. Public task contract and tool surface
   - Write scope: async task domain types, Gantry MCP tool registry/schema,
     agent prompt/docs.
   - Acceptance: `async_mcp_call` mounted only with async task support; sync
     `mcp_call_tool` unchanged.
   - Verify: locked tool surface, MCP server registry, prompt/profile tests.

2. Async MCP lifecycle
   - Write scope: MCP IPC handler/service path and task repository usage.
   - Acceptance: row before remote call, same permission/audit checks as sync
     MCP, terminal receipt persisted.
   - Verify: `ipc-mcp-tool-handlers` and MCP proxy tests.

3. Cancellation and late-result fencing
   - Write scope: task service cancellation path and optional MCP abort wiring.
   - Acceptance: cancellation is honest; late MCP result cannot overwrite a
     terminal cancelled task.
   - Verify: unit tests for abort-supported and cancel-and-ignore paths.

4. Task status UX
   - Write scope: channel-neutral task-status rendering using existing progress
     or todo-style surfaces.
   - Acceptance: coalesced task card updates; no heartbeat chat spam; no
     live-turn progress-generation reset.
   - Verify: group-processing/channel progress tests.

5. Cleanup, docs, and review
   - Write scope: docs/prompts/tests only after runtime behavior is green.
   - Acceptance: cleanup searches classify or remove stale/raw provider public
     mentions.
   - Verify: focused searches, architecture check, full gates, autoreview, PR.

Focused verification:
- `npm run test:unit -- apps/core/test/unit/jobs/ipc-mcp-tool-handlers.test.ts apps/core/test/unit/jobs/ipc-agent-task-lifecycle-handlers.test.ts apps/core/test/unit/jobs/async-command-task-service.test.ts`
- `npm run test:unit -- apps/core/test/unit/runner/locked-tool-surface.test.ts apps/core/test/unit/runner/mcp/server-registry.test.ts apps/core/test/unit/runtime/group-processing.test.ts`
- `npm run test:unit -- apps/core/test/unit/application/mcp-tool-proxy.test.ts`
- `npm run typecheck`
- `npm run build`
- `python3 .codex/scripts/check_architecture.py`

Cleanup searches:
- `rg -n "background: true|background.*mcp_call_tool|async_mcp_get|async_mcp_cancel|task_update" apps/core/src apps/core/test docs -S`
- `rg -n "start_async_task|check_async_task|update_async_task|cancel_async_task|list_async_tasks|write_todos|LangGraph thread|provider task id|subagent dashboard|mission-control" apps/core/src apps/core/test docs -S`
- `rg -n "child pid|lease token|fencing version|privateCorrelationJson" apps/core/src/runner apps/core/src/jobs apps/core/src/channels docs -S`

Full closeout:
- `npm test`
- `python3 .codex/scripts/verify.py`
- `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
- `python3 .codex/scripts/check_task_completion.py`
- Run local autoreview.
- Run ponytail review and remove any complexity that does not protect safety,
  trust boundaries, or requested behavior.
- Create a PR after tests and review are clean.
```
