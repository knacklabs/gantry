# LOCAL-50 Plan: Chat-First Async Work Model

## 1. Problem

Gantry needs one chat-first async work model across live chats, scheduled jobs,
maintenance, async command work, and delegated task/subagent work. Live chats
must not wait behind jobs or maintenance, jobs must remain bounded, and async
command/delegation must be exposed through Gantry-owned lifecycle tools rather
than raw provider async tools.

Current repo truth:

- Durable live turns already use live-turn leases, per-live-worker slots, and
  friendly waiting copy.
- Scheduler jobs already use job leases/slots and inherit target-agent
  capability policy.
- Operator status already shows interactive capacity, backlog, background jobs,
  live warm spare, and sandbox warm-template state.
- `apps/core/src/domain/ports/task-lifecycle.ts` is currently display-only
  `todo_update` state, not a durable async task lifecycle.
- `delegate_task`, `task_get`, and `task_cancel` are intentionally not mounted
  until Gantry has a real delegated-task executor.
- `docs/architecture/neutral-task-lifecycle-wrapper-plan.md` and
  `apps/core/src/adapters/storage/postgres/schema/task-lifecycle.ts`, both named
  by the goal prompt, are absent in this checkout; LOCAL-50 must either restore
  the missing plan doc or treat the goal prompt plus current code as the active
  source.

This goal is larger than one implementation slice. It must be sequenced without
shrinking the final objective: first foundation and durable lifecycle, then
executor lanes, then job/model/capability recovery and cleanup.

## 2. Scope / Non-goals

In scope:

- Runtime admission classes for `interactive`, `interactive_child`,
  `background`, and `maintenance`, preserving chat-first behavior.
- Host CPU/thread detection and an effective host execution budget that clamps
  single-machine concurrency without adding new v1 settings.
- A Gantry-owned durable Task lifecycle for async commands and delegation, with
  public statuses, cancellation, progress, terminal evidence, and fenced writes.
- Harness-neutral Gantry MCP tools: `async_run_command`, `delegate_task`,
  `task_get`, `task_list`, `task_update`, and `task_cancel`.
- Async command execution through the existing command policy, sandbox, egress,
  environment scrub, protected-path, permission, and audit boundaries.
- DeepAgents async subagents behind a preview/API sentinel and Gantry wrapper.
- Anthropic SDK async mechanisms only as adapter-private implementations behind
  the same Gantry task lifecycle.
- Job readiness, capability recovery, and model policy fixes that preserve
  target-agent authority and catalog alias validation.
- Docs, prompt, cleanup-search, and factory verification updates.

Non-goals:

- No public `job.harness`, job-level `agentHarness`, job-level `agentEngine`,
  conversation-level harness selector, or raw provider model id path.
- No pre-spawned sandbox process pool.
- No user-facing subagent mission-control UI or durable user-managed subagent
  definitions.
- No public Control API task-management surface in the first cut; MCP/runtime
  status is the initial surface.
- No raw provider async tools as public Gantry authority.
- No job-owned durable capability grants; jobs inherit the target agent.
- No compatibility shim for unsupported old local task state.

## 3. Acceptance Criteria

1. Chats can start while background jobs are queued or running.
2. Background jobs, async commands, delegated work, and maintenance cannot
   consume live chat slots.
3. User-visible waiting copy never says `worker` or `capacity`.
4. Saturated chat admission sends `Still starting this request.` at most once
   per waiting episode.
5. Job delay copy is exactly
   `Delayed: interactive capacity is reserved for chats.`
6. Operator status shows:
   `Interactive capacity: <used>/<capacity>`,
   `Interactive backlog: <count>, oldest <seconds>s`,
   `Background jobs: <used>/<capacity>`,
   `Host capacity: <used>/<budget>, CPU threads <detected>`,
   `Live warm spare: available | missing`, and
   `Sandbox warm template: available | unavailable, cache hit | miss`.
7. CPU threads are detected with `os.availableParallelism()` and fall back to
   `os.cpus().length`.
8. Effective concurrency is clamped on single-machine deployments while
   reserving chat capacity before jobs, async commands, delegated work, and
   maintenance.
