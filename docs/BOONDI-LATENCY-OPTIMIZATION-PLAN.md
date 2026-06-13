# Boondi Latency Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan one phase at a time. Do not batch phases. After each phase, run the Boondi E2E flow, record the measured difference in this file, and stop for review.

**Goal:** Make Boondi production-grade on customer-visible latency without cutting accuracy, safety, privacy, or brand behavior.

**Architecture:** Optimize the runtime and tool path before touching the large Boondi authored prompts. Each phase is one isolated fix or optimization with its own before/after E2E evidence. Prompt shrinkage for `agents/boondi_support/SOUL.md` and `agents/boondi_support/CLAUDE.md` is explicitly deferred.

**Tech Stack:** Gantry core runtime, Claude Agent SDK, Boondi WhatsApp/Interakt local E2E flow, Shopify MCP, Boondi CRM MCP, Postgres-backed runtime state.

---

## What We Are Doing

We are reducing the latency of Boondi customer replies in measured phases. The work is not "make the code nicer" and not "remove prompt text until it feels smaller." The target is customer-visible reply time, measured through the same local flow used for Boondi E2E testing.

For every phase:

1. Make exactly one focused optimization or bug fix.
2. Run the Boondi E2E flow from `docs/BOONDI-E2E-TESTING.md`.
3. Compare the result against the previous baseline.
4. Record the result in this file.
5. Stop and decide whether the next phase is still worth doing.

## What We Are Targeting

Primary target:

- Reduce customer-visible reply latency for normal Boondi WhatsApp customer turns.

Concrete latency buckets to watch:

- inbound webhook persisted -> queue/message processing starts
- queue/message processing starts -> guardrail decision complete
- guardrail decision complete -> Claude SDK `query()` starts
- SDK `query()` starts -> first SDK message
- tool calls start -> tool results complete
- final assistant result -> outbound message persisted/sent

Current known expensive areas:

- cold first turn sends a large SDK `systemPrompt.append`
- cold first turn pays SDK startup/MCP setup cost
- unnecessary tool calls increase model/tool round trips
- broad product searches can return useless empty payloads
- warm in-process follow-up is much better because it pushes only the new message into the existing `MessageStream`
- message polling/queue timing can add customer-visible latency before the model starts

## Explicitly Deferred

Prompt shrinkage is deferred.

Do not optimize latency by shortening, deleting, summarizing, or restructuring these authored prompt files in the active phases:

- `agents/boondi_support/SOUL.md`
- `agents/boondi_support/CLAUDE.md`

Reason: those files carry Boondi's brand voice, safety behavior, privacy boundaries, Shopify/CRM behavior, and customer-facing error policy. Cutting them is a separate high-risk project and needs its own regression plan.

Allowed during this plan:

- runtime latency fixes
- queue/wakeup fixes
- tool-call reduction
- MCP tool result compaction
- aggregate MCP tools
- SDK/session behavior improvements
- measurement/tracing improvements
- small non-shrinking prompt guidance only if a phase explicitly needs behavior steering and the change is tested

Not allowed during this plan:

- shrinking `SOUL.md`
- shrinking `CLAUDE.md`
- removing Boondi privacy/safety rules
- removing customer voice rules
- claiming improvement without E2E measurement

## Measurement Protocol

Use `docs/BOONDI-E2E-TESTING.md` as the source of truth.

Minimum measurement after every phase:

- Use a fresh test phone number unless the phase specifically tests warm follow-up behavior.
- Keep `GANTRY_OUTBOUND_DRYRUN=1`.
- Run the same heavy prompt before and after a phase when possible:

```text
Hi Boondi, I need around 80 premium Diwali gift boxes for clients in Mumbai and Delhi, budget about ₹1,200 per box. Also check my latest order and suggest available sweets or hampers that fit this gifting plan.
```

- If testing warm follow-up behavior, use the same conversation and then send:

```text
Timeline is next Friday. Split is 50 boxes in Mumbai and 30 in Delhi. Please recheck my latest order once more and compare it with available chocolate options under ₹1,200.
```

- Record customer-visible reply time from the admin badge or latency harness output.
- Prefer sequential runs when comparing timings so queue/concurrency noise does not hide the real effect.
- If using `scripts/measure-latency.mjs`, attach or reference the output path.

Result format after each phase:

```markdown
### Phase N Result

Date:
Commit:
Change:
Prompt/scenario:
Before:
After:
Delta:
Tool calls before:
Tool calls after:
Notes:
Decision:
```

## Phase Ledger

