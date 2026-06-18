# Neutral Task Lifecycle Wrapper Plan

Status: planning artifact for LOCAL-36. This is not implementation evidence.

This plan captures the immediate neutral runtime-event wrapper and the larger
product slices that must follow before Gantry can safely expose Anthropic SDK
native `Agent`/`Task` and DeepAgents synchronous or async delegation features.

## 1. Problem

Gantry already has canonical runtime event names for task lifecycle evidence:
`task.started`, `task.progress`, `task.updated`, and `task.notification`.
The current Anthropic runner can emit those events from SDK `task_*` system
messages, but the normalization lives inside the Anthropic adapter. DeepAgents
raw `task`, `write_todos`, and async task tools are currently hidden, which is
the correct safety posture, but there is no Gantry-owned lifecycle wrapper that
can later project those capabilities under Gantry policy, sandbox, audit, and
fencing.

The target is one provider-neutral lifecycle surface for delegated or
long-running work. Provider SDK payloads, provider task handles, raw prompts,
raw output file paths, raw errors, raw DeepAgents tool names, and durable
subagent identities must stay adapter-private.

## 2. Scope / Non-goals

In scope:

- A runner-layer, provider-neutral lifecycle event builder that emits
  `RunnerRuntimeEventFrame` objects with the existing `task.*` event types.
- Anthropic SDK adapter parsing that maps SDK `task_started`, `task_progress`,
  `task_updated`, and `task_notification` observations into the neutral builder.
- DeepAgents adapter hooks that can emit the same lifecycle frames from
  Gantry-owned wrapper state without exposing raw DeepAgents task tools.
- A future durable command/state model for launch, check, update, cancel, list,
  progress, terminal result, and terminal failure.
- Documentation of every larger product slice that must be implemented before
  raw provider delegation features become user-visible capabilities.

Non-goals:

- No public subagent dashboard, mission-control UI, or user-managed worker
  model.
- No provider-native event taxonomy such as `anthropic.*`, `deepagents.*`, or
  `async_task.*`.
- No direct exposure of DeepAgents `task`, `write_todos`, `start_async_task`,
  `check_async_task`, `update_async_task`, `cancel_async_task`, or
  `list_async_tasks`.
- No schema/API/CLI/MCP expansion for the immediate event-wrapper slice.
- No compatibility shim that keeps provider-shaped task payloads as the public
  contract.

## 3. Acceptance Criteria

Immediate neutral event-wrapper slice:

- The shared wrapper lives in the provider-neutral runner layer and returns
  `RunnerRuntimeEventFrame`.
- Event names remain exactly `task.started`, `task.progress`, `task.updated`,
  and `task.notification`.
- The wrapper accepts a sanitized Gantry lifecycle input rather than raw SDK
  messages.
- Anthropic SDK parsing remains adapter-local and drops raw fields before
  calling the wrapper.
- DeepAgents stream/wrapper code can call the same wrapper without enabling raw
  DeepAgents task tools.
- Event payloads exclude raw prompt text, raw output file paths, raw provider
  error text, stack traces, raw provider credentials, provider task handles, and
  unknown provider fields.
- Existing capability-starvation `task.notification` usage remains distinct:
  lifecycle consumers treat an event as task lifecycle only when a valid
  `payload.taskId` exists.

Full product lifecycle acceptance:

- Lifecycle authority supports launch, check, update, cancel, list, progress,
  terminal result, and terminal failure in Gantry terms.
- Durable task lifecycle state is fenced by app, agent, parent run, live turn
  where present, lease token, fencing version, principal, conversation, thread,
  capability scope, and idempotency key.
- Denied delegation never invokes Anthropic native `Agent`/`Task`, DeepAgents
  raw `task`, or DeepAgents async task machinery.
- Stale workers or stale provider async tasks cannot write progress, terminal
  task events, final output, or receipts.
- Human-in-the-loop prompts create durable `pending_interactions` rows before
  provider or channel prompts render.
