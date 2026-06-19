# Boondi Production Readiness Gate

Date: 2026-06-18

Status: active readiness profile.

This document is the production-readiness entry point for Boondi customer-flow
testing. It does not redefine the live scenarios. The scenario source of truth
is `agents/boondi_support/docs/customer-worker-flow-live-verification-plan.md`.

Use this document to decide:

- which small scenario bundle to run for a focused readiness check
- when the full regression is required
- what evidence must be captured before saying Boondi is ready for customer
  traffic
- how to escalate from a focused failure to the right full-regression phase

## 1. Mental Model

The full regression plan is the detailed ledger. It contains the long run, the
historical failures, the fixes, the evidence logs, and the complete phase list.

This readiness gate is the index that tells an engineer what to run today.

Think of the two docs like this:

| Document | Role | When to use |
| --- | --- | --- |
| `boondi-production-readiness-gate.md` | Daily or pre-release decision gate | Before demos, small PRs, config changes, admin/runtime verification, and quick production-readiness checks |
| `customer-worker-flow-live-verification-plan.md` | Full regression and evidence ledger | Before launch, after runtime routing changes, after worker/queue/cursor changes, or when the focused gate fails |

Do not duplicate scenario instructions from the full plan into this document.
Point to the existing phase or scenario, then state why it belongs in the
focused gate.

## 2. Non-Negotiable Pass Rules

The focused gate passes only when all of these are true:

1. Runtime and admin API preflight passes before customer traffic starts:
   required env is loaded, `GANTRY_FLOW_LOG=1` is enabled for local evidence,
   admin/runtime API auth works, trace/payload endpoints are reachable, and no
   secret values are printed in the evidence packet.
2. Every tested inbound request enters through the actual signed inbound path.
3. Every tested inbound produces exactly one customer-visible outbound reply,
   unless the scenario explicitly tests duplicate provider redelivery.
4. No customer receives another customer's context, marker, order memory, or
   private details.
5. Same-customer follow-ups route to the correct retained or resumed session.
6. CRM and Shopify MCP calls work through live customer traffic when the
   scenario requires them.
7. The admin/API transcript shows the same message counts observed in the
   customer flow.
8. Runtime worker inventory returns to a truthful settled state:
   `activeMessageRuns=0`, `pendingConversationKeys=0`, and stale runtimes
   excluded from healthy totals.
9. Latency reports have detailed sections. A collapsed label such as
   `runtime wait` is not enough.
10. Latency reports include the message/routing identifiers required by the full
   plan's final acceptance criteria.
11. After the final reply, wait the scenario's configured settle window and
    re-check counts so delayed duplicate replies are caught. If the source
    scenario does not define a settle window, wait at least `90s`.
12. After the live run is done, wait `10 minutes`, then review every test
    conversation transcript and evidence row again. The gate fails if any
    conversation later shows an extra outbound reply, missing reply, context
    leak, stale pending work, unexplained latency section, or admin/API mismatch.

If any item fails, do not call the platform ready. Run the matching escalation
phase in section 6.

## 3. Focused Gate Scenario Bundle

Run this bundle when the change is small or when the goal is to decide whether
the current local build is broadly customer-ready without paying the full soak
cost.

Estimated duration: 35 to 60 minutes, depending on model latency, local stack
startup, whether the real provider-delivery smoke is included, and the
mandatory 10-minute post-run transcript audit.

| Gate item | Existing source | Why it is included | Minimum evidence |
| --- | --- | --- | --- |
| F-1. Env/API preflight | Full plan Phase 0 plus local env/API checks | Prevents a false pass where chat works but trace payloads, admin auth, or logs are unavailable. | Required env loaded without printing secrets; `GANTRY_FLOW_LOG=1`; admin/runtime API auth works; trace/payload endpoint reachable. |
| F0. Clean baseline | Full plan Phase 0 | Proves the local stack, admin/API, MCP services, worker inventory, and stale-row filtering start from a known state. | Healthy core(s), admin/API reachable, Shopify MCP healthy, CRM MCP healthy, stale runtimes excluded. |
| F1. Single-customer 4x4 | Full plan Phase 1 | Proves the normal customer chat loop and same-customer follow-up routing. | One conversation with 4 inbound, 4 outbound, 4 latency traces, no unexpected `assistant startup` before idle timeout. |
| F2. Two-customer isolation 4x4 | Full plan Phase 2 | Proves routing isolation and prevents customer-context leaks. | Two conversations, each with 4 inbound and 4 outbound; final replies remember only their own markers. |
| F3. Provider redelivery dedupe | Full plan Scenario 2.4 | Cheap high-value guard against duplicate replies, one of the worst customer-facing failures. | Same provider message id sent twice; exactly 1 inbound persistence path and exactly 1 outbound reply. |
| F4. MCP-backed customer flow | Full plan Phase 3.5 | Proves the runtime can call the Boondi CRM and Shopify MCPs from real customer traffic. | Trace sections show `boondi-crm` and `shopify-api` tool calls; transcript is complete. |
| F5. Dashboard and latency truth | Full plan Phase 6 plus the full plan latency rule | Proves the operator view matches the API and latency is explainable. | Admin UI/API agree; no vague `runtime wait`; message ids and detailed sections visible. |
| F6. Compact two-core/load replay | Full plan Phase 10 | Proves multi-core ownership, queueing, duplicate prevention, and post-settle cleanup in one high-signal replay. | Reply-gated multi-customer run; every customer has exact inbound/outbound/trace counts after settle. |
| F7. Real provider-delivery smoke | Full plan Phase 9 | Signed Interakt-compatible local webhooks prove Gantry/Boondi ingress and routing, but local dry-run does not prove the live Interakt/WhatsApp outbound provider delivered to a real phone. | One real WhatsApp customer message reaches Boondi through live Interakt, Gantry sends the reply with dry-run disabled, the customer receives the reply on WhatsApp, and the same reply is visible in admin/API. |
| F8. 10-minute transcript audit | Full plan Phase 10 evidence pattern | Catches delayed duplicate replies, late reconciler work, stale UI/API drift, and unexpected transcript changes after the run appears complete. | After 10 minutes, every tested conversation still has exact inbound/outbound/trace counts; transcript text is expected; workers remain settled. |

