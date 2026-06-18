# Customer Worker Flow Live Verification Plan

Date: 2026-06-18

Status: passed locally on 2026-06-18 IST after a post-fix two-core live load
rerun. Phase 4 required an active-follow-up queue lifecycle fix so pending
same-customer work drains through the retained pooled worker. Phase 5 proved
two-core startup, ownership, cross-core ingress, core-death recovery, and
post-restart provider-session continuity through live signed webhooks plus
control API and DB evidence. Phase 8 initially exposed stale multi-core cursor
replay, then passed after durable cursor refresh/merge was added and live soak
was rerun. Phase 10 initially passed too early, then a later admin screenshot
showed the same fourth inbound replayed by a delayed recovery/cold-run path.
The runtime now claims conversation work before runner start/active-run
continuation, durably saves accepted warm-run cursors, and revalidates
reconciler work after claim. The final load rerun used eight customers across
two cores and four reply-gated turns per customer; every customer ended at
exactly four inbound, four outbound, and four latency traces, with zero pending
work after settle. Real external WhatsApp delivery remains the user's final
manual acceptance step; local verification kept `GANTRY_OUTBOUND_DRYRUN=1`.

## Production Readiness Usage

For routine production-readiness checks, use
`docs/architecture/boondi-production-readiness-gate.md` as the focused gate.
That document points to the high-signal scenarios in this full plan and defines
when to escalate to the full regression here. Keep this file as the detailed
scenario source of truth and evidence ledger; do not duplicate its scenario
bodies into the focused gate.

## Phase Status Tracker

Update this table after every phase. Do not mark a phase passed unless the
phase acceptance criteria passed through live inbound requests plus admin/API
evidence.

| Phase     | Scope                                           | Scenario count | Status      | Evidence                                                                                                                                                                                                                                                                                                                                            | Notes                                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------- | -------------: | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0   | Harness and baseline                            |  baseline gate | Passed      | 2026-06-18 IST baseline: core 4710, admin 3000, Shopify MCP 8081, CRM MCP 8082; one healthy runtime, 51 stale rows excluded, generic available 3, active 0, pending 0.                                                                                                                                                                              | Admin Runtime and Conversations pages render; latency trace API reachable.                                                                                                                                                                           |
| Phase 1   | Single customer, single core, cache prewarm off |              4 | Passed      | 2026-06-18 IST fixed rerun `conversation:wa:000960000102` persisted 4 inbound, 4 outbound, and 4 latency reports; turn 4 remembered marker `REKEY-MUMBAI-31`; no latency report included `assistant startup`; healthy runtime active 0, pending 0.                                                                                                  | Retained same-process bound-worker continuation is now proven for a natural 4x4 chat. The run also covered a successful `memory_save` tool call.                                                                                                     |
| Phase 2   | Multiple customers, single core                 |              5 | Passed      | 2026-06-18 IST fixed rerun used `conversation:wa:000960000201` and `conversation:wa:000960000202`; both persisted 4 inbound and 4 outbound replies; final replies remembered only their own markers `ALPHA-REKEY-201` and `BRAVO-REKEY-202`; no latency report included `assistant startup`; post-idle runtime active 0, pending 0, bound active 0. | Retained same-process continuation and isolation are now proven for two simultaneous natural 4x4 customer chats. Prior Phase 2 capacity and duplicate-redelivery evidence remains valid.                                                             |
| Phase 3   | Cache prewarm on                                |              2 | Passed      | 2026-06-18 IST throwaway provider-cache implementation proof: `/tmp/gantry-dev-1.log:17` and `/tmp/gantry-dev-2.log:18` logged `Provider cache prewarm succeeded` with `cacheReadUnits=9601`; authenticated `/v1/runtime/workers` showed one shape with no cache-prewarm failures; customer model usage then showed cache reads around `14232`-`15085`; single-core sequential, single-core `SMOKE_CONCURRENCY=3`, two-core sequential, and two-core `SMOKE_CONCURRENCY=3` runtime smokes passed. | Historical pre-fix rows can still contain raw `startup` sections. The admin UI now renders startup explicitly as `Assistant startup`; it must not fold that time into `runtime wait`. Provider-cache prewarm completes before the control HTTP server accepts webhooks when startup prewarm is reachable. |
| Phase 3.5 | MCP smoke                                       |              1 | Passed      | 2026-06-18 IST seeded returning-customer rerun used `conversation:wa:000960000352`; all 4 live signed inbound messages and 4 live outbound replies persisted; traces showed `boondi-crm.get_open_records`, `shopify-api.get_recent_orders_with_details`, and `shopify-api.search_products`; post-idle runtime active 0, pending 0, bound active 0. | CRM and Shopify MCP live traffic are proven through live transcript, trace sections, flow logs, admin API, and runtime workers API.                                                                                                                   |
| Phase 4   | Follow-up routing stress                        |              4 | Passed      | Scenarios 4.1, 4.2, 4.3, and 4.4 passed on 2026-06-18 IST. 4.2 required a queue lifecycle fix so active-run follow-ups drain through the retained pooled worker. 4.4 used `conversation:wa:000960000405`, persisted 5 live inbound and 5 outbound replies, used one `agent_run`, and had no `startup` trace sections.                         | Follow-up routing stress is now proven for rapid follow-ups, active-run overlap, cold resume, and a five-turn same-customer loop. Admin API was not running because a separate Codex session owns admin UI work.                                     |
| Phase 5   | Two core processes                              |              5 | Passed      | Scenarios 5.1 through 5.5 passed on 2026-06-18 IST. Two healthy cores exposed aggregate generic capacity `6`; `conversation:wa:000960000501` kept one owner while ingress alternated across ports; six-customer fanout split owners across both cores; restart scenarios recovered through persisted provider sessions.                         | Admin UI/API was intentionally not used because a separate Codex session owns admin UI work; evidence came from core workers API, DB rows, message traces, and logs.                                                                                 |
| Phase 6   | Dashboard truth                                 | dashboard gate | Passed      | Admin API returned `200` for conversations and runtime workers after Phase 10. Runtime API and admin runtime API both showed two healthy instances, `genericAvailable=6`, `boundActive=0`, `activeMessageRuns=0`, `pendingConversationKeys=0`, and cache prewarm `skipped=6`. Latency UI regression in `boondi-admin` now forbids `runtime wait`. | Another session owns broader admin layout polish, but the data contract and latency report wording are verified.                                                                                                                                     |
| Phase 7   | Failure recovery                                |              3 | Passed      | Scenarios 7.1 through 7.3 passed on 2026-06-18 IST. Runner kill used `conversation:wa:000960000701` with 4 inbound/4 outbound and stable provider session. Clean MCP outage/recovery used `conversation:wa:000960000722` with exactly 2 inbound/2 outbound. Core kill left `runtime:97799` stale and excluded; survivor handled 4x4 chat.       | Admin UI/API was intentionally not used because a separate Codex session owns admin UI work; evidence came from core workers API, DB rows, flow logs, and MCP health checks.                                                                        |
| Phase 8   | Repeated-flow soak                              |      soak gate | Passed      | Initial 2026-06-18 IST soak failed before turn 4 due stale multi-core cursor replay. After durable cursor refresh/merge fix, focused replay probe passed and full five-customer/five-turn soak rerun completed with exactly `5` inbound and `5` outbound per customer, `5` latency traces per customer, no duplicates, and worker totals active/pending `0`. | Five customers, five turns each, at least 10 minutes; post-idle `startup` trace sections are expected because gaps intentionally exceed `idle_timeout_ms=30000`.                                                                                     |
| Phase 9   | Final real-customer acceptance                  |  customer gate | Passed      | Local customer-facing ingress passed on 2026-06-18 IST with `conversation:wa:000960000931`: 4 signed webhooks, 4 outbound dry-run customer replies, 4 latency traces, final reply remembered 6 boxes, chocolate/kaju, `₹1,800`, Pune, and next Friday after a 45s post-idle wait.                                                                      | Real external WhatsApp send remains for the user's final manual test; local acceptance used signed Interakt-compatible webhook ingress and dry-run outbound persistence.                                                                              |
| Phase 10  | Final regression pass                           | regression gate | Passed      | Post-fix load rerun `loadwave1781772606859` used eight customers across ports `4710` and `4711`, with four reply-gated live signed webhook waves. Every customer ended at exactly `4` inbound, `4` outbound, and `4` latency traces. After a 90s settle, workers showed `activeMessageRuns=0`, `pendingConversationKeys=0`, and `boundActive=0`. Focused fix checks and root `npm run build` passed. | Initial compact pass used `conversation:wa:000960001101`, `000960001102`, and `000960001103`, but `000960001102` later showed `4` inbound and `5` outbound messages. That earlier pass is superseded by the claim/revalidate fix and load rerun. |

`Scenario count` is the named scenario count. Default live execution after
Phase 0 is four customer messages and four Boondi replies inside the scenario's
required conversation set. Do not multiply every scenario by four conversations
unless the scenario is explicitly about multi-customer isolation, concurrency,
or capacity.
When adjacent sub-scenarios are parts of the same customer lifecycle, one
four-customer-message / four-Boondi-reply conversation may satisfy multiple
named sub-scenarios if the evidence proves each expected behavior.

## Goal

Prove the customer-visible chat flow works correctly across warm runners,
follow-ups, idle timeout, cache prewarm on/off, and one-core/two-core runtime
layouts.

The customer does not know about cores, workers, queues, prewarm, MCPs, or
provider sessions. From the customer perspective, the system must behave like a
normal chat:

- message in
- relevant reply out
- follow-ups work
- no replies disappear
- no duplicate replies
- no other customer's context appears

The developer-facing goal is to prove the runtime plumbing behind that normal
chat experience:

- inbound routing
- runner binding
- follow-up delivery
- worker release after idle timeout
- persisted provider-session resume
- multi-customer isolation
- multi-core ownership
- dashboard/API accuracy
- cache prewarm behavior

Product semantics are out of scope. Do not test whether Boondi gives the
"best" product answer. Test whether the message reaches the correct isolated
runner and whether the customer gets a reply through the expected runtime path.

## Configuration Under Test

Primary single-core config:

```yaml
runtime:
  warm_pool:
    enabled: true
    size: 3
    idle_timeout_ms: 30000
    max_bound_workers: 3
    cache_prewarm_enabled: false
    cache_prewarm_concurrency: 1
```

Cache-prewarm-on config:

```yaml
runtime:
  warm_pool:
    enabled: true
    size: 3
    idle_timeout_ms: 30000
    max_bound_workers: 3
    cache_prewarm_enabled: true
    cache_prewarm_concurrency: 1
```

Interpretation:

- `size: 3` means each healthy core should maintain three generic warm runners
  for the tested warm-pool shape, unless the runtime is starting, draining, or
  unhealthy.
- `idle_timeout_ms: 30000` means a conversation-bound runner should remain
  alive for follow-ups after it becomes idle after replying. It is not measured
  from the customer's message timestamp.
- Phase 1 intentionally reduced the earlier 200000 ms setting to 30000 ms to
  keep idle/release verification fast. Later phases may raise it again when
  testing longer customer gaps.
- `cache_prewarm_enabled: false` means provider-cache prewarm model calls are
  skipped. It must not break chat correctness.
- `cache_prewarm_enabled: true` means Gantry should run a throwaway synthetic
  Agent SDK query for each active `cacheShapeKey` before customer traffic when
  possible, verify provider cache usage evidence, then destroy the synthetic
  runner before customer traffic.
- A successful shape-level prewarm is refreshed after the default prompt-cache
  refresh interval, currently 45 minutes, by running another throwaway
  synthetic query for the same active `cacheShapeKey`. The refresh is still per
  shape, not per warm worker.
- `cache_prewarm_concurrency: 1` means at most one cache-prewarm model call
  runs at a time; if there are multiple cache shapes requiring prewarm, they
  are prewarmed one by one. Multiple warm workers with the same
  `cacheShapeKey` must share one prewarm result.
- In multi-core local smoke, the smoke env's `GANTRY_DEV_LOG` may contain
  comma-separated core logs. This is required because work accepted on one
  control port can be owned and logged by another runtime instance.

## Evidence Rules

Every scenario must be verified through the actual live flow:

1. Send an actual inbound request into the local runtime path.
2. Confirm the message appears in the admin panel or admin API.
3. Confirm the customer-visible outbound reply appears in the admin panel or
   admin API.
4. Confirm the reply latency trace exists for the outbound reply.
5. Confirm `/api/runtime/workers` or the equivalent control API agrees with the
   dashboard.
6. Confirm no stale runtime row contributes to healthy totals.
7. Confirm no conversation remains stuck in `activeMessageRuns` or
   `pendingConversationKeys` after the expected reply is visible.

Unit tests are supporting evidence only. They do not satisfy acceptance by
themselves.

## Latency Report Detail Rule

The latency report must never blur unknown time into a single unexplained
bucket. A top-level visual grouping is allowed only if the report also exposes
the exact underlying breakup that sums to the total.

Required sections:

- queue / pickup wait
- guardrail
- runner or assistant startup, when present
- main LLM turns
- provider first-response wait, when present
- tool calls
- send / outbound delivery
- runtime handoff or gap, with timestamp and duration
- cache prewarm, only when an actual Gantry cache-prewarm call ran
- provider prompt-cache read/write, labeled as provider prompt-cache usage and
  not as Gantry prewarm

Acceptance:

- fail any phase if the only visible explanation is a collapsed label such as
  `runtime wait`
- fail if `assistant startup` is hidden without a drill-down section showing
  that exact startup duration
- fail if provider wait, queue wait, startup, and internal handoff are merged
  in a way that prevents identifying where latency came from
- pass only when the customer-visible total can be reconciled to detailed
  sections in the admin/API evidence

## Turn Count Rule

Every named scenario after Phase 0 must exercise at least four customer
messages and four Boondi replies unless the scenario explicitly has a smaller
fixed shape, such as duplicate provider redelivery. Do not mark any phase passed
without this natural 4x4 chat evidence.

The default natural chat shape is:

1. Customer asks about gifting sweets or hampers.
2. Customer narrows quantity, budget, delivery city/date, or product preference.
3. Customer asks Boondi to remember or hold the intended order details.
4. Customer comes back and asks whether Boondi remembers the discussion.

Default rule:

- For single-customer scenarios, use one fresh synthetic Boondi customer
  conversation and drive four customer messages through that same conversation;
  require four persisted Boondi replies.
- For multi-customer scenarios, use the minimum customer set needed by the
  scenario and drive four customer messages plus four Boondi replies for each
  customer conversation that is part of the acceptance path.
- Do not run four independent conversations for every scenario by default. That
  burns tokens without improving evidence for first-message, follow-up, idle
  expiry, prewarm, or duplicate-redelivery behavior.

Use multiple conversations only when the scenario is specifically testing one
of these:

- cross-customer isolation
- concurrent customers
- capacity edges
- multi-core ownership
- stale-worker/dashboard accounting across conversations

Acceptance for a scenario requires all required turns to pass:

- each inbound gets exactly one expected outbound reply
- no customer receives another customer's context
- no duplicate outbound is produced for any inbound
- runtime worker counts return to a truthful steady state after the scenario
- latency/admin/API evidence is captured for every turn

## Phase 1 Evidence Log

Status: passed on 2026-06-18 IST after the retained-worker rekey and active-run
counter fixes.

Runtime setup:

- Core: one dev core on `127.0.0.1:4710`, runtime instance `runtime:32942`.
- Admin: `127.0.0.1:3000`.
- MCPs: `shopify-api` healthy on `127.0.0.1:8081`; `boondi-crm` healthy on
  `127.0.0.1:8082`.
- Outbound: `GANTRY_OUTBOUND_DRYRUN=1`.
- Warm pool: `size: 3`, `max_bound_workers: 3`, `cache_prewarm_enabled: false`,
  `idle_timeout_ms: 30000`.

Live scenario:

- Conversation id: `conversation:wa:000910000111`.
- Synthetic customer: `000910000111`.
- Signed inbound provider message ids:
  `4fcef742-cbee-4134-be92-2f786a866418`,
  `96dab3b2-b2ee-4bc5-ba4d-9ea56c467994`,
  `2bd85633-afa2-4dfb-86ff-d58926976c52`,
  `d877c861-cbe3-410e-bd2f-f93c9451512d`.
- Persisted outbound message ids:
  `message:wa:000910000111:outbound:d39ed9f8-74b9-4ceb-a3ff-3a421611ea84`
  (`9680 ms`),
  `message:wa:000910000111:outbound:50581d11-aeed-49da-888c-5a2ca53517c4`
  (`3709 ms`),
  `message:wa:000910000111:outbound:e153c10b-1198-4d79-9eba-539ec4663f24`
  (`6844 ms`),
  `message:wa:000910000111:outbound:fc53f35b-ace0-4b83-81e7-58cf3210790b`
  (`4446 ms`).
- Admin API transcript check: `8` messages, `4` inbound, `4` outbound.
- MCP evidence: turn 1 called
  `shopify-api.get_recent_orders_with_details({ "limit": 1 })`; turn 3 called
  the same tool again for the "check again" follow-up. Both returned order
  `#109260` with discount code `BSS200`.
- Runtime inventory after the scenario for healthy instance `runtime:32942`:
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `boundIdle=0`, `activeMessageRuns=0`, `pendingConversationKeys=0`.

Implementation findings from Phase 1:

- Missing runtime wiring for `queue.sendMessage` meant follow-up delivery was
  never attempted from the app-level group processor.
- A retained warm-worker idle timer could survive failed continuation delivery
  and kill the fallback run. The fallback path now clears preserved idle
  cleanup before spawning a replacement.
- Failed continuation delivery could leave a stale bound pooled worker in the
  runtime inventory. The queue now releases the pooled worker when the retained
  process is no longer reachable by the continuation carrier.
- Earlier post-turn behavior fell back to a resumed SDK session in a fresh
  one-shot runner after the SDK query completed. The retained-worker rekey
  fixed that for the Phase 1 natural 4x4 rerun below.

Natural 4x4 rerun - 2026-06-18 IST:

- Status: customer-visible pass; runtime acceptance blocked.
- Runtime: `runtime:74718`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=3`.
- Conversation: `conversation:wa:000940000101`.
- Inbound provider ids:
  `phase1-natural-4x4-1`, `phase1-natural-4x4-2`,
  `phase1-natural-4x4-3`, `phase1-natural-4x4-4`.
- Persisted outbound ids:
  `message:wa:000940000101:outbound:61013609-2d40-45eb-8813-6ab7e21ef810`
  (`6.486 s`),
  `message:wa:000940000101:outbound:d442d698-1cf4-4a70-b7fe-193f8e4c1570`
  (`11.691 s`),
  `message:wa:000940000101:outbound:d9ced1ec-7104-4b26-83c4-7f8a4f7e8a09`
  (`4.366 s`), and
  `message:wa:000940000101:outbound:0bda3d05-5469-4cdc-aa3f-497054657a61`
  (`5.131 s`).
- Transcript check: `4` inbound and `4` outbound persisted.
- Customer-visible continuity check: turn 4 reply remembered `30 gift boxes`,
  `under ₹1,200 per gift`, `Mumbai`, `next Friday`, and
  `Kaju Katli or assorted sweet boxes`.
- MCP evidence: turn 1 included `boondi-crm.get_open_records`; turn 2 included
  `shopify-api.get_gifting_context`.
- Final runtime snapshot: one healthy runtime, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`.
- Blocking runtime finding: follow-up turns 2, 3, and 4 included
  `assistant startup` in latency traces, so the customer got continuity through
  SDK session resume rather than the retained live-bound worker path.

Rebuilt natural 4x4 rerun - 2026-06-18 IST:

- Status: customer-visible pass; runtime acceptance blocked.
- Runtime: `runtime:45529`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=3`.
- Reason for rerun: rebuilt `dist` after the memory IPC scope patch because the
  Gantry MCP stdio server is launched from `dist/runner/mcp/stdio.js`.
- Conversation: `conversation:wa:000950000102`.
- Inbound provider ids:
  `phase1-rebuilt-1781740117499-1`,
  `phase1-rebuilt-1781740127442-2`,
  `phase1-rebuilt-1781740141290-3`,
  `phase1-rebuilt-1781740149090-4`.
- Persisted outbound ids:
  `message:wa:000950000102:outbound:63a2069b-e383-4c29-9d6e-8d64136ff6fb`
  (`8.523 s`),
  `message:wa:000950000102:outbound:a8cb5487-52cf-42bf-9d5e-0c514afa940d`
  (`12.188 s`),
  `message:wa:000950000102:outbound:ad5d4294-2364-4672-bd82-9d53075229bb`
  (`6.477 s`), and
  `message:wa:000950000102:outbound:19221db6-adc2-48b9-b4f8-b7b712a25124`
  (`6.222 s`).
- Transcript check: `4` inbound and `4` outbound persisted.
- Trace check: `4` message trace rows persisted for the four outbound ids.
- Customer-visible continuity check: turn 4 reply remembered `30 gift boxes`,
  `under ₹1,200 each`, `Kaju Katli or assorted sweets`, and
  `Mumbai delivery by next Friday`.
- Memory IPC scope check: no `memory IPC appId does not match connection scope`
  or `rejected memory frame` log was produced during the rebuilt Phase 1/2
  runs. This run did not force a `memory_save` tool call.
- Final runtime snapshot: one healthy runtime, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`, `boundIdle=0`, `availableTarget=3`.
- Blocking runtime finding: follow-up turns 2, 3, and 4 included
  `assistant startup` in latency traces, so retained same-process bound-worker
  continuation is still not passing.

Fixed retained-worker rerun - 2026-06-18 IST:

- Status: passed.
- Runtime: `runtime:99327`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=4` after one bound worker plus three generic workers.
- Reason for rerun: fixed two runtime defects found by the blocked Phase 1
  evidence:
  - bound warm-worker sockets were still indexed under the generic startup
    run handle, so follow-up continuation lookup missed the retained process
    and fell back to a cold/resumed one-shot runner;
  - retained DB-drain cleanup could double-decrement `activeMessageRuns` after
    `notifyIdle()` had already released the active slot.
- Conversation: `conversation:wa:000960000102`.
- Inbound provider ids:
  `phase1-rekey-counter-1781741773170-1`,
  `phase1-rekey-counter-1781741773170-2`,
  `phase1-rekey-counter-1781741773170-3`,
  `phase1-rekey-counter-1781741773170-4`.
- Persisted outbound ids:
  `message:wa:000960000102:outbound:d3d02f8a-35c8-4d6e-9079-47e9b0eeed17`
  (`7.865 s`),
  `message:wa:000960000102:outbound:856da71c-84fc-4693-8a1b-2f23e80137e5`
  (`9.400 s`),
  `message:wa:000960000102:outbound:e45066d8-3bcf-4a33-87f3-45c4b21f9025`
  (`8.378 s`), and
  `message:wa:000960000102:outbound:09d04a8a-3210-45f9-8c51-2ecb93c4ed47`
  (`2.919 s`).
- Transcript check: admin API showed `4` inbound and `4` outbound messages.
- Trace check: all four outbound replies had latency reports; labels by turn:
  - turn 1: `queue`, `guardrail`, `main LLM · turn 1`, `gap`,
    `get_open_records`, `main LLM · turn 2`, `gap`, `send`;
  - turn 2: `queue`, `main LLM · turn 1`, `gap`, `get_gifting_context`,
    `main LLM · turn 2`, `gap`;
  - turn 3: `queue`, `main LLM · turn 1`, `memory_save`,
    `main LLM · turn 2`, `gap`;
  - turn 4: `queue`, `main LLM · turn 1`, `gap`.
- `assistant startup` check: no turn included `assistant startup` or any
  startup stage in the latency report.
- Customer-visible continuity check: turn 4 reply remembered marker
  `REKEY-MUMBAI-31`, `30 gift boxes`, `Mumbai`, `Friday, Jun 26`,
  `under ₹1,200 per box`, and `Kaju Katli or assorted sweets`.
- MCP evidence: turn 1 included `boondi-crm.get_open_records`; turn 2 included
  `shopify-api.get_gifting_context`; turn 3 included Gantry `memory_save`.
- Final healthy runtime snapshot for `runtime:99327`:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=1`,
  `maxMessageRuns=3`.
- Dashboard truth check: no negative `activeMessageRuns` was observed after the
  retained follow-up finished; the stale old runtime rows remained marked
  `stale` and did not affect the healthy runtime evidence.

## Phase 2 Evidence Log

Status: passed on 2026-06-18 IST after the retained-worker rekey and active-run
counter fixes.

Runtime setup:

- Core: one dev core on `127.0.0.1:4710`.
- Admin: `127.0.0.1:3000`.
- MCPs: `shopify-api` healthy on `127.0.0.1:8081`; `boondi-crm` healthy on
  `127.0.0.1:8082`.
- Outbound: `GANTRY_OUTBOUND_DRYRUN=1`.
- Warm pool: `size: 3`, `max_bound_workers: 3`, `cache_prewarm_enabled: false`,
  `idle_timeout_ms: 30000`.

Scenario 2.1 and 2.1b: two customers sequential plus cross-customer marker
isolation.

- Customer A: `conversation:wa:000920000210`.
- Customer B: `conversation:wa:000920000211`.
- Customer A inbound provider ids: `phase2-marker-a1`, `phase2-marker-a2`.
- Customer A persisted outbound ids:
  `message:wa:000920000210:outbound:787213c7-ebe4-40ac-b0f5-e552385af25a`
  (`3.162 s`) and
  `message:wa:000920000210:outbound:bfde5d67-bfdf-4706-8c77-9d77f7c4fca8`
  (`4.033 s`).
- Customer B inbound provider ids: `phase2-marker-b1`, `phase2-marker-b2`.
- Customer B persisted outbound ids:
  `message:wa:000920000211:outbound:1bd11c6d-22e5-445f-9cc6-57da041a0779`
  (`2.175 s`) and
  `message:wa:000920000211:outbound:89274634-f7c5-4ed1-b63b-cdfeb967fd13`
  (`4.343 s`).
- Isolation checks: Customer A recovered `ALPHA-P2-210` and did not receive
  `BRAVO-P2-211`; Customer B recovered `BRAVO-P2-211` and did not receive
  `ALPHA-P2-210`.
- Transcript counts: Customer A `2` inbound and `2` outbound; Customer B `2`
  inbound and `2` outbound.
- Note: an earlier marker phrase without a Boondi-scoped delivery/order context
  was correctly rejected by the Boondi scope guardrail, so the accepted evidence
  uses Boondi-scoped reference-marker wording.

Scenario 2.2: two customers concurrent.

- Customers: `conversation:wa:000920000203` and
  `conversation:wa:000920000204`.
- Persisted outbound ids:
  `message:wa:000920000203:outbound:c16db457-4e7b-4df7-87d8-2aa2446e6bf5`
  (`3.642 s`) and
  `message:wa:000920000204:outbound:f4e639ff-2293-43c6-b6c4-f99ce5dcaf2a`
  (`2.757 s`).
- Runtime snapshot during the overlap showed one active message run and zero
  pending conversation keys; both conversations received exactly one reply.

Scenario 2.3: capacity edge with four customers.

- Customers: `conversation:wa:000920000205`,
  `conversation:wa:000920000206`, `conversation:wa:000920000207`, and
  `conversation:wa:000920000208`.
- Inbound provider ids: `phase2-capacity-1`, `phase2-capacity-2`,
  `phase2-capacity-3`, `phase2-capacity-4`.
- Persisted outbound ids:
  `message:wa:000920000205:outbound:b6744cee-7481-48e3-9482-743218c0a437`
  (`2.705 s`),
  `message:wa:000920000206:outbound:cd4a77ba-8983-42f5-be07-af0bffdd81a7`
  (`6.940 s`),
  `message:wa:000920000207:outbound:0fa4da30-f215-4e7a-84d0-eda9cd5bc78a`
  (`7.706 s`), and
  `message:wa:000920000208:outbound:4f7554ec-93fb-40d4-9744-8a90cd96c991`
  (`6.999 s`).
- Runtime snapshots during the run showed active work moving through the
  `max_message_runs: 3` limit without stranded pending conversations. The
  observed five-second snapshot was `activeMessageRuns=3`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `boundActive=3`.
- All four conversations received exactly one outbound reply.

Scenario 2.4: provider redelivery dedupe.

- Customer: `conversation:wa:000920000209`.
- Duplicate provider message id sent twice: `phase2-duplicate-1`.
- Persisted outbound id:
  `message:wa:000920000209:outbound:5f3af8cf-79ca-4de4-80f3-6323f0c281ec`
  (`4.202 s`).
- Admin transcript check after a post-reply wait: `1` inbound, `1` outbound,
  new outbound count `1`.

Final Phase 2 drain snapshot:

- `activeMessageRuns=0`.
- `pendingConversationKeys=0`.
- `genericAvailable=3`.
- `genericStarting=0`.
- `boundActive=0`.
- `boundIdle=0`.
- `availableTarget=3`.
- Cache prewarm summary: `pending=0`, `succeeded=0`, `skipped=3`, `failed=0`.

Natural 4x4 rerun - 2026-06-18 IST:

- Status: customer-visible pass; runtime acceptance blocked.
- Runtime: `runtime:74718`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=3`.
- Customer A: `conversation:wa:000940000201`, marker `ALPHA-MUMBAI-30`.
- Customer B: `conversation:wa:000940000202`, marker `BRAVO-DELHI-12`.
- Each round sent both customers concurrently, then waited for both persisted
  outbound replies before sending the next round.
- Customer A inbound provider ids:
  `phase2-natural-000940000201-1`,
  `phase2-natural-000940000201-2`,
  `phase2-natural-000940000201-3`,
  `phase2-natural-000940000201-4`.
- Customer A persisted outbound ids:
  `message:wa:000940000201:outbound:26c38039-1825-47a4-91e1-7deae602389f`
  (`6.833 s`),
  `message:wa:000940000201:outbound:1fb7593f-9a24-4a9e-bb6b-09bc0646ca8d`
  (`13.209 s`),
  `message:wa:000940000201:outbound:0512b20b-f5d3-46b1-b2b0-6b37bc59c8df`
  (`10.092 s`), and
  `message:wa:000940000201:outbound:46a9e02a-fc97-4b00-b1de-b3bb6ec72dae`
  (`6.132 s`).
- Customer B inbound provider ids:
  `phase2-natural-000940000202-1`,
  `phase2-natural-000940000202-2`,
  `phase2-natural-000940000202-3`,
  `phase2-natural-000940000202-4`.
- Customer B persisted outbound ids:
  `message:wa:000940000202:outbound:8e2a12eb-a3b8-41d1-9efa-fa5cc10a0766`
  (`11.093 s`),
  `message:wa:000940000202:outbound:abe11047-679f-42bb-9ee1-38f0924b9010`
  (`7.320 s`),
  `message:wa:000940000202:outbound:a88e7cbd-471a-4423-8cc3-a87792272d4f`
  (`10.626 s`), and
  `message:wa:000940000202:outbound:8ee61837-a1ba-4fdc-9937-fe75cf7ca37e`
  (`6.864 s`).
- Transcript checks: Customer A had `4` inbound and `4` outbound; Customer B
  had `4` inbound and `4` outbound.
- Isolation checks: Customer A final reply contained `ALPHA-MUMBAI-30` and did
  not contain `BRAVO-DELHI-12`; Customer B final reply contained
  `BRAVO-DELHI-12` and did not contain `ALPHA-MUMBAI-30`.
- MCP evidence: traces included `boondi-crm.get_open_records`,
  `shopify-api.get_gifting_context`, and `memory_save`.
- Final runtime snapshot: one healthy runtime, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`.
- Blocking runtime findings:
  - Follow-up turns included `assistant startup`, so same-process retained
    worker continuation is still not passing.
  - Both remember turns attempted `memory_save`, but the trace recorded
    `ok=false`; core logs showed `memory IPC appId does not match connection
scope`.