| Phase | Status   | Optimization                                                         | Before                            | After                                              | Delta                        | Evidence                                                                                                           |
| ----- | -------- | -------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0     | Complete | Establish fresh baseline                                             | N/A                               | Heavy first turn: 32.793s; warm follow-up: 15.703s | Baseline only                | `/tmp/boondi-phase0-baseline-1781305528412.json`; admin `conversation:wa:000000059`; `/tmp/gantry-dev.log`         |
| 1     | Complete | Measure and reduce pre-SDK queue/poll delay                          | Heavy: 32.793s; warm: 15.703s     | Heavy: 48.726s; warm: 14.461s                      | Heavy +15.933s; warm -1.242s | `/tmp/boondi-phase1-measurement-1781306076756.json`; admin `conversation:wa:000000058`; focused unit/runtime tests |
| 2     | Complete | Remove unnecessary CRM lookup from normal substantive customer turns | Heavy: 48.726s; warm: 14.461s     | Heavy: 21.264s; warm: 12.770s                      | Heavy -27.462s; warm -1.691s | `/tmp/boondi-phase2-measurement-1781306829854.json`; isolated `multi-turn-shopping-flow` regression passed         |
| 3     | Complete | Reduce unnecessary product searches in qualified gifting flows       | Heavy: 21.264s; warm: 12.770s     | Heavy: 17.186s; warm: 12.499s                      | Heavy -4.078s; warm -0.271s  | `/tmp/boondi-phase3-measurement-1781307514603.json`; isolated qualified-gifting regression passed                  |
| 4     | Complete | Add a Shopify aggregate tool for gifting context                     | Heavy: 17.186s; warm: 12.499s     | Heavy: 15.295s; warm: 14.436s                      | Heavy -1.891s; warm +1.937s  | `/tmp/boondi-phase4-measurement-1781309567303.json`; isolated aggregate-tool regression passed                     |
| 5     | Complete | Tune warm in-process follow-up retention                             | Phase 4 warm: 14.436s, SDK resume | Delayed warm: 15.023s, in-process continuation     | Warm +0.587s; retention hit  | `/tmp/boondi-phase5-measurement-1781310596666.json`; `IDLE_TIMEOUT=20000`; 10s delayed follow-up                   |
| 6     | Complete | SDK static/dynamic prompt-cache spike, no prompt shrinkage           | Exploratory: 20.077s + CRM call   | Heavy: 19.170s; SDK cache spike rejected           | Heavy -0.907s; CRM call gone | `/tmp/boondi-phase6-final-measurement-1781311836427.json`; isolated qualified-gifting regression passed            |

## Phase 0: Fresh Baseline

**Purpose:** Establish the measurement baseline from the current checkout before changing behavior.

**Plain-English resolution logic:**

First we need a clean starting number. We will run the same Boondi customer scenario before making any optimization and record how long the first reply and warm follow-up take. This gives us the control value. Every later phase must beat or explain itself against this baseline.

**Files:**

- Read: `docs/BOONDI-E2E-TESTING.md`
- Read: `scripts/measure-latency.mjs`
- Update: `docs/BOONDI-LATENCY-OPTIMIZATION-PLAN.md`

**Steps:**

- [ ] Restart the local Boondi stack from the current checkout.
- [ ] Confirm the current runtime is the intended worktree.
- [ ] Run the heavy prompt with a fresh phone number.
- [ ] Run the warm follow-up prompt in the same conversation.
- [ ] Record first-turn and warm-follow-up timings in the Phase Ledger.
- [ ] Record observed tool calls.
- [ ] Do not change code in this phase.

**Exit criteria:**

- We have a fresh measured baseline for this branch.
- The baseline record names the exact command/runbook used.

## Phase 1: Pre-SDK Queue/Poll Delay

**Purpose:** Remove latency before Claude even starts.

**Hypothesis:** If inbound messages wait for the poll loop or queue wakeup, customer-visible latency increases even when the model path is unchanged.

**Plain-English resolution logic:**

Right now, a normal WhatsApp message can behave like this: Gantry saves the message, then Boondi waits until the polling loop checks for new messages. Polling is like checking a mailbox every few hundred milliseconds. If the message is already saved but Boondi is waiting for the next check, that waiting time is wasted.

The fix is to ring the doorbell when the message is saved. After Gantry successfully stores the incoming customer message in the database, it should immediately wake the exact Boondi chat queue for that conversation. In code terms, the persistence path should call the queue wakeup after `storeMessage(msg)` succeeds, not before.

The order matters:

```text
Customer WhatsApp message arrives
-> Gantry validates and routes it
-> Gantry saves the message in the database
-> Gantry immediately wakes the exact chat queue
-> Boondi starts guardrail/main LLM work
```

We should not wake the queue before saving the message, because the queue reads messages from the database. If Boondi wakes too early, it may find nothing to process.