- Final answers that used delegation include host-enforced evidence receipt
  lines:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: yes/no`
  - `Needs attention: <blocker or none>`

## 4. Technical Approach

### Immediate Slice

Add a focused provider-neutral runner-layer module with a narrow API:

- `TaskLifecycleEventKind`
- `TaskLifecycleContext`
- `TaskLifecycleEventInput`
- `buildTaskLifecycleRuntimeEvent(context, input)`

The wrapper should own canonical event mapping and payload sanitization. It
should not parse Anthropic SDK messages, DeepAgents stream objects, LangGraph
events, or MCP protocol details. Provider adapters translate their private
observations into the neutral input first.

Anthropic `query-loop.ts` should keep only SDK-specific field reads and call the
neutral wrapper. DeepAgents `stream-normalizer.ts` or future
`AgentDelegation` wrapper should call the same builder when it has Gantry-owned
lifecycle observations.

Do not add Postgres schema, settings, Control API, CLI, or Gantry MCP tool
changes for the immediate event-wrapper slice.

### Larger Product Slices

The larger slices are required before launching full async/sync delegation as a
product capability:

1. Durable lifecycle repository and fencing.
2. Gantry delegation permission and pending-interaction gate.
3. DeepAgents sync/default/async delegation projection.
4. Anthropic SDK native `Agent`/`Task` projection.
5. HITL, streaming, rejoin, queued input, progress, and receipts.
6. Skill, MCP, and tool scope isolation for parent and delegated work.
7. Sandbox/backend ownership and authority-free warmup.
8. Structured outputs, telemetry, retries, timeouts, loop limits, frontend
   protocol adapters, and closeout verification.

### Surface Impact Matrix

| Surface                      | Immediate wrapper                                                                                   | Full product lifecycle                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed. Runner frames use one neutral lifecycle builder.                                           | Changed. Launch/check/update/cancel/list/progress/terminal lifecycle becomes durable and fenced.                                |
| `settings.yaml`              | Unchanged by design. The immediate wrapper has no selected capability, default, or profile setting. | Deferred. Delegation defaults and low-latency profile settings need separate product approval in future slices.                 |
| Postgres/runtime projection  | Read-only/observable. Existing `runtime_events` only.                                               | Changed. Durable task lifecycle rows/read models are required for async state, cancellation, stale-write rejection, and rejoin. |
| Control API                  | Unchanged by design. No immediate status, command, or receipt endpoint changes.                     | Changed. Future lifecycle status, rejoin cursors, receipts, and structured results require API projection.                      |
| SDK/contracts                | Unchanged by design. Public DTOs and provider contracts do not change for event normalization.      | Changed. Public lifecycle, status, and structured-output DTOs are part of the full product surface.                             |
| CLI                          | Unchanged by design. No immediate diagnostic or control command changes.                            | Deferred. Future status or diagnostic display needs a dedicated CLI surface decision.                                           |
| Gantry MCP tools/admin skill | Unchanged by design. The immediate wrapper adds no agent-facing tool authority.                     | Deferred. Future reviewed diagnostics or Gantry delegation tools need separate MCP/admin-tool approval.                         |
| Channel/provider adapters    | Provider adapters changed; channel adapters unchanged.                                              | Provider adapters changed; channels render channel-neutral progress and receipts.                                               |
| Docs/prompts                 | Changed. Goal prompt references this plan.                                                          | Changed as each slice lands.                                                                                                    |
| Audit/events                 | Changed only by normalized event payloads.                                                          | Changed. Delegation attempts, denials, HITL, cancellation, stale-write rejection, and terminal evidence are auditable.          |
| Tests/verification           | Changed. Focused unit and runner tests.                                                             | Changed. Unit, integration, Postgres, benchmark, cleanup, review, and functional checks.                                        |

## 5. Task Decomposition

### LOCAL-36-TLC-01: Neutral Event Wrapper

Objective: Move task lifecycle event construction into the provider-neutral
runner layer.

Write scope:

- a new focused module under `apps/core/src/runner/`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/runner/stream-normalizer.ts`
- focused unit tests under `apps/core/test/unit/runner/` and
  `apps/core/test/unit/adapters/`

Acceptance:

- Anthropic task messages still emit the four canonical event types.
- DeepAgents can emit the same event frames from wrapper-owned observations.
- Raw prompts, raw output files, and raw errors are absent from serialized
  runtime events.
- Raw DeepAgents async task tools remain hidden.

Verify:

- `npm run test:unit -- apps/core/test/unit/runner/task-lifecycle-events.test.ts`
- `npm run test:unit -- apps/core/test/unit/runner/agent-runner-ipc.test.ts -t "emits SDK task lifecycle messages"`
- `npm run test:unit -- apps/core/test/unit/adapters/deepagents-stream-normalizer.test.ts`
- `npm run test:unit -- apps/core/test/unit/adapters/deepagents-raw-authority-denial.test.ts`
- `npm run build`
- `python3 .codex/scripts/check_architecture.py`

### LOCAL-36-TLC-02: Durable Lifecycle State

Objective: Add durable lifecycle state for async or long-running delegated work.

Write scope:

- domain/application port for task lifecycle state
- Postgres schema and repository
- Postgres integration tests

Acceptance:

- Launch is idempotent per parent run and task idempotency key.
- Check/update/cancel/list enforce app, agent, principal, conversation, thread,
  parent run, lease/fence, and capability scope.