Rebuilt natural 4x4 rerun - 2026-06-18 IST:

- Status: customer-visible pass; runtime acceptance blocked.
- Runtime: `runtime:45529`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=3`.
- Reason for rerun: rebuilt `dist` after the memory IPC scope patch because the
  Gantry MCP stdio server is launched from `dist/runner/mcp/stdio.js`.
- Customer A: `conversation:wa:000950000201`, marker `ALPHA-MUMBAI-30`.
- Customer B: `conversation:wa:000950000202`, marker `BRAVO-DELHI-12`.
- Each round sent both customers concurrently, then waited for both persisted
  outbound replies before sending the next round.
- Customer A inbound provider ids:
  `phase2-rebuilt-A-1781740196800-1`,
  `phase2-rebuilt-A-1781740208653-2`,
  `phase2-rebuilt-A-1781740223497-3`,
  `phase2-rebuilt-A-1781740234313-4`.
- Customer A persisted outbound ids:
  `message:wa:000950000201:outbound:7239e3ca-3203-4c11-bdb3-208bcf6fe0cd`
  (`10.189 s`),
  `message:wa:000950000201:outbound:fc95debd-28d8-4b53-99aa-6f5579780227`
  (`13.721 s`),
  `message:wa:000950000201:outbound:12b0589f-ff6e-48e0-b88f-6d0c3559de2c`
  (`9.346 s`), and
  `message:wa:000950000201:outbound:74274941-922e-4e32-8e0c-0cb33b09fe52`
  (`9.609 s`).
- Customer B inbound provider ids:
  `phase2-rebuilt-B-1781740196816-1`,
  `phase2-rebuilt-B-1781740208657-2`,
  `phase2-rebuilt-B-1781740223501-3`,
  `phase2-rebuilt-B-1781740234314-4`.
- Customer B persisted outbound ids:
  `message:wa:000950000202:outbound:3253d132-7122-4a2a-9790-e5e45ee537fd`
  (`10.432 s`),
  `message:wa:000950000202:outbound:af7d1f44-1498-44ef-b13c-f98e1dddea0d`
  (`13.229 s`),
  `message:wa:000950000202:outbound:a7f282d2-48ca-4261-bf4c-b8b48499b290`
  (`9.490 s`), and
  `message:wa:000950000202:outbound:8d3251f8-cb6b-45a5-a6e9-89b1c545a178`
  (`10.231 s`).
- Transcript checks: Customer A had `4` inbound and `4` outbound; Customer B
  had `4` inbound and `4` outbound.
- Trace checks: Customer A had `4` trace rows; Customer B had `4` trace rows.
- Isolation checks: Customer A final reply contained `ALPHA-MUMBAI-30` and did
  not contain `BRAVO-DELHI-12`; Customer B final reply contained
  `BRAVO-DELHI-12` and did not contain `ALPHA-MUMBAI-30`.
- Memory IPC scope check: no `memory IPC appId does not match connection scope`
  or `rejected memory frame` log was produced during the rebuilt Phase 1/2
  runs. This run did not force a `memory_save` tool call.
- Final runtime snapshot: one healthy runtime, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`, `boundIdle=0`, `availableTarget=3`.
- Blocking runtime finding: follow-up turns for both customers included
  `assistant startup`, so same-process retained bound-worker continuation is
  still not passing.

Fixed retained-worker natural 4x4 rerun - 2026-06-18 IST:

- Status: passed.
- Runtime: `runtime:18519`, one healthy core, `cache_prewarm_enabled=false`,
  `cachePrewarm.skipped=3` after idle drain.
- Reason for rerun: Phase 2 customer-visible isolation had already passed, but
  follow-up latency traces from the prior runs still contained
  `assistant startup`. This rerun validates the same two-customer natural 4x4
  flow after the retained-worker socket rekey and active-run counter fixes.
- Customer A: `conversation:wa:000960000201`, marker `ALPHA-REKEY-201`.
- Customer B: `conversation:wa:000960000202`, marker `BRAVO-REKEY-202`.
- Each round sent both customers concurrently, then waited for both persisted
  outbound replies before sending the next round.
- Customer A inbound provider ids:
  `phase2-rekey-A-1781742297117-1`,
  `phase2-rekey-A-1781742297117-2`,
  `phase2-rekey-A-1781742297117-3`,
  `phase2-rekey-A-1781742297117-4`.
- Customer A persisted outbound ids:
  `message:wa:000960000201:outbound:7a766019-af61-44a8-81da-6c96a54dfff2`
  (`9.516 s`),
  `message:wa:000960000201:outbound:4417b394-d933-4119-825e-7af1acd47aa1`
  (`10.238 s`),
  `message:wa:000960000201:outbound:98315206-ddbb-474c-8497-471aac60bd1f`
  (`4.147 s`), and
  `message:wa:000960000201:outbound:78281594-e871-4a18-a62c-0d8d33cdab0f`
  (`4.081 s`).
- Customer B inbound provider ids:
  `phase2-rekey-B-1781742297117-1`,
  `phase2-rekey-B-1781742297117-2`,
  `phase2-rekey-B-1781742297117-3`,
  `phase2-rekey-B-1781742297117-4`.
- Customer B persisted outbound ids:
  `message:wa:000960000202:outbound:abd0700a-8af1-4d71-8a04-8c26513f2228`
  (`12.088 s`),
  `message:wa:000960000202:outbound:95930fa4-dd77-49cf-93c6-d3c0a6114566`
  (`9.495 s`),
  `message:wa:000960000202:outbound:fe87d2af-ba6a-4a57-8364-973b9982ef58`
  (`3.602 s`), and
  `message:wa:000960000202:outbound:38dc70de-980e-4456-91a1-3077f888f9e5`
  (`3.784 s`).
- Transcript checks: Customer A had `4` inbound and `4` outbound; Customer B
  had `4` inbound and `4` outbound.
- `assistant startup` check: all eight outbound latency reports had
  `startupByTurn=false`.
- Isolation checks: Customer A final reply contained `ALPHA-REKEY-201` and did
  not contain `BRAVO-REKEY-202`; Customer B final reply contained
  `BRAVO-REKEY-202` and did not contain `ALPHA-REKEY-201`.
- MCP evidence: traces included `boondi-crm.get_open_records`,
  `shopify-api.get_gifting_context`, and `shopify-api.search_products`.
- Runtime overlap evidence: during round 1, the healthy runtime reached
  `activeMessageRuns=2`, `pendingConversationKeys=0`, `genericAvailable=2`,
  `genericStarting=1`, `boundActive=2`, `maxMessageRuns=3`.
- Immediate post-run retained state: `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=2`, `boundIdle=0`, `availableTarget=3`.
- Post-idle drain snapshot after waiting past `idle_timeout_ms`:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `boundIdle=0`, `boundDraining=0`, `availableTarget=3`,
  `cachePrewarm.pending=0`, `cachePrewarm.succeeded=0`,
  `cachePrewarm.skipped=3`, `cachePrewarm.failed=0`.

## Phase 3 Evidence Log

Status: passed on 2026-06-18 IST.

Runtime setup:

- Core: one dev core on `127.0.0.1:4710`, restarted after enabling cache
  prewarm.
- Admin: `127.0.0.1:3000`.
- MCPs: `shopify-api` healthy on `127.0.0.1:8081`; `boondi-crm` healthy on
  `127.0.0.1:8082`.
- Outbound: `GANTRY_OUTBOUND_DRYRUN=1`.
- Warm pool: `size: 3`, `max_bound_workers: 3`, `cache_prewarm_enabled: true`,
  `cache_prewarm_concurrency: 1`, `idle_timeout_ms: 30000`.

Startup-order finding:

- Code path: `apps/core/src/app/index.ts` awaits `prewarmWarmPoolRoutes(...)`
  before connecting enabled channels and starting the control HTTP server.
- Scope: `apps/core/src/app/bootstrap/startup.ts` awaits default Interakt route
  prewarm and fire-and-forgets only prewarm of previously discovered existing
  routes.
- Result: a signed webhook cannot arrive during default startup prewarm because
  the control HTTP server is not listening yet.
- Acceptance interpretation: Scenario 3.2 was exercised as the reachable
  equivalent, traffic while generic workers are consumed and replacement
  prewarm/startup is in progress.

Warm-pool and provider-cache prewarm evidence:

- Core logs showed `Warm pool prewarm started`, followed by
  `Warm pool prewarm ready`, before the control server logged that it was
  listening on `127.0.0.1:4710`.
- Runtime precondition before traffic:
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `availableTarget=3`.
- Cache prewarm summary before traffic:
  `pending=0`, `succeeded=3`, `skipped=0`, `failed=0`.
- The cache shape for `agent:boondi_support` showed `status=succeeded` with
  `workers=3`.
- The configured `cache_prewarm_concurrency=1` was in effect for this run; this
  pass verified the final status but did not independently time every provider
  model call to prove serialization.

Final throwaway provider-cache implementation proof:

- Runtime instance: one dev core on `127.0.0.1:4710`.
- Log evidence: `/tmp/gantry-dev-1.log:17` and `/tmp/gantry-dev-2.log:18`
  logged `Provider cache prewarm succeeded` for the Boondi shape with
  `cacheReadUnits=9601` and `cacheWriteUnits=0`.
- Shape evidence: the logged `cacheShapeKey` used
  `anthropic:claude-agent-sdk`, `agent:boondi_support`,
  model `claude-sonnet-4-6`, Gantry MCP tools
  `mcp_call_tool`, `mcp_list_tools`, `memory_save`, `memory_search`,
  native `ToolSearch`, and MCP set `mcp:boondi-crm`, `mcp:shopify-api`.
- Inventory evidence: authenticated `GET /v1/runtime/workers` with the smoke
  token showed one healthy runtime, `availableTarget=3`,
  `genericAvailable=3`, `boundActive=0`, and cache prewarm
  `pending=0`, `succeeded=3`, `skipped=0`, `failed=0` for that one
  `cacheShapeKey`.
- Customer benefit evidence: subsequent `flow:model.usage` rows in the same
  core logs showed provider cache reads including `14271`, `14232`, `14850`,
  `15023`, `14789`, `14874`, `14911`, `15085`, and `14932`.
- Regression evidence: `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env
  npm run smoke:boondi-runtime` passed for the three default smoke cases, and
  `SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime` also passed.
- Multi-core runtime smoke evidence:
  `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env.1
  GANTRY_DEV_LOG=/tmp/gantry-dev-1.log,/tmp/gantry-dev-2.log
  SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime` passed with two healthy
  runtime instances, `availableTarget=6`, cache prewarm `succeeded=6`
  before traffic, cache prewarm `succeeded=8` after replacement warm workers,
  `failed=0`, and three concurrent smoke cases. Reply times were `11137 ms`,
  `12319 ms`, and `5673 ms`.
- Multi-core harness finding: reading only one core log is insufficient because
  a webhook accepted on one control port can be owned by another runtime
  instance. The smoke harness now accepts comma-separated `GANTRY_DEV_LOG`
  paths, and the local stack rewrites printed smoke env files with all core
  logs.

Fixed natural 4x4 rerun under cache-prewarm-on:

- Runtime instance: `runtime:27640`.
- Customer: `conversation:wa:000960000301`.
- Scenario marker: `PREWARM-ON-301`.
- Pre-traffic runtime snapshot: `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`, `activeMessageRuns=0`, `pendingConversationKeys=0`,
  cache prewarm `pending=0`, `succeeded=3`, `skipped=0`, `failed=0`.
- Signed inbound provider message ids:
  `phase3-prewarm-on-1781742732071-1`,
  `phase3-prewarm-on-1781742732071-2`,
  `phase3-prewarm-on-1781742732071-3`, and
  `phase3-prewarm-on-1781742732071-4`.
- Persisted outbound message ids:
  `message:wa:000960000301:outbound:ed433c90-d132-46de-87d0-b145707ac6f4`
  (`7.048 s`),
  `message:wa:000960000301:outbound:e834df4b-ce50-4583-9018-ca678172c38a`
  (`8.764 s`),
  `message:wa:000960000301:outbound:7a45189b-389d-41c4-9ad9-7cc31765b1ca`
  (`3.059 s`), and
  `message:wa:000960000301:outbound:01c8caee-454c-4541-ac55-3e84d5cf594d`
  (`2.527 s`).
- Trace labels by turn:
  - Turn 1:
    `queue`, `guardrail`, `main LLM · turn 1`, `gap`,
    `get_open_records`, `main LLM · turn 2`, `gap`, `send`.
  - Turn 2:
    `queue`, `main LLM · turn 1`, `gap`, `search_products`,
    `main LLM · turn 2`, `gap`.
  - Turn 3: `queue`, `main LLM · turn 1`, `gap`.
  - Turn 4: `queue`, `main LLM · turn 1`, `gap`.
- `assistant startup` check: all four outbound latency reports had no
  `startup` section.
- `cache_prewarm` check: all four outbound latency reports had no
  customer-visible `cache_prewarm` section.
- Final reply remembered `PREWARM-ON-301`, 18 boxes, ₹1,500 per box,
  assorted sweets plus chocolate, Pune, and next Friday.
- Immediate post-run runtime snapshot: `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=1`, cache prewarm `succeeded=4`.
- Post-idle runtime snapshot: `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`, `boundIdle=0`, `boundDraining=0`, `availableTarget=3`,
  cache prewarm `pending=0`, `succeeded=3`, `skipped=0`, `failed=0`.

Current-vs-historical startup trace finding:

- Current fixed rows for `conversation:wa:000960000301`,
  `conversation:wa:000960000201`, and `conversation:wa:000960000202` do not
  contain `startup` sections in `message_traces.timings_json`.
- Historical pre-fix rows such as `conversation:wa:000950000201` and
  `conversation:wa:000950000202` still contain raw `startup` sections because
  those traces were persisted before the retained-worker rekey fix.
- Admin UI behavior was updated in the sibling `boondi-admin` app to render raw
  `startup` sections explicitly as `Assistant startup`. It must not fold that
  time into a collapsed `runtime wait` label.

Scenario 3.1: prewarm complete before traffic.

- Customer: `conversation:wa:000930000301`.
- Inbound provider id: `phase3-prewarm-complete-1`.
- Persisted outbound id:
  `message:wa:000930000301:outbound:8542caa0-1ae7-4aba-9c58-5832c8fb8fe6`.
