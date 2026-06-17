# Live Useful Answer Latency Goal Prompt

> Status: next goal prompt.
>
> Use this after the live startup benchmark goal. It keeps the next slice narrow:
> prove user-facing latency for tool-required turns and SDK app-channel turns.

```text
/goal Prove and harden Gantry's user-facing first useful answer latency for tool-required live turns and SDK app-channel live turns.

This is an implementation goal. Make code, tests, docs, benchmark artifacts, and verification changes as needed. Do not stop at a design summary. Convert this goal into acceptance criteria and a capability-driven task decomposition before editing.

Product model:
- "First visible output" measures the first content-bearing assistant output.
- "First useful answer" measures the first content-bearing output that either answers from available context or includes the required approved tool result.
- "First acknowledgement" measures the first durable user-visible status/progress event when useful output is blocked by model, tool, permission, capacity, or SDK delivery delay.

Primary decision:
- Keep Postgres as launch truth for messages, runtime events, benchmark evidence, and replay.
- Reuse the existing startup diagnostic and live latency benchmark surfaces. Do not add a parallel metrics system.
- Do not add Redis, SQS, Kafka, a generic cache provider, or a broker selector for this goal.
- Do not reduce latency by globally removing selected skills, MCP servers, tools, permissions, sandboxing, streaming, or subagents. Low-latency narrowing must be projection-only and must not mutate durable capability truth.
- Status-only text is not a useful answer. It is measured as acknowledgement latency.

Mandatory process:
1. Reread repo truth before edits:
   - `README.md`
   - `WORKFLOW.md`
   - `docs/FACTORY.md`
   - `docs/QUALITY.md`
   - `docs/product/BRIEF.md`
   - `docs/architecture/live-latency-hardening-goal-prompt.md`
   - `docs/architecture/runtime-components.md`
   - `docs/architecture/live-horizontal-execution.md`
   - `docs/architecture/current-verification-commands.md`
   - `docs/decisions/2026-04-29-runtime-event-exchange.md`
   - `docs/decisions/2026-05-12-event-bus-outbox-boundary.md`
2. Inspect current code before edits:
   - `apps/core/test/harness/live-latency-benchmark.ts`
   - `apps/core/test/integration/live-latency-benchmark.postgres.integration.test.ts`
   - `apps/core/src/application/sessions/session-interaction-module.ts`
   - `apps/core/src/control/server/routes/sessions.ts`
   - `packages/sdk/src/index.ts`
   - `apps/core/src/runtime/group-processing.ts`
   - `apps/core/src/runtime/group-agent-runner.ts`
   - `apps/core/src/runtime/agent-spawn-startup-timing.ts`
   - `apps/core/src/application/mcp/mcp-tool-proxy.ts`
   - `apps/core/src/shared/tool-execution-policy-service.ts`
   - `apps/core/src/runner/mcp/server.ts`
   - `apps/core/src/runner/mcp/tools/*.ts`
   - Anthropic and DeepAgents runner startup-diagnostic emitters.
3. Use planner and decomposer prompts. Decompose by capability/runtime seam, not by file list.
4. Use parallel read-only agents only for independent research scopes when allowed by the current orchestration mode. Suggested scopes:
   - benchmark metric taxonomy and readiness evidence,
   - SDK app-channel send/stream/wait path,
   - tool-required live-turn path and MCP proxy audit,
   - status/readiness/user-visible copy.

Exact UX contract:
- Reuse existing live status copy unless a missing state is proven:
  - `model_slow`: "Still working: waiting on the model."
  - `tool_slow`: "Still working: waiting on <tool/capability>."
  - `listener_degraded`: "Gantry is catching up after a delivery delay. Your message is saved."
  - `queued_capacity`: "Gantry is at live capacity. Your message is saved and will start when a worker is available."
- SDK app-channel consumers receive the same semantic status through runtime events/SSE/wait projections. Adapters may change layout, not meaning.
- Permission-required turns are not failures if the prompt renders durably. Measure acknowledgement-to-prompt latency separately from useful-answer latency.

Acceptance criteria:
1. Benchmark scenarios:
   - Baseline no-tool live turn.
   - Required first-party Gantry MCP tool turn with synthetic 0 ms, 250 ms, and 1000 ms tool latency.
   - Required selected third-party MCP tool unavailable/fail-closed turn.
   - Required permission prompt turn.
   - SDK app-channel `sendMessage` + `stream`/SSE path.
   - SDK app-channel `sendMessage` + `wait` path.
2. Metrics:
   - Report P50/P95/P99 for accepted-to-first-acknowledgement, accepted-to-first-visible-output, accepted-to-first-useful-answer, first-tool-call, first-tool-result, tool-wait, model-wait, SDK first event, SDK wait completion, DB pool wait, lock wait, and failures.
   - For synthetic model/tool runs, report host overhead separately from injected model/tool latency.
   - Launch target: with synthetic model latency <= 1000 ms and synthetic tool latency <= 500 ms, P95 accepted-to-first-useful-answer <= 5s at 300 concurrent conversations.
   - If useful answer cannot meet target because synthetic tool latency is intentionally slow, P95 accepted-to-first-acknowledgement must be <= 2s and `tool_slow` must be emitted once per visible turn.
3. Evidence:
   - Readiness-critical useful-answer metrics must come from runner/runtime-origin evidence, not fixture-seeded placeholders.
   - Benchmark artifact path: `.factory/benchmarks/live-useful-answer/<benchmarkRunId>.json`.
   - Artifact includes scenario name, injected latencies, evidence source per metric, failures, and readiness verdict.
4. Correctness and authority:
   - Tool-required useful answer cannot be counted until the selected tool result is observed or a fail-closed denial is surfaced.
   - Raw third-party MCP, raw provider tools, raw DeepAgents tools, and raw SDK built-ins remain unavailable unless already selected through Gantry authority.
   - Permission/HITL prompts create durable `pending_interactions` before rendering.
   - SDK stream/wait paths replay from durable runtime events and do not create a second event truth.
5. No shortcuts:
   - No max-message or character cap that silently drops user input.
   - No global low-latency mode that mutates durable selected capabilities.
   - No new provider/broker/cache settings.

Capability-driven task decomposition:
1. Benchmark taxonomy and artifact contract:
   - Extend the live latency benchmark with first useful answer, first acknowledgement, SDK event, and tool timing metrics.
   - Tests: unit coverage for metric classification and readiness-source rejection.
2. Tool-required live-turn scenarios:
   - Add synthetic first-party tool scenario and selected third-party unavailable scenario without bypassing Gantry MCP/tool policy.
   - Tests: useful answer waits for tool result; unavailable MCP reports fail-closed status/audit.
3. Permission/HITL timing scenario:
   - Measure durable prompt render latency and exclude unresolved permission waits from useful-answer target.
   - Tests: pending interaction exists before prompt event; replayed callback does not double-count.
4. SDK app-channel timing:
   - Measure `sendMessage` to first SDK stream/SSE event and wait completion using runtime events as truth.
   - Tests: stream/wait replay from cursor; dropped notification recovers by durable event replay.
5. Status/readiness projection:
   - Surface useful-answer benchmark results and current live status through existing status/readiness/diagnostic surfaces only where needed.
   - Tests: snapshot/status coverage for useful-answer fields and degraded/tool-slow states.
6. Docs and cleanup:
   - Update docs/prompts only where active behavior changes.
   - Run cleanup searches for broker/cache shortcuts, raw tool exposure, synthetic readiness placeholders, and stale benchmark claims.

Surface Impact Matrix:
- Runtime behavior: Changed. Benchmark and status semantics distinguish acknowledgement, first visible output, and useful answer.
- `settings.yaml`: Unchanged by design. No new broker/cache/low-latency setting.
- Postgres/runtime projection: Read-only/observable unless a metric field requires a persisted runtime event payload extension.
- Control API: Changed if SDK/status DTOs expose new timing fields; otherwise read-only/observable.
- SDK/contracts: Changed only for status/diagnostic fields if needed; no behavior-breaking API shape.
- CLI: Read-only/observable if `gantry status` reports benchmark/live useful-answer fields.
- Gantry MCP tools/admin skill: Read-only/observable unless diagnostics add fields.
- Channel/provider adapters: Unchanged by design except existing status descriptor rendering.
- Docs/prompts: Changed. Add this goal and any behavior docs touched by implementation.
- Audit/events: Changed. Tool-required and SDK timing evidence must be redacted and durable.
- Tests/verification: Changed. Add unit/integration/benchmark coverage.

Required verification:
- Focused tests for changed benchmark/tool/SDK/status modules.
- `npm run test:unit -- apps/core/test/unit/harness/live-latency-benchmark.test.ts`
- `npm run test:unit -- apps/core/test/unit/application/mcp-tool-proxy.test.ts apps/core/test/unit/shared/tool-execution-policy-service.test.ts`
- `npm run test:integration -- apps/core/test/integration/live-latency-benchmark.postgres.integration.test.ts`
- Postgres-backed benchmark/integration with disposable Postgres when repository/runtime-event persistence changes.
- `npm run build`
- `npm test`
- `python3 .codex/scripts/verify.py`
- Run `autoreview` after implementation, tests, cleanup searches, and verification.
- Run `ponytail` after `autoreview` and fix any accepted simplification findings.

Required cleanup searches:
- `rg -n "Redis|redis|SQS|sqs|Kafka|kafka|broker selector|queue provider|cache provider" apps/core/src apps/core/test docs`
- `rg -n "fixture-seeded|synthetic placeholder|readiness-critical|first useful|first-useful|firstUseful" apps/core/src apps/core/test docs`
- `rg -n "raw MCP|raw provider tool|raw DeepAgents|bypass Gantry|direct tool" apps/core/src apps/core/test docs`
- `rg -n "max messages|max chars|MAX_MESSAGES_PER_PROMPT|truncate.*prompt|slice\\(0" apps/core/src apps/core/test docs`

Final handoff must include:
- Scenario table with P50/P95/P99 and readiness verdict.
- Host-overhead versus injected model/tool latency.
- SDK stream/wait evidence.
- Tool-required useful-answer evidence.
- Permission prompt timing evidence.
- Status/readiness fields changed, if any.
- Cleanup search results and interpretation.
- Verification commands and results.
- `autoreview` result.
- `ponytail` result.

Definition of done:
- Gantry can prove P95 accepted-to-first-useful-answer <= 5s at 300 concurrent synthetic tool-required conversations under the stated synthetic latency budget.
- SDK app-channel stream/wait paths have equivalent first-event/useful-answer evidence.
- Slow or permission-blocked turns acknowledge within 2s with the existing status copy.
- No Redis/SQS/Kafka/cache-provider shortcut, raw tool bypass, or silent input truncation is introduced.
```
