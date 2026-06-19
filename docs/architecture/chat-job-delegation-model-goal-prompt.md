# Chat-First Async Work Goal Prompt

Use this prompt to implement the chat-first runtime, bounded jobs, durable async
delegation, async command execution, and cross-model job selection work as one
coherent Gantry goal.

```text
/goal Implement Gantry's chat-first async work model: chats must not be blocked by jobs or maintenance, jobs remain bounded, and async command/task/subagent work must be available through one Gantry-owned lifecycle across both `anthropic_sdk` and `deepagents`.

This is an implementation goal. Make code, test, docs, and prompt changes as
needed. Do not expose raw provider async tools as public Gantry authority.

Product model:
- Agent: durable identity, prompt/profile, selected capabilities, attached sources, default `modelAlias`, and `agentHarness`.
- Job: scheduled/run-now background trigger that targets an agent and may choose a catalog `modelAlias` under a model policy.
- Task: Gantry-owned async work item with durable status, cancellation, audit, and receipt.
- Subagent: harness-private execution strategy used behind a Gantry Task.
- Run: one execution attempt that owns lease/fence, status, provider session/correlation, and terminal evidence.

Locked decisions:
- Chats beat jobs.
- Jobs do not multiply into chat capacity.
- Use capacity isolation, not a global priority scheduler.
- No pre-spawned sandbox process pool in this goal.
- No user-facing subagent mission-control UI.
- Harness-neutral Gantry tools are the product surface; provider tools are adapter-private.
- Async Bash/RunCommand, Task, and Subagent must work for both `anthropic_sdk` and `deepagents`.
- DeepAgents async subagents are allowed in v1 despite preview status, but only behind Gantry lifecycle, version/API sentinels, and fail-closed behavior.
- Same-workspace jobs remain capped by `runtime.queue.max_job_runs`.
- Machine thread/CPU capacity is an admission input, not an afterthought; async commands, tasks, subagents, jobs, and maintenance must share a host budget so parallel work cannot oversubscribe one machine.
- No public `job.harness`, job-level `agentHarness`, job-level `agentEngine`, conversation-level harness selector, or raw provider model id.

Documentation citations to refresh before implementation:
- Claude background Bash: Claude Code background commands run asynchronously, return a background task id, write output to a file, and are cleaned up with the session. Source: https://code.claude.com/docs/en/interactive-mode#background-bash-commands
- Claude Agent/subagent behavior: the Agent tool spawns a subagent; background subagents run with already granted permissions and auto-deny promptable calls. Source: https://code.claude.com/docs/en/tools-reference#agent-tool-behavior
- Claude SDK task lifecycle: SDK task messages cover background Bash, Monitor watches, and background subagents. Source: https://code.claude.com/docs/en/agent-sdk/python
- DeepAgents async subagents: async subagents are preview, return a task id immediately, and support start/check/update/cancel/list through Agent Protocol transport. Source: https://docs.langchain.com/oss/python/deepagents/async-subagents
- DeepAgents sync subagents: sync subagents block the supervisor; async subagents are the documented path for long-running, parallel, steerable work. Source: https://docs.langchain.com/oss/python/deepagents/subagents
- Deep Agents Code caveat: Deep Agents Code subagents are sync only; async subagents are not available in that Code surface. Source: https://docs.langchain.com/oss/python/deepagents/code/subagents

Local repo citations to reread before editing:
- `README.md`
- `WORKFLOW.md`
- `docs/FACTORY.md`
- `docs/QUALITY.md`
- `docs/architecture/codebase-refactor-principles.md`
- `docs/architecture/current-verification-commands.md`
- `docs/decisions/2026-05-01-model-catalog-and-cache-accounting.md`
- `docs/decisions/2026-06-14-agent-harness-selection.md`
- `docs/architecture/runtime-components.md`
- `docs/architecture/autonomous-jobs.md`
- `docs/architecture/capability-management.md`
- `apps/core/src/domain/ports/task-lifecycle.ts`
- `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`
- `apps/core/src/runner/mcp/tools/task-lifecycle.ts`
- `apps/core/test/unit/runner/task-lifecycle-events.test.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/runner/builtin-tool-exclusion.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-tools.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/native-agent-tool-input.ts`

Exact UX contract:
- Never show users old worker/capacity queue internals in waiting copy.
- If chat admission is delayed past 30s, show once per waiting episode: `Still starting this request.`
- Job delay copy: `Delayed: interactive capacity is reserved for chats.`
- Missing delegation capability: `Agent delegation is not approved for this agent.`
- DeepAgents preview/API sentinel failure: `Async delegation is unavailable for this DeepAgents version. Gantry did not start delegated work.`
- Unsupported Anthropic task update: `Task update is not supported for this active Anthropic task state.`
- Command authority missing: `This command is not approved for this agent. Request access or choose an approved capability.`
- Cancel success: `Delegated work was cancelled. Nothing else changed.`
- Already terminal: `Delegated task is already finished and cannot be cancelled.`
- Provider-private detail requested: `Provider task details are internal. Use the Gantry task id to check status or cancel.`
- Setup blocker copy:
  - `Setup needed: approve <Capability Name> for this agent.`
  - `Setup needed: connect <Source Name> for this agent.`
  - `Setup needed: finish <Requirement Name> for this agent.`
- Terminal receipt lines must be host-enforced:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities or none>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: yes/no`
  - `Needs attention: <blocker or none>`