9. Public task statuses are exactly `queued`, `running`, `needs_attention`,
   `completed`, `failed`, `cancelled`, and `timed_out`.
10. `async_run_command`, `delegate_task`, `task_get`, `task_list`,
    `task_update`, and `task_cancel` are harness-neutral Gantry tools.
11. Gantry task ids are the only public task handles; provider task ids, thread
    ids, run ids, output files, child pids, and raw SDK messages remain
    adapter-private.
12. `task_get` and `task_list` return durable Gantry status after restart.
13. `task_cancel` makes the Gantry task terminal first, then attempts
    provider/process cancellation best-effort.
14. Denied work never invokes command execution, Anthropic native Agent/Task or
    background Bash, DeepAgents sync/async task APIs, or Agent Protocol.
15. Command work requires exact approved `RunCommand(<argv pattern>)` authority
    or a reviewed semantic capability that expands to scoped command authority.
16. Missing delegation capability returns
    `Agent delegation is not approved for this agent.`
17. Missing command authority returns
    `This command is not approved for this agent. Request access or choose an approved capability.`
18. DeepAgents preview/API sentinel failure returns
    `Async delegation is unavailable for this DeepAgents version. Gantry did not start delegated work.`
19. Unsupported Anthropic task update returns
    `Task update is not supported for this active Anthropic task state.`
20. Cancellation success returns
    `Delegated work was cancelled. Nothing else changed.`
21. Already-terminal cancellation returns
    `Delegated task is already finished and cannot be cancelled.`
22. Provider-private detail requests return
    `Provider task details are internal. Use the Gantry task id to check status or cancel.`
23. Every terminal delegated task/job receipt is host-enforced with:
    `Completed: <short outcome>`,
    `Used: <tools/capabilities or none>`,
    `Changed: <files/accounts/channels or none>`,
    `Delegated: yes/no`, and
    `Needs attention: <blocker or none>`.
24. DeepAgents raw `task`, `write_todos`, `start_async_task`,
    `check_async_task`, `update_async_task`, `cancel_async_task`, and
    `list_async_tasks` remain hidden from model-visible/public surfaces.
25. Anthropic SDK native Agent/Task/background Bash remain wrapper-only and
    never become public Gantry authority.
26. Jobs may choose a catalog `modelAlias` under model policy, but cannot choose
    harness or raw provider model ids.
27. Missing job source setup and missing action capability are distinct and
    expose one user-actionable next step.
28. Delegation/subagent docs and prompts do not imply durable horizontal scaling
    before leases, slots, cancellation, and receipts exist.

## 4. Technical Approach

Treat Task as a Gantry-owned runtime object, not a provider task. Provider async
mechanics are executor details that can update Gantry task rows only through
lease/fence-checked transitions.

Implementation sequence:

1. Admission and host budget foundation. Extend current live/job slot reporting
   with a host-budget admission layer that reserves chat capacity before
   admitting lower-priority runtime classes. Keep existing live-turn and
   scheduler lease models intact.
2. Durable task lifecycle. Add the canonical domain port, Postgres schema,
   repository, runtime events, and fenced transition API before any new public
   delegation tool launches work.
3. MCP task tools. Keep `todo_update` display-only. Mount `async_run_command`,
   `delegate_task`, `task_get`, `task_list`, `task_update`, and `task_cancel`
   only when they route through the real lifecycle/executor path.
4. Executor lanes. Add async command, DeepAgents async, and Anthropic async
   executors behind the same lifecycle, capability, sandbox, and audit gates.
5. Job/model/capability recovery. Finish job readiness, capability-source
   distinction, model policy, and terminal evidence requirements.
6. Docs/prompts/cleanup. Update docs and run cleanup searches for old wording,
   raw provider surfaces, provider ids, and unsupported scale claims.