- Stale fences, wrong parent run, wrong thread, replayed commands, and
  post-terminal writes are rejected.
- Terminal evidence is durable before external delivery claims success.

Verify:

- focused repository unit tests
- disposable Postgres integration test for concurrent launch and stale writes
- `GANTRY_TEST_DATABASE_URL=... npm run test:integration:postgres`

### LOCAL-36-TLC-03: Permission and HITL Gate

Objective: Route lifecycle launch and interaction decisions through Gantry
policy and durable pending interactions.

Write scope:

- tool execution policy call sites
- pending interaction durability
- runner permission IPC helpers
- permission/HITL tests

Acceptance:

- Delegation requires a reviewed neutral capability such as `AgentDelegation`
  or an explicit successor name approved in the capability catalog.
- Denied launch never invokes provider task APIs.
- HITL approval/edit/reject/respond/timeout/cancel resumes in provider-required
  order and only after durable interaction state exists.
- Transient grants stay run-lease-scoped.

Verify:

- `npm run test:unit -- apps/core/test/unit/shared/tool-execution-policy-service.test.ts`
- `npm run test:unit -- apps/core/test/unit/application/pending-interaction-durability.test.ts`
- `npm run test:integration -- apps/core/test/integration/permission-approval-ipc.integration.test.ts`

### LOCAL-36-TLC-04: DeepAgents Delegation Projection

Objective: Enable DeepAgents sync/default/async delegation through Gantry-owned
tools and state, while raw DeepAgents task surfaces stay hidden.

Write scope:

- DeepAgents runner wrapper files
- `builtin-tool-exclusion.ts`
- DeepAgents raw authority and wrapper tests

Acceptance:

- Raw `task`, `write_todos`, `start_async_task`, `check_async_task`,
  `update_async_task`, `cancel_async_task`, and `list_async_tasks` remain hidden
  from the model-visible surface.
- A Gantry-owned delegation tool returns a durable Gantry task id quickly.
- Provider async task ids and checkpoint thread ids remain adapter-private.
- Co-deployed topology is the default when Gantry owns both sides.
- Remote HTTP or Agent Protocol topology is capability-gated and fail-closed
  until auth, audit, worker-pool, and backpressure rules exist.

Verify:

- `npm run test:unit -- apps/core/test/unit/adapters/deepagents-raw-authority-denial.test.ts`
- DeepAgents delegation wrapper unit tests
- DeepAgents boundary integration tests when provider mechanics are exercised

### LOCAL-36-TLC-05: Anthropic Native Agent/Task Projection

Objective: Map Anthropic SDK native `Agent`/`Task` behavior into the same
Gantry lifecycle without relying on raw SDK permission inheritance.

Write scope:

- Anthropic runner tool validation and permission files
- Anthropic runner lifecycle mapping tests
- Claude Agent SDK boundary tests

Acceptance:

- Native `Agent`/`Task` launches are unavailable by default or wrapped behind
  Gantry lifecycle authority.
- Subagents inherit only bounded host-resolved model, tool, MCP, and skill
  scopes.
- Hook and permission order is tested against SDK semantics.
- Directory-global `continue` is not used for horizontal live workers.
- `sessionStore` remains mirror-only unless separately approved and tested.

Verify:

- `npm run test:unit -- apps/core/test/unit/runner/agent-runner-ipc.test.ts`
- `npm run test:integration -- apps/core/test/integration/claude-agent-sdk-boundary.integration.test.ts`

### LOCAL-36-TLC-06: User-Visible Progress, Rejoin, and Receipts

Objective: Make lifecycle state visible and recoverable across live channels,
SDK status streams, and jobs.

Write scope:

- runtime event projection
- status/session surfaces where needed
- channel-neutral descriptors
- receipt enforcement tests

Acceptance:

- Users see launch, progress, approval-waiting, retrying, cancelled, failed,
  timed-out, and completed states.
- Rejoining clients resume by durable cursor.
- Final responses with delegation include the exact receipt lines.
- Structured task outputs are schema-validated and kept separate from
  free-form assistant UX.

Verify:

- control/session projection tests
- channel-neutral descriptor tests
- stream/rejoin tests

### LOCAL-36-TLC-07: Skill, MCP, Tool, and Sandbox Boundaries

Objective: Ensure lifecycle delegation cannot activate raw extension surfaces.

Write scope:

- DeepAgents and Anthropic raw authority gates
- MCP proxy/list/call behavior if touched
- sandbox provider tests

Acceptance:

- Main and delegated scopes replace rather than merge tool, skill, and MCP
  scopes.