- Operator status must show:
  - `Interactive capacity: <used>/<capacity>`
  - `Interactive backlog: <count>, oldest <seconds>s`
  - `Background jobs: <used>/<capacity>`
  - `Host capacity: <used>/<budget>, CPU threads <detected>`
  - `Live warm spare: available | missing`
  - `Sandbox warm template: available | unavailable, cache hit | miss`

Implementation requirements:

1. Runtime admission and capacity isolation
- Runtime classes:
  - `interactive`: live chat turns, continuations, approvals, questions.
  - `interactive_child`: chat-owned task/subagent work inside a parent chat run.
  - `background`: scheduled/run-now jobs.
  - `maintenance`: memory dreaming, cleanup, bake/reconcile work.
- `interactive` uses live-worker slots only.
- `background` uses job-worker slots only.
- `maintenance` is lowest priority and must never consume chat capacity.
- No preemption in v1; do not kill running jobs. Stop admitting lower-priority work when interactive backlog exists.
- Chats must start while Knacklabs/background jobs are queued or running.
- Background jobs cannot consume live chat slots.

2. Host thread and process budget
- Detect local CPU capacity with Node `os.availableParallelism()` when available, falling back to `os.cpus().length`.
- Compute a conservative effective host execution budget from detected CPU threads, process role, existing queue settings, and reserved interactive capacity.
- On single-machine deployments, clamp effective live/job/task/subagent/command concurrency to the host budget. Settings remain desired upper bounds, not permission to oversubscribe the machine.
- Admission must reserve capacity for live chat before jobs, async commands, delegated tasks/subagents, and maintenance.
- Async command/task/subagent launches must acquire the appropriate runtime class slot and host budget slot before spawning provider or child process work.
- Long provider/network waits still hold lifecycle slots, but they must not allow unbounded child process fanout.
- Expose detected CPU threads and effective host budget in startup diagnostics, status, and operator events.

3. Unified async work surface
- Public Gantry MCP tools:
  - `async_run_command`: starts scoped command work asynchronously.
  - `delegate_task`: starts delegated agent/subagent work asynchronously.
  - `task_get`: reads one owned task by Gantry task id.
  - `task_list`: lists owned tasks in current app/agent/conversation/thread/run scope.
  - `task_update`: sends follow-up instructions when the active task implementation supports it.
  - `task_cancel`: cancels owned non-terminal task.
- Public statuses:
  - `queued`
  - `running`
  - `needs_attention`
  - `completed`
  - `failed`
  - `cancelled`
  - `timed_out`
- Gantry task ids are the only public handles. Provider task ids, thread ids, run ids, output files, child pids, and raw SDK messages stay adapter-private.
- Denied launch never invokes Anthropic native Agent/Task, Claude background Bash, DeepAgents sync task, DeepAgents async task, Agent Protocol, or command execution.
- Cancellation marks the Gantry task terminal first, then performs best-effort provider cancellation.
- Progress and terminal writes must be lease/fence checked; stale workers cannot write progress, results, receipts, or cancellation.

