# LAT-GATE-0 Response Latency Prerequisite Gates Plan

## Problem

The response-latency program requires trustworthy local integration, Postgres
hot-path, agent E2E, CI, review, and live-smoke gates before any latency PR can
merge. After Forge contradiction signal `S-0001-8d39`, LAT-GATE-0 is narrowed to
two fixture repairs:

1. `apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
   has a host-side RunCommand approval helper with a fixed 5 second wait for the
   permission request. Cold DeepAgents/Postgres startup can exceed that helper
   budget even when the production path is correct.
2. `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
   seeds and exercises the Postgres MCP inventory/audit hot-path without the
   reviewed semantic capability evidence required by the current MCP
   action-authority contract.

The prior job-lifecycle fixture premise is rejected. On macOS, the packaged
runner strips `HOME`, so `allowedOuterSandboxClaudeExecutable` rejects
`fakeHome/.local/bin/claude`. Changing executable trust is production scope and
is not authorized for this prerequisite. The job-lifecycle test must return to
the unchanged baseline and be proven in a disposable Linux/CI-parity Node 25
worktree or container. That baseline evidence is now recorded from unchanged
base `5fff01d0f` in a Node 25 container with a container-local Postgres proxy:
job-lifecycle E2E, 1 file / 1 test passed, 0 skipped, 38.03s. The macOS host
failure is recorded as a platform mismatch, not a fixture defect.

`npm run lint` currently reports a current-main baseline of 43 errors and 1047
warnings outside this fixture-repair scope.

This is a prerequisite gate repair, not a response-latency optimization phase.

## Scope / Non-goals

In scope:

- Fixture-only repair for the two blockers above.
- Restore the job-lifecycle test and any job-lifecycle fake-Claude helper edits
  to the unchanged baseline; job-lifecycle remains an evidence gate, not an
  implementation target.
- Preserve the current security model: reviewed semantic capabilities remain
  required for third-party MCP action authority, and RunCommand remains mediated
  through signed IPC and the host permission coordinator.
- Preserve the packaged-runtime E2E contract: fresh `GANTRY_HOME`, disposable
  Postgres, no live user runtime, no persistent developer database, and no real
  model provider.
- Record the current-main lint baseline and raise a Forge signal if the baseline
  still blocks PR-ready after the fixture repairs.

Non-goals:

- No production source changes. If these two fixtures cannot model current
  production behavior, raise a Forge signal and stop for a revised plan and new
  client signoff.
- No executable-trust, sandbox, `HOME`, `allowedOuterSandboxClaudeExecutable`,
  packaged-runner, provider, scheduler, or job-lifecycle fake-Claude changes.
- No lint cleanup, architecture exception changes, broad timeout rewrites, or
  unrelated flaky-test fixes.
- No edits to the LAT-0 latency harness branch/files.
- No weakening of auth, signed IPC replay checks, permission decision
  precedence, sandbox projection, MCP reviewed-capability rules, or
  scheduler/job state transitions.
- No changes to the local KnackLabs runtime or lead-gen job in this prerequisite
  branch.

## Acceptance Criteria

- DeepAgents RunCommand Postgres integration no longer fails solely because the
  test helper times out before the cold runner creates its permission request.
- The helper wait budget is scoped to the test helper and remains bounded; it
  does not change production runner, permission, model, sandbox, or provider
  timeouts.
- The MCP hot-path Postgres fixture includes reviewed semantic capability data
  for `HOT_SERVER_ID`, `HOT_SERVER_NAME`, and `HOT_TOOL_NAME` rather than relying
  on stale exact third-party MCP grants.
- The MCP fixture still preserves source-inventory versus action-authority
  separation: hot-path inventory/search evidence remains available, and any call
  authority comes from reviewed semantic capability evidence.
- The job-lifecycle E2E test and its fake-Claude helper are unchanged from the
  baseline. No job-lifecycle file is part of this PR's write scope.
- The macOS packaged-runner failure from `fakeHome/.local/bin/claude` rejection
  is documented as platform mismatch evidence from `S-0001-8d39`, not as a
  fixture defect or pass/fail claim.
- Hermetic job-lifecycle E2E has recorded Linux/CI-parity baseline evidence from
  unchanged base `5fff01d0f`: Node 25 container, container-local Postgres proxy,
  1 file / 1 test passed, 0 skipped, 38.03s. Repeat this gate for the branch and
  in CI before PR-ready.
- `npm run lint` is run and its 43-error/1047-warning current-main baseline is
  recorded. If still present, implementation raises a Forge signal and does not
  widen this PR to clean unrelated lint debt.
