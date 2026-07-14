# /goal Prompt: Event-Driven Waits And Agent-Only Subagents

Use this prompt to pursue the goal:

```text
/goal Implement Event-Driven Waits And Agent-Only Subagents from docs/architecture/event-driven-waits-agent-subagent-goal-prompt.md.

Mode:
- Single-cut code. No legacy mode, no compatibility shim, no migration helper for old local state.
- Use ponytail full mode: smallest correct diff, deletion over translation, no speculative abstractions, no wrapper-only files.
- Use architecture-refactor for boundary cleanup and permission-safety for raw tool authority changes.
- Do not bypass Gantry permission/capability flows, runtime event contracts, or durable storage truth.

Goal:
- Replace the remaining useful fixed-poll waits with durable event/wakeup-driven waits.
- Cut Anthropic native subagent support to Agent only. The deprecated Claude Task tool spelling must not work, normalize, or request access.
- Keep Gantry product task lifecycle tools, such as mcp__gantry__task_get, because those are runtime task APIs and not Claude's deprecated subagent tool.
```

## Current Repo Truth To Preserve

- Main-agent steering during a running turn is already event/wakeup-driven:
  durable `live_turn_commands`, Postgres `NOTIFY`, and the owner command pump.
  Do not rewrite this path.
- `LiveTurnAuthority` still needs its owner tick for lease renewal, slot renewal,
  ownership-loss detection, and missed-wakeup recovery.
- `runtime_events` are durable observable truth. `LISTEN/NOTIFY`, file watches,
  and subscriptions are wakeups only; every consumer must re-query durable rows.
- Anthropic docs now use `Agent` for subagent spawning and note that `Task(...)`
  was renamed to `Agent(...)` in Claude Code v2.1.63:
  <https://code.claude.com/docs/en/sub-agents>.
- The installed `@anthropic-ai/claude-agent-sdk` still emits `task_*` lifecycle
  system messages. Those event names are provider wire shape, not supported
  user-facing `Task` tool authority.

## Implementation Tasks

1. Event-drive `scheduler_wait_for_events`.
   - Replace the fixed 1s sleep loop in
     `apps/core/src/jobs/ipc-scheduler-query-handlers.ts`.
   - Query durable job events first.
   - Wait on a matching runtime-event subscription or wakeup.
   - Re-query durable job events after each wake.
   - Keep bounded timeout fallback for missed notifications.

2. Event-drive delegated child-task waits.
   - Replace the 1s `linkedChildTaskCounts` polling in
     `apps/core/src/jobs/async-delegated-agent-task.ts`.
   - Add the smallest terminal async-task wakeup at the existing task transition
     boundary.
   - Parent waits subscribe by parent task id, wake on child terminal state, and
     re-query durable child counts.
   - Keep timeout/recovery fallback.

3. Event-drive due-now control webhook delivery.
   - Add a Postgres wakeup when a webhook delivery row is inserted or requeued
     with `nextAttemptAt <= now`.
   - Subscribe in the control server and call `flushWebhookDeliveries()`
     immediately on wake.
   - Keep the existing periodic flush as retry/backstop.

4. Cut Anthropic native subagent spelling to `Agent` only.
   - Keep `Agent -> AgentDelegation`.
   - Remove `Task` and `Task*` from translation/replacement paths that normalize
     raw provider-native tools to `AgentDelegation`.
   - Keep `Task` and `Task*` in provider-native rejection/disallowed lists so old
     configs fail closed instead of becoming available.
   - Add an explicit hard deny in the runner permission path for raw `Task` and
     `Task*`: no approval prompt, no yolo allow, no persistent request, no alias.
   - Remove `Task` from native Agent input validation/background coercion paths.
   - Leave SDK `task_*` lifecycle event parsing intact.

5. Docs and cleanup.
   - Update active docs and tests that describe `Task/Agent` parity to say
     `Agent` only.
   - Do not update historical decision records unless they are actively
     misleading current implementation guidance.

## Acceptance Criteria

- Follow-up messages during a running live turn still route through the existing
  live-turn command inbox.
- `scheduler_wait_for_events` wakes on relevant job/runtime events without a
  fixed 1s success-path delay.
- Delegated parent tasks wake when the final linked child task reaches terminal
  state.