4. Async command execution
- Durable authority is `RunCommand(<argv pattern>)` or a reviewed semantic capability that expands to scoped command authority.
- Bare persistent `Bash`, `RunCommand`, `Bash(*)`, `RunCommand(*)`, provider-native command tools, and leading-wildcard command scopes remain rejected.
- `async_run_command` creates a fenced task row before spawning any process.
- Command execution must use the same policy, sandbox, egress, environment scrub, protected-path, and audit rules as current synchronous shell paths.
- Command output is bounded and summarized. Full raw output paths are internal details, not user copy.
- Cancellation must kill the full process group or otherwise prove no child process outlives its Gantry task.

5. DeepAgents async delegation
- Use DeepAgents async subagents as the v1 DeepAgents implementation path even though they are preview.
- Keep raw DeepAgents tools hidden from the model-visible surface:
  - `task`
  - `write_todos`
  - `start_async_task`
  - `check_async_task`
  - `update_async_task`
  - `cancel_async_task`
  - `list_async_tasks`
- The adapter may invoke preview APIs only behind the Gantry wrapper after `AgentDelegation`, task-row creation, sandbox/capability/model/harness checks, and DeepAgents sentinel checks pass.
- Add a DeepAgents async sentinel for the pinned supported package range, starting with local `deepagents@1.10.2`.
- Sentinel must fail closed if expected exports, tool names, schemas, status/result shapes, Agent Protocol transport assumptions, or cancellation semantics drift.
- Prefer co-deployed/in-process topology first. Remote HTTP Agent Protocol is a separate capability-gated path requiring auth, audit, egress, backpressure, and worker-pool rules.
- Mirror enough DeepAgents async state into `agent_delegated_tasks` so compaction or provider state loss cannot erase public task authority.

6. Anthropic SDK async delegation
- The public surface remains Gantry tools, not raw `Agent`, `Task`, `TaskOutput`, `TaskStop`, `Monitor`, or raw background Bash ids.
- Native SDK Agent/Task and background Bash may be used only as adapter-private mechanisms after the Gantry task row and authority decision exist.
- Direct native Agent/Task model calls remain denied or redirected with "use delegate_task" behavior unless they flow through the wrapper.
- `task_update` must not fake parity. If there is no active steering path for an Anthropic task, fail closed with the locked unsupported update copy.
- SDK task lifecycle messages should update Gantry runtime events and task rows after sanitization.

7. Job issues and recovery
- Knacklabs/background jobs inherit target-agent capabilities and model policy; jobs do not own durable access.
- Missing tool source and missing action capability must be distinct:
  - source missing -> `request_mcp_server` or source setup action.
  - action missing -> `request_access` with `target.kind=capability`.
  - scoped `RunCommand(...)` remains fallback only when no reviewed semantic capability fits.
- Job readiness/status must expose one clear next action. Users must not inspect logs to find the blocker.
- Startup/scheduler recovery must rehydrate paused/recoverable job turns through production wiring, not optional test-only callbacks.
- Stale lease recovery must preserve normal retry/backoff/dead-letter accounting and durable terminal evidence.
- Worker capability dispatch must fail closed if advertised worker capability inventory is unavailable.

8. Model policy for jobs/tasks
- Jobs may choose a catalog `modelAlias`; jobs must not choose `agentHarness`.
- Model selection precedence:
  - explicit job `modelAlias`
  - job-kind default
  - agent default
  - system fallback
- Add model policy:
  - `inherit`: existing precedence.
  - `locked`: user-selected catalog alias; agent cannot override.
  - `agent_recommended`: agent may recommend a catalog alias with short reason and fit label `cheap | balanced | rich`; Gantry validates compatibility.
- Raw provider model ids are rejected at user/API/job/MCP boundaries unless registered as aliases.
- Future model-capabilities skill is advisory only; catalog validation remains authority.

9. Capability and tool discovery
- Jobs, tasks, and subagents inherit target-agent capabilities; they do not own durable access.
- `ToolSearch` is transport/discovery, not authority.
- Scheduled/background jobs must not use provider `ToolSearch` as a grant path. Gantry inventory remains through `mcp_list_tools` and `mcp_describe_tool`.
- Add the missing path from discovered MCP tool to reviewed semantic capability to agent approval to job retry.