Polling stays in place as a safety fallback. If the immediate wakeup is missed, the process restarts, or an older message is still pending, polling can still recover it later. The goal is not to remove polling; the goal is to stop using polling as the normal fast path for fresh webhook messages.

This phase does not change Boondi's prompt, tools, memory, answer quality, or safety behavior. It only removes dead waiting time before Boondi begins work.

**Files to inspect:**

- `apps/core/src/runtime/message-loop.ts`
- `apps/core/src/runtime/group-queue.ts`
- `apps/core/src/runtime/group-processing.ts`
- channel webhook/persistence path used by `docs/BOONDI-E2E-TESTING.md`

**Optimization target:**

- Ensure webhook message persistence wakes the right group processing path immediately.
- Keep polling as fallback, not the normal fast path.

**Steps:**

- [ ] Add or use timing marks for inbound persisted -> processing start.
- [ ] Write a focused test for immediate wakeup if a suitable test surface exists.
- [ ] Implement the smallest wakeup fix.
- [ ] Run focused runtime tests.
- [ ] Run Boondi E2E heavy prompt.
- [ ] Update Phase Ledger with before/after timing.

**Exit criteria:**

- Measured inbound-to-processing delay is lower or proven not to be the bottleneck.

## Phase 2: Remove Unnecessary CRM Lookup

**Purpose:** Stop spending a tool call on CRM when the customer sent a substantive normal request that does not need open CRM context.

**Hypothesis:** `get_open_records` is useful for returning greetings and continuity, but not for every heavy product/order request.

**Plain-English resolution logic:**

We will separate "customer needs CRM continuity" from "customer asked a normal order/product/gifting question." For a bare returning greeting, CRM open records can help Boondi recognise the customer. For a substantive message like "check my latest order and suggest gifting options," the latest order and product tools matter more, and CRM lookup is usually unnecessary. The fix is to stop Boondi from calling CRM by default on these normal substantive turns.

**Files to inspect:**

- `agents/boondi_support/CLAUDE.md`
- `packages/mcp-crm/src/tools/get-open-records.ts`
- `packages/mcp-crm/test/server.test.ts`
- `docs/BOONDI-MAIN-CHAT-LIVE-FIRST-PAYLOAD.md`

**Optimization target:**

- Heavy first-turn request should not call `boondi-crm.get_open_records` unless the behavior genuinely needs open CRM context.

**Steps:**

- [ ] Add a regression scenario showing a normal substantive gifting/order message should not require CRM lookup.
- [ ] Apply the smallest behavior/tool-routing change.
- [ ] Run focused tests.
- [ ] Run Boondi E2E heavy prompt.
- [ ] Update Phase Ledger with tool-call count and timing delta.

**Exit criteria:**

- Heavy prompt still answers correctly.
- CRM lookup count is reduced when not needed.

## Phase 3: Reduce Unnecessary Product Searches

**Purpose:** Prevent broad multi-query product searching when a gifting handoff or one targeted search is enough.

**Hypothesis:** The heavy prompt can trigger several `search_products` calls, many returning empty results. This adds latency and context without improving the reply.

**Plain-English resolution logic:**

We will make Boondi more selective about product search. If the customer has already given a corporate gifting brief, Boondi may only need to route the brief to the gifting team and ask for missing details. If the customer explicitly asks for product options, Boondi should use a smaller number of targeted searches instead of several broad guesses. The goal is fewer searches, fewer empty results, and the same useful customer answer.

**Files to inspect:**

- `agents/boondi_support/CLAUDE.md`
- `packages/mcp-shopify/src/tools/search-products.ts`
- `packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts`
- `docs/BOONDI-MAIN-CHAT-LIVE-FIRST-PAYLOAD.md`

**Optimization target:**

- Use product search only when product options, availability, pricing, or recommendations are actually required.
- Prefer one targeted product search over several broad searches.

**Steps:**

- [ ] Add/identify a regression scenario for qualified gifting flow with product recommendation request.
- [ ] Reduce broad search fanout without weakening the answer.
- [ ] Run focused Shopify/tool tests.
- [ ] Run Boondi E2E heavy prompt.
- [ ] Update Phase Ledger with number of product searches and timing delta.

**Exit criteria:**

- Product search count is lower.
- Reply still handles latest order + gifting plan correctly.

## Phase 4: Shopify Aggregate Gifting Context Tool

**Purpose:** Replace several model-planned Shopify calls with one purpose-built tool that runs internal lookups in parallel and returns compact data.

**Hypothesis:** One aggregate MCP call can reduce model/tool round trips and shrink tool-result context.

**Plain-English resolution logic:**