- Due-now webhook delivery flushes immediately after enqueue/requeue.
- Missed notifications remain safe because durable rows are re-queried and
  periodic backstops remain.
- Raw Anthropic `Agent` attempts still route through Gantry `AgentDelegation`.
- Raw Anthropic `Task` or `Task*` attempts fail closed and never normalize to
  `AgentDelegation`.
- Gantry runtime task APIs remain available only through Gantry MCP task tools.

## Focused Tests

Run focused tests first:

```bash
npm run test:unit -- apps/core/test/unit/runner/agent-capabilities.test.ts
npm run test:unit -- apps/core/test/unit/runner/tool-permission-gate.test.ts
npm run test:unit -- apps/core/test/unit/shared/agent-tool-references.test.ts
npm run test:unit -- apps/core/test/unit/jobs/async-command-task-service.test.ts
npm run test:unit -- apps/core/test/unit/jobs/outbound-delivery-recovery.test.ts
npm run test:unit -- apps/core/test/unit/application/runtime-events/runtime-event-exchange.test.ts
```

Add or update tests for:

- `scheduler_wait_for_events` wakes from a matching runtime event and still times
  out cleanly.
- Parent delegated task wait wakes when linked child count reaches zero.
- Webhook delivery insert/requeue triggers immediate flush and periodic recovery
  still runs.
- Raw `Task` and `Task*` permission callbacks are denied without approval.
- `Agent` remains the only native subagent tool spelling that can be projected
  through `AgentDelegation`.

## Cleanup Searches

Run and interpret these before closeout:

```bash
rg -n "Task\\(|Task tool|Task/Agent|Agent and Task|TEST_SUBAGENT_TOOL_NAME = 'Task'" apps/core/src apps/core/test docs -S
rg -n "scheduler_wait_for_events|SCHEDULER_WAIT_POLL_MS|waitForLinkedChildTasks|setInterval\\(|setTimeout\\(" apps/core/src apps/core/test -S
rg -n "AgentDelegation|providerNativeToolReplacement|publicGantryToolNameForSdkTool|permissionRequestToolName" apps/core/src apps/core/test -S
```

Remaining matches must be:

- current Gantry runtime task lifecycle APIs;
- SDK `task_*` lifecycle event parsing;
- tests proving raw `Task` is denied;
- historical docs intentionally retained with no active implementation guidance.

## Verification

Run the smallest focused checks after each change. Final gates:

```bash
npm run typecheck
npm run test:unit
npm test
npm run build
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/check_task_completion.py
```

If Postgres-backed behavior changes, use a disposable Postgres database with
the required `vector` and `pg_trgm` extensions and run the relevant Postgres
integration tests with `GANTRY_TEST_DATABASE_URL`.

## Review Loop

Run autoreview after implementation and verification:

```bash
python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local
```

Fix accepted findings with the smallest diffs, rerun focused tests, and rerun
autoreview until no accepted/actionable findings remain.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Selected waits become wakeup-first; raw Anthropic `Task` fails closed. |
| `settings.yaml` | Unchanged by design | No config, migration, alias, or compatibility branch. |
| Postgres/runtime projection | Changed | Internal wakeups may be added; durable rows remain truth. |
| Control API | Read-only/observable | Webhook delivery latency may improve; endpoint shapes unchanged. |
| SDK/contracts | Changed | Anthropic native subagent projection is `Agent` only. |
| CLI | Unchanged by design | No command or flag changes. |
| Gantry MCP/admin tools | Read-only/observable | Scheduler waits may return sooner; Gantry task tools unchanged. |
| Channel/provider adapters | Unchanged by design | No channel behavior change. |
| Docs/prompts | Changed | Active docs must stop presenting `Task` as a supported subagent spelling. |
| Audit/events | Unchanged by design | SDK `task_*` lifecycle events remain provider event names. |
| Tests/verification | Changed | Add wakeup-first and raw-`Task` hard-deny coverage. |

## Non-Negotiable Rejections

- No `Task` alias.
- No `Task` to `AgentDelegation` normalization.
- No migration helper for old `Task(...)` settings.
- No new config switch for polling vs event-driven mode.
- No removal of lease, heartbeat, timeout, provider transport polling, or
  missed-wakeup recovery loops.
- No use of runtime events as a command bus.
