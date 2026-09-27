# Job runner: split runActiveJob and runQuery by phase

## What changes for you

In scope: the two functions, one sibling module each, architecture-map entries, no test edits (additions only). Strictly verbatim moves (owner ruling): call sites move; no dedup, no hoists, no signature changes to anything outside the two files. Non-goals: behaviour, the heartbeat/nudge/stream semantics themselves, other runner or jobs files, dedup follow-ups.

## Why

The PR #444 cyclomatic review named three giants; CHAN-2 (#451) retired the Telegram callback. Two remain: `runActiveJob` in `apps/core/src/jobs/execution.ts:116` (AST CC 76, ~400 lines of an 848-line file) and `runQuery` in `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:102` (CC 81, ~600 lines of a 770-line file). Every incident fix of the last two weeks (lease/heartbeat, notifications, finish nudge, stream open/close, permission waits) landed inside one of them, each harder to review than it should be because the whole phase sequence lives in one body.

## Done when

1. AC1: `runActiveJob` in jobs/execution.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, sequenced from a body whose own complexity is <= 15; no behaviour change.
2. AC2: `runQuery` in runner/query-loop.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, driven from a loop body whose own complexity is <= 15; no behaviour change.
3. AC3: No behaviour change: existing unit and Postgres integration tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
4. AC4: Branch based on main after PR #451 (CHAN-2).

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Split runActiveJob by phase into jobs/execution-phases.ts | Verbatim move: runActiveJob in apps/core/src/jobs/execution.ts (733 lines) becomes a phase sequencer (CC <= 15) over one ActiveJobRunContext built once; each phase is a named function (CC <= 25) in TWO sibling modules by phase group — jobs/execution-phases-setup.ts (context, failover, session/setup pause, lease + heartbeat) and jobs/execution-phases-run.ts (bind/event, system turn, agent-with-failover, finalization). try/finally stays in the sequencer. Zero test edits. | 1, 3, 4 | `apps/core/src/jobs/execution.ts`, `apps/core/src/jobs/execution-phases-setup.ts`, `apps/core/src/jobs/execution-phases-run.ts`, `scripts/architecture-map.json`, `apps/core/test/unit/jobs/`, `docs/specs/job-runner-splits.md` | `apps/core/test/unit/jobs/execution.test.ts` | none | no |
| T2 | Split runQuery by phase into runner/query-loop-phases.ts | Verbatim move: runQuery in runner/query-loop.ts becomes a for-await dispatcher (CC <= 15) over one QueryLoopContext built once; SDK options/sandbox setup, per-message handlers (system, assistant, stream_event, result incl. nudge + stream.end) and close/end are named functions (CC <= 25) in ONE sibling module runner/query-loop-phases.ts. Only the two source-text tests re-point their file path; no other test edits. | 2 | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases.ts`, `scripts/architecture-map.json`, `apps/core/test/unit/runner/`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.ts` | `apps/core/test/unit/runner/query-loop.test.ts` | T1 | no |

New moving parts: none named in the old plan

## Risks

- Moved phases that read variables computed earlier must receive them through the context; a miss surfaces as a tsc error or a failing existing test (both gating).
- `try/finally` ordering around lease release/heartbeat stop must stay in the sequencer, not inside a phase.
- The `result` branch carries incident fixes (nudge, stream.end) — verbatim move; the runner suites (`apps/core/test/unit/runner/*`) are the oracle.

## Notes

Converted from plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md by forge migrate.

### Technical Approach

Same recipe as CHAN-2 T2. Complexity measured with the AST counter used there (branches + logical operators, baseline 1).

- `runActiveJob` (jobs/execution.ts:116–~520) → `apps/core/src/jobs/execution-phases.ts`. Build one `ActiveJobRunContext` (deps, job, runId, execution context, failover candidates, app session, lease context, event state, logger fields) once; phases as named functions taking the context: resolve execution context / dead-letter, model failover candidates, app session + setup pause, lease claim + heartbeat wiring, run bind + JOB_STARTED event, system job turn, agent invocation with failover + provider metadata updates, result/finalization handoff, cleanup (the existing `try/finally` shape stays in the sequencer so lease release ordering is untouched). Existing helpers (`resolveExecutionContextOrDeadLetter`, `claimSchedulerRunLease`, `runJobAgentWithFailover`, `execution-finalization.ts`, …) are called, not re-implemented.
- `runQuery` (runner/query-loop.ts:102–~700) → `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases.ts`. Build one `QueryLoopContext` (stream, agentInput, flags like enableIpcFollowups/isScheduledJob, nudge state, accumulators, steering gate, logger) once; phases: SDK options/sandbox setup (the two-axis model block and env wiring, verbatim), per-message handlers for `system` (init / api_retry / other), `assistant`, `stream_event` (text deltas), `result` (incl. the Q-0105/Q-0108 nudge and stream.end decisions verbatim), and close/end. The `for await` loop stays in `runQuery` as the dispatcher (type → handler).
- Architecture map: entries for both new modules (`scripts/architecture-map.json`) if `check:architecture` requires them; each new module <= 700 lines or split by the same rule.

### Decisions

No new decision record: internal structure only; 0040 (two-axis model) comments move with their code. Active decisions reviewed; none constrains this. Roadmap kind = feature so the refactor ratchet (net-growth veto) does not apply to a split.

### Surface Impact

None user-visible. Module layout: two new sibling files; the two giants shrink to sequencers.

### Task Decomposition

- CHAN-3-T1: `runActiveJob` split (jobs/execution.ts + jobs/execution-phases.ts + architecture map). Contract: AC1, AC3, AC4.
- CHAN-3-T2: `runQuery` split (runner/query-loop.ts + runner/query-loop-phases.ts + architecture map). Contract: AC2, AC3.

### Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/ apps/core/test/unit/runner/` unchanged and green (git diff --stat -- apps/core/test empty); full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; Postgres lane `GANTRY_TEST_DATABASE_URL=… npm run test:integration:postgres`; CC report (scratchpad/cc.mjs) over the four files: sequencers <= 15, every phase <= 25; `python3 factory/scripts/verify.py`.

### Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-28: AC1/AC2 'ONE sibling module' is read as one module per phase group whenever a single module would exceed the 700-line architecture budget after prettier (owner ruling 2026-08-28; T1 = execution-phases-setup/-run, T2 = query-loop-phases-setup/-messages).