Instead of asking the model to plan several separate Shopify calls, we will give it one purpose-built Shopify tool for the common gifting flow. That tool can internally fetch the latest order and relevant product candidates at the same time, dedupe the products, filter to compact fields, and return one clean result. This moves predictable orchestration from the LLM into deterministic code, which should reduce both latency and context bloat.

**Files to inspect or modify:**

- `packages/mcp-shopify/src/tools/index.ts`
- `packages/mcp-shopify/src/tools/get-recent-orders-with-details.ts`
- `packages/mcp-shopify/src/tools/search-products.ts`
- `packages/mcp-shopify/src/tools/shared.ts`
- `packages/mcp-shopify/test/unit/tools/`

**Candidate tool:**

```ts
get_gifting_context({
  includeLatestOrder: true,
  productQueries: ['chocolate gift box', 'premium festive hamper'],
  maxProductsPerQuery: 3,
  budgetMax: 1200,
});
```

**Optimization target:**

- Internally use `Promise.all` where calls are independent.
- Deduplicate product results.
- Return compact fields only.
- Preserve privacy guard behavior.

**Steps:**

- [ ] Write unit tests for aggregate success, empty product results, and privacy guard propagation.
- [ ] Implement aggregate tool.
- [ ] Register the tool in Shopify MCP.
- [ ] Update Boondi routing only if needed so the model prefers the aggregate tool.
- [ ] Run Shopify MCP tests.
- [ ] Run Boondi E2E heavy prompt.
- [ ] Update Phase Ledger with tool-call count and timing delta.

**Exit criteria:**

- Heavy prompt needs fewer external tool calls.
- Tool result payload is smaller.
- Reply remains accurate and customer-safe.

## Phase 5: Warm Follow-Up Retention

**Purpose:** Keep the fastest path available for realistic follow-ups.

**Known fact:** Warm follow-up does not create a new SDK `query()` call. It pushes only the new customer message into the existing `MessageStream`.

**Plain-English resolution logic:**

Warm follow-up is already the fastest path because it avoids rebuilding the full SDK request. We will measure whether real follow-ups are missing that warm window because the runner idles out too quickly. If yes, we tune the idle window just enough to preserve common customer follow-ups. We will not blindly keep runners alive forever, because that can waste resources.

**Files to inspect:**

- `apps/core/src/runtime/group-agent-runner.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/message-stream.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
- `apps/core/src/config/settings/runtime-settings-agents-parser.ts`

**Optimization target:**

- Preserve warm in-process follow-up for normal customer reply cadence.
- Do not keep runners alive so long that resource usage becomes unreasonable.

**Steps:**

- [ ] Measure current warm-follow-up hit/miss behavior.
- [ ] Identify idle timeout setting used by Boondi.
- [ ] Tune only if measurement shows useful misses.
- [ ] Run E2E warm follow-up scenario.
- [ ] Update Phase Ledger with warm-follow-up timing.

**Exit criteria:**

- Warm follow-up path is preserved or improved.
- Resource tradeoff is documented.

## Phase 6: SDK Static/Dynamic Prompt Cache Spike

**Purpose:** Research whether SDK prompt cache boundary can reduce cold-turn cost without shrinking Boondi prompts.

**Important constraint:** This phase must not shrink `SOUL.md` or `CLAUDE.md`.

**Known SDK fact to verify in this repo:**

- The installed Claude Agent SDK exposes `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for `string[]` system prompts.
- Gantry currently uses the Claude Code preset object with `append`.

**Plain-English resolution logic:**

We will test whether the SDK can cache the stable part of the system prompt more effectively without removing any Boondi prompt content. This is only a spike because Gantry currently uses the Claude Code preset prompt shape, and changing that shape could affect behavior. The only acceptable outcome is measured latency/cache improvement with the same Boondi behavior; otherwise we reject it and leave the SDK prompt path unchanged.

**Files to inspect:**

- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/system-prompt.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

**Optimization target:**

- Determine whether a static/dynamic boundary can improve cache behavior while preserving the Claude Code preset behavior.

**Steps:**

- [x] Build a spike branch or local experiment only.
- [x] Log exact SDK `systemPrompt` shape before and after.
- [x] Run a cold first-turn E2E comparison.
- [x] Verify tools, MCP, sandbox, and Boondi behavior remain the same.
- [x] Update this plan with accept/reject decision.

**Exit criteria:**

- Either a measured improvement with no behavior regression, or a documented rejection.

## Surface Impact Matrix