- `replySeconds=2.462`.
- Latency sections:
  - `queue=83 ms`.
  - `guardrail=1 ms`, with `obvious_bss_topic`.
  - `main LLM=2274 ms`.
  - `gap=104 ms`.
- The reply latency report did not include a customer-visible
  `cache_prewarm` section because prewarm had already succeeded before traffic.
- Immediate post-reply runtime snapshot showed replacement activity:
  `activeMessageRuns=1`, `genericAvailable=2`, `genericStarting=1`,
  `boundActive=1`, cache prewarm `succeeded=3`.
- After the replacement finished, runtime reached `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `genericAvailable=3`, `genericStarting=0`,
  `boundActive=1`, cache prewarm `succeeded=4`.

Scenario 3.2: traffic while workers are consumed and replacement starts.

- Customers: `conversation:wa:000930000302`,
  `conversation:wa:000930000303`, `conversation:wa:000930000304`, and
  `conversation:wa:000930000305`.
- Inbound provider ids: `phase3-prewarm-during-1`,
  `phase3-prewarm-during-2`, `phase3-prewarm-during-3`, and
  `phase3-prewarm-during-4`.
- Runtime snapshot at five seconds:
  `activeMessageRuns=3`, `pendingConversationKeys=1`,
  `genericAvailable=1`, `genericStarting=1`, `boundActive=3`,
  `availableTarget=3`, cache prewarm `succeeded=4`.
- Persisted outbound ids:
  `message:wa:000930000302:outbound:79d3e258-7a74-4879-93d7-d0bc76b1fe88`
  (`7.275 s`),
  `message:wa:000930000303:outbound:6147d43a-e33b-41b8-8396-8aa1d12f3403`
  (`4.481 s`),
  `message:wa:000930000304:outbound:15fa2961-73ca-4e3d-a7f0-ca3f8ef30158`
  (`9.985 s`), and
  `message:wa:000930000305:outbound:8200575d-6f6b-451d-8ea8-170b73b7b52d`
  (`4.408 s`).
- The fourth customer showed the expected capacity-saturated path explicitly in
  the raw backend trace from the earlier run: `queue=4437 ms`,
  `assistant startup=3689 ms`, `main LLM=1770 ms`, and final `gap=80 ms`.
  This is retained as historical diagnostic evidence only; the natural 4x4
  rerun above is the current Phase 3 acceptance evidence, and the admin UI now
  renders raw `startup` explicitly as `Assistant startup`.
- No customer hung; all four conversations received exactly one outbound reply.

Final Phase 3 drain snapshot:

- `activeMessageRuns=0`.
- `pendingConversationKeys=0`.
- `genericAvailable=3`.
- `genericStarting=0`.
- `boundActive=0`.
- `boundIdle=0`.
- `availableTarget=3`.
- Cache prewarm summary: `pending=0`, `succeeded=3`, `skipped=0`, `failed=0`.

## Phase 3.5 Evidence Log

Status: passed on 2026-06-18 IST.

Runtime setup:

- Core: one dev core on `127.0.0.1:4710`.
- Runtime instance: `runtime:89545`.
- Admin API: `127.0.0.1:3000` returned 200 for `/api/messages`,
  `/api/conversations`, and `/api/runtime/workers` during evidence capture.
- MCPs: `shopify-api` healthy on `127.0.0.1:8081`; `boondi-crm` healthy on
  `127.0.0.1:8082`.
- Outbound: `GANTRY_OUTBOUND_DRYRUN=1`.
- Warm pool: `size: 3`, `max_bound_workers: 3`,
  `cache_prewarm_enabled: false`, `cache_prewarm_concurrency: 1`,
  `idle_timeout_ms: 30000`.

Baseline runtime snapshot:

- Healthy runtime instances: `1`.
- Healthy warm-pool totals: `genericAvailable=3`, `genericStarting=0`,
  `boundActive=0`, `boundIdle=0`, `boundDraining=0`, `availableTarget=3`,
  `maxBoundWorkers=3`.
- Healthy queue totals: `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `maxMessageRuns=3`.
- Healthy cache-prewarm totals: `pending=0`, `succeeded=0`, `skipped=3`,
  `failed=0`.
- Cache shape included both MCP sources:
  `mcpSet=["mcp:boondi-crm","mcp:shopify-api"]`.
- Stale runtime rows were present in the inventory but excluded from
  `healthyTotals`.

Initial partial attempt:

- Customer: `conversation:wa:000960000351`.
- Result: four signed inbound messages and four outbound replies persisted, and
  `shopify-api.get_recent_orders_with_details` appeared in the trace.
- Reason not used as pass evidence: it proved Shopify live traffic but did not
  produce a `boondi-crm` live tool call, so it did not satisfy the
  CRM-and-Shopify smoke scope.

Passing seeded returning-customer 4x4 rerun:

- Customer: `conversation:wa:000960000352`.
- Seed: `seedReturning(...)` inserted prior open corporate Diwali-gifting
  context for the fake customer so a bare returning greeting should exercise
  `boondi-crm.get_open_records`.
- Scenario marker: `CRM-SHOP-352`.
- Live signed inbound provider message ids:
  `phase35-crm-shop-1781744919018-1`,
  `phase35-crm-shop-1781744925085-2`,
  `phase35-crm-shop-1781744932146-3`, and
  `phase35-crm-shop-1781744943327-4`.
- Persisted outbound message ids:
  `message:wa:000960000352:outbound:36cdf2e6-83b6-4c7a-9f5c-fa9473c02381`
  (`replySeconds=5.924`, `totalMs=5927`),
  `message:wa:000960000352:outbound:c1272594-57c2-4778-adc0-2334582f7841`
  (`replySeconds=6.331`, `totalMs=6332`),
  `message:wa:000960000352:outbound:53bf528e-68b3-46bc-8f64-44d160cf9250`
  (`replySeconds=10.591`, `totalMs=10593`), and
  `message:wa:000960000352:outbound:800f992b-d719-4968-91d2-bcf620b50055`
  (`replySeconds=3.771`, `totalMs=3771`).
- Admin `/api/messages` evidence showed 10 total messages for the seeded
  conversation: two seeded history messages plus four live inbound and four
  live outbound messages.
- Admin `/api/conversations` evidence showed
  `conversation:wa:000960000352`, phone `000960000352`, `messageCount=10`,
  `inboundCount=5`, `outboundCount=5`, and latest direction `outbound`.

Trace and MCP evidence:

- Turn 1 latency sections:
  `queue`, `main LLM · turn 1`, `gap`, `get_open_records`,
  `main LLM · turn 2`, `gap`, `send`.
- Turn 1 tool evidence:
  `boondi-crm.get_open_records`, `111 ms`.
- Turn 1 flow-log evidence:
  `flow:mcp.request` and `flow:mcp.response` for
  `serverName=boondi-crm`, `toolName=get_open_records`.
- Turn 2 latency sections:
  `queue`, `main LLM · turn 1`, `gap`,
  `get_recent_orders_with_details`, `main LLM · turn 2`, `gap`.
- Turn 2 tool evidence:
  `shopify-api.get_recent_orders_with_details`, `524 ms`.
- Turn 2 flow-log evidence:
  `flow:mcp.request` and `flow:mcp.response` for
  `serverName=shopify-api`, `toolName=get_recent_orders_with_details`.
- Turn 3 latency sections:
  `queue`, `main LLM · turn 1`, `gap`, `search_products`,
  `main LLM · turn 2`, `gap`.
- Turn 3 tool evidence:
  `shopify-api.search_products`, `810 ms`.
- Turn 3 flow-log evidence:
  `flow:mcp.request` and `flow:mcp.response` for
  `serverName=shopify-api`, `toolName=search_products`.
- Turn 4 latency sections:
  `queue`, `main LLM · turn 1`, `gap`.
- `assistant startup` check: all four outbound latency reports had no
  `startup` section.
- Customer-context check: final reply remembered the seeded Diwali team-gifting
  context and the later 18-box, ₹1,500, Kaju Katli/chocolate gift-box plan from
  the same conversation. No other customer's context appeared.

Post-run worker and dashboard evidence:

- During the run, the bound worker count temporarily rose while the conversation
  was retained for follow-ups, and replacement generic workers started as
  expected.
- Post-idle core control API and admin `/api/runtime/workers` both showed:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `boundIdle=0`, `boundDraining=0`, `availableTarget=3`,
  `maxBoundWorkers=3`, cache prewarm `pending=0`, `succeeded=0`,
  `skipped=3`, `failed=0`.

Admin-dev note:

- While collecting evidence, the sibling `boondi-admin` Next dev server briefly
  served a generated `.next` missing-route fallback. Clearing the generated
  `.next` cache and restarting the admin dev server restored the admin API long
  enough to capture `/api/messages`, `/api/conversations`, and
  `/api/runtime/workers` evidence.
- A separate Codex session is now responsible for admin UI work; this phase did
  not require any further `boondi-admin` source edits.

## Required Live Evidence Per Scenario

For each scenario turn, capture:

- scenario id
- runtime config used
- number of core processes
- synthetic customer phone/conversation id
- inbound provider message id
- persisted inbound message id
- inbound request id or provider message id
- admin transcript before and after
- outbound provider message id, when available
- outbound message id
- `replySeconds`
- latency report sections
- runtime workers snapshot before, during, and after
- relevant runner run handle or worker id when available
- owning runtime instance id, when available
- stale runtime rows, if any
- pass/fail result

Minimum API/admin checks:

- conversation list shows the customer conversation
- message API shows the inbound customer message
- message API shows the outbound Boondi reply
- runtime workers API shows queue and warm-pool state
- latency trace API shows the outbound trace

Actual inbound means a signed Interakt-compatible webhook into the Gantry core
HTTP ingress path. Direct DB inserts, admin-panel message creation, or direct
calls into internal processing functions do not satisfy live-flow acceptance.

## Latency Report Contract

The latency report must be useful for debugging customer-side latency and
routing. It should show identifiers first, then timing sections.

Required identifiers:

- conversation id
- customer phone/JID
- inbound provider message id
- persisted inbound message id
- outbound provider message id, when available
- persisted outbound message id
- runtime instance id that processed the reply
- runner run handle
- worker id, when a warm worker was used
- provider session id as a redacted value or stable fingerprint, never raw
- trace id or latency record id

Required timing sections:

- inbound webhook receipt
- inbound validation and dedupe
- inbound persistence
- route resolution
- owner/claim acquisition in multi-core mode
- queue wait
- continuation delivery or worker acquisition
- warm bind, when a warm worker is used
- Gantry cache prewarm, only when it is customer-visible or relevant to the run
- runner startup
- guardrail/safety check
- main LLM turns
- provider prompt-cache read/write during each LLM call
- MCP/tool calls
- outbound persistence
- provider send
- post-reply cleanup/release, when it delays the next customer message
- unexplained gap, only as a residual section with enough neighboring ids to
  diagnose it

Wording requirements:

- Do not label provider prompt-cache read/write as Gantry prewarm.
- Do not show a large `gap` without adjacent stage timestamps and ids.
- If a reply was blocked behind a previous runner, show the previous run handle
  or worker id when available.
- If the customer message was queued because all eligible workers were busy,
  show that as queue wait, not as LLM time.
- If a cold resumed one-shot runner answers and exits, the report should make
  that path clear.
- If a retained warm runner handles a follow-up, the report should make that
  path clear.

## Stop Conditions

Stop the scenario run and diagnose before continuing if any of these happen:

- inbound message is persisted but no reply appears
- reply appears after an unexpected long timeout
- normal first reply exceeds 45 seconds unless the scenario is intentionally
  testing failure behavior
- normal retained-runner follow-up exceeds 30 seconds unless the scenario is
  intentionally testing failure behavior
- any reply waits for runner cleanup timeout before the next inbound can move
- `activeMessageRuns` remains non-zero after the reply is visible
- `pendingConversationKeys` remains non-zero after the reply is visible
- dashboard healthy totals disagree with runtime API
- stale runtime workers are counted as usable healthy capacity
- a customer receives another customer's context
- duplicate outbound replies are sent for one inbound
- a same-customer follow-up starts a second simultaneous runner for the same
  conversation
- a duplicate provider message id produces more than one outbound reply

## Phase Boundaries

Before starting each phase:

1. Use fresh synthetic phone numbers, or explicitly reset the conversation and
   verify the reset completed.
2. Confirm `activeMessageRuns = 0`.
3. Confirm `pendingConversationKeys = 0`.
4. Confirm stale runtime rows are not counted in healthy totals.
5. Save a baseline runtime workers snapshot.

After each phase:

1. Confirm every inbound has either exactly one outbound reply or a documented
   expected failure.
2. Confirm there are no stuck active or pending conversations.
3. Save admin/API evidence for each scenario.
4. Do not continue to the next phase while a routing, queue, or dashboard
   inconsistency remains unexplained.

## Evidence Log

### Phase 0 Baseline - 2026-06-18 IST

Config:

- `/Users/caw-d/gantry/settings.yaml`
- `runtime.queue.max_message_runs: 3`
- `runtime.runner.idle_timeout_ms: 200000`
- `runtime.warm_pool.enabled: true`
- `runtime.warm_pool.size: 3`
- `runtime.warm_pool.max_bound_workers: 3`
- `runtime.warm_pool.cache_prewarm_enabled: false`
- `runtime.warm_pool.cache_prewarm_concurrency: 1`

Process and service evidence:

- Gantry core is running from this checkout on `127.0.0.1:4710`.
- Shopify MCP is running from this checkout on `127.0.0.1:8081` and returns `{"ok":true}` from `/healthz`.
- CRM MCP is running from this checkout on `127.0.0.1:8082` and returns `{"ok":true}` from `/healthz`.
- Boondi admin is running on `localhost:3000`.
- Live core process env contains `GANTRY_FLOW_LOG=1`, `GANTRY_OUTBOUND_DRYRUN=1`, `GANTRY_DEV_LOG=/tmp/gantry-capture.log`, and `GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633`.

Runtime inventory evidence from `GET http://127.0.0.1:3000/api/runtime/workers`:

- total runtime rows: 52
- healthy runtime rows: 1
- stale runtime rows: 51
- healthy instance: `runtime:13993`
- healthy queue: `activeMessageRuns: 0`, `pendingConversationKeys: 0`, `maxMessageRuns: 3`
- healthy warm pool: `genericAvailable: 3`, `genericStarting: 0`, `boundActive: 0`, `availableTarget: 3`, `maxBoundWorkers: 3`
- cache prewarm summary: `pending: 0`, `succeeded: 0`, `skipped: 3`, `failed: 0`

Admin/API evidence:

- `GET http://127.0.0.1:3000/api/conversations` returns 112 conversations.
- Admin Runtime page renders the expected counters, warm-pool grid, cache shape, and runtime instance table.
- Admin Conversations page renders the conversation list and latency badges.
- Existing latency trace found for `conversation:wa:000674571130`, outbound message `message:wa:000674571130:outbound:b5a36fe3-d6c3-4122-92e3-b9f305ac00c8`, with `replySeconds: 8.078`, `totalMs: 8073`, and seven trace stages.
- `GET http://127.0.0.1:3000/api/trace?messageId=does-not-exist` returns `200` with `{"payloads":null}`, proving the trace endpoint is reachable.

Phase 0 result:

- Passed. The harness is usable for Phase 1 live inbound traffic.

## Phase 0: Harness And Baseline

Purpose: make later failures diagnosable instead of ambiguous.

Steps:

1. Start with one core process, Shopify MCP, CRM MCP, and the admin panel.
2. Confirm the admin panel loads conversations, runtime, and latency report.
3. Confirm the runtime API is reachable.
4. Record current config values:
   - `runtime.warm_pool.enabled`
   - `runtime.warm_pool.size`
   - `runtime.warm_pool.idle_timeout_ms`
   - `runtime.warm_pool.max_bound_workers`
   - `runtime.warm_pool.cache_prewarm_enabled`
   - `runtime.warm_pool.cache_prewarm_concurrency`
5. Confirm there is exactly one healthy core.
6. Confirm stale rows, if present, are marked stale and excluded from healthy
   totals.
7. Confirm generic workers reach the expected steady state.

Acceptance:

- admin panel is usable
- runtime API is usable
- one healthy core is visible
- healthy totals are internally consistent
- baseline snapshot is saved before traffic starts

## Phase 1: Single Customer, Single Core, Cache Prewarm Off

Config:

```yaml
cache_prewarm_enabled: false
size: 3
idle_timeout_ms: 30000
```

### Scenario 1.1: First Customer Message Uses A Warm Runner

Steps:

1. Create Customer A with a unique synthetic phone number.
2. Send one actual inbound customer request.
3. Watch admin panel/API until inbound appears.
4. Watch admin panel/API until outbound appears.
5. Capture runtime workers before, during, and after.
6. Open the latency report for the outbound reply.

Expected:

- Customer A receives exactly one reply.
- A generic warm runner is consumed/bound for the conversation path.
- No cache-prewarm model-call stage is charged to the customer flow because
  cache prewarm is disabled.
- Provider prompt-cache read/write chips may appear, but they must be labeled
  as provider prompt-cache usage during that LLM call, not Gantry prewarm.
- `activeMessageRuns` returns to `0`.
- `pendingConversationKeys` returns to `0`.

Acceptance:

- pass only if the actual admin transcript shows inbound and outbound
- pass only if runtime API confirms no stuck active/pending conversation
- fail if only unit tests pass but the live admin transcript does not

### Scenario 1.2: Same Customer Follow-Up Before Idle Timeout

Steps:

1. Use the same Customer A.
2. Send a follow-up within `idle_timeout_ms`.
3. Confirm the inbound and outbound in admin/API.
4. Capture runtime workers before, during, and after.
5. Compare run handle, worker id, or latency sections with Scenario 1.1 when
   available.

Expected:

- Customer A receives exactly one follow-up reply.
- The follow-up routes to the existing live conversation-bound runner when that
  runner is still retained.
- It must not route through another customer's runner.
- It must not remain pending behind a dead or cold one-shot process.
- The transcript must preserve Customer A's own context.

Acceptance:

- pass only if the live transcript shows the follow-up reply
- pass only if dashboard/API shows no stuck active/pending after the reply
- fail if the reply appears only after a long cleanup timeout

### Scenario 1.3: Same Customer After Idle Timeout

Steps:

1. Wait longer than `idle_timeout_ms` after Customer A's last reply.
2. Confirm the old bound runner is released or no longer active.
3. Send another Customer A inbound message.
4. Confirm inbound and outbound in admin/API.
5. Capture runtime workers and latency trace.

Expected:

- Customer A receives exactly one reply.
- The old live bound worker is gone.
- A new warm runner or a valid cold-resume path handles the message.
- The customer does not see an error or reset caused by worker expiry.
- Persisted provider-session resume behavior is visible if expected.

Acceptance:

- pass only if live flow works after idle expiry
- pass only if no stale bound worker remains counted as active

### Scenario 1.4: Same-Customer Continuity Marker

Steps:

1. Customer A sends: `For this chat, remember marker ALPHA-123.`
2. Confirm Customer A receives a reply.
3. Customer A sends: `What marker did I just give you?`
4. Confirm Customer A receives a reply containing `ALPHA-123`.
5. Capture latency report and runtime workers for both replies.

Expected:

- Same-customer follow-up has access to the correct prior conversation context.
- The marker is not stored or surfaced in any other customer transcript.
- The follow-up does not hang behind stale runner state.

Acceptance:

- pass only if live admin/API transcript shows both turns and the marker reply
- fail if continuity only works in synthetic unit tests

## Phase 2: Multiple Customers, Single Core

Purpose: prove isolation before adding more cores.

### Scenario 2.1: Two Customers Sequential

Steps:

1. Customer A sends first message and receives reply.
2. Customer B sends first message and receives reply.
3. Customer A sends follow-up.
4. Customer B sends follow-up.
5. Check both transcripts through admin/API.

Expected:

- A and B each receive the correct number of replies.
- A's transcript never includes B's message or context.
- B's transcript never includes A's message or context.
- Runtime worker counts match the number of active or retained conversations.

Acceptance:

- pass only if both admin transcripts are isolated
- fail on any cross-customer context leak

### Scenario 2.1b: Cross-Customer Continuity Isolation

Steps:

1. Customer A sends: `For this chat, remember marker ALPHA-123.`
2. Customer A confirms the marker with a follow-up.
3. Customer B sends: `What marker did I just give you?`
4. Check both transcripts.

Expected:

- Customer A can recover `ALPHA-123`.
- Customer B must not receive `ALPHA-123`.
- Customer B should get a normal answer indicating there is no such marker in
  its own conversation context.

Acceptance:

- pass only if admin/API transcripts prove no cross-customer marker leak

### Scenario 2.2: Two Customers Concurrent

Steps:

1. Send Customer A and Customer B inbound messages close together.
2. Confirm both inbound messages appear.
3. Confirm both outbound replies appear.
4. Capture runtime worker snapshots during the overlap.

Expected:

- Two conversations can run independently.
- No duplicate outbound replies.
- No wrong-recipient replies.
- Active/pending counts match the real in-flight state.

Acceptance:

- pass only if both live transcripts complete
- fail if one customer blocks indefinitely while capacity is available

### Scenario 2.3: Capacity Edge With Four Customers

Steps:

1. With `size: 3`, send messages from Customers A, B, and C.
2. Send Customer D while the first three are active or retained.
3. Observe whether D waits, cold-spawns, or uses another allowed path.
4. Confirm all four transcripts.

Expected:

- No customer receives another customer's context.
- Customer D behavior is explicit in runtime evidence:
  - queued, or
  - started under allowed message-run capacity, or
  - served by a newly available runner.
- Dashboard/API must explain active and pending counts truthfully.

Acceptance:

- pass only if all four customer flows complete through live admin/API evidence
- fail if D disappears, duplicates, or steals another bound runner

### Scenario 2.4: Provider Redelivery Dedupe

Steps:

1. Send Customer A one signed inbound webhook with provider message id
   `duplicate-test-1`.
2. Send the same signed inbound payload again with the same provider message id.
3. Confirm admin/API transcript and runtime workers.

Expected:

- The duplicate inbound is deduped or marked duplicate.
- Exactly one outbound reply is sent for `duplicate-test-1`.
- No second active run is started for the duplicate.
- `pendingConversationKeys` returns to `0`.

Acceptance:

- pass only if live admin/API evidence shows one customer-visible reply
- fail if duplicate provider delivery creates duplicate outbound replies

## Phase 3: Cache Prewarm On

Config:

```yaml
cache_prewarm_enabled: true
cache_prewarm_concurrency: 1
size: 3
idle_timeout_ms: 30000
```

### Scenario 3.1: Prewarm Completes Before Traffic

Steps:

1. Restart runtime with cache prewarm enabled.
2. Do not send customer traffic immediately.
3. Observe runtime workers and cache-prewarm status until steady.
4. Send Customer A inbound message.
5. Confirm inbound, outbound, and latency trace.

Expected:

- Cache prewarm occurs before customer traffic when possible by using a
  throwaway synthetic runner, not a customer-bound runner.
- The throwaway query runs as an ephemeral provider-cache runner with
  `GANTRY_PROVIDER_CACHE_PREWARM=1` and `warmGenericBoot: false`; it must not
  enter the warm-generic `startup()` and bind-wait path.
- With concurrency `1`, prewarm work runs one model call at a time per active
  cache shape.
- For `size: 3` and one Boondi shape, exactly one provider-cache synthetic
  query should run for that shape; all three warm workers should report the
  shared successful prewarm status.
- After the default 45 minute cache TTL, the active shape is refreshed with one
  more throwaway synthetic query. This refresh is not repeated once per warm
  worker.
- The prewarm synthetic runner must report provider usage evidence:
  `cacheWriteTokens > 0` or `cacheReadTokens > 0`.
- First customer call for the same `cacheShapeKey` should report provider
  cache read evidence.
- First customer reply does not include cache-prewarm wait as customer-side
  latency if prewarm already completed.
- Dashboard shows prewarm status accurately.

Acceptance:

- pass only if live customer reply works and cache-prewarm status is visible
- pass only if the synthetic prewarm session id is not reused as the customer
  session id
- fail if prewarm status is misleading or counted as active customer work after
  it completed before traffic

### Scenario 3.1.1: Provider Cache Transfers Across Fresh Sessions

Steps:

1. Create one unique large system prompt/cache shape.
2. Start a throwaway Agent SDK runner with that shape.
3. Send a tiny synthetic query and wait for usage evidence.
4. Destroy the throwaway runner/session.
5. Start four fresh independent Agent SDK sessions with the same shape.
6. Optionally start a fifth fresh session after roughly 60 seconds.

Expected:

- The throwaway synthetic query writes or reads provider cache.
- Each fresh session reads the provider cache despite using a different SDK
  session.
- No fresh session depends on the throwaway session id.

Acceptance:

- pass if the throwaway query has provider cache usage evidence and the four
  fresh sessions show high `cache_read_input_tokens`
- fail if cache reads only happen inside the original throwaway session

### Scenario 3.2: Customer Arrives While Prewarm Is In Progress

Steps:

1. Restart runtime with cache prewarm enabled.
2. Send Customer A inbound message before prewarm finishes.
3. Capture runtime workers and latency trace.
4. Confirm outbound reply.

Expected:

- Customer receives a reply.
- Runtime behavior is explicit:
  - customer waits for a ready worker, or
  - customer uses an available non-prewarmed worker, or
  - customer uses a valid fallback.
- Latency report shows any customer-visible wait clearly.
- No hang.

Acceptance:

- pass only if the actual live transcript completes
- fail if prewarm blocks customer traffic without dashboard/trace evidence

## Phase 3.5: MCP Smoke

Purpose: prove basic MCP availability and trace visibility without judging
product answer quality.

### Scenario 3.5.1: CRM And Shopify MCP Readiness

Steps:

1. Confirm CRM MCP process is running and reachable.
2. Confirm Shopify MCP process is running and reachable.
3. Confirm the runtime worker shape includes both MCP sources where expected.
4. Send a live customer request that should require a simple MCP-backed lookup.
5. Confirm inbound, outbound, and latency trace through admin/API.

Expected:

- Customer receives exactly one reply.
- Latency report includes the MCP/tool call section when a tool was used.
- MCP call result is isolated to that customer conversation.
- Runtime does not hang if one MCP call is slow but eventually returns.

Acceptance:

- pass only if live transcript completes and trace shows MCP/tool evidence
- fail if MCP availability is assumed only from process existence

## Phase 4: Follow-Up Routing Stress

Purpose: reproduce the class of bug where a reply is visible but later routing
stops working.

### Scenario 4.1: Rapid Follow-Ups After First Reply

Steps:

1. Customer A sends first message.
2. After the outbound appears, send two follow-ups quickly.
3. Confirm all inbound and outbound messages in admin/API.
4. Capture runtime workers throughout.

Expected:

- Follow-ups preserve order.
- Same customer routes to the same retained bound runner if within idle
  timeout.
- No follow-up remains pending after the prior reply is already visible.
- No long timeout is required to unlock the queue.

Acceptance:

- pass only if all live replies appear without abnormal delay
- fail if a cold resumed process stays active after visible reply and blocks
  the next inbound

### Scenario 4.2: Follow-Up While Runner Is Active

Steps:

1. Send Customer A a request likely to keep the runner active long enough to
   overlap.
2. Before the first reply completes, send a follow-up.
3. Confirm transcript and runtime queue state.

Expected:

- The same conversation has at most one active runner.
- The follow-up is piped into the live runner or queued for the same
  conversation.
- It must not start a second active runner for Customer A.
- It must not be delivered to another customer.

Acceptance:

- pass only if live transcript and runtime state prove same-conversation
  ordering

### Scenario 4.3: Cold Resume Does Not Become A Fake Bound Worker

Steps:

1. Force or observe a cold resumed path for Customer A.
2. Confirm the outbound reply appears.
3. Send another follow-up shortly after.
4. Capture runtime API immediately after the first outbound and after the
   follow-up.

Expected:

- A cold resumed runner may answer one turn.
- It must not remain open as a fake retained follow-up worker unless the queue
  can route to it reliably.
- The next follow-up must be processed by a real retained worker or a new valid
  run.

Acceptance:

- pass only if no reply waits for process timeout cleanup
- fail if `activeMessageRuns` remains non-zero after the outbound reply and the
  next inbound sits pending

### Scenario 4.4: Five-Turn Same-Customer Loop

Steps:

1. Customer A sends five normal chat messages in sequence.
2. Mix immediate follow-ups and short waits between turns.
3. Confirm each inbound and outbound in admin/API.
4. Capture runtime workers after every reply.

Expected:

- Exactly five outbound replies for five inbound messages.
- No turn waits for stale-runner cleanup.
- No `activeMessageRuns` or `pendingConversationKeys` remains stuck after any
  reply.
- The customer experience remains normal across repeated follow-ups.

Acceptance:

- pass only if all five live turns complete cleanly
- fail if the system works for early replies and then stops routing later

## Phase 4 Evidence Log

Status: in progress on 2026-06-18 IST.

### Scenario 4.1 Evidence: Rapid Follow-Ups After First Reply

Status: passed.

- Customer: `conversation:wa:000960000401`.
- Scenario marker: `RAPID-401`.
- Live inbound provider message ids:
  `phase4-1-1781745620074-1`, `phase4-1-1781745633415-2`, and
  `phase4-1-1781745633418-3`.
- The second and third inbound messages were sent three milliseconds apart after
  the first outbound appeared.
- Persisted transcript evidence:
  three live inbound messages and three live outbound replies.
- Persisted outbound message ids:
  `message:wa:000960000401:outbound:a275d423-59e3-4383-a11e-18e79d817445`
  (`totalMs=12380`),
  `message:wa:000960000401:outbound:6f8fe82d-5490-4af3-adf0-08c0f811d3bf`
  (`totalMs=11144`), and
  `message:wa:000960000401:outbound:ec6870a0-bdb0-4fd7-9059-131dcd57c6ef`
  (`totalMs=21929`).
- Trace sections:
  - First reply:
    `queue`, `main LLM · turn 1`, `gap`, `get_open_records`,
    `main LLM · turn 2`, `gap`.
  - Second reply:
    `queue`, `main LLM · turn 1`, `gap`, `search_products`,
    `main LLM · turn 2`, `gap`.
  - Third reply:
    `queue`, `main LLM · turn 1`, `memory_save`,
    `main LLM · turn 2`, `gap`.
- Rapid-follow-up behavior:
  the third inbound queued behind the second reply for `11122 ms` and then
  completed normally; it did not start a duplicate same-customer active runner
  or remain pending after the prior visible reply.
- `assistant startup` check:
  all three current latency traces had no `startup` section.
