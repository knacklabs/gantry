# LAT-GATE-0 Response Latency Prerequisite Gates Plan

## Problem

The response-latency program requires clean local integration and agent E2E gates before any latency PR can be merged. Current main has three fixture-level blockers that make those gates unreliable:

1. `apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts` has a host-side RunCommand approval helper with a fixed 5 second wait for the permission request. Cold DeepAgents/Postgres startup can exceed that helper budget even when the production path is correct.
2. `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts` seeds and exercises the Postgres MCP inventory/audit hot-path without the reviewed semantic capability evidence required by the current MCP action-authority contract.
3. `apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts` uses a hermetic fake Claude executable installed by the test, but the fake trigger path waits for `control_request.initialize` or EOF before it emits the transcript needed by the current packaged runtime runner path.
4. `npm run lint` currently reports a current-main baseline of 43 errors and 1047 warnings outside this fixture-repair scope.

This is a prerequisite gate repair, not a response-latency optimization phase.

## Scope / Non-goals

In scope:

- Fixture-only repair for the three blockers above.
- Preserve the current security model: reviewed semantic capabilities remain required for third-party MCP action authority, and RunCommand remains mediated through signed IPC and the host permission coordinator.
- Preserve the packaged-runtime E2E contract: fresh `GANTRY_HOME`, disposable Postgres, no live user runtime, no persistent developer database, and no real model provider.
- Record Forge artifacts before implementation.
- Record the current-main lint baseline and raise a Forge signal if the baseline still blocks PR-ready after the fixture repairs.

Non-goals:

- No production source changes. If a fixture cannot model current production behavior, raise a Forge signal and stop for a revised plan and new client signoff.
- No lint cleanup, architecture exception changes, broad timeout rewrites, or unrelated flaky-test fixes.
- No edits to the LAT-0 latency harness branch/files.
- No weakening of auth, signed IPC replay checks, permission decision precedence, sandbox projection, MCP reviewed-capability rules, or scheduler/job state transitions.
- No changes to the local KnackLabs runtime or lead-gen job in this prerequisite branch.

## Acceptance Criteria

- DeepAgents RunCommand Postgres integration no longer fails solely because the test helper times out before the cold runner creates its permission request.
- The helper wait budget is scoped to the test helper and remains bounded; it does not change production runner, permission, or model timeouts.
- The MCP hot-path Postgres fixture includes reviewed semantic capability data for `HOT_SERVER_ID`, `HOT_SERVER_NAME`, and `HOT_TOOL_NAME` rather than relying on stale exact third-party MCP grants.
- The MCP fixture still preserves source-inventory versus action-authority separation: hot-path inventory/search evidence remains available, and any call authority comes from reviewed semantic capability evidence.
- The job-lifecycle fake Claude executable speaks the current runner protocol sufficiently for the packaged runtime test to prove pause, resume, trigger, completion, delivery, and persisted evidence. Concretely, after handling required control responses and receiving the first prompt-stream input item, it emits the existing deterministic transcript: `system`/`init` with connected Gantry MCP status, assistant text, and `result`/`success`.
- The job-lifecycle scenario stays hermetic: no real provider credential, no real `~/gantry`, disposable Postgres only, no live user or persistent developer database, and no model phrasing assertions.
- `npm run lint` is run and its 43-error/1047-warning current-main baseline is recorded. If still present, implementation raises a Forge signal and does not widen this PR to clean unrelated lint debt.
- Before merge, the checkout-bound local runtime smoke passes for the canonical KnackLabs lead-maintenance job. Evidence must prove the running local service was built/installed from the active PR worktree, then run `scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e` and record terminal health `completed`.
- Targeted gates pass:
  - `npm run test:integration:postgres -- apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
  - `GANTRY_POSTGRES_HOT_PATH=1 npm run test:integration:postgres:hot-path -- apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
  - `npm run build:runtime`
  - `npm run test:e2e:agent:hermetic -- apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
- Final branch gates for this prerequisite PR pass before it is treated as unblocking the latency program:
  - `npm run format:check`
  - `npm run typecheck`
  - `npm run lint` or a recorded Forge signal that the confirmed 43-error/1047-warning current-main lint baseline remains outside this PR's scope
  - `npm run test:unit`
  - `npm run test:integration`
  - `npm run test:integration:postgres`
  - `npm run test:e2e:agent:hermetic`
  - `npm run check:architecture`
  - `/opt/homebrew/bin/python3 .agents/scripts/verify.py`

## Technical Approach

Use the smallest fixture repairs that match current runtime truth.

1. DeepAgents RunCommand helper
   - Update only the test helper that waits for the host permission request.
   - Replace the fixed 5 second polling deadline with a bounded helper parameter or local constant aligned with the surrounding 120 second test timeout.
   - Keep the signed request parse, `coordinatePermissionDecision`, reviewed rule decision, and signed response write unchanged.
   - Add/retain a targeted assertion that the host decision is still `reviewed_rule` for `RunCommand(echo *)`.

2. MCP hot-path fixture
   - Update `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`.
   - Add reviewed semantic capability fixture data for the actual hot-path constants: `HOT_SERVER_ID`, `HOT_SERVER_NAME`, and `HOT_TOOL_NAME`.
   - Keep `GANTRY_POSTGRES_HOT_PATH=1` as part of the targeted verification so the row-volume hot-path scenario actually runs.
   - Do not restore legacy exact third-party MCP action grants as authority.
   - Preserve inventory/audit hot-path evidence and source/action separation.

3. Hermetic job-lifecycle fake Claude
   - Re-resolve the fake executable path installed by `installHermeticRunnerTools`.
   - Update the fake to retain required control responses and, on the first prompt-stream input item, emit the current deterministic runner transcript expected by packaged runtime jobs: `system`/`init` with connected Gantry MCP status, assistant text, and `result`/`success`.
   - Assert scheduler behavior through API state, job events, run status, and delivery persistence; do not assert natural-language model text.
   - Keep all credentials fake and scoped through the existing harness `env` path.

4. Lint baseline
   - Run `npm run lint` before final gate claims.
   - If it still reports the confirmed current-main 43 errors and 1047 warnings, record the exact output summary and raise a Forge signal instead of editing unrelated files.
   - Do not expand the fixture repair to lint-clean production or unrelated test files.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | Fixture repairs only; production runner and scheduler contracts remain the source of truth. |
| API | Read-only/observable | Job E2E exercises existing control endpoints without route or contract changes. |
| Data/schema | Read-only/observable | Postgres suites are used to prove current behavior; no schema, migration, or repository edits planned. |
| CLI/ops | Read-only/observable | The KnackLabs smoke uses existing `gantry` CLI/service operations; no CLI behavior or launchd ownership change. |
| UI | Not applicable | No user-interface surface is touched. |
| Docs | Changed | This plan and the accepted signoff decision record are added. |
| Tests | Changed | Exactly the targeted validation fixtures are repaired. |

Cleanup search terms for the implementer:

- `while (Date.now() - startedAt < 5_000)`
- `RunCommand(echo *)`
- `HOT_SERVER_ID`
- `HOT_SERVER_NAME`
- `HOT_TOOL_NAME`
- `mcp-inventory-audit-explain-itest`
- `installHermeticRunnerTools`
- `system`
- `init`
- `Final Job Report`

## Decisions

No new decisions.

Existing gate record: `docs/decisions/0064-client-signoff.md` records the
accepted client signoff for this prerequisite branch through the normal Forge
gate.

## Task Decomposition

One bounded implementation stage is sufficient.

Stage `LAT-GATE-0-FIXTURES`

- Objective: repair the three validation fixtures without production behavior changes.
- Write scope:
  - `apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
  - `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
  - `apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
  - Any existing test-only helper directly owned by the job-lifecycle scenario, only if the fake executable is defined there.
