# /goal Prompt: Durable Async Tool Burst Queue

Use this prompt to pursue the goal:

```text
/goal Implement Durable Async Tool Burst Queue from docs/architecture/durable-async-tool-burst-queue-goal-prompt.md.

Mode:
- Single-cut code. No legacy mode, no compatibility shim, no local-state migration helper.
- Required skills: use ponytail full mode and architecture-refactor before code changes.
- Ponytail rule: smallest correct diff, reuse existing leases/slots/fencing, no speculative abstraction.
- Architecture rule: keep domain/application/runtime/adapter boundaries clean.
- Use subagents for independent implementation, test, and review slices with disjoint write scopes.
- No commentary during pursuit except required final handoff evidence or a real blocker.
- Keep runtime events observable-only; durable rows, leases, and fences remain authority.

Goal:
- Make async tool fanout reliable under bursty parallel agents.
- Replace admission-only async tool capacity with durable queue + worker claim/drain.
- Keep agent-facing tools and permission/capability authority unchanged.
```

## Current Repo Truth To Preserve

- Live turns and scheduled jobs already use the stronger pattern: durable
  ownership, `run_leases`, `run_slots`, fencing, heartbeats, and recovery.
- `agent_async_tasks` already stores async command, MCP, and delegated-agent task
  state. Extend that lane before adding another queue table.
- `runtime_events` and `LISTEN/NOTIFY` may wake workers, but workers must
  re-query durable task rows before executing.
- Native subagents remain local to the parent runner; Gantry exposes delegation
  through the `AgentDelegation` facade, not raw provider authority.

## Implementation Tasks

1. Turn async task admission into durable queueing.
   - Creating an async command, async MCP call, or delegated-agent task should
     insert a queued task even when active capacity is full.
   - Reserve rejection for invalid authority, invalid input, missing capability,
     or hard backlog limits.

2. Add a small async task drainer.
   - Claim queued tasks by app/agent/kind capacity.
   - Use lease token + fencing version for execution and terminal transitions.
   - Wake on task creation/transition, with a bounded periodic recovery pass.

3. Keep fairness simple.
   - Prevent one agent from consuming all app capacity.
   - Prefer oldest queued task within capacity, with per-agent caps preserved.

4. Remove active-only capacity assumptions.
   - Replace "capacity full, wait or cancel" success-path messages with queued
     receipts.
   - Keep cancellation, status, receipts, and stale recovery working.

5. Add focused tests and cleanup searches.
   - Prove burst tasks queue instead of reject.
   - Prove the drainer starts queued work when capacity frees.
   - Prove stale/expired running work is recovered or failed under fencing.

## Acceptance Criteria

- Multiple agents can submit more async tool calls than active capacity without
  losing valid work.
- Only capacity-claimed tasks execute; stale workers cannot finalize tasks after
  losing their fence.
- Per-app and per-agent caps still bound running work.
- Parent delegated-agent waits still wake when child tasks finish.
- Agent-facing tool names, permission prompts, and capability rules do not
  change.

## Verification

Run focused tests first:

```bash
npm run test:unit -- apps/core/test/unit/jobs/async-command-task-service.test.ts
npm run test:unit -- apps/core/test/unit/jobs/async-mcp-tool-task.test.ts
npm run test:unit -- apps/core/test/unit/jobs/async-delegated-agent-task.test.ts
```

Final checks:

```bash
npm run build
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
```

## Cleanup Searches

```bash
rg -n "capacity is full|MAX_ACTIVE_ASYNC|activeAsyncMcpControllers|createTaskWithAdmission" apps/core/src apps/core/test -S
rg -n "agent_async_tasks|leaseToken|fencingVersion|transitionTask" apps/core/src apps/core/test -S
```

Remaining matches must be active queue/drainer code, focused tests, or explicit
hard backlog rejection paths.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Async tool bursts queue durably instead of valid work being rejected at active capacity. |
| `settings.yaml` | Unchanged by design | No new config switch; existing queue/capacity settings remain the source. |
| Postgres/runtime projection | Changed | Existing async task rows gain queue/drain semantics; durable rows remain authority. |
| Control API | Read-only/observable | Task status may show queued longer; endpoint shapes unchanged. |
| SDK/contracts | Unchanged by design | No public contract or tool-name change. |
| CLI | Unchanged by design | No command or flag change. |
| Gantry MCP/admin tools | Read-only/observable | Async task tools return queued receipts instead of capacity rejections. |
| Channel/provider adapters | Unchanged by design | No channel/provider-specific behavior change. |
| Docs/prompts | Changed | This goal prompt documents the cutover. |
| Audit/events | Read-only/observable | Queue and execution transitions may emit clearer events; runtime events are not authority. |
| Tests/verification | Changed | Add burst queue, drainer, fencing, cancellation, and recovery coverage. |

## Non-Negotiable Rejections

- No in-memory-only queue for cross-agent burst work.
- No second queue table unless `agent_async_tasks` proves insufficient.
- No runtime event command bus.
- No raw provider tool authority expansion.
- No compatibility branch for old capacity-rejection behavior.