The earlier focused-gate phases still use the real runtime ingress path, but
they may use locally signed Interakt-compatible webhooks and
`GANTRY_OUTBOUND_DRYRUN=1`. F7 is different: it is the final live provider
delivery check through the real Interakt/WhatsApp account with dry-run disabled.
F7 can be manual if the production WhatsApp channel cannot be exercised by the
agent. Mark the focused gate as "engineering passed, provider-delivery manual
pending" until F7 is completed.

## 4. Heavy Gate

Run the full regression in
`agents/boondi_support/docs/customer-worker-flow-live-verification-plan.md` when the
change touches any of these surfaces:

- worker binding or warm-pool lifecycle
- queueing, claiming, leases, cursors, or reconciliation
- duplicate protection or provider redelivery handling
- outbound delivery, dry-run behavior, or message persistence
- multi-core ownership or runtime inventory aggregation
- latency trace collection, section labels, or admin latency rendering
- runtime dashboard data contracts
- MCP materialization or MCP request routing
- session continuity, idle timeout, provider-session resume, or memory
  persistence
- production launch readiness

Estimated duration: 90 to 150+ minutes. The full gate is intentionally slower
because it includes soak, restart, recovery, and settle windows.

## 5. Evidence Packet

Every focused-gate run should leave a short evidence packet. It can be pasted
into the run notes, PR description, or the full plan's evidence section when the
run becomes release-blocking.

Capture:

- date/time and config under test
- core count and ports
- runtime instance ids
- `GANTRY_OUTBOUND_DRYRUN` value
- cache prewarm setting and observed summary
- admin/runtime API auth and trace/payload endpoint readiness, without secret
  values
- customer conversation ids
- inbound provider message ids
- persisted outbound message ids
- per-conversation inbound/outbound/trace counts
- worker inventory before traffic, during load when relevant, immediately after
  replies, after the duplicate-settle window, and after the 10-minute transcript
  audit
- latency section labels for each tested reply
- explicit note that no latency label hid time under `runtime wait`
- MCP tool names observed in traces for MCP scenarios
- admin UI/API agreement result
- 10-minute post-run transcript audit result for every tested conversation
- real provider-delivery result when F7 is run

The evidence packet should be concise. The full transcript belongs in the
admin/API or DB evidence, not pasted into this document.

## 6. Escalation Matrix

If the focused gate fails, run the smallest matching full-regression phase
instead of guessing.

| Focused failure | Run next | Reason |
| --- | --- | --- |
| First reply missing | Full plan Phase 1 and Phase 4 | Separates normal first-message routing from follow-up/queue lifecycle issues. |
| Follow-up missing or delayed forever | Full plan Phase 4 | Exercises active follow-up, rapid follow-up, cold resume, and same-customer loops. |
| Duplicate outbound reply | Full plan Scenario 2.4, Phase 8, and Phase 10 | Covers provider redelivery, stale cursor replay, and post-settle duplicate detection. |
| Customer context leak | Full plan Phase 2 and Phase 10 | Proves isolation in single-core and compact multi-core/load conditions. |
| MCP failure | Full plan Phase 3.5 and Phase 7.2 | Separates normal MCP routing from outage/recovery behavior. |
| Dashboard/API mismatch | Full plan Phase 6 | Confirms admin projection, stale-runtime filtering, and runtime API truth. |
| Latency report is vague | Full plan latency rule and Phase 6 | The fix belongs in trace detail or admin rendering, not in scenario semantics. |
| Multi-core ownership confusion | Full plan Phase 5 and Phase 10 | Proves owner leases, cross-port ingress, restart continuity, and load replay. |
| Failure only appears after several turns | Full plan Phase 8 | Soak catches delayed cursor, cleanup, and duplicate replay bugs. |
| 10-minute transcript audit changes counts or content | Full plan Phase 8 and Phase 10 | Delayed transcript drift usually means stale cursor replay, delayed recovery work, duplicate outbound, or dashboard/API drift. |
| External customer did not receive reply | Full plan Phase 9 plus outbound delivery logs | Local dry-run evidence cannot prove real Interakt/WhatsApp provider delivery. |

## 7. Pass Labels

Use these exact labels in run notes:

- `Focused gate passed`: F-1 through F8 passed, including F7.
- `Focused gate engineering passed; provider-delivery pending`: F-1, F0 through
  F6, and F8 passed, but F7 was not run.
- `Focused gate failed`: any required item failed.
- `Heavy gate passed`: the full regression plan passed.
- `Heavy gate failed`: any full-regression acceptance criterion failed.

Do not use "ready" without one of those labels and the evidence packet.

## 8. Why This Shape Is Intentionally Small

The focused gate is not trying to prove every edge case. The full regression
already does that.

The focused gate covers the failures that would most visibly hurt customers:

- no reply
- duplicate reply
- wrong customer context
- follow-up loses memory
- MCP-backed answer path broken
- dashboard lies to the operator
- latency report hides the real source of delay
- multi-core load creates ownership or replay bugs
- local dry-run passes but the real Interakt/WhatsApp provider does not deliver

That is the smallest useful gate. Adding more scenarios here would mostly
duplicate the full plan and increase token/time cost without giving a clearer
production decision.