- Post-run worker evidence from the authenticated runtime workers API:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `availableTarget=3`.
- Admin evidence:
  the admin API on `127.0.0.1:3000` was not running during this capture because
  a separate Codex session owns admin UI work. This scenario used direct
  Postgres transcript/trace evidence plus authenticated core runtime API
  evidence instead of starting or restarting the admin app.

### Scenario 4.2 Evidence: Follow-Up While Runner Is Active

Status: passed after queue lifecycle fix.

Initial failed reproduction:

- Customer: `conversation:wa:000960000402`.
- Result before the fix:
  two live inbound messages and two live outbound replies persisted, but the
  second reply was handled by a second `agent_run` and its latency trace
  included `assistant startup`.
- Root cause:
  while the first run was active, `enqueueMessageCheck` marked
  `pendingMessages=true`. When the pooled worker reached idle, `GroupQueue`
  refused to retain it because pending messages existed, cleared the process,
  then drained the pending message as a cold resumed run.

Code fix:

- `GroupQueue` now retains an idle pooled worker even when pending messages are
  waiting, then drains the same group so the pending batch can call
  `queue.sendMessage(...)` against the retained socket.
- Focused regression:
  `apps/core/test/unit/runtime/group-queue.test.ts` now covers the active-run
  pending-message case.
- Focused verification:
  `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-queue.test.ts`
  passed with 64 tests.

Fixed live rerun:

- Customer: `conversation:wa:000960000403`.
- Scenario marker: `ACTIVE-403`.
- Live inbound provider message ids:
  `phase4-2-fixed-1781746358626-1` and
  `phase4-2-fixed-1781746359644-2`.
- The second inbound was sent one second after the first inbound, before the
  first outbound completed.
- Persisted transcript evidence:
  two live inbound messages and two live outbound replies.
- Persisted outbound message ids:
  `message:wa:000960000403:outbound:b34cf340-57f0-48f5-b9d0-023c82ea61c8`
  (`totalMs=19437`) and
  `message:wa:000960000403:outbound:acdd18d7-2f84-49cb-ba53-f78de8b034f7`
  (`totalMs=27653`).
- Run evidence:
  exactly one `agent_run` handled both messages:
  `agent-run:b9b608e7-a041-4fcc-9196-68313a202266`,
  provider run `gantry-boondi-support-1781746358803-c7e7c1c8`,
  provider session `737ed4a0-481f-45bd-a713-4f56ff17eb2a`.
- During the overlap window, runtime workers showed
  `activeMessageRuns=1`, `pendingConversationKeys=1`,
  `boundActive=1`, `genericAvailable=2`, `genericStarting=1`.
- Trace sections:
  - First reply:
    `queue`, `guardrail`, `main LLM · turn 1`, `gap`,
    `search_products`, `main LLM · turn 2`, `gap`,
    `search_products`, `main LLM · turn 3`, `gap`.
  - Second reply:
    `queue`, `main LLM · turn 1`, `gap`, `search_products`,
    `main LLM · turn 2`, `gap`, `send`.
- `assistant startup` check:
  both current latency traces had no `startup` section.
- Post-idle worker evidence from the authenticated runtime workers API:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `availableTarget=3`.

### Scenario 4.3 Evidence: Cold Resume Does Not Become A Fake Bound Worker

Status: passed.

- Customer: `conversation:wa:000960000404`.
- Scenario marker: `COLD-404`.
- Live inbound provider message ids:
  `phase4-3-1781746497225-1`, `phase4-3-1781746535296-2`, and
  `phase4-3-1781746550768-3`.
- Flow:
  first inbound received a reply; the test waited past `idle_timeout_ms`; a
  second inbound exercised the cold-resume path; a third inbound immediately
  after the cold-resume reply verified routing did not hang behind a fake bound
  worker.
- Persisted transcript evidence:
  three live inbound messages and three live outbound replies.
- Persisted outbound message ids:
  `message:wa:000960000404:outbound:753fedcb-219a-4db3-a3fa-734bfa5aa53f`
  (`totalMs=2733`),
  `message:wa:000960000404:outbound:feb7c2bf-f646-45d4-83f1-b33249a1a411`
  (`totalMs=13911`), and
  `message:wa:000960000404:outbound:2031cfee-832b-4b36-bd93-cb919019872a`
  (`totalMs=5810`).
- Runtime state after the idle-timeout wait:
  `activeMessageRuns=0`, `pendingConversationKeys=0`, `boundActive=0`,
  `genericAvailable=3`.
- Cold-resume run evidence:
  the second and third replies used the same persisted provider session
  `7cd4dabd-2a80-4000-86f3-e51b694851b5`, but each was a separate one-shot
  `agent_run` after the retained worker had been released.
- Trace evidence:
  the cold-resume replies contained `assistant startup`, which is expected for
  this one-shot resume path. The important routing assertion is that
  `boundActive=0` after the cold-resume reply and the immediate next inbound
  still produced a reply instead of waiting behind an unusable retained worker.
- Post-idle worker evidence from the authenticated runtime workers API:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `availableTarget=3`.

### Scenario 4.4 Evidence: Five-Turn Same-Customer Loop

Status: passed.

- Customer: `conversation:wa:000960000405`.
- Scenario marker: `LOOP-405`.
- Live inbound provider message ids:
  `phase4-4-1781746665943-1`, `phase4-4-1781746669758-2`,
  `phase4-4-1781746683473-3`, `phase4-4-1781746684280-4`, and
  `phase4-4-1781746696108-5`.
- Flow:
  five normal customer messages in one conversation, with a rapid pair between
  turns 3 and 4 and short waits elsewhere.
- Persisted transcript evidence:
  five live inbound messages and five live outbound replies.
- Persisted outbound message ids:
  `message:wa:000960000405:outbound:f1459a48-c29f-468b-a783-186d468182f1`
  (`totalMs=3220`),
  `message:wa:000960000405:outbound:bd24aecd-ebd1-41b4-9243-75be96290485`
  (`totalMs=13532`),
  `message:wa:000960000405:outbound:75117892-5dac-40e9-9d26-2b31ac8c028f`
  (`totalMs=5209`),
  `message:wa:000960000405:outbound:6fc82a29-407e-4f07-afd2-0856788b22a7`
  (`totalMs=9163`), and
  `message:wa:000960000405:outbound:9fa3db62-e4ba-481a-b0d9-51a6dc012dc3`
  (`totalMs=4714`).
- Run evidence:
  exactly one `agent_run` handled all five turns:
  `agent-run:ffb4e558-ed95-421b-b7cd-ea0d26efbc88`,
  provider run `gantry-boondi-support-1781746666097-6afcf4fb`,
  provider session `f2531810-ae30-42bb-97e1-27f1226db018`.
- Trace evidence:
  all five current latency traces had no `startup` section.
- Queue behavior:
  the rapid turn-4 inbound temporarily showed
  `pendingConversationKeys=1` after reply 3 and `activeMessageRuns=1` after
  reply 4 while the retained worker was finishing the queued continuation; both
  cleared without intervention.
- Customer-context check:
  the final reply remembered the plan as 8 birthday gift boxes, around ₹1,500
  each, chocolate direction, and nut-allergy safety constraint.
- Post-idle worker evidence from the authenticated runtime workers API:
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `genericStarting=0`, `boundActive=0`,
  `availableTarget=3`.

## Phase 5: Two Core Processes

Purpose: prove horizontal runtime ownership without duplicate replies or stale
capacity.

### Scenario 5.1: Two-Core Startup Inventory

Steps:

1. Start two core processes.
2. Confirm both appear in runtime workers API.
3. Confirm dashboard shows two healthy instances.
4. Confirm each core's warm pool is visible separately.
5. Confirm aggregate healthy totals equal the sum of healthy instances only.

Expected:

- Two healthy runtime rows.
- Stale rows are marked stale and excluded from healthy totals.
- If each core has `size: 3`, aggregate generic capacity should be six unless
  startup/drain state explains otherwise.

Acceptance:

- pass only if dashboard and runtime API agree
- fail if stale rows inflate usable capacity

### Scenario 5.2: One Customer, Two Cores

Steps:

1. Send Customer A inbound message.
2. Confirm exactly one core claims and processes the conversation.
3. Confirm exactly one outbound reply.
4. Send Customer A follow-up within idle timeout.
5. Confirm routing and reply.

Expected:

- No duplicate outbound.
- No two cores process the same inbound.
- Follow-up reaches the correct owner/live worker or a valid resumed path.
- Dashboard active/pending counts stay correct.

Acceptance:

- pass only if live admin transcript has exactly one reply per inbound
- fail on duplicate replies or stranded pending state

### Scenario 5.3: Multiple Customers Across Two Cores

Steps:

1. Send messages from Customers A through F.
2. Confirm all inbound messages.
3. Confirm all outbound replies.
4. Capture per-core runtime workers while work is in flight.
5. Send follow-ups from a subset of customers.

Expected:

- Work may distribute across cores.
- Each customer remains isolated.
- Same-customer follow-ups route correctly.
- No stale core is treated as healthy capacity.

Acceptance:

- pass only if every live transcript completes with no leaks or duplicates

### Scenario 5.4: Core Restart During Bound Conversation

Steps:

1. Customer A gets a reply and has a bound runner.
2. Restart or kill the owning core.
3. Confirm dashboard marks old runtime stale or removes it from healthy totals.
4. Send Customer A follow-up.
5. Confirm outbound reply.

Expected:

- Dead workers stop counting as healthy.
- Follow-up is claimed by a healthy core.
- Persisted session resume works if needed.
- No duplicate reply from stale owner.

Acceptance:

- pass only if customer flow recovers through live request/admin evidence
- fail if dashboard says dead workers are usable

### Scenario 5.5: Post-Restart Continuity

Steps:

1. Customer A sends a message and receives a reply.
2. Restart the owning core.
3. Customer A sends a natural follow-up.
4. Confirm inbound, outbound, latency report, and runtime workers.

Expected:

- No duplicate outbound from the old owner.
- Healthy core claims the follow-up.
- Persisted provider-session resume works when available.
- Customer does not experience a silent reset unless explicitly expected and
  visible in the trace.

Acceptance:

- pass only if live transcript works after restart
- fail if continuity exists only before restart

## Phase 5 Evidence Log

Status: passed on 2026-06-18 IST.

Runtime setup:

- Stack command: `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime`.
- Core ports: `127.0.0.1:4710` and `127.0.0.1:4711`.
- Runtime instances in the first two-core stack:
  `runtime:75320` on port `4710`, `runtime:76375` on port `4711`.
- Runtime instances in the post-restart stack:
  `runtime:97344` and `runtime:97799`.
- MCPs: `shopify-api` healthy on `127.0.0.1:8081`; `boondi-crm` healthy on
  `127.0.0.1:8082`.
- Outbound: `GANTRY_OUTBOUND_DRYRUN=1`.
- Admin UI/API was intentionally not used because a separate Codex session owns
  admin UI work. Evidence for this phase came from signed Interakt-compatible
  webhooks, the authenticated core `/v1/runtime/workers` API, Postgres
  transcripts, message traces, owner leases, agent runs, and core logs.

Scenario 5.1: two-core startup inventory.

- Both control APIs returned the same healthy aggregate view.
- Healthy runtime instances: `2`.
- Healthy warm-pool totals: `genericAvailable=6`, `genericStarting=0`,
  `boundActive=0`, `boundIdle=0`, `boundDraining=0`, `availableTarget=6`,
  `maxBoundWorkers=6`.
- Healthy queue totals: `activeMessageRuns=0`,
  `pendingConversationKeys=0`, `maxMessageRuns=6`.
- Cache prewarm totals: `pending=0`, `succeeded=0`, `skipped=6`,
  `failed=0`.
- Historical runtime rows were present but marked `stale` and excluded from
  healthy totals.

Scenario 5.2: one customer, two cores, alternating ingress ports.

- Customer: `conversation:wa:000960000501`.
- Inbound provider ids:
  `phase5-2-1781747238628-1`,
  `phase5-2-1781747253054-2`,
  `phase5-2-1781747258015-3`, and
  `phase5-2-1781747270350-4`.
- Ingress ports by turn: `4710`, `4711`, `4710`, `4711`.
- Transcript counts: `4` inbound and `4` outbound.
- Persisted outbound ids:
  `message:wa:000960000501:outbound:7c388d07-6927-4573-b149-c5c0a6994b78`
  (`13.442 s`),
  `message:wa:000960000501:outbound:1089cda1-5a02-4b52-af8c-196fdce27f95`
  (`4.600 s`),
  `message:wa:000960000501:outbound:fe791d1c-71a1-49ad-82a9-83ed25013405`
  (`11.679 s`), and
  `message:wa:000960000501:outbound:0775d291-a4c6-40e7-ab14-79a6a7b1e29e`
  (`3.428 s`).
- Owner lease stayed on `runtime:75320` even when ingress arrived on port
  `4711`.
- Exactly one `agent_run` was created:
  `agent-run:1f4c9135-3392-4b0e-b528-a7641baa66d5`.
- Provider session id stayed stable:
  `eb8f8bc9-2e32-4876-a486-3892cd8265d4`.
- All four latency traces had no `startup` section.
- Final worker totals from both core APIs: healthy instances `2`,
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=6`, `boundActive=0`.

Scenario 5.3: six customers across two cores, focused follow-up subset.

- Customers:
  `conversation:wa:000960000531`,
  `conversation:wa:000960000532`,
  `conversation:wa:000960000533`,
  `conversation:wa:000960000534`,
  `conversation:wa:000960000535`, and
  `conversation:wa:000960000536`.
- Initial six-customer fanout used alternating ingress ports and all six
  customers received exactly one outbound reply.
- At the five-second overlap snapshot, owner leases were split across both
  cores: `000960000531`, `000960000533`, and `000960000535` on
  `runtime:75320`; `000960000532`, `000960000534`, and `000960000536` on
  `runtime:76375`.
- The same overlap showed active work on both cores:
  `runtime:75320 activeMessageRuns=2`, `runtime:76375 activeMessageRuns=1`,
  aggregate `pendingConversationKeys=0`.
- Follow-up subset:
  `conversation:wa:000960000531` and `conversation:wa:000960000536` each
  completed a natural 4-turn path.
- Final transcript counts:
  - `000960000531`: `4` inbound, `4` outbound.
  - `000960000536`: `4` inbound, `4` outbound.
  - `000960000532`, `000960000533`, `000960000534`, `000960000535`: `1`
    inbound and `1` outbound each.
- All 12 outbound latency traces had no `startup` section.
- Final worker totals from both core APIs: healthy instances `2`,
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=6`, `boundActive=0`.

Scenario 5.4: owning core killed during a bound conversation.

- Customer: `conversation:wa:000960000541`.
- First turn owner: `runtime:75320`.
- Killed owner process: `runtime:75320` / PID `75320`.
- Inbound provider ids:
  `phase5-4-1781747509062-1`,
  `phase5-4-1781747530153-2`,
  `phase5-4-1781747541209-3`, and
  `phase5-4-1781747549254-4`.
- Transcript counts after recovery: `4` inbound and `4` outbound.
- Persisted outbound ids:
  `message:wa:000960000541:outbound:be0e66e7-d258-45df-8b48-11426e5c097f`
  (`8.331 s`),
  `message:wa:000960000541:outbound:41591ef2-98ed-471f-bba2-c5d6477902cf`
  (`10.404 s`),
  `message:wa:000960000541:outbound:6b2de0bf-bf91-4527-823c-7912ea9059c0`
  (`7.338 s`), and
  `message:wa:000960000541:outbound:7d84d7c9-3f58-482d-9d74-c5732e3278db`
  (`6.363 s`).