Surface Impact Matrix:

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Adds runtime classes, host-budget admission, async task lifecycle, cancellation, and two-harness executor dispatch. |
| `settings.yaml` | Unchanged by design | Existing `runtime.queue.*`, `agent_harness`, model aliases, sources, and capabilities remain authority; host budget is derived. |
| Postgres/runtime projection | Changed | Adds durable task rows, provider-private correlation, fenced transitions, list/get/update/cancel read models, and audit linkage. |
| Control API | Deferred | Initial cut ships through MCP/status; direct Web/SDK task management needs a separate public API contract. |
| SDK/contracts | Changed | Shared task DTO/status/result contracts are needed where task surfaces cross process or package boundaries; provider ids stay excluded. |
| CLI | Changed | `gantry status` must show host capacity and CPU thread count; no CLI task-management commands in this slice. |
| Gantry MCP tools/admin skill | Changed | Adds/extends async task tools; keeps `todo_update` display-only and non-authority. |
| Channel/provider adapters | Changed | Anthropic SDK and DeepAgents map private async mechanics into Gantry lifecycle; channels render neutral copy and receipts only. |
| Docs/prompts | Changed | Document Gantry task lifecycle, preview DeepAgents guardrails, provider-private tooling, and honest scale claims. |
| Audit/events | Changed | Emit admission delay, budget delay, launch, deny, progress, update, cancel, terminal, stale-fence, provider-correlation, and sentinel events. |
| Tests/verification | Changed | Add admission, host-budget, copy, lifecycle, command, adapter, capability, model-policy, cleanup, Postgres, and full factory checks. |

Provider-doc refresh notes:

- Claude background Bash can run asynchronously and return task ids with output
  files and session cleanup behavior.
- Claude SDK task notifications cover background Bash, Monitor watches, and
  background subagents.
- Claude Agent spawns subagents, but direct provider subagent behavior remains
  adapter-private for Gantry.
- DeepAgents async subagents expose start/check/update/cancel/list tools and are
  preview; Gantry needs sentinels and fail-closed behavior.
- Deep Agents Code does not support async subagents, so LOCAL-50 must use the
  DeepAgents SDK path, not the Code surface.

## 5. Task Decomposition

1. Admission/copy/status foundation
   - Write scope: live admission/status/metrics/runtime diagnostics.
   - Acceptance: chats stay isolated from background jobs and maintenance;
     waiting copy is friendly and deduped; status includes host capacity/thread
     count plus existing capacity lines.
   - Verify: focused waiting-status, status, metrics, and live/job saturation
     tests.

2. Host capacity budget
   - Write scope: host budget calculator and admission clamps for
     live/job/task/subagent/command/maintenance classes.
   - Acceptance: low-thread simulated hosts queue lower-priority work instead of
     spawning beyond budget; chat capacity is reserved.
   - Verify: unit tests for `availableParallelism()` fallback and budget math;
     integration test for low-thread queuing.

3. Durable task lifecycle storage
   - Write scope: domain port, Postgres schema/migration/repository, runtime
     events, audit linkage, idempotent/fenced transition service.
   - Acceptance: create/list/get/update/progress/cancel/terminal transitions are
     durable, restart-safe, provider-private, and stale-fenced.
   - Verify: Postgres integration tests with disposable database and unit tests
     for transition rules.

4. Gantry MCP task tools
   - Write scope: `apps/core/src/runner/mcp/tools/task-lifecycle.ts`, IPC
     handlers, tool-surface selection, capability tests.
   - Acceptance: `async_run_command`, `delegate_task`, `task_get`, `task_list`,
     `task_update`, and `task_cancel` route through the lifecycle; denied or
     unavailable work does not invoke executors; `todo_update` stays
     display-only.
   - Verify: MCP tool unit tests, locked-tool-surface tests, IPC handler tests.

5. Async command executor
   - Write scope: command task executor, process management, cancellation,
     bounded output, permission-policy integration.
   - Acceptance: command launch checks authority before spawning, reuses
     existing command policy/sandbox/egress/env scrub/protected-path/audit
     rules, and cancel kills the process group or proves no child survives.
   - Verify: policy-denial, sandbox/env, output-bound, cancellation, and stale
     write tests.

6. DeepAgents async executor
   - Write scope: DeepAgents adapter bridge, async sentinel, provider-private
     correlation mapper, raw-tool exclusion tests.
   - Acceptance: async subagents are used behind the wrapper only after
     `AgentDelegation`, task-row creation, model/harness/sandbox/capability, and
     sentinel checks pass; drift fails closed with locked copy.
   - Verify: sentinel pass/fail tests, raw-tool model-visible exclusion tests,
     adapter lifecycle tests.