10. Sandbox warmup and diagnostics
- Keep existing sandbox-runtime warm template cache.
- Do not add pre-spawned sandbox pools in this goal.
- Expose warm-template status in startup diagnostics/status.
- Warmup must be authority-free: no provider session, credentials, MCP clients, transient grants, browser tokens, memory, workspace overlays, or selected capability state.

Acceptance criteria:
- A chat can start while Knacklabs/background jobs are queued or running.
- Background jobs cannot consume live chat slots.
- Users never see worker/capacity wording.
- Saturated chat admission sends `Still starting this request.` at most once per waiting episode.
- Operators can see interactive capacity, backlog, host capacity/thread count, warm spare, job capacity, and sandbox warm-template state.
- Host CPU/thread count is detected and used to clamp effective async command/task/subagent/job concurrency on single-machine deployments.
- `async_run_command`, `delegate_task`, `task_get`, `task_list`, `task_update`, and `task_cancel` are harness-neutral Gantry tools.
- `anthropic_sdk` and `deepagents` both satisfy the async command/task/subagent lifecycle.
- DeepAgents async subagents are used in v1 behind the wrapper when the sentinel passes.
- Raw provider tool names and provider task ids never appear in public MCP/API/channel responses.
- `task_get` and `task_list` return durable Gantry status after restart.
- `task_cancel` makes Gantry terminal first and provider cancellation best-effort second.
- Command work requires exact approved command/semantic capability authority.
- Subagent/tool scopes replace parent scope unless an explicit Gantry projection says otherwise.
- Every terminal task/job that delegated work includes the five receipt lines.
- Denied work never invokes provider async APIs or command execution.
- Delegation/subagent docs and prompts do not imply durable horizontal scaling before leases, slots, cancellation, and receipts exist.

Capability-driven task decomposition:
1. Admission/copy/status slice
   - Implement runtime class admission and friendly waiting copy.
   - Add operator status metrics, host capacity/thread count, and sandbox warm-template status.
   - Verify chat can start while job capacity is saturated.

2. Host capacity budget slice
   - Detect CPU threads, derive the effective host budget, and clamp live/job/task/subagent/command admission.
   - Reserve chat capacity before admitting jobs, delegated tasks, async commands, or maintenance.
   - Verify low-thread simulated hosts queue lower-priority work instead of spawning beyond budget.

3. Task lifecycle contract slice
   - Extend current task lifecycle domain/repository with `kind`, public statuses, list/update/progress/terminal transitions, provider correlation writes, and stale-fenced writes.
   - Keep provider ids adapter-private.

4. Gantry MCP tool slice
   - Add `async_run_command`, `task_list`, and `task_update`.
   - Make `delegate_task` launch through the executor instead of failing unavailable when capability and executor are present.
   - Preserve missing capability and forbidden-scope denials.

5. Async command executor slice
   - Implement fenced async command launch/get/list/cancel/terminal evidence.
   - Reuse existing command policy, sandbox, egress, environment scrub, and permission IPC.

6. DeepAgents async executor slice
   - Add async subagent sentinel and adapter-private bridge.
   - Keep raw DeepAgents async tools excluded from model-visible surface.
   - Fail closed on version/API/transport/sandbox/capability mismatch.

7. Anthropic async executor slice
   - Implement equivalent Gantry lifecycle using adapter-private SDK Agent/Task/background Bash where safe.
   - Sanitize SDK task lifecycle messages into Gantry task rows/events.
   - Fail closed for unsupported update states.

8. Job/capability/model recovery slice
   - Fix job capability discovery and recovery gaps.
   - Add job model policy and compatibility validation.
   - Ensure terminal evidence and setup blockers are durable and user-actionable.

9. Docs/prompts/cleanup slice
   - Update architecture docs, agent prompts, admin/status docs, Gantry MCP tool docs, and this goal's follow-up references.
   - Cleanup-search raw provider tool exposure, old harness names, worker/capacity user copy, and unsupported scale claims.