- Before merge, the checkout-bound local runtime smoke passes for the canonical
  KnackLabs lead-maintenance job. Evidence must prove the running local service
  was built/installed from the active PR worktree, then run
  `scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e` and
  record terminal health `completed`.
- CI is green before merge.
- Targeted local gates pass:
  - `npm run test:integration:postgres -- apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
  - `GANTRY_POSTGRES_HOT_PATH=1 npm run test:integration:postgres:hot-path -- apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
  - `npm run build:runtime`
- Linux/CI-parity Node 25 gate is repeated before PR-ready:
  - `npm run test:e2e:agent:hermetic -- apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
- Final branch gates for this prerequisite PR pass before it is treated as
  unblocking the latency program:
  - `npm run format:check`
  - `npm run typecheck`
  - `npm run lint` or a recorded Forge signal that the confirmed
    43-error/1047-warning current-main lint baseline remains outside this PR's
    scope
  - `npm run test:unit`
  - `npm run test:integration`
  - `npm run test:integration:postgres`
  - `npm run test:e2e:agent:hermetic` in Linux/CI-parity Node 25
  - `npm run check:architecture`
  - `/opt/homebrew/bin/python3 .agents/scripts/verify.py`

## Technical Approach

Use the smallest fixture repairs that match current runtime truth.

1. DeepAgents RunCommand helper
   - Update only the test helper that waits for the host permission request.
   - Replace the fixed 5 second polling deadline with a bounded helper parameter
     or local constant aligned with the surrounding 120 second test timeout.
   - Keep the signed request parse, `coordinatePermissionDecision`, reviewed
     rule decision, and signed response write unchanged.
   - Add or retain a targeted assertion that the host decision is still
     `reviewed_rule` for `RunCommand(echo *)`.

2. MCP hot-path fixture
   - Update
     `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`.
   - Add reviewed semantic capability fixture data for the actual hot-path
     constants: `HOT_SERVER_ID`, `HOT_SERVER_NAME`, and `HOT_TOOL_NAME`.
   - Keep `GANTRY_POSTGRES_HOT_PATH=1` and the dedicated hot-path script as part
     of targeted verification so the row-volume hot-path scenario actually runs.
   - Do not restore legacy exact third-party MCP action grants as authority.
   - Preserve inventory/audit hot-path evidence and source/action separation.

3. Job-lifecycle E2E evidence
   - Restore `apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
     and any job-lifecycle fake-Claude helper edits to the unchanged baseline.
   - Do not change executable trust, sandbox path admission, `HOME` handling, or
     packaged-runner production behavior in this prerequisite.
   - Use the recorded baseline approach for hermetic job-lifecycle E2E evidence:
     unchanged base `5fff01d0f`, Node 25 container, and container-local Postgres
     proxy. The recorded baseline result is 1 file / 1 test passed, 0 skipped,
     38.03s. Repeat the same gate for this branch and in CI before PR-ready.
   - Record the macOS host result as the `S-0001-8d39` platform mismatch:
     packaged runner strips `HOME`, so
     `allowedOuterSandboxClaudeExecutable(fakeHome/.local/bin/claude)` rejects
     the fake executable.

4. Lint baseline
   - Run `npm run lint` before final gate claims.
   - If it still reports the confirmed current-main 43 errors and 1047 warnings,
     record the exact output summary and raise a Forge signal instead of editing
     unrelated files.
   - Do not expand the fixture repair to lint-clean production or unrelated test
     files.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | Fixture repairs only; production runner, sandbox, executable trust, provider, and scheduler contracts remain unchanged. |
| API | Read-only/observable | Job E2E and KnackLabs smoke exercise existing control endpoints without route or contract changes. |
| Data/schema | Read-only/observable | Postgres suites prove current behavior; no schema, migration, or repository edits planned. |
| CLI/ops | Read-only/observable | KnackLabs smoke uses existing `gantry` CLI/service operations; no CLI behavior or launchd ownership change. |
| UI | Not applicable | No user-interface surface is touched. |
| Docs | Changed | This plan and revised signoff decision record are added. |
| Tests | Changed | Exactly the two targeted validation fixtures are repaired; job-lifecycle returns to unchanged baseline. |

Cleanup search terms for the implementer:

- `while (Date.now() - startedAt < 5_000)`
- `RunCommand(echo *)`
- `HOT_SERVER_ID`
- `HOT_SERVER_NAME`
- `HOT_TOOL_NAME`
- `mcp-inventory-audit-explain-itest`
- `job-lifecycle.agent-e2e.test.ts`
- `installHermeticRunnerTools`
- `allowedOuterSandboxClaudeExecutable`
- `fakeHome/.local/bin/claude`

## Decisions

- `docs/decisions/0064-client-signoff.md` records the original accepted
  LAT-GATE-0 signoff for three fixture repairs.
- `docs/decisions/0067-client-signoff.md` records the accepted revised signoff
  for the narrowed two-fixture plan and Linux/CI-parity hermetic E2E gate.

## Task Decomposition

One bounded implementation stage is sufficient.

Stage `LAT-GATE-0-FIXTURES`

- Objective: repair the DeepAgents wait and MCP reviewed-capability fixtures
  without production behavior changes.
- Write scope:
  - `apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
  - `apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
- Restore scope:
  - `apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
  - Any job-lifecycle fake-Claude helper changed in this prerequisite worktree
- Acceptance: all criteria above pass with no production file edits and no
  job-lifecycle fixture changes. If either target fixture cannot model current
  behavior within the test-only scope, raise a Forge signal and stop for a
  revised plan and new client signoff.
- Reviewer focus: fixture faithfulness to production contracts, no timeout
  masking of real hangs, no MCP authorization weakening, no executable-trust
  or sandbox relaxation, no accidental use of real model/runtime state, and
  Ponytail simplest-sufficient scope inside the single autoreview quality lens
  or a non-recorded local checklist.

## Risks

- A longer helper wait could hide a real deadlock if it is applied broadly.
  Mitigation: change only the specific permission-request wait and keep
  test-level timeout bounded.
- The MCP fixture could accidentally re-authorize exact third-party MCP tools.
  Mitigation: add reviewed semantic capability data instead of removing
  negative stale-rule coverage.
- Linux hermetic E2E must stay representative of CI rather than macOS host
  behavior. Mitigation: repeat the recorded Node 25 container plus
  container-local Postgres proxy approach for this branch and CI.
- macOS packaged-runner behavior can be mistaken for a job-lifecycle fixture
  defect. Mitigation: document `S-0001-8d39` as a platform mismatch and do not
  change executable trust in this prerequisite.
- The local KnackLabs smoke can give false confidence if `com.gantry` is still
  running from another checkout. Mitigation: record service/worktree proof
  before triggering `job-knacklabs-lead-maintenance-43527c192a6e`.

## Verify Plan

Before implementation:

- `/opt/homebrew/bin/python3 .agents/scripts/forge.py next`
- `/opt/homebrew/bin/python3 .agents/scripts/forge.py decision list --active`
- Re-resolve every cited symbol with `rg`/file reads.
- Confirm Forge is back to planning and contradiction signal `S-0001-8d39` is
  resolved by accepted `docs/decisions/0067-client-signoff.md` before
  implementation proceeds.

During implementation:

- `npm run test:integration:postgres -- apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts`
- `GANTRY_POSTGRES_HOT_PATH=1 npm run test:integration:postgres:hot-path -- apps/core/test/integration/mcp-inventory-audit-explain.postgres.integration.test.ts`
- `npm run build:runtime`
- `npm run lint` to record whether the confirmed current-main
  43-error/1047-warning lint baseline remains
- Restore or confirm unchanged baseline for
  `apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`

Before PR-ready:

- `npm run format:check`
- `npm run typecheck`
- `npm run lint` or a Forge signal documenting the confirmed current-main lint
  baseline as outside this PR's write scope
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:integration:postgres`
- Linux/CI-parity Node 25, repeating the recorded unchanged-base `5fff01d0f`
  container-local Postgres proxy approach:
  `npm run test:e2e:agent:hermetic -- apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts`
- `npm run check:architecture`
- `/opt/homebrew/bin/python3 .agents/scripts/verify.py`
- One autoreview helper run with quality, performance, and security lenses.
  The quality lens should include Ponytail simplest-sufficient scope review, or
  the implementer may run a non-recorded local Ponytail checklist before the
  single required autoreview.
- Record automated tests and reviews through the Forge recorders.

Before merge:

- CI green.
- Prove the local Gantry service is built/installed from the active PR worktree,
  not another checkout, by recording service/worktree evidence alongside
  `gantry status`.
- Run `scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e`
  from the active checkout.
- Record the canonical job's terminal health as `completed`; if setup/auth
  blocks the live smoke, report the blocker and do not merge.