| Surface                      | Status               | Reason                                                                                                   |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Queue/wakeup, runner retention, and SDK query behavior may be optimized phase by phase.                  |
| `settings.yaml`              | Read-only/observable | Only touched if warm-retention tuning requires a settings-owned idle value; otherwise no settings write. |
| Postgres/runtime projection  | Read-only/observable | Used for persisted transcript and timing verification; no schema change expected.                        |
| Control API                  | Unchanged by design  | Latency changes target runtime and MCP path, not public control API.                                     |
| SDK/contracts                | Changed              | Query shape/cache spike and runner behavior may change, but only after measurement.                      |
| CLI                          | Unchanged by design  | E2E/harness commands may be used, but CLI surface should not change.                                     |
| Gantry MCP tools/admin skill | Unchanged by design  | Gantry admin tools are not the optimization target.                                                      |
| Shopify MCP                  | Changed              | Aggregate gifting context tool and result compaction may change Shopify MCP surface.                     |
| Boondi CRM MCP               | Read-only/observable | CRM call frequency may drop; CRM tool behavior should not change unless a phase explicitly proves need.  |
| Channel/provider adapters    | Read-only/observable | Webhook wakeup may touch channel plumbing if measurement proves delay there.                             |
| Docs/prompts                 | Changed              | This plan and results ledger update after every phase; prompt shrinkage deferred.                        |
| Audit/events                 | Changed              | Timing/measurement events may be added or reused.                                                        |
| Tests/verification           | Changed              | Every phase requires focused tests plus Boondi E2E measurement.                                          |

## Phase Result Log

Add results below after each phase. Do not start the next phase until this section is updated.

### Phase 0 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6
Change: Fresh baseline only; no implementation or prompt changes.
Prompt/scenario: Fresh fake phone `000000059`; heavy prompt, then warm follow-up in the same conversation, using `docs/BOONDI-E2E-TESTING.md` signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`.
Before: N/A. This phase establishes the branch baseline.
After: Heavy first turn persisted at 32.793s. Warm follow-up persisted at 15.703s.
Delta: N/A. Baseline for later phase comparison.
Tool calls before: N/A.
Tool calls after: Heavy first turn made 5 Shopify calls: 1 `get_recent_orders_with_details`, then 4 `search_products`. Warm follow-up made 2 Shopify calls: 1 `get_recent_orders_with_details`, then 1 `search_products`.
Evidence: `/tmp/boondi-phase0-baseline-1781305528412.json`; `/tmp/gantry-dev.log`; admin API confirmed 4 persisted messages for `conversation:wa:000000059`.
Decision: Stop for review before Phase 1, per this plan's one-phase-at-a-time rule.

### Phase 1 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1 worktree changes.
Change: Existing Interakt direct conversations now enqueue the exact chat queue immediately after inbound `storeMessage` succeeds. Auto-registered first Interakt messages keep the existing deferred wakeup path to avoid the known first-message race.
Prompt/scenario: Fresh fake phone `000000058`; same heavy prompt, then warm follow-up in the same conversation, using `docs/BOONDI-E2E-TESTING.md` signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`.
Before: Phase 0 baseline was heavy first turn 32.793s and warm follow-up 15.703s. Phase 0 pre-SDK timing was guardrail at 314ms and cold `llm.input` at 451ms for the heavy turn; warm guardrail at 465ms.
After: Heavy first turn persisted at 48.726s, with guardrail at 476ms and cold `llm.input` at 661ms. Warm follow-up persisted at 14.461s, with guardrail at 258ms.
Delta: Heavy first turn +15.933s overall and +210ms to cold `llm.input`; warm follow-up -1.242s overall and -207ms to guardrail. Pre-SDK delay remains sub-second and is not the dominant bottleneck.
Tool calls before: Heavy first turn made 5 Shopify calls: 1 `get_recent_orders_with_details`, then 4 `search_products`. Warm follow-up made 2 Shopify calls: 1 `get_recent_orders_with_details`, then 1 `search_products`.
Tool calls after: Heavy first turn made 6 Shopify calls: 1 `get_recent_orders_with_details`, then 5 `search_products`. Warm follow-up made 2 Shopify calls: 1 `get_recent_orders_with_details`, then 1 `search_products`.
Evidence: `/tmp/boondi-phase1-measurement-1781306076756.json`; `/tmp/gantry-dev.log`; admin API confirmed 4 persisted messages for `conversation:wa:000000058`; `npm run test:unit -- apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runtime/message-loop.test.ts apps/core/test/unit/runtime/group-queue.test.ts`; `npm run typecheck`.
Decision: Phase 1 fixed the existing-route post-persistence wakeup, but measured customer latency is still dominated by LLM/tool planning and product-search fanout. Continue to Phase 2/3 after review.