- The surviving core `runtime:76375` claimed the conversation and answered all
  post-kill follow-ups.
- Provider session id stayed stable across the owner kill:
  `4e27dfef-3542-4c08-adc6-078dbfcf9d37`.
- Post-kill replies contained `assistant startup`, which is expected because
  the live retained worker died and the surviving core used persisted
  provider-session resume.
- Final worker totals from the surviving API: healthy instances `1`,
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=3`, `boundActive=0`.
- The killed runtime row remained visible as `stale` and did not inflate
  healthy totals.

Scenario 5.5: full stack restart and post-restart continuity.

- Customer: `conversation:wa:000960000551`.
- Pre-restart owner: `runtime:94295`.
- First inbound id:
  `phase5-5-before-restart-1781747750772-1`.
- First outbound id:
  `message:wa:000960000551:outbound:53ce7925-d194-49ab-a556-8903d6d83cbc`
  (`8.675 s`), with no `startup` section.
- The two-core stack was stopped and restarted before follow-ups.
- Post-restart healthy instances: `runtime:97344` and `runtime:97799`.
- Post-restart inbound provider ids:
  `phase5-5-after-restart-1781747900600-2`,
  `phase5-5-after-restart-1781747914713-3`, and
  `phase5-5-after-restart-1781747930822-4`.
- Final transcript counts: `4` inbound and `4` outbound.
- Post-restart outbound ids:
  `message:wa:000960000551:outbound:466dfdbf-519c-47cb-b535-aa289489c7f9`
  (`13.374 s`),
  `message:wa:000960000551:outbound:02eb5fe4-6aae-48f1-86cc-9818f25ec7a3`
  (`15.387 s`), and
  `message:wa:000960000551:outbound:81d727b9-6337-4b24-ba9c-dac3c5363548`
  (`16.509 s`).
- New owner after restart: `runtime:97799`.
- Provider session id stayed stable across full stack restart:
  `24f66284-d8f5-4656-8e9a-31d3d3aac994`.
- Post-restart replies contained `assistant startup`, expected for cold
  resumed one-shot runs after all live worker processes were restarted.
- Old owner `runtime:94295` was visible as `stale` and excluded from healthy
  totals.
- Final worker totals from both core APIs: healthy instances `2`,
  `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=6`, `boundActive=0`.

## Phase 6: Dashboard Truth

Purpose: make the operator panel trustworthy during all prior phases.

For every scenario, compare dashboard with runtime API for:

- healthy runtime instance count
- stale runtime rows
- generic available
- generic starting
- bound active
- available target
- active message runs
- pending conversations
- cache prewarm pending/succeeded/skipped/failed
- cache shape worker counts

Expected dashboard language:

- `Generic available`: generic warm workers ready to bind to new conversations.
- `Generic starting`: generic workers being started.
- `Bound active`: workers currently bound to conversations.
- `Available target`: desired generic ready count.
- `Active message runs`: conversations currently being processed.
- `Pending conversations`: conversations with queued work not yet processed.

Acceptance:

- dashboard and API agree for healthy totals
- stale rows are clearly stale
- metrics that cannot be populated reliably are removed or hidden
- `Bound active` stays because it is useful and means "worker bound to a
  conversation"

### Phase 6 Evidence Log

Status: passed on 2026-06-18 IST for the data/API contract and latency report
wording. Broader admin layout polish is owned by a separate Codex session.

Admin/API evidence:

- `GET http://localhost:3000/api/conversations` returned `200` with
  `191` conversations.
- `GET http://localhost:3000/api/runtime/workers` returned `200` and matched
  the authenticated core workers API after Phase 10.
- Final healthy totals:
  - `instances=2`
  - `availableTarget=6`
  - `genericAvailable=6`
  - `genericStarting=0`
  - `boundActive=0`
  - `boundIdle=0`
  - `boundDraining=0`
  - `maxBoundWorkers=6`
  - `activeMessageRuns=0`
  - `pendingConversationKeys=0`
  - cache prewarm `pending=0`, `succeeded=0`, `skipped=6`, `failed=0`

Latency report UI evidence:

- `boondi-admin/components/LatencyReport.tsx` no longer rewrites `startup`
  stages into a fake `gap` stage labeled `runtime wait`.
- Startup now renders as `Assistant startup`.
- LLM timing chips now use explicit `provider wait` and `generation` labels.
- `boondi-admin/e2e/latency-report.spec.ts` asserts that `runtime wait` is
  absent, `assistant startup` is visible, and the provider/generation timing
  chips are visible.
- Verification command:
  `npm run test:e2e -- e2e/latency-report.spec.ts` in
  `/Users/caw-d/Desktop/boondi-admin` passed with `2` tests.

## Phase 7: Failure Recovery

### Scenario 7.1: Kill Bound Runner

Steps:

1. Customer A gets a reply and has a bound runner.
2. Kill that runner process.
3. Send Customer A follow-up.
4. Confirm admin/API transcript and runtime state.

Expected:

- Runtime releases stale bound state.
- Follow-up is retried or assigned a valid new runner.
- No permanent pending state.

Acceptance:

- pass only if live follow-up gets a reply

### Scenario 7.2: MCP Temporarily Down

Steps:

1. Stop one required MCP.
2. Send Customer A inbound message.
3. Confirm admin/API result and runtime state.
4. Restart MCP.
5. Send another inbound message.

Expected:

- Runtime fails clearly or retries according to policy.
- Dashboard does not report the worker as fully healthy if it is blocked on a
  required MCP.
- After MCP restart, normal routing resumes.

Acceptance:

- pass only if failure and recovery are visible through live admin/API evidence

### Scenario 7.3: Ungraceful Core Death

Steps:

1. Start one or two cores.
2. Kill one core ungracefully.
3. Confirm runtime API/dashboard stale handling.
4. Send customer traffic.

Expected:

- Stale core becomes stale.
- Stale workers do not count as usable capacity.
- Healthy core handles traffic.

Acceptance:

- pass only if live traffic works and dashboard excludes stale capacity

### Phase 7 Evidence Log

Run context:

- Stack command: `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime`.
- Healthy cores before failure scenarios: `runtime:97344` on port `4710` and
  `runtime:97799` on port `4711`.
- Admin UI/API intentionally not used because another Codex session owns admin
  panel UI changes.

Scenario 7.1 - bound runner killed:

- Customer: `conversation:wa:000960000701`.
- First reply owner: `runtime:97344`.
- Killed runner child processes under the owner: `3408`, `3409`, `3410`, and
  `4076`.
- Inbound ids:
  `phase7-1-1781748230450-1`,
  `phase7-1-1781748246190-2`,
  `phase7-1-1781748258316-3`, and
  `phase7-1-1781748264434-4`.
- Persisted transcript: 4 inbound and 4 outbound messages.
- Outbound ids:
  `message:wa:000960000701:outbound:d23f39bb-7975-4bb4-85a9-c98f685af240`,
  `message:wa:000960000701:outbound:4cd05336-c727-4670-970d-83c1414550d5`,
  `message:wa:000960000701:outbound:95120bcc-1d01-4497-a539-dc1029fd0c70`,
  and
  `message:wa:000960000701:outbound:67481106-2438-4d5d-a8cb-765b9b6a1e29`.
- Provider session stayed stable:
  `d419bcd9-93ec-4a1a-8a71-031c5cf5b7be`.
- Runtime recovered from the killed runner; final workers API showed healthy
  instances `2`, `activeMessageRuns=0`, `pendingConversationKeys=0`,
  `genericAvailable=6`, and `boundActive=0`.

Scenario 7.2 - MCP temporarily down:

- Clean acceptance rerun customer: `conversation:wa:000960000722`.
- Shopify MCP was stopped and `http://127.0.0.1:8081/healthz` failed before
  the first turn.
- Outage inbound:
  `phase7-2-clean-down-1781748942221-1`.
- Outage result:
  `message:wa:000960000722:outbound:43537f37-8981-4ad0-b2b5-bc4d9c882794`
  with visible fallback text: `I'm having a small hiccup with that right now`.
- Flow log showed `MCP tool call failed`, `serverName=shopify-api`,
  `toolName=search_products`, and `err.message=fetch failed`.
- Shopify MCP was restarted in a persistent process and `/healthz` returned
  `{"ok":true}` before the recovery turn.
- Recovery inbound:
  `phase7-2-clean-up-1781749007329-2`.
- Recovery result:
  `message:wa:000960000722:outbound:c2d2e478-c7d3-4a22-9b4c-dc74fa565de1`
  with normal product reply for `Ultimate Sweet Shop Hamper`.
- Flow log showed `flow:mcp.request` and `flow:mcp.response` for
  `shopify-api.search_products`.
- Persisted transcript was exactly 2 inbound and 2 outbound messages.
- Both agent runs completed with stable provider session
  `47a74ad3-aec9-412e-8afc-473db1bf3a59` and `error_summary=null`.
- Final workers API showed `activeMessageRuns=0`,
  `pendingConversationKeys=0`, and `genericAvailable=6`.

Scenario 7.3 - ungraceful core death:

- Killed core: `runtime:97799` / port `4711` with `SIGKILL`.
- Port `4711` returned no response while survivor port `4710` remained up.
- After heartbeat expiry, workers API reported `runtime:97799` as `stale` and
  healthy totals dropped to one instance:
  `instances=1`, `genericAvailable=3`, `maxMessageRuns=3`,
  `activeMessageRuns=0`, and `pendingConversationKeys=0`.
- Survivor runtime: `runtime:97344`.
- Survivor traffic customer: `conversation:wa:000960000731`.
- Inbound ids:
  `phase7-3-corekill-1781749177537-1`,
  `phase7-3-corekill-1781749193808-2`,
  `phase7-3-corekill-1781749208558-3`, and
  `phase7-3-corekill-1781749218804-4`.
- Persisted transcript: 4 inbound and 4 outbound messages.
- Final reply remembered marker `COREKILL-731`, including 8 gift boxes, Pune,
  next Friday, budget around `1500`, Kaju Katli interest, and the last-order
  context.
- Final workers API still excluded the killed core from healthy capacity:
  `runtime:97344` healthy, `runtime:97799` stale, `instances=1`,
  `genericAvailable=3`, `boundActive=1`, `activeMessageRuns=0`, and
  `pendingConversationKeys=0`.

## Phase 8: Repeated-Flow Soak

Purpose: catch failures that appear only after a few replies.

Steps:

1. Use five unique synthetic customers.
2. Send five turns per customer.
3. Mix:
   - immediate follow-ups
   - follow-ups during active processing
   - waits shorter than `idle_timeout_ms`
   - waits longer than `idle_timeout_ms`
4. Run the flow for at least 10 minutes.
5. Keep polling admin/API and runtime workers during the run.
6. At the end, verify every inbound has exactly one expected outbound or a
   documented expected failure.

Expected:

- No lost replies.
- No duplicate replies.
- No cross-customer context leaks.
- No permanent pending conversations.
- No stale runtime capacity counted as healthy.
- Dashboard remains in sync for the entire run.

Acceptance:

- pass only if all live transcripts complete through admin/API evidence
- fail if the platform works for a few replies and then stops routing correctly

### Phase 8 Evidence Log

Status: passed on 2026-06-18 IST after a cursor-consistency fix and live
rerun. The first live soak exposed a multi-core duplicate-reply bug and was
stopped before completion.

Initial failed soak:

- Stack: fresh two-core dev runtime with healthy cores `runtime:13973` on port
  `4710` and `runtime:14139` on port `4711`.
- Customers: `conversation:wa:000960000801` through
  `conversation:wa:000960000805`.
- Intended schedule: five turns per customer over at least 10 minutes
  (`0s`, `2s`, `70s`, `245s`, and `600s`).
- The run was stopped around `240s`, before turn 4, because turn 3 had already
  produced duplicate replies for `000960000801`, `000960000803`, and
  `000960000805`.
- Failure counts at stop:
  - `000960000801`: `3` inbound, `4` outbound, `3` agent runs.
  - `000960000802`: `3` inbound, `3` outbound, `2` agent runs.
  - `000960000803`: `3` inbound, `4` outbound, `3` agent runs.
  - `000960000804`: `3` inbound, `3` outbound, `2` agent runs.
  - `000960000805`: `3` inbound, `4` outbound, `3` agent runs.
- Log pattern: core `4710` handled turn 3 for `801`, `803`, and `805` around
  `02:26:50-02:26:52`; core `4711` later replayed those same turn-3 inbound
  texts around `02:27:40` without new inbound DB rows.
- DB evidence: `conversation_owner_leases` had all soak conversations owned by
  `runtime:14139` with
  `last_claim_reason='conversation_work_reconciler:expired_owner_lease'`.
  Affected conversations had lease version `2`.
- Root cause: `RuntimeApp.getOrRecoverCursor()` returned a stale
  process-local `lastAgentTimestamp` cursor before consulting durable
  `last_agent_timestamp`. In a two-core run, one core could advance the shared
  cursor while another core kept an older local cursor and later reconciled the
  same inbound as pending work.
- Related write-side risk: `saveState()` wrote the whole local cursor map back
  to the shared `last_agent_timestamp` key, so a stale process could clobber a
  fresher cursor from another core.

Targeted regression added before live rerun:

- `apps/core/test/unit/bootstrap/runtime-app.test.ts` now covers:
  - preferring a fresher durable agent cursor over stale local memory
  - merging durable agent cursors before saving local state
- RED command:
  `npm run test:unit -- apps/core/test/unit/bootstrap/runtime-app.test.ts`
  failed with the stale local cursor returned and durable cursor overwritten.
- GREEN command after the fix:
  `npm run test:unit -- apps/core/test/unit/bootstrap/runtime-app.test.ts`
  passed with `11` tests.

Implementation invariant for the live rerun:

- Before reading a cursor, refresh process-local cursor state from durable
  router state and keep the newest cursor by timestamp/id.
- Before saving cursor state, merge durable and local maps and write the newest
  cursor for each conversation key.

Focused replay probe after the fix:

- Customers: `conversation:wa:000960000821`,
  `conversation:wa:000960000822`, and `conversation:wa:000960000823`.
- Shape: three customers, three turns each, including the same owner-expiry
  reconciler path that produced the duplicate in the failed soak.
- Result after duplicate-settle window: each customer had exactly `3` inbound
  and `3` outbound messages.
- `conversation_owner_leases` still showed
  `last_claim_reason='conversation_work_reconciler:expired_owner_lease'`, so
  the reconciler path was exercised without replaying old inbound work.
- Final workers API: two healthy runtimes, `genericAvailable=6`,
  `boundActive=0`, `activeMessageRuns=0`, and
  `pendingConversationKeys=0`.

Full live soak rerun after the fix:

- Stack: fresh two-core dev runtime with healthy cores `runtime:39369` on port
  `4710` and `runtime:39515` on port `4711`.
- Customers: `conversation:wa:000960000841` through
  `conversation:wa:000960000845`.
- Schedule: five turns per customer over `710s`, with turns at approximately
  `0s`, `2s`, `70s`, `245s`, and `600s`, followed by a `90s`
  duplicate-settle window.
- Final transcript counts:
  - `000960000841`: `5` inbound, `5` outbound.
  - `000960000842`: `5` inbound, `5` outbound.
  - `000960000843`: `5` inbound, `5` outbound.
  - `000960000844`: `5` inbound, `5` outbound.
  - `000960000845`: `5` inbound, `5` outbound.
