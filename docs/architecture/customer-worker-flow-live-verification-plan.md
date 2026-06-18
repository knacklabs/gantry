# Customer Worker Flow Live Verification Plan

Date: 2026-06-18

Status: execution in progress. Phase 0 passed on 2026-06-18 IST. Phase 1 passed
after the retained warm-worker socket was rekeyed to the bound conversation run
handle and the active-run counter double-decrement was fixed. Phase 2 still
needs the multi-customer 4x4 rerun after that fix. The earlier `memory_save` IPC
app-scope failure is covered by the IPC unit regression and Phase 1 now includes
a successful `memory_save` live turn. Phase 3 remains reopened for the same
natural 4x4 rerun under cache-prewarm-on config.

## Phase Status Tracker

Update this table after every phase. Do not mark a phase passed unless the
phase acceptance criteria passed through live inbound requests plus admin/API
evidence.

| Phase     | Scope                                           | Scenario count | Status      | Evidence                                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------- | -------------: | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0   | Harness and baseline                            |  baseline gate | Passed      | 2026-06-18 IST baseline: core 4710, admin 3000, Shopify MCP 8081, CRM MCP 8082; one healthy runtime, 51 stale rows excluded, generic available 3, active 0, pending 0.                                                                                                                                                   | Admin Runtime and Conversations pages render; latency trace API reachable.                                                                                                                                            |
| Phase 1   | Single customer, single core, cache prewarm off |              4 | Passed      | 2026-06-18 IST fixed rerun `conversation:wa:000960000102` persisted 4 inbound, 4 outbound, and 4 latency reports; turn 4 remembered marker `REKEY-MUMBAI-31`; no latency report included `assistant startup`; healthy runtime active 0, pending 0.                                                                       | Retained same-process bound-worker continuation is now proven for a natural 4x4 chat. The run also covered a successful `memory_save` tool call.                                                                      |
| Phase 2   | Multiple customers, single core                 |              5 | Blocked     | 2026-06-18 IST rebuilt natural 4x4 rerun used `conversation:wa:000950000201` and `conversation:wa:000950000202`; both persisted 4 inbound, 4 outbound, and 4 trace rows; final replies remembered only their own markers `ALPHA-MUMBAI-30` and `BRAVO-DELHI-12`; final runtime active 0, pending 0, generic available 3. | Customer-visible isolation passed before the retained-worker fix, but follow-up traces showed `assistant startup`; rerun Phase 2 after Phase 1 fix.                                                                   |
| Phase 3   | Cache prewarm on                                |              2 | Reopened    | 2026-06-18 IST plumbing evidence exists from `conversation:wa:000930000301` and `conversation:wa:000930000302`-`305`; final phase pass now requires natural 4x4 chat coverage under cache-prewarm-on config.                                                                                                             | Startup prewarm completes before the control HTTP server accepts webhooks, so customer-during-startup-prewarm is not externally reachable in this build; replacement/replenishment during traffic was tested instead. |
| Phase 3.5 | MCP smoke                                       |              1 | Not started | TBD                                                                                                                                                                                                                                                                                                                      | CRM and Shopify MCP live-traffic smoke.                                                                                                                                                                               |
| Phase 4   | Follow-up routing stress                        |              4 | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Rapid follow-ups, active-run follow-up, cold resume, five-turn loop.                                                                                                                                                  |
| Phase 5   | Two core processes                              |              5 | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Ownership, distribution, restart, post-restart continuity.                                                                                                                                                            |
| Phase 6   | Dashboard truth                                 | dashboard gate | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Must be checked across every scenario, then summarized here.                                                                                                                                                          |
| Phase 7   | Failure recovery                                |              3 | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Kill runner, MCP down/up, ungraceful core death.                                                                                                                                                                      |
| Phase 8   | Repeated-flow soak                              |      soak gate | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Five customers, five turns each, at least 10 minutes.                                                                                                                                                                 |
| Phase 9   | Final real-customer acceptance                  |  customer gate | Not started | TBD                                                                                                                                                                                                                                                                                                                      | Real customer-facing channel proof after engineering verification.                                                                                                                                                    |

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
- `cache_prewarm_enabled: false` means startup cache-prewarm model calls are
  skipped. It must not break chat correctness.
- `cache_prewarm_enabled: true` means cache-prewarm work should happen before
  customer traffic when possible.
- `cache_prewarm_concurrency: 1` means at most one cache-prewarm model call
  runs at a time; if there are multiple cache shapes or workers requiring
  prewarm, they are prewarmed one by one.

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

Status: original plumbing evidence passed on 2026-06-18 IST; natural 4x4
customer-visible rerun passed on 2026-06-18 IST; runtime acceptance blocked by
follow-up continuation and `memory_save` IPC scope behavior.

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

Startup prewarm evidence:

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
  the latency report: `queue=4437 ms`, `assistant startup=3689 ms`,
  `main LLM=1770 ms`, and final `gap=80 ms`.
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

- Cache prewarm occurs before customer traffic when possible.
- With concurrency `1`, prewarm work runs one model call at a time.
- First customer reply does not include cache-prewarm wait as customer-side
  latency if prewarm already completed.
- Dashboard shows prewarm status accurately.

Acceptance:

- pass only if live customer reply works and cache-prewarm status is visible
- fail if prewarm status is misleading or counted as active customer work after
  it completed before traffic

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