### Phase 2 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1/2 worktree changes.
Change: Added a regression-runner expectation, `mcpMustNotCall`, and applied it to the Shopify `multi-turn-shopping-flow` scenario so substantive shopping/order flows fail if they call `boondi-crm.get_open_records`. No Boondi prompt/runtime behavior changed because current live evidence already showed zero CRM calls on the heavy prompt.
Prompt/scenario: Fresh fake phone `000000057`; same heavy prompt, then warm follow-up in the same conversation, using the signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`. Also ran an isolated `multi-turn-shopping-flow` regression on fake phone `000000043`.
Before: Phase 1 measured heavy first turn at 48.726s and warm follow-up at 14.461s. CRM lookup count was already 0 on both Phase 0 and Phase 1 heavy measurements.
After: Heavy first turn persisted at 21.264s, with guardrail at 406ms and cold `llm.input` at 544ms. Warm follow-up persisted at 12.770s, with guardrail at 27ms and resumed `llm.input` at 90ms.
Delta: Heavy first turn -27.462s versus Phase 1 and -11.529s versus Phase 0. Warm follow-up -1.691s versus Phase 1 and -2.933s versus Phase 0. Because this phase did not change production prompt/runtime behavior and CRM was already zero, treat the timing improvement as observed variance plus lower product-search fanout, not causal proof of the regression guard.
Tool calls before: Phase 1 heavy first turn made 6 Shopify calls and 0 CRM calls. Phase 1 warm follow-up made 2 Shopify calls and 0 CRM calls.
Tool calls after: Phase 2 heavy first turn made 3 Shopify calls: 1 `get_recent_orders_with_details`, then 2 `search_products`; 0 CRM calls. Phase 2 warm follow-up made 2 Shopify calls: 1 `get_recent_orders_with_details`, then 1 `search_products`; 0 CRM calls. The isolated `multi-turn-shopping-flow` made no MCP call on turn 1, `search_products` on turn 2, `get_recent_orders_with_details` on turn 3, and no CRM calls.
Evidence: `/tmp/boondi-phase2-measurement-1781306829854.json`; `/tmp/gantry-dev.log`; `npm run test:unit -- apps/core/test/unit/repo/boondi-scenarios.test.ts`; `BOONDI_SCENARIOS=/tmp/boondi-phase2-scenario.json TURN_TIMEOUT_MS=150000 node scripts/boondi-regression.mjs shopify`.
Decision: Phase 2 exit criteria are met as an enforced invariant, not as a production behavior change. Continue to Phase 3 after review because the remaining high-variance bottleneck is still product-search planning/fanout.

### Phase 3 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1/2/3 worktree changes.
Change: Added a regression-runner expectation, `mcpMaxCallCount`, converted the Shopify gifting scenario into the heavy qualified gifting/product-options prompt, and added non-shrinking Boondi prompt guidance that caps qualified corporate/bulk gifting product suggestions at one targeted `search_products` call. The first softer prompt note still allowed a second broad fallback search after an empty result; moving the hard cap into the Shopify tool-use section made the live regression pass.
Prompt/scenario: Fresh fake phone `000000056`; same heavy prompt, then warm follow-up in the same conversation, using the signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`. Also ran isolated `qualified-gifting-product-options` regression on fake phone `000000043`.
Before: Phase 2 measured heavy first turn at 21.264s with 3 Shopify calls: 1 `get_recent_orders_with_details`, then 2 `search_products`; 0 CRM calls. Warm follow-up was 12.770s with 2 Shopify calls.
After: Heavy first turn persisted at 17.186s, with guardrail at 451ms and cold `llm.input` at 569ms. Warm follow-up persisted at 12.499s, with guardrail at 78ms and resumed `llm.input` at 207ms.
Delta: Heavy first turn -4.078s versus Phase 2 and -15.607s versus Phase 0. Warm follow-up -0.271s versus Phase 2 and -3.204s versus Phase 0.
Tool calls before: Phase 2 heavy first turn made 1 `get_recent_orders_with_details` call and 2 `search_products` calls. Phase 2 warm follow-up made 1 `get_recent_orders_with_details` call and 1 `search_products` call.
Tool calls after: Phase 3 heavy first turn made 1 `get_recent_orders_with_details` call and 1 `search_products` call (`premium festive hamper gift box Diwali`). Phase 3 warm follow-up made 1 `get_recent_orders_with_details` call and 1 `search_products` call (`chocolate gift box under 1200`). No CRM calls.
Evidence: `/tmp/boondi-phase3-measurement-1781307514603.json`; `/tmp/gantry-dev.log`; `npm run test:unit -- apps/core/test/unit/repo/boondi-scenarios.test.ts`; `BOONDI_SCENARIOS=/tmp/boondi-phase3-scenario.json TURN_TIMEOUT_MS=150000 node scripts/boondi-regression.mjs shopify`.
Decision: Phase 3 exit criteria are met. Product-search count is lower for the heavy prompt, and the reply still includes latest-order context plus a corporate gifting-team handoff. Continue to Phase 4 after review because replacing separate model-planned Shopify calls with an aggregate tool is the next planned latency lever.

