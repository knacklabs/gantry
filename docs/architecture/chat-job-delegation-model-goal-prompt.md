# True Async Subagents Goal Prompt

Use this prompt to implement Gantry's true async subagent model without adding
a dashboard, recursive mission control, or provider-private task authority.

```text
/goal Implement true async subagents for Gantry.

Build the minimal complete architecture where an agent can delegate work to a
durable async child agent run, inspect progress while it runs, steer it with
follow-up messages, cancel it, and allow that child agent to use approved async
bash tools under the same Gantry permission/sandbox model.

Product model:
- Agent: durable identity, prompt/profile, selected capabilities, attached
  sources, default `modelAlias`, and `agentHarness`.
- JobRun: one scheduled or manual execution attempt for a Job or Recurring Job.
- Task: Gantry-owned async work item with durable row, public status,
  cancellation, audit, recovery, steering, and terminal receipt.
- Async command task: approved long-running command work.
- Delegated agent task: durable child Gantry agent run owned by a parent run.
- Subagent: the child run execution strategy behind a Gantry Task; provider ids
  and raw provider tools stay private.

One-sentence product contract:
Gantry agents can start approved long-running work or delegate a child agent
run, get a Gantry task id, check status after restart, steer delegated work,
cancel it, and receive one durable receipt.

Locked scope:
- Keep existing `async_run_command`, `task_get`, `task_list`, and `task_cancel`.
- Add `delegate_task` for durable child agent runs.
- Add `task_message` for steering delegated tasks.
- Let delegated child runs receive the normal Gantry MCP/tool surface,
  including async bash tools only when the host enables the async executor and
  enforcing sandbox.
- Keep `task_update` out of scope.
- Keep recurring jobs as schedules over JobRuns; jobs may create Tasks, but
  Tasks are not schedules.
- Reject recursive delegation in this slice with max depth 1.
- Do not add new `settings.yaml` keys.
- Do not expose raw provider task ids, provider session ids, child pids, lease
  tokens, fencing versions, output file paths, or raw SDK task messages.

Exact UX contract:
- Task created: `Started: <short task summary>`
- Steering accepted: `Message sent to delegated task.`
- Command authority missing: `This command is not approved for this agent. Request access or choose an approved capability.`
- Cancel success: `Task was cancelled. Nothing else changed.`
- Already terminal cancel: `Task is already finished and cannot be cancelled.`
- Already terminal steering: `Task is already finished and cannot receive messages.`
- Provider-private detail requested: `Provider task details are internal. Use the Gantry task id to check status or cancel.`
- Terminal receipt lines must be host-enforced:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities or none>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: yes/no`
  - `Subtasks: <n completed, n failed, n cancelled>` when delegated
  - `Needs attention: <blocker or none>`

Acceptance criteria:
1. `delegate_task` creates a durable `delegated_agent` task row before spawning
   a child agent process.
2. The row records parent run id, app id, agent id, conversation/thread scope,
   objective summary, status, lease/fence identity, progress, steering state,
   and terminal receipt.
3. `task_get` returns public status, current phase, last progress, last tool
   summary, pending steering count, consumed steering count, blocker, receipt
   lines, and allowed next actions.
4. `task_message` persists a steering message before exposing it to the child
   run, then marks it consumed after delivery to the runner continuation input.
5. Steering terminal tasks is rejected.
6. Steering `async_command` tasks is rejected.
7. `task_cancel` cancels delegated child runs through the same terminal-first
   fenced transition used by async commands.
8. Delegated child runs can use `async_run_command` only through the normal
   mounted Gantry MCP tool surface and existing async executor/sandbox gates.
9. Child runs cannot widen durable authority; they use selected tool rules and
   existing approval flows.
10. Public DTOs never expose private provider/process/lease correlation.
11. Locked agents cannot forge `delegate_task` or `task_message` IPC requests.
12. The implementation works in plain Codex and does not require ACP/ACPX.

Surface Impact Matrix:
- Runtime behavior: Changed. Adds delegated child agent tasks and steering.
- `settings.yaml`: Unchanged by design. No new config needed for the slice.
- Postgres/runtime projection: Changed. Reuses `agent_async_tasks` with
  `kind = delegated_agent` and private steering/progress correlation.
- Control API: Unchanged by design. MCP/runtime task tools are enough.
- SDK/contracts: Changed. Adds `delegate_task` and `task_message`.
- CLI: Read-only/observable. Existing status continues showing async capacity.
- Gantry MCP tools/admin skill: Changed. Mounts the two new task tools only
  when async task tools are enabled.
- Channel/provider adapters: Unchanged by design. Receipts are channel-neutral.
- Docs/prompts: Changed. This prompt becomes the current contract.
- Audit/events: Read-only/observable. Existing runtime events remain provider
  neutral; add only if needed by tests.
- Tests/verification: Changed. Add focused unit/integration coverage.

Verification:
- `npm run typecheck`
- focused task lifecycle unit tests
- `npm test`
- `npm run build`
- `python3 .codex/scripts/verify.py`
- `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
- ponytail review
- autoreview
- build/restart `com.gantry`, check status, and run Knacklabs lead gen
- open/update PR and wait for CI to pass
```
