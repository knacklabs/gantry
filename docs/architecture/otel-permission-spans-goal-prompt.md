# OTel permission-decision spans — goal prompt

Status: GRILL + DOUBLE-CRITIQUE + PLAN-VALIDATION LOCKED 2026-07-22. Design = a
host-side tap on the existing `permission.*` runtime-event stream → OTel
`permission` spans. The plan-validation NARROWED the scope (coverage is not
universal; exactly-one-span + cross-restart duration need care) — this doc is the
honest v1 it converged to. Behind `observability.tracing.enabled` (default off).
Builds on #220 (turn/chat) + #262 (execute_tool). Do NOT touch #262 or the sandbox.

## v1 = one host-side subscriber on the permission-event stream (narrowed, honest)
A lifecycle-managed pull loop on `RuntimeEventExchange.subscribe(filter)`
(`application/runtime-events/runtime-event-exchange.ts:109/173` — it is a PULL
subscription: own the `next()`/`close()` loop) converts permission decisions into
`permission` spans. Zero runner/IPC changes, read-only.

**Filter (exact — no `permission.*` wildcard; `appId` is mandatory & equality-filtered):**
scope v1 to the `default` app; `eventTypes` = the 9 permission types
(REQUESTED, ALLOWED, DENIED, CANCELLED, PERSISTED, RESUMED, FINAL_OUTCOME,
CLASSIFIER_DECISION, YOLO_DENYLIST_HIT). Per-app subscriptions are a follow-up.

## Locked decisions (plan-validation-hardened)
1. **ONE canonical terminal = `final_outcome` (request-correlated).** One approval
   emits `allowed`→`resumed`→`final_outcome`; emit the span ONLY on the correlated
   `final_outcome` (pairing `requested`→`final_outcome` by `requestId`). `allowed`/
   `denied`/`cancelled`/`persisted`/`resumed` ENRICH the pending pair, never emit
   their own span. Exactly one span per correlated decision (`ipc-interaction-processing.ts:172/197/302/307`).
2. **`classifier_decision` with no preceding `requested`** (inline classifier
   auto-allow, `inline-agent-loop-tools.ts:392/422`) → a standalone POINT span.
3. **Parent = `getTurnSpan(runId)` when the event carries runId, else root+tags.**
   Fail closed — never guess another turn's parent (`tracing.ts:196/410/440`).
4. **STRICT structural attribute allowlist** = `decision_path`, tool name,
   `requestId`, `runId`, `jobId`, **`conversationId`** (id, not content — resolves
   the decision-2/3 contradiction), `mode`, `decidedBy`-kind, `duration`. EXCLUDE
   all command-bearing fields: `commandPreview`, `reason`, `matchedRule`,
   `closestRule`, **`matchedPattern`** (the yolo field name, `permission-classifier.ts:348`),
   paths, args. The classifier `reason` is model free-text already durably
   persisted regardless of tracing — pre-existing, out of scope, and NOT copied here.
5. **Restart: defer exact cross-restart duration.** The pending-pair map is
   process-local; start the subscription at TAIL (no historical replay → no
   re-exported old spans). A decision spanning a restart → a root POINT span, no
   duration. Do NOT build durable checkpointing in v1.
6. **The tap loop catches its own errors** (per-event AND loop-level) — a rejected
   background promise must never crash the host; publish already durably-appends
   before best-effort notify, so the tap can never affect the publish path.

## EXPLICITLY EXCLUDED from v1 coverage (name the gaps — no silent "all engines")
- DeepAgents yolo prechecks deny with NO event (`gantry-shell-tool.ts:173`) — invisible.
- Anthropic-runner yolo events have no request correlation (`tool-permission-events.ts:22`) — root point span only.
- Uncorrelated prime-mode `requested` (`tool-permission-gate.ts:155`), locked-task
  `denied`, job-recovery `final_outcome` (`job-permission-recovery.ts:172`) — no
  runId/requestId → root point spans, not paired.
v1 covers: request-correlated attended chains (Anthropic + DeepAgents worker +
inline attended) + classifier-decision point spans. It is NOT "all engines."

## Surface Impact Matrix (AGENTS.md:203 — required)
| Surface | Change |
|---|---|
| New host observability subscriber (tap loop) | add (default-app, 9 event types) |
| `permission` span emission (genai/observability module) | add |
| Settings / IPC / runner / sandbox | none |
| Existing runtime-event publish path | none (read-only subscriber) |

## Verify (real)
1. tsc clean. 2. Unit (InMemorySpanExporter + fake event stream): exactly ONE span
per correlated decision on `final_outcome` (allowed/resumed do not double-emit);
classifier-only → point span; parent=turn when runId present else root+tag;
`capture_content` false drops nothing structural (allowlist is already structure-
only). 3. **Security test**: no `reason`/`matchedRule`/`matchedPattern`/`commandPreview`
ever on a span. 4. **Restart test**: tail-start, no historical re-export; a
cross-restart decision → root point span, no crash. 5. Tap-loop error isolation:
a throwing handler never affects publish and never crashes the host. 6. Existing
suites green; autoreview clean before each commit.

## Non-goals (v1)
Per-app subscription (default only) · exact cross-restart duration · DeepAgents-yolo
+ uncorrelated prime/locked/recovery coverage · memory/tool-duration spans ·
generalized causal nesting.

## Staging
1. Tap loop (default-app, 9 types) + `permission` span builder + strict allowlist +
   one-canonical-terminal pairing + point-span for classifier-only → unit + security + restart tests.
2. Langfuse/LangSmith smoke: attended ask + auto-allow + deny appear as `permission`
   spans under the turn (attended shows real wait duration).