- MCP prompts/resources/sampling/elicitation/tasks/auth remain fail-closed
  unless reviewed adapter flows exist.
- Sandbox warmup contains no provider session, credentials, MCP clients,
  transient grants, browser tokens, memory, workspace overlays, or selected
  authority.
- DeepAgents shell/file behavior stays behind Gantry-owned tools and enforcing
  sandbox checks.

Verify:

- raw DeepAgents authority tests
- MCP proxy tests
- sandbox provider tests
- cleanup searches for raw extension names

### LOCAL-36-TLC-08: Robustness, Telemetry, and Protocol Adapters

Objective: Add lifecycle-safe structured output, retries, timeouts, telemetry,
frontend rejoin, and protocol adapter behavior without creating a second
control plane.

Write scope:

- structured output validators
- telemetry/progress projection
- retry/timeout budget code
- frontend/protocol adapter docs and tests where selected

Acceptance:

- Anthropic `outputFormat` and DeepAgents `responseFormat` are used only behind
  Gantry schemas and redaction.
- Cost/usage/OpenTelemetry fields are metrics, not authority.
- Retry, timeout, loop, and worker-pool exhaustion produce terminal evidence.
- ACP, A2A, remote Agent Protocol, and headless client tools stay Gantry
  adapters over app/agent/conversation/thread/run identity or fail closed.

Verify:

- focused structured-output tests
- retry/timeout terminal evidence tests
- protocol adapter fail-closed tests

### LOCAL-36-TLC-09: Closeout and Cleanup

Objective: Prove there are no raw provider task authority leaks and no stale
planning gaps.

Write scope:

- docs updates
- factory artifacts
- review evidence

Acceptance:

- Every raw task/subagent/provider lifecycle match is classified as active,
  rejected-only, historical, generated, or owned follow-up.
- Every deferred raw provider surface has a fail-closed test or explicit
  activation condition.
- 300-concurrent benchmark evidence remains valid or records a launch blocker.
- Architecture, build, unit, integration, review, and artifact validation gates
  are recorded.

Verify:

- cleanup searches from the live latency hardening goal prompt
- `npm run build`
- `npm test`
- `python3 .codex/scripts/verify.py`
- `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
- `python3 .codex/scripts/check_task_completion.py`

## 6. Risks

- A lifecycle event wrapper alone is observable evidence, not command authority.
  It must not be mistaken for async task state or cancellation control.
- Raw DeepAgents async task tools are tempting because the library supplies
  them, but exposing them directly would bypass Gantry fencing and audit.
- Provider task ids are useful for adapter correlation, but they must not become
  public durable authority.
- Anthropic SDK hook and permission order can diverge from Gantry expectations;
  tests must model SDK semantics before wrapped native delegation is enabled.
- Durable lifecycle schema work increases scope and requires disposable
  Postgres verification.
- Low-latency mode must narrow selected projection only for a run or agent; it
  must not delete feature support or mutate durable capability truth.

## 7. Verify Plan

Before implementation:

- Confirm the active run is in planning and this plan is approved.
- Re-run official documentation checks for the touched slice when the feature is
  unstable or preview, especially DeepAgents async subagents and Anthropic SDK
  task/subagent APIs.
- Re-read scoped `AGENTS.md` files for every write scope.

Immediate wrapper commands:

```bash
npm run test:unit -- apps/core/test/unit/runner/task-lifecycle-events.test.ts
npm run test:unit -- apps/core/test/unit/runner/agent-runner-ipc.test.ts -t "emits SDK task lifecycle messages"
npm run test:unit -- apps/core/test/unit/adapters/deepagents-stream-normalizer.test.ts
npm run test:unit -- apps/core/test/unit/adapters/deepagents-raw-authority-denial.test.ts
npm run build
python3 .codex/scripts/check_architecture.py
```

Full lifecycle commands:

```bash
GANTRY_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gantry_test npm run test:integration:postgres
npm test
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/check_task_completion.py
```

Official documentation checkpoints to refresh before related implementation:

- Anthropic Agent SDK subagents, permissions, hooks, sessions, session storage,
  streaming input/output, structured outputs, custom tools, MCP, plugins,
  slash commands, file checkpointing, cost tracking, OpenTelemetry, hosting, and
  secure deployment.
- DeepAgents skills, tools/MCP, permissions, subagents, async subagents,
  human-in-the-loop, event streaming, streaming, profiles, interpreters,
  backends, sandboxes, memory, context engineering, structured output,
  customization, production, Code/managed surfaces, and protocol adapters.
- MCP latest tools, resources, prompts, roots, sampling, elicitation,
  authorization, lifecycle, task-support, schema metadata, pagination, and
  `notifications/tools/list_changed`.
