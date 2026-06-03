# Operator Trust and Runtime Honesty Roadmap

## Goal

Gantry must never say something is ready, delivered, running, allowed,
remembered, or connected unless that state is true and recoverable.

This roadmap adds honesty on top of the workspace/access, setup, runtime
repository, bootstrap, and wrapper cleanup stack. It does not reopen those
decisions.

## Scope

In scope:

- Operator-facing error shape and recovery guidance.
- MCP/admin/tool handler parity at boot.
- Watchdog-owned terminal state for stuck jobs, runner IPC, MCP calls, and
  delivery.
- Honest browser, delivery, memory, provider, and model status.
- Channel-neutral interaction descriptors for approvals, blockers, partial
  delivery, memory status, and operator errors.

Out of scope:

- New setup flows.
- New provider public contracts.
- Legacy aliases, fallback success paths, or compatibility shims.
- A second runtime mode. Host runtime remains the only supported runtime mode.

## UX Contract

Every operator-facing error uses this shape:

```text
<one-line summary>
cause: <specific cause with errno/status/tool/path when available>
recover: <one exact next step>
```

Tool registry boot failure:

```text
Gantry could not start because <tool_name> is registered without a handler.
cause: MCP tool registry mismatch
recover: remove the tool registration or add its handler before starting Gantry.
```

Stuck run timeout:

```text
Run failed.
cause: watchdog_timeout after <duration>
recover: review the job output, adjust timeout if needed, then retry.
```

Partial delivery:

```text
Message delivery incomplete.
cause: <provider> rejected part <n>/<total>
recover: see logs for the full output and retry after fixing delivery.
```

Memory status:

```text
Memory: Ready | Needs setup | Needs review | Disabled
Last dream: <time | never>
Review queue: <count>
Injected this run: <count>
```

Provider/model status:

```text
Provider: <name>
Connection: Ready | Needs credential | Needs login | Blocked
Model: <modelAlias>
```

## Current Starting Points

- MCP server handler parity already exists in
  `apps/core/src/runner/mcp/server.ts`, but the thrown copy must be converted
  to the exact operator error contract.
- `InteractionDescriptor` already exists in `apps/core/src/domain/types.ts`
  and is documented in `docs/architecture/channel-interactions.md`; extend it
  before adding channel-specific formatting.
- Partial-delivery domain work already exists under
  `apps/core/src/domain/messages/partial-delivery.ts`; delivery surfaces must
  report actual provider acceptance rather than absence of exceptions.
- Watchdog and scheduler cancellation are already identified in
  `docs/architecture/runtime-refactor-plan.md` and
  `docs/architecture/refactor-gap-closure-plan.md`; this roadmap keeps that
  work narrow and testable.

## Slices

### Slice 1: Surface Honesty

Objective: every operator-visible success or failure must have a truthful source
of evidence.

Tasks:

- Add one shared operator error formatter for `summary`, `cause`, and
  `recover`.
- Convert MCP/admin/tool boot parity failures to the exact tool registry copy.
- Keep browser status scoped to browser/CDP driveability only.
- Convert delivery reporting to use accepted/rejected parts, not "no exception
  thrown".

Primary write scope:

- `apps/core/src/runner/mcp/server.ts`
- `apps/core/src/runner/mcp/tools/browser.ts`
- `apps/core/src/runtime/group-browser-status.ts`
- `apps/core/src/domain/messages/partial-delivery.ts`
- `apps/core/src/jobs/delivery.ts`
- `apps/core/src/application/outbound-delivery/`
- shared operator formatting near existing shared/domain status types

Verify:

- Boot parity unit test asserts exact registry mismatch copy.
- Browser status unit test proves model credential failure does not affect
  browser readiness.
- Delivery unit test simulates provider rejection for part `n/total`.

### Slice 2: Watchdog and Cancellation

Objective: no run can remain `running` beyond its timeout plus grace.

Tasks:

- Add an independent watchdog owner for jobs, runner IPC, MCP calls, and provider
  delivery budgets.
- Route `scheduler_cancel_run` through the same terminal-state path as watchdog
  reaping.
- Make scheduler-owned terminal states authoritative; runners report progress
  only.
- Persist cause, recovery step, and audit/event evidence for failed and
  cancelled runs.

Primary write scope:

- `apps/core/src/jobs/`
- `apps/core/src/runner/mcp/tools/scheduler.ts`
- Postgres job/run repositories
- runtime event/audit writers

Verify:

- Wedged-run test fails within `timeout + grace`.
- Manual cancel test and watchdog timeout test assert the same terminal-state
  path.
- Status formatting test asserts non-empty cause and recovery step.

### Slice 3: Memory and Continuity Control Center

Objective: memory remains optional, but its state is visible and explainable.

Tasks:

- Add one memory status projection with `Ready`, `Needs setup`,
  `Needs review`, and `Disabled`.
- Show last dream time, review queue count, and continuity injected this run.
- Surface open commitments at run start through the existing channel-neutral
  interaction path.

Primary write scope:

- `apps/core/src/runner/mcp/tools/memory.ts`
- memory repositories/services
- session/run-start status formatting
- CLI/control status surfaces

Verify:

- Memory status tests cover empty, ready, disabled, and needs-review states.
- Run-start test asserts injected continuity count is observable.

### Slice 4: Provider and Settings Boundary Cleanup

Objective: provider implementation names stay inside registries and adapters.

Tasks:

- Add an architecture gate for provider-specific implementation names outside
  approved registry/adapter files.
- Keep user-facing model status on `modelAlias`.
- Render provider connection state as `Ready`, `Needs credential`,
  `Needs login`, or `Blocked`.

Primary write scope:

- model catalog and provider registry files
- settings desired-state readers/writers
- CLI/control status formatting
- architecture checker allowlist

Verify:

- Provider boundary gate rejects implementation names outside approved files.
- Status tests assert the exact provider/model copy.

### Slice 5: Channel-Neutral Interaction Polish

Objective: Slack, Telegram, Teams, and Web/API may format differently, but they
must carry the same meaning and choices.

Tasks:

- Extend `InteractionDescriptor` for operator errors, setup blockers, partial
  delivery, memory status, and provider/model status.
- Move channel renderers to consume that descriptor instead of rebuilding
  meaning locally.
- Add snapshots for each channel adapter.

Primary write scope:

- `apps/core/src/domain/types.ts`
- channel renderers under `apps/core/src/channels/`
- runtime IPC parsing/formatting
- Web/API status serializers

Verify:

- Channel snapshot tests prove equal semantic content across Slack, Telegram,
  Teams, and Web/API.

## Acceptance Criteria

- Gantry never boots with a listed tool that cannot run.
- No job can stay `running` past its timeout plus watchdog grace.
- Every failed or cancelled run has a non-empty cause and recovery step.
- Browser status does not include unrelated model gateway or broker health.
- Telegram, Slack, and provider delivery can report partial failure without
  marking the whole message delivered.
- Memory status answers what is remembered, what needs review, and what was
  injected.
- Shared settings/model code does not leak provider-specific implementation
  names outside approved registries and adapters.

## Surface Impact Matrix

| Surface                      | Classification | Reason                                                                                                   |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed        | Watchdog cancellation, boot validation, delivery truth, and status honesty change runtime outcomes.      |
| `settings.yaml`              | Changed        | Provider/settings boundary cleanup may remove leaked implementation names without compatibility aliases. |
| Postgres/runtime projection  | Changed        | Terminal run evidence, watchdog events, memory status, and delivery status need durable evidence.        |
| Control API                  | Changed        | Exposes the same honest status and error shapes.                                                         |
| SDK/contracts                | Changed        | Tool/status/error responses become stricter and explicit.                                                |
| CLI                          | Changed        | Status, doctor, memory, provider, and setup follow-up output use the shared copy.                        |
| Gantry MCP tools/admin skill | Changed        | Scheduler cancellation, memory status, and error receipts use the same contract.                         |
| Channel/provider adapters    | Changed        | Adapters consume channel-neutral interaction descriptors for the affected surfaces.                      |
| Docs/prompts                 | Changed        | Documents honest status, watchdog behavior, memory control, and provider-neutral settings.               |
| Audit/events                 | Changed        | Records watchdog timeout, cancellation, partial delivery, and boot registry failure.                     |
| Tests/verification           | Changed        | Adds boot, watchdog, delivery, memory, provider-boundary, and channel-rendering gates.                   |

## Final Gates

Run focused checks while landing each slice, then run:

```bash
npm run build
npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
```

## Locked Decisions

- The next theme after the current cleanup stack is trust, not another naming
  pass.
- No new feature ships if its status, error, delivery, and recovery path are not
  honest.
- Memory stays optional, but once enabled it must be visible and explainable.
- Provider implementation names belong in adapters and registries, not shared
  product contracts.
- No legacy status fields, fallback success paths, or compatibility shims.
