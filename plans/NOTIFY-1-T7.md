# Deterministic structured job result from recorded run actions

## What changes for you

In scope: rename `JOB_TOOL_ACTIVITY`->`TOOL_ACTIVITY`, record a terminal outcome for EVERY tool call on both worker runtimes and both inline lanes for EVERY turn (live + job), a correlation-ID backbone, retention/pruning, and a neutral projection that turns a job's recorded actions into a structured result for any tool. Non-goals: itemizing a subagent's INNER tools into the parent job result (explicit "top-level tool calls only" contract); outstanding-call reconciliation on hard process death (accepted; the job terminal status conveys it).

## Why

A scheduled job that uses non-capability tools (WebSearch, WebRead, RunCommand, file tools, MCP, delegation) produces an EMPTY structured result and falls back to raw narration: (a) the projection ignores generic tool phases, (b) neither worker runtime records a terminal per-tool success/failure event, and (c) the whole tool-activity signal is gated to scheduled jobs (`isScheduledJob`) even though it is a universal runtime signal useful for live-turn diagnostics, audit, and the observer.

## Done when

1. Every tool call on both runtimes and both inline lanes emits a terminal `TOOL_ACTIVITY` success/failure event with a stable per-invocation correlation id; live turns (jobId null) emit too.
2. The projection builds result.items neutrally from any tool (humanize label, outcome from ok), grouped by RAW semantic key with counts, failed-first, with a "+N more" overflow line, deterministic without DB ordering; no per-tool or per-provider code.
3. Capability/browser/denial dedup is correlation-id based, not name based: a generic event is suppressed only when an authoritative host event with the same id exists, else kept as fallback; a rich denial wins over its correlated generic failure.
4. `runtime_events` TOOL_ACTIVITY growth is bounded by retention; jobs keep full fidelity to completion.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| NOTIFY-1-T7 | Move required tool-activity tests to top-level it for JUnit attribution | Three required tests are nested in describe blocks, so vitest JUnit names them 'describe > it' and the forge stage gate (which needs testcase name == id and runs with -t id) cannot attribute them (nested test is skipped). Move each required test to a TOP-LEVEL it() named exactly toolact-projection / toolact-anthropic / toolact-deepagents, out of its describe, keeping it passing. Change ONLY test structure; no product code. |  | `apps/core/src/jobs`, `apps/core/src/domain`, `apps/core/src/adapters/llm`, `apps/core/src/shared`, `apps/core/src/adapters/storage/postgres`, `apps/core/test/unit/jobs`, `apps/core/test/unit/adapters`, `apps/core/test/unit/runner`, `apps/core/test/unit/shared`, `apps/core/test/integration`, `scripts`, `apps/core/src/application/jobs`, `apps/core/src/runtime`, `apps/core/src/runner`, `apps/core/test/unit/application`, `apps/core/test/unit/runtime`, `apps/core/test/e2e`, `apps/core/test/unit/adapters/storage/postgres`, `apps/core/test/unit/application/runtime-events`, `apps/core/test/unit/control`, `apps/core/src/control`, `packages/sdk`, `docs/decisions` | `apps/core/test/unit/jobs/status-formatting.test.ts`, `apps/core/test/unit/runner/query-loop.test.ts`, `apps/core/test/unit/adapters/deepagents-stream-normalizer.test.ts` | none | no |

New moving parts: none named in the old plan

## Risks

- Dedup collapse vs double-count — closed by invocationId in the runner event key + per-frame streaming filter.
- Host/generic double or lost record — closed by id-correlated suppression with fallback.
- Colliding humanized labels merging distinct tools — closed by raw-key grouping.
- Live-turn volume — closed by retention/pruning.
- LangGraph event-shape drift — defensive ok derivation.

## Notes

Converted from plans/active/NOTIFY-1-T7-deterministic-structured-job-result-from-recorded-run-actions.md by forge migrate.

### Technical Approach

Correlation-ID backbone: one `invocationId` (+ monotonic `seq`) allocated at tool START, carried to the terminal outcome, stamped on generic, capability_run, browser_action, and denial events. Anthropic id = `hookInput.tool_use_id || toolUseID`; inline id allocated in `start()` retained to `finish()`; deepagents id = LangGraph v2 `run_id`. Recording: anthropic worker emits from the matcher-less PostToolUse/PostToolUseFailure hooks using the FULL structural error classifier (`toolResponseIsError`); deepagents worker emits from `on_tool_end`/`on_tool_error` with `runtimeEventOnly:true` and generic structural ok-detection; inline `run()` records failure on error-shaped results, and the deepagents inline normalizer gets the same outcome callback so middleware/skill tools are covered. Streaming dedup: filter EACH streamed frame against the forwarded-key set (keyed incl. invocationId), not just the final pass. Projection: classify -> group by raw key -> order (failed first, then seq, tie-break raw key) -> bound with overflow + preserved count suffix; fix `humanizeTechnicalIdentifier` to split camelCase and retain the MCP tool suffix. Full detail in the task plan.

### Decisions

- Rename `JOB_TOOL_ACTIVITY`->`TOOL_ACTIVITY` and `JOB_TOOL_DENIED`->`TOOL_DENIED`, no backcompat alias (early-stage, decision 0003).
- Drop the `isScheduledJob` gates; tool-activity is a universal runtime signal, job notification is one consumer.
- Delegation: top-level tool calls only; subagent inner tools not itemized (explicit, tested).
- Hard-abort outstanding calls: accepted, not reconciled.

### Surface Impact

domain/events/runtime-event-types.ts (rename + refs); jobs/{status-formatting,execution,execution-diagnostics,browser-activity-events,ipc-capability-run-handler}.ts; adapters/llm/anthropic-claude-agent/runner/{query-loop,tool-permission-events,query-tool-success-ledger}.ts + inline-lane/index.ts; adapters/llm/deepagents-langchain/runner/{stream-normalizer,index,deep-agent-runner}.ts + inline-lane/index.ts; adapters/llm/inline-lane-tool-activity.ts; shared/user-visible-messages.ts; storage/postgres (retention); scripts/architecture-map.json (query-loop budget).

### Task Decomposition

Single bounded task TOOLACT-1 landing together (the pieces are interdependent through the invocationId backbone): rename + un-gate, per-seam recording + correlation id, host-event id stamping, streaming dedup, neutral projection, retention, tests. If Codex must split, order: rename/un-gate -> recording+id per seam -> projection -> retention.

### Verify Plan

`python3 factory/scripts/verify.py` green (typecheck + unit + integration + architecture). Projection + per-seam recording + streaming-dedup + retention tests per the task plan pass, across both runtimes.
