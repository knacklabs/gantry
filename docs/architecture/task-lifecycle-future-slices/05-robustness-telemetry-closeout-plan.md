# Robustness, Telemetry, and Closeout Plan

Status: future product-slice plan for LOCAL-36. This is not implementation
evidence.

## 1. Problem

Delegation needs production controls beyond task launch: structured outputs,
retry/timeout budgets, loop limits, cancellation propagation, cost telemetry,
OpenTelemetry, protocol adapter boundaries, benchmark evidence, cleanup
searches, and closeout review.

## 2. Scope / Non-goals

In scope:

- Structured output validation for Anthropic and DeepAgents result payloads.
- Retry, timeout, model-call, tool-call, loop, and worker-pool budgets.
- Cancellation propagation and terminal evidence.
- Startup, first-visible, cost, token, prompt-cache, and delegation metrics.
- Progress-event coalescing, bounded replay cursors, and redacted lifecycle
  status fields for high-frequency delegated work.
- Frontend/headless/protocol adapters as Gantry adapters.
- Cleanup searches and final launch gates.

Non-goals:

- No metrics as authority.
- No ACP/A2A/remote Agent Protocol as a second control plane.
- No raw provider plugin, custom-tool, interpreter, profile, or managed-agent
  surface without reviewed projection.

## 3. Acceptance Criteria

- Invalid structured outputs downgrade or fail with redacted evidence.
- Retry/timeout/budget exhaustion writes terminal evidence.
- Cancellation reaches provider tasks where supported and always fences Gantry
  writes after terminal state.
- Metrics and audit remain separate from policy decisions.
- High-frequency progress does not create unbounded runtime-event write
  amplification; dropped or coalesced notifications recover from durable state.
- Lifecycle status text, errors, and provider correlation evidence are redacted
  and bounded before external delivery or telemetry export.
- Protocol adapters authenticate to Gantry app/agent/conversation/thread/run
  identity or fail closed.
- Every deferred raw provider surface has a fail-closed test or explicit
  activation condition.
- 300-concurrent benchmark evidence is current or recorded as a launch blocker.

## 4. Technical Approach

Extend existing startup diagnostics and runtime-event evidence instead of
creating parallel metric authority. Protocol adapters read and write through
Gantry runtime surfaces; provider-native protocols remain adapter details.

### Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Budgets, cancellation, terminal evidence, and metrics improve robustness. |
| `settings.yaml` | Deferred | Tunable budgets or telemetry exporters need settings approval. |
| Postgres/runtime projection | Changed | Terminal evidence, metrics, and benchmark read models may change. |
| Control API | Changed | Status, metrics, and protocol adapter projections may be exposed. |
| SDK/contracts | Changed | Structured-output/result contracts and telemetry fields change. |
| CLI | Deferred | Optional diagnostics need a separate CLI decision. |
| Gantry MCP tools/admin skill | Deferred | Reviewed diagnostics/admin tools need capability approval. |
| Channel/provider adapters | Changed | Providers and protocol adapters carry cancellation and structured results. |
| Docs/prompts | Changed | Robustness, telemetry, and closeout evidence must be documented. |
| Audit/events | Changed | Retry, timeout, cancellation, cost, and terminal evidence are auditable. |
| Tests/verification | Changed | Robustness, protocol, benchmark, cleanup, and review checks are required. |

## 5. Task Decomposition

1. Add structured-output validators and redacted invalid-output evidence.
2. Add retry, timeout, loop, tool-call, model-call, and worker-pool budget
   behavior for delegated lifecycle work.
3. Add cancellation propagation and terminal write fencing tests.
4. Add progress-event coalescing and bounded replay cursors for delegated work.
5. Extend startup and delegation diagnostics with cost/token/cache/timing
   fields.
6. Add redaction and bounded-field checks for lifecycle status, errors, and
   provider correlation evidence before telemetry or channel delivery.
7. Classify protocol adapters and managed/provider extension surfaces.
8. Run cleanup searches, benchmark checks, architecture checks, build, tests,
   artifact validation, and autoreview before closeout.

## 6. Risks

- Retry loops can hide terminal failures and keep workers occupied.
- Per-progress runtime-event persistence can become write amplification under
  high-frequency subagent progress unless coalesced behind durable state.
- Cost/telemetry data can leak prompt or tool details without redaction.
- Lifecycle status text and provider correlation ids can leak adapter-private
  details unless bounded and redacted before leaving runtime evidence.
- Protocol adapters can become a second control plane if they bypass Gantry
  runtime identity and permissions.

## 7. Verify Plan

- Structured-output validation tests.
- Retry/timeout/cancellation terminal evidence tests.
- Telemetry redaction tests.
- Progress coalescing/replay tests under high-frequency delegated updates.
- Lifecycle status/error/provider-correlation bounding and redaction tests.
- Protocol adapter fail-closed tests.
- 300-concurrent benchmark artifact or explicit launch blocker.
- `npm run build`
- `npm test`
- `python3 .codex/scripts/verify.py`
- `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
- `python3 .codex/scripts/check_task_completion.py`