7. Anthropic async executor
   - Write scope: Anthropic SDK adapter bridge, task-message sanitization,
     update/cancel behavior.
   - Acceptance: native Agent/Task/background Bash are wrapper-only;
     unsupported update states fail closed; SDK task lifecycle messages update
     Gantry rows/events after sanitization.
   - Verify: unit tests for direct native denial/wrapper path, task update
     unsupported copy, sanitized lifecycle event mapping.

8. Job/capability/model recovery
   - Write scope: scheduler readiness/status, setup blocker rendering,
     capability-source distinction, model policy, compatibility validation.
   - Acceptance: jobs inherit target-agent capabilities, expose one clear next
     action, validate catalog aliases, and never own harness or durable access.
   - Verify: scheduler/job capability tests, model policy tests, recovery tests.

9. Docs/prompts/cleanup
   - Write scope: architecture docs, prompt docs, MCP tool docs, cleanup search
     evidence, factory artifacts.
   - Acceptance: no unsupported durable scaling claims; raw provider ids/tool
     names remain only in adapter-private code, sentinel tests, exclusion tests,
     or historical docs.
   - Verify: cleanup searches and factory validation.

## 6. Risks

- The goal prompt names missing source anchors. Implementation must not assume
  those files exist; restore or replace them intentionally.
- The durable task lifecycle schema does not exist yet, so the first storage
  slice is a real schema change and requires disposable Postgres verification.
- Full LOCAL-50 crosses concurrency, security, provider adapters, persistence,
  and public tool contracts. Attempting to land it as one unbounded patch would
  be too risky.
- DeepAgents async APIs are preview. Sentinel coverage is mandatory before any
  provider API call.
- Async command cancellation is OS-sensitive and must prove child cleanup.
- Mounting task/delegation tools before the executor is real would violate
  current runner/MCP AGENTS guidance and expose a fake product surface.
- Host-budget clamping must add a layer over existing live/job slots, not
  replace current lease/fence ownership semantics.
- Model policy changes must preserve the accepted public `agentHarness` contract
  and must not reintroduce public `agentEngine`.

## 7. Verify Plan

Planning phase:

```bash
python3 .codex/scripts/stage_orchestrator.py --phase planning --json
```

Focused implementation checks, selected per slice:

```bash
npm run test:unit -- apps/core/test/unit/app/bootstrap/live-execution-waiting-status.test.ts apps/core/test/unit/cli/status.test.ts
npm run test:unit -- apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/application/live-turn-lease-service.test.ts
npm run test:unit -- apps/core/test/unit/jobs/ipc-agent-task-lifecycle-handlers.test.ts apps/core/test/unit/runner/mcp/task-lifecycle-tools.test.ts apps/core/test/unit/runner/locked-tool-surface.test.ts
npm run test:unit -- apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runner/tool-permission-gate.test.ts
npm run test:unit -- apps/core/test/unit/adapters/deepagents-stream-normalizer.test.ts apps/core/test/unit/adapters/deepagents-credential-validation.test.ts
```

Postgres-backed checks for storage/lifecycle work:

```bash
GANTRY_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/gantry_test npm run test:integration:postgres
```

Broader closeout gates:

```bash
npm test
npm run build
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/validate_work.py
```

Cleanup searches:

```bash
rg -n "Waiting for an available worker|Waiting for an available interactive worker" apps/core/src apps/core/test docs -S
rg -n "start_async_task|check_async_task|update_async_task|cancel_async_task|list_async_tasks|write_todos|\\btask\\b" apps/core/src/adapters/llm/deepagents-langchain apps/core/test docs -S
rg -n "provider task id|providerTaskId|background task id|TaskOutput|TaskStop|TaskUpdate|Monitor" apps/core/src apps/core/test docs -S
rg -n "job\\.harness|job-level agentHarness|job-level agentEngine|agentEngine|raw provider model" apps/core/src apps/core/test docs README.md -S
```

Factory transition:

```bash
python3 .codex/scripts/update_run.py --plan-status awaiting-approval --phase awaiting-approval
```

After explicit human approval only:

```bash
python3 .codex/scripts/update_run.py --plan-status approved --phase decomposing
```