### Phase 4 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1/2/3/4 worktree changes.
Change: Added Shopify MCP `get_gifting_context` as a deterministic aggregate for qualified gifting turns that need latest-order context plus product suggestions. The tool fetches the caller-verified latest order and compact product candidates in one MCP call, dedupes products, keeps privacy denials customer-safe, and tolerates live-model shorthand (`limit` without `productQueries`, and `budget` as an alias for `budgetMax`). The Boondi prompt now steers only this specific qualified gifting/latest-order/product-suggestion intent to the aggregate tool, and the regression runner can require/forbid exact MCP calls with `mcpMustCall`, `mcpMustNotCall`, and `mcpMaxCallCount`.
Prompt/scenario: Fresh fake phone `000000053`; same heavy prompt, then warm follow-up in the same conversation, using the signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`. Also ran isolated `qualified-gifting-product-options` regression on fake phone `000000043`.
Before: Phase 3 measured heavy first turn at 17.186s with 2 Shopify calls: 1 `get_recent_orders_with_details`, then 1 `search_products`; 0 CRM calls. Warm follow-up was 12.499s with the same 2 Shopify calls.
After: Heavy first turn persisted at 15.295s, with guardrail at 506ms and cold `llm.input` at 587ms. Warm follow-up persisted at 14.436s, with guardrail at 86ms and resumed `llm.input` at 217ms.
Delta: Heavy first turn -1.891s versus Phase 3 and -17.498s versus Phase 0. Warm follow-up +1.937s versus Phase 3 and -1.267s versus Phase 0.
Tool calls before: Phase 3 heavy first turn made 1 `get_recent_orders_with_details` call and 1 `search_products` call. Phase 3 warm follow-up made 1 `get_recent_orders_with_details` call and 1 `search_products` call.
Tool calls after: Phase 4 heavy first turn made 1 `get_gifting_context` call with live shorthand arguments (`budget`, `quantity`, `occasion`, `includeRecentOrder`), returned latest order `#109260`, and returned compact `productQueries` metadata. Phase 4 warm follow-up still made 1 `get_recent_orders_with_details` call and 1 `search_products` call; this phase does not fix warm follow-up tool reuse.
Evidence: `/tmp/boondi-phase4-measurement-1781309567303.json`; `/tmp/gantry-dev.log`; `npm run test:unit -- packages/mcp-shopify/test/unit/tools/gifting-context.test.ts`; `BOONDI_SCENARIOS=/tmp/boondi-phase4-scenario.json TURN_TIMEOUT_MS=150000 node scripts/boondi-regression.mjs shopify`.
Decision: Phase 4 exit criteria are met for the heavy qualified gifting path: model-planned separate Shopify calls are replaced by one aggregate call and the heavy turn improved in the final measurement. Warm follow-up regressed and still uses separate order/search calls, so Phase 5 remains justified and should focus on reusing retained context or routing warm qualified gifting follow-ups through the aggregate path.