Surface Impact Matrix:
| Surface | Impact | Reason |
|---|---|---|
| Runtime behavior | Changed | Adds chat-first admission classes, host budget admission, async task executor, async command executor, and both-harness delegation lifecycle. |
| `settings.yaml` | Read-only/observable | No new v1 keys; existing `runtime.queue.max_message_runs`, `max_job_runs`, `agent_harness`, capabilities, and model aliases remain authority. |
| Postgres/runtime projection | Changed | Existing task lifecycle rows need richer status/progress/list/update/terminal transitions and provider-correlation privacy. |
| Control API | Deferred | V1 can ship through MCP/runtime status first; add public task API only when Web/SDK needs direct task management. |
| SDK/contracts | Changed | Public task DTO/status contract is needed if task list/update surfaces leave MCP; raw provider ids are excluded. |
| CLI | Changed | `status` shows interactive/job/host/sandbox readiness; no CLI task-management surface unless added after API contract stabilizes. |
| Gantry MCP tools/admin skill | Changed | Adds/extends async task tools and reports host capacity/delegation availability honestly. |
| Channel/provider adapters | Changed | Anthropic SDK and DeepAgents map private async mechanics into Gantry lifecycle; channels render neutral copy/receipts only. |
| Docs/prompts | Changed | Remove raw scale claims; document Gantry task lifecycle, preview DeepAgents guardrails, and provider-private tooling. |
| Audit/events | Changed | Emit admission delay, host-budget delay, launch, deny, progress, update, cancel, terminal, stale-fence, provider-correlation, and preview-sentinel events. |
| Tests/verification | Changed | Add admission, host-budget, copy, task lifecycle, command executor, both-harness adapter, sandbox, capability, model policy, and cleanup tests. |

Test plan:
- Unit: waiting-status copy contains no `worker` or `capacity`.
- Unit: waiting-status dedupe sends `Still starting this request.` once per episode.
- Unit: runtime class admission keeps jobs/maintenance off live slots.
- Unit: host capacity detection falls back from `os.availableParallelism()` to `os.cpus().length`.
- Unit: effective concurrency clamps configured live/job/task/subagent/command limits to host budget while reserving chat capacity.
- Unit: sandbox warm template reports `available`, `cacheHit`, and `authorityFree`.
- Unit: `delegate_task` denies before provider call when `AgentDelegation` is absent.
- Unit: DeepAgents async sentinel passes for pinned supported API and fails closed on missing exports/tool names/schema.
- Unit: DeepAgents model-visible tool list excludes raw task/todo/async tool names.
- Unit: Anthropic native Agent/Task direct calls remain denied or wrapper-only.
- Unit: async command checks command authority before process spawn.
- Unit: `task_update` works for DeepAgents and fails with locked copy for unsupported Anthropic states.
- Unit: terminal receipts are host-enforced.
- Integration: saturated background jobs plus new chat still admits through live-worker path.
- Integration: saturated live slots produce friendly delayed copy plus operator metrics.
- Integration: low-thread simulated host queues parallel async jobs/tasks/commands instead of spawning beyond budget.
- Integration: `task_get` and `task_list` return durable status after restart.
- Integration: `task_cancel` prevents stale provider/task writes after terminal cancellation.
- Integration: stale fences cannot write progress or terminal results.
- Postgres: task lifecycle launch/list/update/cancel/progress/terminal transitions are fenced and idempotent.
- Cleanup: raw provider tool names appear only in adapter-private bridges, exclusion tests, sentinel tests, or historical docs.

Required verification and closeout:
1. Run focused checks after each slice.
2. Spawn `automated-tester` after implementation and before deterministic verify. It must follow `.codex/prompts/tester-automated.md`.
3. Record automated test artifact:
   - `python3 .codex/scripts/record_test_from_json.py --kind automated --input /tmp/automated-test.json`
4. Run deterministic verify:
   - `python3 .codex/scripts/verify.py`
5. Run ponytail simplification review before completing the goal. Remove overbuilt abstractions, extra settings, premature APIs, and compatibility shims.
6. Run autoreview before completing the goal:
   - `.agents/skills/autoreview/scripts/autoreview --mode local`
   - or `.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main`
7. Move to reviewing only after automated tests are recorded and verify passes:
   - `python3 .codex/scripts/update_run.py --phase reviewing`

Final handoff must include:
- Exact behavior implemented.
- Files changed grouped by surface.
- Acceptance criteria status.
- Surface Impact Matrix.
- Cleanup search results and interpretation.
- Automated-tester artifact status.
- Ponytail findings and what was simplified.
- Autoreview findings and disposition.
- Verification commands run and results.
```
