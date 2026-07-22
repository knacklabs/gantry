# OTel permission-decision spans — goal prompt

Status: GRILL + DOUBLE-CRITIQUE LOCKED 2026-07-22 (Fable + Codex, two rounds).
The critiques collapsed the original design ~5×: **do NOT** instrument
`ToolExecutionPolicyService.evaluate` (called 2–3×/decision, not terminal), **do
NOT** build a Stage-0 correlation "foundation" (mostly already exists), **do
NOT** build a non-durable telemetry frame (unnecessary for v1). Behind
`observability.tracing.enabled` (default off). Builds on #220 (turn/chat spans) +
#262 (execute_tool spans — do not touch).

## v1 = one host-side tap on the EXISTING permission event stream
The runtime already publishes host-side permission events with `runId`/`requestId`
correlation across every engine: `permission.requested / allowed / denied /
cancelled / persisted / resumed / final_outcome / classifier_decision /
yolo_denylist_hit` (`domain/events/runtime-event-types.ts:31-39`), attended via
`ipc-interaction-processing.ts`, classifier via `permission-classifier.ts:566`,
inline via `ipc-permission-telemetry.ts`.

**The whole slice:** a host-side subscriber on `RuntimeEventExchange.subscribe`
(`application/runtime-events/runtime-event-exchange.ts:109`) filtered to
`permission.*`, converting each decision into a `permission` span. **Zero runner
changes, zero IPC changes, zero new frames, engine-neutral.**

## Locked decisions
1. **Span from the event pair, not a span-over-await.** Emit a point-in-time
   `permission {tool}` span from `requested` → terminal (`final_outcome`/`allowed`/
   `denied`/`cancelled`/`resumed`), paired by `requestId`: start = requested ts,
   end = terminal ts → real duration INCLUDING human wait. This is lifecycle-
   correct for abandoned/cross-restart asks (`resumed`) where a held span leaks or
   mis-times (both critiques). `classifier_decision` = attribute or a child
   `permission.policy` span; `yolo_denylist_hit` = tagged.
2. **Parent = `getTurnSpan(runId)` when the event carries runId; else root + tags.**
   Job runs carry runId immediately. The child-span helper FAILS CLOSED — a
   root span tagged `requestId`/`conversationId`, NEVER a wrong-turn parent
   (continuation-rotation race, Codex #4). Live-turn parenting is a fast-follow
   (see below), not a v1 blocker.
3. **STRICT structural attribute allowlist — this is the security core.** Span
   attributes are ONLY: `decision_path` (derived from event type),
   `gen_ai.tool.name`, `requestId`, `runId`, `jobId`, `mode`, `decidedBy`-kind,
   `duration`. **NEVER** `reason`, `matchedRule`, `closestRule`, command preview,
   `targetResource`, or paths — those embed the command even when they look like
   codes (`normalizeBashLeafRuleContent` IS the command; classifier `reason` is
   model free-text). Use a narrow typed `startPermissionSpan(...)`, NOT a generic
   `startChildSpan(...attrs)` that lets callers mark arbitrary content structural.
   `capture_content` does NOT relax this in v1 — free-text permission content
   would need a separate explicit opt-in, never the default-true setting.

## Explicitly deferred (NOT v1)
- **Subprocess silent fast-path allows** (SDK `allowedTools`/`alwaysAllowedTools`,
  subprocess deterministic allows) — they publish NO host event, are sub-ms, and
  are the ONLY thing that would need a new `observabilityEvents` non-durable frame
  (Codex #2). Defer; note the coverage gap in the span docs.
- **Live-turn ask parenting under the turn** — ordinary live-turn permission IPC
  doesn't carry runId. The minimal fix (Codex "Stage 0 surface") is ONE projected
  `correlationRunId` key through worker permission IPC (`agent-spawn.ts:526`,
  `permission-ipc-client.ts:30`, `ipc-parsing.ts:307`, `domain/types.ts:124`) +
  inline reading `correlationRunId` not `input.runId` (`inline-agent-loop-tools.ts:118`).
  NOT the MCP-envelope expansion (over-built). Fast-follow after v1 tap ships.
- Memory spans, tool durations, full causal nesting — separate later slices.

## Pre-existing finding to FLAG (out of scope — do not fix here)
The classifier `reason` (model free-text that can echo the command) is ALREADY
written durably to `PERMISSION_CLASSIFIER_DECISION` regardless of tracing
(`permission-classifier.ts:563`); `capture_content=false` is only an OTel gate,
not a permission-audit persistence gate. Record this against
[[permission-engine-redesign]]; the v1 tap does NOT propagate it into spans (per
decision 3), so the tap adds no new leak.

## Plan-validation gate (goal-pipeline Codex twin, before build)
1. Confirm the `requested`→terminal `requestId` pairing is reliable for every
   terminal event type, and that the subscriber sees both (ordering, restart).
2. Confirm which events carry `runId` (parent vs root+tag).
3. Confirm `RuntimeEventFilter` can scope to `permission.*` without a firehose.
4. Confirm no decision double-emits a span.

## Verify (real)
1. `apps/core && npx tsc --noEmit` clean.
2. Unit (InMemorySpanExporter + a fake event stream): one span per decision with
   correct `decision_path`; duration = requested→terminal; parent = turn when
   runId present, root+tagged otherwise; abandoned ask (`resumed` after turn end)
   produces a correct span, no leak.
3. **Security test:** assert NO `reason`/`matchedRule`/`closestRule`/command text
   ever appears on a span attribute, with `capture_content` true AND false.
4. **Runtime-neutral test:** permission spans produced for SDK-worker, inline, and
   DeepAgents decisions (drive the event stream for each).
5. **No live-turn impact:** the tap is a passive subscriber — assert it cannot
   complete/dequeue a turn and never throws into the publish path (fail-open).
6. Existing suites green (disabled = no-op). `autoreview --mode local` (xhigh)
   clean before EACH commit.

## Non-goals
- Instrumenting `evaluate` / any per-gate seam (tap the outcome events instead).
- New runner/IPC frames (v1 rides existing host events).
- Emitting NEW permission events (read-only tap; the events already exist).

## Staging (each leaves tree green; autoreview before each commit)
1. `permission`-event → span tap subscriber + `startPermissionSpan` typed API +
   strict allowlist → unit + security + runtime-neutral tests.
2. (fast-follow, optional) worker-permission-IPC `correlationRunId` projection for
   live-turn parenting → unit.
3. Langfuse/LangSmith smoke: one attended ask + one auto-allow + one deny appear
   as `permission` spans (attended one shows real human-wait duration).