- Latency traces: `5` `message_traces` rows per customer using trace
  conversation ids `wa:000960000841` through `wa:000960000845`.
- Trace timing ranges:
  - `000960000841`: `3600 ms` to `13616 ms`.
  - `000960000842`: `6883 ms` to `13927 ms`.
  - `000960000843`: `6764 ms` to `14156 ms`.
  - `000960000844`: `5066 ms` to `22119 ms`.
  - `000960000845`: `6338 ms` to `18416 ms`.
- `startup` trace sections appeared on post-idle turns. This is expected in
  this soak because the `70s`, `245s`, and `600s` gaps intentionally exceed
  `idle_timeout_ms=30000`, so the live bound runner is allowed to die and the
  runtime resumes through a new runner.
- Agent-run evidence: each customer had `4` agent runs and exactly `1`
  distinct provider session id, proving provider-session continuity across
  cold resumes.
- Owner leases were reclaimed by `conversation_work_reconciler:expired_owner_lease`
  during the soak without producing duplicate replies.
- Final workers API from both cores: healthy instances `2`,
  `genericAvailable=6`, `boundActive=0`, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, and stale rows excluded from healthy totals.

Latency evidence note:

- `message_traces.conversation_id` stores the raw chat id (`wa:<phone>`), while
  `messages.conversation_id` stores the canonical conversation id
  (`conversation:wa:<phone>`). Phase evidence queries must use the correct id
  shape for each table.
- A collapsed `runtime wait` UI label is not enough to prove this phase. The
  evidence must inspect detailed timing sections such as `queue`, `startup`,
  `llm`, `tool`, `send`, and `gap`, plus LLM detail fields such as
  `providerWaitMs` and `generationMs`.

## Phase 9: Final Real-Customer Acceptance

Purpose: prove the platform works from the real customer perspective after
engineering verification passes.

Steps:

1. Use the actual customer-facing channel path, not a DB insert or internal
   function call.
2. Send a normal first customer message.
3. Confirm the customer receives one reply.
4. Send two or three natural follow-ups within `idle_timeout_ms`.
5. Confirm each follow-up receives one reply.
6. Wait longer than `idle_timeout_ms`.
7. Send another natural follow-up.
8. Confirm the customer receives one reply.
9. Check admin panel transcript, message API, latency report, and runtime
   workers after the flow.

Expected:

- From the customer side, chat feels normal.
- No reply silently disappears.
- No duplicate reply arrives.
- No obviously wrong customer context appears.
- Dashboard/API agrees with what the customer saw.
- No active or pending conversation remains stuck after the final reply.

Acceptance:

- pass only if the real customer-side channel and admin/API evidence agree
- fail if admin says the reply exists but the customer channel did not receive it

### Phase 9 Evidence Log

Status: passed for the local customer-facing acceptance path on 2026-06-18 IST.
Real external WhatsApp delivery remains the user's final manual confirmation
after engineering verification; local runtime verification keeps
`GANTRY_OUTBOUND_DRYRUN=1`.

Runtime setup:

- Stack: two-core dev runtime with healthy cores `runtime:39369` on port
  `4710` and `runtime:39515` on port `4711`.
- Customer: `conversation:wa:000960000931`.
- Ingress: signed Interakt-compatible webhook route, not DB inserts or
  internal function calls.
- Outbound: dry-run customer-visible persistence, as required for local tests.

Live customer flow:

- Turn 1 inbound:
  `phase9-customer-000960000931-1781751849316-1`.
- Turn 1 outbound:
  `message:wa:000960000931:outbound:4ab0e175-5e2b-40cd-89c4-1705c17942e9`.
- Turn 2 inbound:
  `phase9-customer-000960000931-1781751860399-2`.
- Turn 2 outbound:
  `message:wa:000960000931:outbound:66bb37b9-94fe-47e9-b516-d5fe94b318e4`.
- Turn 3 inbound:
  `phase9-customer-000960000931-1781751874512-3`.
- Turn 3 outbound:
  `message:wa:000960000931:outbound:c4a46d55-18a6-46ed-8a35-d67cb4ba48b7`.
- Waited `45s`, longer than `idle_timeout_ms=30000`.
- Turn 4 inbound:
  `phase9-customer-000960000931-1781751928610-4`.
- Turn 4 outbound:
  `message:wa:000960000931:outbound:4c1f073d-70f9-47b4-aee8-42e144f04a75`.

Acceptance evidence:

- Transcript counts: `4` inbound and `4` outbound.
- Latency traces: `4` rows for trace conversation id `wa:000960000931`.
- Trace totals by turn: `5010 ms`, `8707 ms`, `6329 ms`, and `6506 ms`.
- Final reply after the post-idle wait remembered the plan:
  `6 boxes`, `chocolate or kaju sweets`, `₹1,800`, `Pune`, and next Friday.
- Agent-run evidence: `2` agent runs and exactly `1` provider session id
  (`f901065e-e35c-448d-a6ac-7926500ed346`), proving continuity across the
  post-idle resumed runner.
- Detailed latency sections were available for every reply:
  - turn 1: `queue`, `guardrail`, `main LLM`, and `gap`
  - turn 2: `queue`, `main LLM`, `gap`, `search_products`, `main LLM`, and
    `gap`
  - turn 3: `queue`, `main LLM`, `memory_save`, `main LLM`, and `gap`
  - turn 4 after idle: `queue`, `gap`, `assistant startup`, `main LLM`, and
    `gap`
- Turn 4's `assistant startup=2242 ms` is expected because the wait exceeded
  `idle_timeout_ms`; the section is explicitly visible and not hidden under a
  collapsed `runtime wait` label.
- Final workers API: healthy instances `2`, `genericAvailable=6`,
  `boundActive=0`, `activeMessageRuns=0`, and
  `pendingConversationKeys=0`.

## Phase 10: Final Regression Pass

Purpose: after all implementation and admin/runtime changes are complete,
confirm the latest code and config did not regress the scenarios that already
passed earlier in the plan.

Run the smallest high-signal replay set:

1. Single-customer 4x4 chat with cache prewarm off.
2. Two-customer isolation with four turns per customer.
3. MCP smoke proving both `boondi-crm` and `shopify-api` calls still work.
4. Active-run follow-up where a message arrives while the previous turn is
   still processing.
5. Two-core restart continuity with a customer follow-up after restart.

Expected:

- Every replayed inbound gets exactly one outbound reply.
- No replayed follow-up gets stuck in `pendingConversationKeys`.
- No replayed same-customer warm-follow-up shows `assistant startup` unless the
  replay intentionally restarts or kills the live worker.
- Stale runtime rows remain excluded from healthy totals.
- Admin/API evidence and DB evidence agree.

Acceptance:

- pass only if the replay set runs against the latest code after all phases
  and produces fresh evidence
- fail if any earlier pass only holds for an older build or older config

### Phase 10 Evidence Log

Status: passed on 2026-06-18 IST against the latest local code after the
latency report UI fix, durable cursor refresh/merge runtime fix, and
conversation-work claim/revalidation fix.

Post-fix live load rerun:

- Run id: `loadwave1781772606859`.
- Stack: two-core dev runtime with `GANTRY_CORE_COUNT=2`.
- Traffic path: signed Interakt-compatible webhooks through ports `4710` and
  `4711`; no DB inserts.
- Load shape: eight customers, four reply-gated waves per customer.
- Capacity pressure: `maxMessageRuns=6`; the run used eight concurrent
  customers so queueing, ownership, and worker reuse were exercised.
- Customers:
  - `conversation:wa:00097001001`
  - `conversation:wa:00097001002`
  - `conversation:wa:00097001003`
  - `conversation:wa:00097001004`
  - `conversation:wa:00097001005`
  - `conversation:wa:00097001006`
  - `conversation:wa:00097001007`
  - `conversation:wa:00097001008`
- Wave results:
  - after turn 1: all eight customers had `1` inbound, `1` outbound, and
    `1` trace
  - after turn 2: all eight customers had `2` inbound, `2` outbound, and
    `2` traces
  - after turn 3: all eight customers had `3` inbound, `3` outbound, and
    `3` traces
  - after turn 4: all eight customers had `4` inbound, `4` outbound, and
    `4` traces
- Immediate post-reply worker snapshot: two healthy instances,
  `genericAvailable=6`, `boundActive=6`, `activeMessageRuns=1`,
  `pendingConversationKeys=0`, and `maxMessageRuns=6`.
- Post-settle worker snapshot after a 90s wait: two healthy instances,
  `genericAvailable=6`, `genericStarting=0`, `boundActive=0`,
  `activeMessageRuns=0`, and `pendingConversationKeys=0`.
- Agent-run continuity: every customer used exactly one provider session; six
  customers completed in one accepted active-run prompt and two customers
  completed in four same-session prompts.
- Result: all eight customers remained at exactly `4` inbound, `4` outbound,
  and `4` traces after the settle window.

Invalid load shape that was superseded:

- Run id: `loadfix1781772258713`.
- This attempt sent turn 2 one second after turn 1 for all customers, before
  some queued runners had started.
- Two customers had both pending inbound messages legitimately batched into one
  prompt and therefore produced one outbound reply for the two-message batch.
- This did not prove the required four-customer-message / four-Boondi-reply
  acceptance shape, so it was replaced by the reply-gated load rerun above.

Run context:

- Stack: two-core dev runtime with `GANTRY_CORE_COUNT=2`.
- Runtime smoke env: `/tmp/gantry-runtime-smoke.env.1` for authenticated
  worker API reads.
- Initial workers API: healthy instances `2`, `availableTarget=6`,
  `genericAvailable=6`, `genericStarting=0`, `boundActive=0`,
  `activeMessageRuns=0`, `pendingConversationKeys=0`, cache prewarm
  `skipped=6`.
- Traffic path: signed Interakt-compatible webhooks through ports `4710` and
  `4711`; no DB inserts.

Single-customer active follow-up:

- Customer: `conversation:wa:000960001101`.
- Marker: `P10-SINGLE-1101`.
- Turn 1 inbound:
  `phase10-000960001101-1-1781752758675` via port `4710`.
- Turn 2 inbound:
  `phase10-000960001101-2-1781752759683` via port `4711`, sent one second
  after turn 1 while the previous run was still active.
- Turn 3 inbound:
  `phase10-000960001101-3-1781752780781`.
- Turn 4 inbound:
  `phase10-000960001101-4-1781752790829`.
- Result: exactly `4` inbound and `4` outbound messages.
- Latency traces: `15687 ms`, `20250 ms`, `9771 ms`, and `2915 ms`.
- Trace section kinds included `queue`, `llm`, `gap`, and `tool`.
- Final reply remembered marker `P10-SINGLE-1101` and the gift plan:
  `6` chocolate/kaju gift boxes, `₹1,800`, Pune, Friday.

Two-customer isolation:

- Customers:
  - `conversation:wa:000960001102` with marker `P10-ALPHA-1102`
  - `conversation:wa:000960001103` with marker `P10-BRAVO-1103`
- Four turns per customer were interleaved across ports `4710` and `4711`.
- Result for each customer: exactly `4` inbound and `4` outbound messages.
- `000960001102` latency traces:
  `4892 ms`, `10136 ms`, `7408 ms`, and `2961 ms`.
- `000960001103` latency traces:
  `6742 ms`, `13808 ms`, `11935 ms`, and `3809 ms`.
- Both customers' trace section kinds included `queue`, `llm`, `gap`, and
  `tool`.
- Final replies remembered the correct private marker and gift plan.
- No final reply contained another customer's private marker.

Latency detail evidence:

- Every Phase 10 outbound had a `message_traces` row.
- No Phase 10 timing section label contained `runtime wait`.
- Tool sections were present, proving MCP-backed turns still route through the
  live runner path.

Worker/dashboard evidence:

- Immediate post-reply snapshot still had `boundActive=2`, which is expected
  inside the `idle_timeout_ms=30000` retention window.
- Post-idle snapshot after waiting past `idle_timeout_ms`:
  `instances=2`, `availableTarget=6`, `genericAvailable=6`,
  `genericStarting=0`, `boundActive=0`, `activeMessageRuns=0`,
  `pendingConversationKeys=0`, cache prewarm `skipped=6`.

## Final Acceptance Criteria

The complete plan passes only when live-flow evidence proves:

1. A first customer message receives exactly one outbound reply.
2. Same-customer follow-ups before idle timeout receive replies without being
   stranded behind a stale or cold one-shot runner.
3. Same-customer messages after idle timeout receive replies through a new
   valid worker path.
4. Multiple customers never share context.
5. Two cores never duplicate replies for one inbound.
6. Dead/stale workers do not appear as healthy usable capacity.
7. No message remains pending after the responsible runner has already produced
   a visible reply.
8. Cache prewarm on/off is accurately reflected in dashboard and latency report.
9. Latency report separates:
   - inbound webhook receipt
   - inbound validation/dedupe
   - inbound persistence
   - route resolution
   - owner/claim acquisition
   - Gantry cache prewarm
   - provider prompt-cache read/write during the LLM call
   - queue wait
   - continuation delivery or worker acquisition
   - warm bind
   - runner startup
   - guardrail/safety check
   - main LLM generation
   - MCP/tool calls
   - outbound persistence
   - send time
   - post-reply cleanup/release when it affects the next turn
10. Latency report shows message and routing identifiers:

- conversation id
- inbound provider message id
- persisted inbound message id
- outbound provider message id, when available
- persisted outbound message id
- runtime instance id
- run handle
- worker id, when applicable

11. CRM and Shopify MCP smoke passes through live customer traffic and trace
    evidence.
12. Duplicate provider redelivery produces exactly one customer-visible reply.
13. Repeated-flow soak completes without lost replies, duplicate replies,
    cross-customer context leaks, or stuck pending conversations.
14. Final real-customer acceptance passes through the actual customer-facing
    channel.
15. Admin panel/API and customer-side delivery evidence agree.

## Parallelization Guidance

Do not parallelize until Phase 1 passes.

Safe parallel tracks after Phase 1:

- Agent A: single-core customer flow scenarios
- Agent B: dashboard/API consistency scenarios
- Agent C: two-core ownership/routing scenarios

Do not parallelize edits to runner lifecycle, queue semantics, worker inventory,
or ownership until the basic single-core flow is proven through live requests.

## Surface Impact Matrix

This is a verification plan, not an implementation plan.

| Surface                      | Status               | Reason                                                                             |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| Runtime behavior             | Read-only/observable | The plan verifies runner routing, queue state, and ownership through live traffic. |
| `settings.yaml`              | Read-only/observable | The plan changes config between scenarios but does not define new settings.        |
| Postgres/runtime projection  | Read-only/observable | The plan inspects persisted messages, traces, runtime rows, and stale instances.   |
| Control/admin API            | Read-only/observable | The plan requires API evidence but does not change API contracts.                  |
| SDK/contracts                | Read-only/observable | The plan verifies Anthropic SDK runner behavior but does not change SDK contracts. |
| CLI                          | Not applicable       | No CLI surface changes are planned.                                                |
| Gantry MCP tools/admin skill | Not applicable       | The plan does not add or change Gantry MCP tools.                                  |
| Channel/provider adapters    | Read-only/observable | The plan sends real inbound requests and observes outbound delivery.               |
| Docs/prompts                 | Changed              | This document records the live verification plan.                                  |
| Audit/events                 | Read-only/observable | Existing traces/events are used as evidence.                                       |
| Tests/verification           | Changed              | Acceptance requires live-flow verification in addition to unit/integration tests.  |