### Phase 5 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1/2/3/4/5 worktree changes.
Change: Made the Boondi regression setup script's runner idle window explicit and configurable via `BOONDI_TEST_IDLE_TIMEOUT_MS`, defaulting broad scenario suites to `2500ms` while allowing warm-retention latency checks to use a bounded realistic value such as `20000ms`. Updated the E2E runbook and local runtime/script notes so the short suite timeout is not mistaken for proof of realistic warm-follow-up retention. No production `settings.yaml` write was needed; the runtime default remains 30 minutes when `IDLE_TIMEOUT` is unset.
Prompt/scenario: Fresh fake phone `000000052`; same heavy prompt, then a 10-second delayed warm follow-up in the same conversation, using the signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1`, `GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633`, and `IDLE_TIMEOUT=20000`.
Before: Phase 4 measured warm follow-up at 14.436s after the short local `IDLE_TIMEOUT=2500` window closed, so the warm turn spawned/resumed a new SDK session (`flow:llm.input` present, `resumed: true`). The prior Phase 4 heavy path was 15.295s.
After: Phase 5 heavy first turn in this sample was 22.849s with 1 `get_gifting_context` call. The 10-second delayed warm follow-up persisted at 15.023s with no new host spawn and no `flow:llm.input`; it reached the live runner through the in-process continuation path.
Delta: Warm follow-up +0.587s versus Phase 4's immediate SDK-resume warm sample, so this is not a one-sample latency win. The retention target is met: a realistic delayed follow-up remained in-process instead of being forced into SDK-session resume.
Tool calls before: Phase 4 warm follow-up made 1 `get_recent_orders_with_details` call and 1 `search_products` call after a fresh SDK-resume `query()` call.
Tool calls after: Phase 5 delayed warm follow-up still made 1 `get_recent_orders_with_details` call and 1 `search_products` call, but did so inside the existing live runner. Tool-routing reuse is still a separate optimization from runner retention.
Evidence: `/tmp/boondi-phase5-measurement-1781310596666.json`; `/tmp/gantry-dev.log`; `npm run test:unit -- apps/core/test/unit/repo/boondi-scenarios.test.ts`; live core env confirmed `IDLE_TIMEOUT=20000`.
Decision: Phase 5 exit criteria are met for retention: the warm in-process path is preserved for a normal 10-second customer follow-up when the latency harness uses a bounded 20-second idle window. Keep broad scenario suites at `2500ms` to avoid active-run slot buildup; use `20000ms` only for warm-retention latency checks. Continue to Phase 6 after review because remaining latency work is SDK prompt/cache behavior, not runner retention.

### Phase 6 Result

Date: 2026-06-13 (Asia/Kolkata)
Commit: e8a9d6c6 + uncommitted Phase 1/2/3/4/5/6 worktree changes.
Change: Rejected the SDK static/dynamic system-prompt boundary as a production change. The installed Claude Agent SDK exposes `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` only for custom `string[]` system prompts, while Gantry uses the Claude Code preset object with `append` and `excludeDynamicSections: true`; switching to `string[]` would stop preserving preset behavior. The SDK prompt path was left unchanged. During the measurement, a nondeterministic `boondi-crm.get_open_records` call surfaced on the heavy gifting prompt, so Boondi guidance was tightened without shrinking prompts: `get_open_records` is now explicitly bare-returning-greeting-only, and a unit regression pins that invariant.
Prompt/scenario: Fresh isolated `qualified-gifting-product-options` heavy prompt on fake phone `000000043`, using the signed Interakt webhook flow with `GANTRY_OUTBOUND_DRYRUN=1` after restarting core so the updated Boondi prompt profile was loaded. A prior Phase 6 exploratory run on fake phone `000000050` measured the unchanged SDK prompt/cache path and exposed the extra CRM call.
Before: Phase 5 heavy first turn in that sample was 22.849s with 1 `get_gifting_context` call. The exploratory Phase 6 run with unchanged SDK prompt path was 20.077s from first inbound log to outbound, with `cacheRead=22937`, `cacheWrite=17399`, 1 `get_gifting_context` call, and an extra `boondi-crm.get_open_records` call.
After: Final Phase 6 heavy first turn persisted at 19.170s from first inbound log to outbound. Guardrail reached at 544ms, cold `llm.input` followed 123ms later, and `llm.input` to outbound took 18.503s. Runtime aggregate usage was `cacheRead=22488`, `cacheWrite=16754`, `input=770`, `output=363`, and `billableInput=0`.
Delta: Versus the Phase 5 heavy sample, -3.679s. Versus the Phase 6 exploratory run, -0.907s and one fewer CRM MCP call. Treat the SDK-cache decision as rejected rather than optimized: the measured cache profile is already using the preset object's supported cache path, and no safe preset-preserving dynamic boundary exists in the installed SDK type contract.
Tool calls before: Exploratory Phase 6 heavy first turn made 1 `shopify-api.get_gifting_context` call plus 1 unwanted `boondi-crm.get_open_records` call.
Tool calls after: Final Phase 6 heavy first turn made exactly 1 MCP call: `shopify-api.get_gifting_context`; no CRM call.
Evidence: `/tmp/boondi-phase6-measurement-1781311428737.json`; `/tmp/boondi-phase6-final-measurement-1781311836427.json`; `/tmp/gantry-dev.log`; `npm run test:unit -- apps/core/test/unit/repo/boondi-scenarios.test.ts`; `BOONDI_SCENARIOS=/tmp/boondi-phase6-crm-red-scenario.json TURN_TIMEOUT_MS=150000 node scripts/boondi-regression.mjs shopify`; SDK source inspected at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
Decision: Phase 6 exit criteria are met as a documented rejection of the SDK prompt-cache spike plus a measured cleanup of the CRM routing invariant. Do not change Gantry's SDK `systemPrompt` shape unless a future SDK version supports a preset-preserving dynamic boundary. The latency plan is complete through Phase 6.