- Acceptance: all criteria above pass with no production file edits. If a fixture cannot model current behavior within the test-only scope, raise a Forge signal and stop for a revised plan and new client signoff.
- Reviewer focus: fixture faithfulness to production contracts, no timeout masking of real hangs, no MCP authorization weakening, no accidental use of real model/runtime state.

## Risks

- A longer helper wait could hide a real deadlock if it is applied broadly. Mitigation: change only the specific permission-request wait and keep test-level timeout bounded.
- The MCP fixture could accidentally re-authorize exact third-party MCP tools. Mitigation: add reviewed semantic capability data instead of removing negative stale-rule coverage.
- The fake Claude update could become a parallel runner implementation. Mitigation: emit only the minimum frames needed for job-lifecycle state assertions.
- E2E may still fail from environment prerequisites such as missing disposable Postgres, missing build output, or port conflicts. Mitigation: report those as environment blockers, not as passing evidence.
- The local KnackLabs smoke can give false confidence if `com.gantry` is still running from another checkout. Mitigation: record service/worktree proof before triggering `job-knacklabs-lead-maintenance-43527c192a6e`.

## Verify Plan

Before implementation:

- `/opt/homebrew/bin/python3 .agents/scripts/forge.py next`
- `/opt/homebrew/bin/python3 .agents/scripts/forge.py decision list --active`
- Re-resolve every cited symbol with `rg`/file reads.

During implementation:

- `npm run test:integration:postgres -- apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
- `GANTRY_POSTGRES_HOT_PATH=1 npm run test:integration:postgres:hot-path -- apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
- `npm run build:runtime`
- `npm run test:e2e:agent:hermetic -- apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
- `npm run lint` to record whether the confirmed current-main 43-error/1047-warning lint baseline remains

Before PR-ready:

- `npm run format:check`
- `npm run typecheck`
- `npm run lint` or a Forge signal documenting the confirmed current-main lint baseline as outside this PR's write scope
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:integration:postgres`
- `npm run test:e2e:agent:hermetic`
- `npm run check:architecture`
- `/opt/homebrew/bin/python3 .agents/scripts/verify.py`
- One autoreview helper run with quality, performance, and security lenses.
- Record automated tests and reviews through the Forge recorders.

Before merge:

- Prove the local Gantry service is built/installed from the active PR worktree, not another checkout, by recording service/worktree evidence alongside `gantry status`.
- Run `scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e` from the active checkout.
- Record the canonical job's terminal health as `completed`; if setup/auth blocks the live smoke, report the blocker and do not merge.
