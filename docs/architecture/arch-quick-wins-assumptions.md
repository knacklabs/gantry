# Architecture Quick Wins Assumptions

This ledger records the bounded decisions for findings 8 and 1 from the
2026-07-16 Fable architecture review. The review document is not present at
this branch's `HEAD`; its accepted findings were read from repository history
and checked against the current implementation before changes were made.

## 1. Deferred durable-work primitive

Retention was removed from this quick win and deferred to the durable-work-primitive cycle (Fable finding 1) because it entangles with scheduler run-recording (which must prune `agent_runs` job-backed history, not `job_runs`), agent materialization (which needs an agentless/hidden system principal that never creates `agent:system` through `insertRun`/`ensureJobRunGraph` or workspace preparation), and lease fencing (cluster re-registration must not erase live leases, and deadline must not be conflated with cancellation).

## 2. Error counters

- `gantry_errors_total{subsystem,kind}` is a process-local monotonic Prometheus
  counter. Restart reset is expected for process metrics.
- Labels are a closed, low-cardinality vocabulary selected at load-bearing
  top-level failure boundaries. Exception text, identifiers, and provider
  payloads never become labels.
- The counter records failures that are caught, converted, retried, or
  downgraded at the selected runtime, job, delivery, and channel seams. It does
  not attempt to instrument every `catch`.

## 3. Per-turn log context

- Async-local context is used because Gantry's shared logger is imported by
  deep helpers; threading child logger parameters through those stacks would
  be a broader refactor.
- Context is scoped with `run`, not ambient mutation, so concurrent turns do
  not leak `runId`, `appId`, `agentId`, or `traceId` into one another.
- An ordinary interactive turn's persisted run ID is log/trace correlation
  only. Worker and inline model credential bindings use that tracked ID for
  gateway trace/audit parenting without copying it into `AgentInput`.
  `GANTRY_JOB_RUN_ID` is projected only with a complete scheduled lease token
  and fencing version, so unfenced permission and question IPC remains outside
  scheduled-lease validation.
- `traceId` is copied only from a real OpenTelemetry turn span. It is absent
  when tracing is disabled rather than being synthesized from a run ID.
- Per-call fields retain the logger's existing override order. Structured log
  data is merged first and redacted once.

## 4. Durable `send_message`

- Current repository reality differs from the review anchor: runner IPC
  already delegates through channel wiring with `durability: 'required'`, and
  that path creates an outbound delivery before provider dispatch.
- The reliability gap is startup order. When outbound storage is available,
  IPC processing starts only after the existing durable outbound attempt
  factory and recovery loop are installed. A repository-absent runtime still
  starts IPC, but required sends fail closed before provider dispatch.
- No second queue or enqueue-only IPC path is introduced. The existing path
  retains route authorization, message projection, partial-delivery handling,
  attachment behavior, and immediate delivery while making provider failures
  retry-eligible.

## 5. Deferred IPC overload backpressure

IPC overload backpressure was split out alongside retention and deferred to the
durable-work-primitive cycle (Fable finding 1). It needs bounded scanning with a
persistent cursor across polls: ignored `.processing-*`, temp, and non-JSON
entries must not consume the scan budget or starve later valid requests. The
design must never archive valid work, must reject genuine floods at ingress,
and must define lane-aware task-deadline semantics. This requires a proper
durable queue design, not a poll patch.

## Surface Impact Matrix

| Surface                      | Classification      | Decision                                                                                                                         |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed             | Adds failure counters, per-turn child log context without widening lease-gated IPC, and durable-send startup ordering.           |
| `settings.yaml`              | Unchanged by design | The three retained quick wins add no configuration keys.                                                                         |
| Postgres/runtime projection  | Unchanged by design | Durable send reuses the existing outbound-delivery rows and repository; no schema or settings projection changes.                |
| Control API                  | Unchanged by design | No control endpoint, request, or response changes.                                                                               |
| SDK/contracts                | Unchanged by design | No public request, response, or tool schema changes.                                                                             |
| CLI                          | Unchanged by design | No commands or settings validation/rendering changes.                                                                            |
| Gantry MCP tools/admin skill | Unchanged by design | No new agent or admin authority is introduced.                                                                                   |
| Channel/provider adapters    | Changed             | Selected Slack and Teams failure seams increment the closed-label error counter.                                                 |
| Docs/prompts                 | Changed             | This ledger records the narrowed quick-win scope and its durable-work follow-up.                                                 |
| Audit/events                 | Unchanged by design | Existing audit and outbound-delivery event contracts are reused unchanged.                                                       |
| Tests/verification           | Changed             | Focused tests pin counters, `{runId, appId, agentId, traceId}` log context, durable send, and unfenced interactive IPC identity. |
