# Boondi KB Skill Architecture Plan

Date: 2026-06-20

Status: Phase 4/5 architecture evidence is usable, Phase 6 is `Evidence ready`
for all Template_BA groups, Phase 7 has a passing 59-row live regression bundle,
Phase 8 has passing warmth plus 10-worker multi-core canary evidence, and
Phase 9 has one live proof for the generic `customer_live` prompt surface plus
latest-only SDK payload logging. Phase 10 provider-neutral identity and
order-number UX has focused live signed-webhook evidence and strict 4-row review
pass; human reviewer decision is still pending before marking it `Passed`.
Progressive Boondi KB exposure, native `Skill` availability, direct Shopify MCP
routing, product-care PRE-01 through PRE-05, PRE-06 through PRE-09 gifting,
PRE-10/DEL/POST order support, CAFE/AGG, and MISC rows now have live
signed-webhook evidence plus post-fix cross-scenario regression passes.

Goal: prove a scalable Boondi knowledge architecture where growing intent
coverage does not grow the always-on runtime prompt.

Architecture: Boondi owns business knowledge, scenario playbooks, and customer
behavior. Gantry owns the generic runtime, skill/materialization mechanics,
MCP/tool routing, audit, and live execution. Every phase must be advanced only
after live signed-webhook evidence proves the claim.

Scaling target: start with `agents/boondi_support/kb/gifting.md` for PRE-06
through PRE-09. If live evidence is promising, scale the KB pattern across all
59 scenario rows in the `Template_BA` tab of
`/Users/caw-d/Downloads/Boondi_Intent_Scenario_Template.xlsx`.

## Status Legend

- `Not started`: no implementation or evidence yet.
- `In progress`: files or checks are being changed.
- `Evidence ready`: live/test evidence exists and is linked in this document.
- `Passed`: evidence reviewed and phase acceptance met.
- `Blocked`: cannot proceed; blocker and owner recorded.

## Non-Negotiables

1. No broad prompt growth. `CLAUDE.md` and `SOUL.md` stay compact.
2. No Boondi-specific behavior moves into Gantry core.
3. No phase advances without evidence from actual signed webhook runs.
4. No final success claim without admin/API transcript, flow logs, and payload
  size evidence.
5. Static review, unit tests, or prompt inspection alone never satisfy
  acceptance. The only acceptance gate is live webhook testing plus LLM payload
   and reply evidence.
6. MCP changes are allowed when they reduce tool loops, shrink tool payloads, or
  make Boondi's answer path clearer. They must follow
   `agents/boondi_support/docs/mcp-tool-design-guide.md`.
7. No commit from Codex; the owner reviews and commits manually.
8. Make it token optimized, only make Live calls when you are sure on the code
  path. Try to save tokens as much as possible.
9. No isolated scenario fix is accepted by itself. Every behavior-affecting fix
  must rerun the current cross-scenario regression pack and prove it did not
  break another intent route, reply shape, or MCP path.

## Current Evidence Snapshot

Updated: 2026-06-20 19:10 IST.

What is proven:

- Agent-folder skill disclosure block is now present in live SDK payloads as
  `[[AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION]]`.
- Live payloads list `skills:["boondi-kb","gantry-admin"]`.
- The full `boondi-kb` runtime gifting projection is not in
  `systemPrompt.append`.
- Progressive skill exposure now keeps the native `Skill` tool available even
  when the agent narrows `tool_surface.native` to `[ToolSearch]`.
- Native SDK/direct-MCP tool calls are already persisted into reply traces when
  the SDK surfaces them as assistant `tool_use` blocks. Hidden Claude Code
  internals can now be inspected in live proof runs with explicit
  `GANTRY_CLAUDE_SDK_DEBUG_FILE=<path>`; normal runs do not enable SDK debug.
- Live signed webhook `000000829` proved the stronger native Skill trace path:
  `message_traces.timings_json` recorded a `tool` stage labeled `Skill` with
  `server:"sdk"`, and `payloads_json` recorded request
  `{skill:"boondi-kb", args:"Kaju Katli ingredients allergens cashew dairy product care"}`.
  The SDK debug file also showed `SkillTool returning ... for skill boondi-kb`.
- Live payload after the fix for `conversation:wa:000000828` contained
  `tools:["ToolSearch","Skill"]`, `skills:["boondi-kb","gantry-admin"]`,
  the progressive skill pointer, and no `boondi-kb` body.
- Live payload for `conversation:wa:000000829` contained
  `tools:["ToolSearch","Skill"]`, `skills:["boondi-kb","gantry-admin"]`,
  `debugFile` present, the progressive skill pointer, and no full KB body in
  `systemPrompt.append`.
- Product-care focused live evidence:
  `/tmp/boondi-product-care-rerun9-evidence.json` passed the four previously
  failing rows for delivery ETA, custom pack size, sugar-free, and missed-window
  discount with no `mcp_list_tools` and no KB/process leakage.
- Full product-care reruns:
  `/tmp/boondi-product-care-full-rerun4-evidence.json` passed 11/12 rows but
  exposed a remaining `pre-03-custom-pack-size` process-narration leak. This is
  recorded as a failed regression gate, not a pass.
- `/tmp/boondi-product-care-full-rerun15-evidence.json` still failed the
  regression gate before the final targeted fixes: `pre-03-custom-pack-size`
  leaked prior-context analysis and `pre-05-missed-window` emitted general
  order-date/delivery-date offer-window rules.
- Latest focused custom-pack proof:
  `/tmp/boondi-product-care-rerun15-evidence.json` passed after the final
  output-guard update. Customer-visible reply no longer included search,
  context, draft-contract, or meta-reply narration.
- Latest focused product-care proofs after the full-pack failures:
  `/tmp/boondi-focused-rerun15-evidence.json` passed travel, custom-pack, and
  sugar-free checks after deterministic travel-promise replacement and
  availability-wording normalization.
- `/tmp/boondi-focused-rerun16-evidence.json` passed custom-pack and
  missed-window checks after trimming prior-context analysis and generic
  order-date/delivery-date discount rules.
- Full product-care pass:
  `/tmp/boondi-product-care-full-rerun17-evidence.json` passed all 12 PRE-01
  through PRE-05 rows with the strict product-care parser after output-guard,
  prompt, KB, and Shopify MCP tightening.
- Mixed gifting/order focused proof:
  `/tmp/boondi-mixed-focused-rerun3-evidence.json` passed PRE-08 GST/logo and
  DEL-01 order-status after fixing process narration and phone/email fallback
  asking. Tool paths: PRE-08 used no product search; DEL-01 used no product
  search and asked only for order number.
- Mixed gifting/order regression proof:
  `/tmp/boondi-mixed-gifting-orders-rerun2-evidence.json` passed the 10-row
  PRE-06/PRE-07/PRE-08/PRE-09 plus DEL-01 pack with strict reply and tool-path
  parsing. Personal-gifting rows used Shopify search only where expected;
  PRE-08/PRE-09/DEL-01 avoided product search and internal/process leakage.
- Payload proof for the mixed rerun:
  `/tmp/boondi-mixed-rerun3-llm-sdk-query-args.json` captured 12 SDK queries.
  Every query used `tools:["ToolSearch","Skill"]`,
  `skills:["boondi-kb","gantry-admin"]`, append chars `17937`,
  `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
  `INSTALLED_SKILLS_AVAILABLE_THIS_SESSION=false`, and no full KB body markers
  such as `Gift message/card details need team confirmation` or the PRE-08 KB
  table row in `systemPrompt.append`.
- Template_BA source verification:
  `agents/boondi_support/evals/template-ba-live-scenarios.json` now matches all
  59 scenario rows from the `Template_BA` tab. A mechanical verification fixed
  29 subflow-label mismatches; rerun result was `xlsx rows 59`,
  `manifest scenarios 59`, `mismatches 0`.
- Orders baseline failure:
  `/tmp/boondi-orders-rerun1-evidence.json` failed live review. Failures
  included sensitive payment wording (`OTP`), fake CRM/Shopify tool names,
  sender display name used as lookup identity, no-bill drift into gifting
  intake, missing photo ask for wrong packaging, and invoice/GST overpromise.
- Orders focused recovery:
  `/tmp/boondi-orders-focused-rerun2-evidence.json` passed the nine failed
  order rows after prompt/KB/CRM-tool-description fixes. A later full rerun
  `/tmp/boondi-orders-rerun2-evidence.json` was not accepted because human
  review caught `del-03-date-request` process narration despite the parser
  passing.
- Orders final bundle:
  `/tmp/boondi-orders-rerun6-evidence.json` passed all 22 orders rows
  (`PRE-10`, `DEL-01` through `DEL-05`, and `POST-01` through `POST-06`) with
  the strict orders parser. It used no fake CRM tools, no product search, no
  sensitive payment credential wording, no process narration, no delivery/refund
  overpromise, and preserved photo/order-number asks where required.
- Cross-scenario regression after orders:
  `/tmp/boondi-orders-cross-regression-rerun7-evidence.json` passed
  `pre-03-custom-pack-size`, `pre-05-missed-window`, `pre-08-gst-logo`,
  `pre-09-branded-sleeve`, and `del-01-order-status` after catching and fixing
  a `pre-08-gst-logo` classifier/brief preamble leak in the prior cross run.
- Store/aggregator bundle evidence:
  `/tmp/boondi-store-aggregator-rerun7-evidence.json` captured all 11 CAFE/AGG
  rows with live replies. Light review showed CAFE rows using native `Skill`
  where store guidance was needed, AGG bill/issue rows avoiding Shopify order
  lookup, and no non-Skill MCP/API fanout in the summary.
- Misc-policy bundle evidence:
  `/tmp/boondi-misc-policy-rerun15-evidence.json` captured all 5 MISC rows with
  live replies. Spam stayed to BSS-scope response, opt-out/repeat opt-out avoided
  completion claims and identity re-asks, franchise used native `Skill`, and jobs
  stayed bounded to team confirmation.
- Latest cross-scenario regression proof:
  `/tmp/boondi-cross-regression-rerun17-evidence.json` passed
  `pre-03-custom-pack-size`, `pre-05-missed-window`, `pre-08-gst-logo`,
  `pre-09-branded-sleeve`, `del-01-order-status`, `cafe-02-nearest-store`,
  `misc-02-repeat-opt-out`, and `agg-04-bill`. The prior rerun16 correctly
  caught a store regression caused by a leading `our KB` preamble being
  fail-closed to generic scope denial; rerun17 passed after adding a targeted
  customer-output regression test and sanitizer update.
- Full Template_BA live regression:
  `/tmp/boondi-template-ba-full-rerun1-evidence.json` captured all 59 rows from
  the `Template_BA` manifest through signed Interakt webhook calls. Initial
  review found 56/59 accepted rows plus two trace-collection timing gaps and one
  customer-facing "route this" phrasing issue.
- Focused recovery for the remaining full-run blockers:
  `/tmp/boondi-template-ba-focused-rerun2-evidence.json` reran
  `pre-08-corporate-quote`, `agg-02-missing-item`, and `agg-04-bill`; strict
  review passed 3/3 with trace payloads present and no "route this" phrasing.
- Merged full-regression decision:
  `/tmp/boondi-template-ba-merged-rerun2-evidence.json` combines the 56 accepted
  rows from the full run with the 3 focused recovery rows. Strict reviewer
  result: 59/59 passed.
- Post-fix cross-scenario regression proof:
  `/tmp/boondi-template-ba-cross-rerun19-evidence.json` passed 8/8 after the
  final memory/tool-use and customer-output fixes. Scope:
  `pre-03-custom-pack-size`, `pre-05-missed-window`, `pre-08-gst-logo`,
  `pre-09-branded-sleeve`, `del-01-order-status`, `cafe-02-nearest-store`,
  `misc-02-repeat-opt-out`, and `agg-04-bill`. This rerun specifically proved
  the custom-pack row no longer used `gantry:memory_search` and aggregator bill
  wording stayed customer-facing.
- Payload proof for the full and focused reruns:
  `/tmp/boondi-template-ba-full-rerun1-llm-sdk-query-args.json` captured 59 SDK
  queries and `/tmp/boondi-template-ba-focused-rerun2-llm-sdk-query-args.json`
  captured 3 SDK queries. Every inspected entry had
  `skills:["boondi-kb","gantry-admin"]`,
  `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
  `INSTALLED_SKILLS_AVAILABLE_THIS_SESSION=false`, a progressive pointer saying
  the skill is intentionally not preloaded, and no full KB body markers such as
  `Hard source rule:`, `PRE-06 to PRE-09 runtime gifting projection`, or the KB
  source file list in `systemPrompt.append`.
- Test evidence after the latest fixes:
  `npm run test:unit -- apps/core/test/unit/application/customer-output/customer-safe-output.test.ts apps/core/test/unit/application/guardrails/customer-support-guardrails.test.ts packages/mcp-shopify/test/unit/env.test.ts packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts`
  passed 126 tests; `npm run test -- env.test.ts` in `packages/mcp-crm` passed
  12 tests; `git diff --check` passed.
- Phase 10 provider-neutral/order-number UX live proof:
  `/tmp/boondi-phase10-focused-merged-rerun2-evidence.json` passed 4/4 strict
  review with `pre-06-gift-budget`, `del-01-order-status`,
  `post-02-missing-item`, and `agg-04-bill`.
- Phase 10 source files:
  `/tmp/boondi-phase10-focused-live-evidence.json`,
  `/tmp/boondi-phase10-del01-tool-rerun-evidence.json`, and
  `/tmp/boondi-phase10-post02-fallback-rerun-evidence.json`.
- Phase 10 payload proof:
  `/tmp/boondi-phase10-final-llm-sdk-query-args.json` copied from the latest
  `llm-sdk-query-args.json` after the focused reruns had
  `skills:["boondi-kb","gantry-admin"]`, `tools:["ToolSearch","Skill"]`,
  no `Interakt`/`interakt` in `systemPrompt.append`, no
  `Gantry has supplied`, provider-neutral verified sender wording, and the
  exact `finding recent orders linked to this chat` fallback in the prompt
  append.
- Payload proof for orders/cross reruns:
  `/tmp/boondi-orders-rerun6-llm-sdk-query-args.json` captured 28 SDK queries
  and `/tmp/boondi-orders-rerun7-llm-sdk-query-args.json` captured 6 SDK
  queries. Sampled queries had append chars `19341`,
  `skills:["boondi-kb","gantry-admin"]`,
  `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
  `INSTALLED_SKILLS_AVAILABLE_THIS_SESSION=false`, and no sampled full KB body
  markers such as `Boondi Orders KB`, `Boondi Gifting KB`,
  `Source Scenarios`, or gift-message table text in `systemPrompt.append`.
- Tool-path hardening evidence: targeted unit suite passed after the latest
  changes: `npm run test:unit -- apps/core/test/unit/application/customer-output/customer-safe-output.test.ts packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts` passed 77 tests.
- Whitespace check passed: `git diff --check`.
- Customer-live prompt-surface proof:
  `/tmp/boondi-customer-live-prompt-surface-evidence-final.json` passed one
  signed webhook for `pre-06-gift-budget`. The run returned webhook status
  `200`, `replyReceived:true`, and trace stages for native `Skill` plus
  `shopify-api.search_products`.
- Latest-only SDK payload proof:
  `llm-sdk-query-args.json` was rewritten as a single JSON object, not appended
  as a growing array. The latest captured keys were
  `capturedAt,path,prompt,rawPrompt,options`; the path was `warm_bound_worker`.
  The file stayed compact at 195 lines for the inspected live run.
- Customer-live prompt content proof:
  latest `llm-sdk-query-args.json` had no `[[CAPABILITY_GUIDANCE]]`, no
  `[[OPERATING_GUIDANCE]]`, no full `# Gantry Runtime Rules`, and no full
  `## Gantry Durable Memory Boundary`. It kept `## Memory Boundary`,
  `[[RUNTIME_RULES]]`, `# Runtime Rules`, `[[SOUL]]`, `[[GROUP_CONTEXT]]`,
  `[[AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION]]`,
  `## Boondi Scope Check For This Turn`, `## Approved MCP Services`,
  `shopify-api`, and `boondi-crm`.
- Customer-live implementation paths:
  `apps/core/src/shared/prompt-surface.ts`,
  `apps/core/src/application/agents/prompt-profile-service.ts`,
  `apps/core/src/runner/memory-boundary.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/system-prompt.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`,
  and
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/sdk-query-args-log.ts`.
  Settings parse/render/export plumbing is in the runtime settings and desired
  state services.
- Customer-live focused tests:
  `npm run test:unit -- apps/core/test/unit/runtime/prompt-profile.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/runner/sdk-query-args-log.test.ts apps/core/test/unit/runner/system-prompt.test.ts`
  passed 98 tests across 4 files. `npm run typecheck` passed.

Current blocker before broader `Passed`:

- Human reviewer decision is still pending before marking Phase 4/5/6/7
  `Passed`.
- Future row-level fixes must continue rerunning the relevant cross-scenario
  pack before a scenario can be accepted. This remains required by
  Non-Negotiable #9.
- A Boondi-owned Template_BA live eval manifest and runner now exist for
  scalable evidence collection:
  `agents/boondi_support/evals/template-ba-live-scenarios.json` and
  `agents/boondi_support/evals/run-template-ba-live.ts`.
- Live signed webhook `000000828` for Kaju Katli allergens returned the
  KB-consistent answer: cashew/tree nuts, no dairy. Earlier probes
  `000000825` through `000000827` answered from general knowledge and exposed
  the missing native `Skill` tool bug.
- The earlier `boondi-kb.read_skill_file` / `MCP server is not approved for
  this agent: boondi-kb` failure is fixed by boundary guidance plus native
  Skill exposure; selected skills are not treated as MCP servers.
- `CLAUDE.md` stayed compact and synced at runtime through `CLAUDE.md@v12`.
- Shopify MCP `search_products` defaults to a compact 3-product result and
  accepts `maxPrice`.
- Shopify MCP product search cache is enabled in the live MCP with
  `productSearchCacheTtlMs=86400000` and
  `productSearchCacheRefreshLeadMs=600000`.
- Unit evidence proves product search cache hit and near-expiry refresh.
- Live evidence proved one cache-hit turn dropped `search_products` tool
  duration from ~1081ms to 22ms when the query key matched.
- PRE-06 personal birthday gift under Rs 500 now replies website-first using a
  customer-safe `search_products` reply contract.
- A bulk wedding-hamper regression was caught live: the final reply was correct,
  but the MCP initially returned a personal-gift draft for a wedding-hamper
  query. The MCP now suppresses personal-gift drafts for bulk/event/corporate
  signals, with unit and live replay evidence.
- A non-gifting order-support live turn used `shopify-api.get_order` and did
  not become gifting-flavored.
- PRE-06 roka/personal-occasion gifting now has a passing rerun after fixing an
  over-budget product leak from the MCP response shape.
- PRE-08 corporate 100-unit quote now routes directly to brief capture without
  Shopify product search or CRM lookup.
- PRE-08 GST/logo branding routes to corporate gifting and captures missing
  budget/location/date without source/tool fanout.
- PRE-09 custom message card and logo/custom-box questions now route to team
  confirmation without feasibility promises or unnecessary MCP calls.
- PRE-06 roka regression now returns product alternatives under budget and does
  not convert the shortlist into a combined hamper.
- Focused tests passed after the latest fixes:
  - `npm run test:unit -- packages/mcp-shopify/test/unit/tools/gifting-context.test.ts packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts packages/mcp-shopify/test/unit/env.test.ts packages/mcp-shopify/test/unit/server-health.test.ts packages/mcp-shopify/test/unit/server-identity-mode.test.ts apps/core/test/unit/runtime/session-resume-runtime.test.ts`
  - `npm test --workspace @gantry/mcp-crm -- test/get-last-query-or-lead.test.ts test/get-open-records.test.ts`
  - `npm run test:unit -- apps/core/test/unit/runner/agent-runner-ipc.test.ts apps/core/test/unit/runner/native-sdk-skills.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runtime/session-resume-runtime.test.ts`

What is not accepted yet:

- Human reviewer decision is still pending before marking the phases `Passed`.
- Bulk wedding-hamper replay still made one `search_products` call before
  routing correctly. Reply correctness and MCP response shape passed; future
  optimization can reduce that remaining unnecessary product call.
- Phase 6 scaling now has all-group live evidence and a merged 59-row strict
  review pass. Keep it `Evidence ready` until human review accepts the bundle.
- Historical product-care baseline run `000001200` through `000001211`
  collected live replies for all 12 PRE-01 to PRE-05 scenarios, but it failed
  acceptance:
  unsupported shelf-life/storage/travel/discount-window facts were invented,
  Kaju Katli dairy status was over-asserted, and several rows called
  `mcp_list_tools`. This is recorded as a useful baseline failure, not a pass.

## Target Boundary


| Surface                           | Owner                 | Rule                                                                               |
| --------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `agents/boondi_support/CLAUDE.md` | Boondi                | Tiny runtime router and hard safety boundaries only.                               |
| `agents/boondi_support/SOUL.md`   | Boondi                | Voice and customer experience only.                                                |
| `agents/boondi_support/kb/*.md`   | Boondi                | Human-owned business knowledge source.                                             |
| `agents/boondi_support/skills/**` | Boondi/Gantry adapter | Runtime skill projection only if needed.                                           |
| Gifting scenario playbook         | Boondi                | Offline evaluator; never injected into every live turn.                            |
| Shopify/CRM MCP                   | Boondi tools          | Live truth for products, orders, and lead/query records.                           |
| `packages/mcp-crm`                | Boondi CRM MCP        | Compact CRM opportunity/query reads, including `get_last_query_or_lead`.           |
| `packages/mcp-shopify`            | Shopify MCP           | Compact Shopify product/order/gifting reads; enhance only when live flow needs it. |
| Gantry runtime                    | Gantry                | Generic skill execution, prompt assembly, MCP policy, audit.                       |


## MCP Design Rules For This Plan

Source: `agents/boondi_support/docs/mcp-tool-design-guide.md`.

- Optimize the customer turn, not the number of exposed tools.
- Prefer one compact aggregate call over several tiny calls when the common
customer answer always needs the same data.
- Avoid forcing the main LLM to call `mcp_list_tools` when the runtime already
knows the right MCP/tool.
- Keep JSON compact, stable, and customer-safe.
- Use verified caller identity for customer data. Do not trust phone/email/order
identity supplied by the LLM when Gantry can project identity.
- Make common customer calls argument-free where possible.
- Do not duplicate live truth in KB files. KBs should guide behavior; MCPs
provide fresh customer/product/order data.
- Add or modify MCP tools only after a scenario proves the current path needs
fewer calls, smaller payloads, better aggregation, or safer wording.

## Cross-Scenario Regression Gate

Purpose: prevent a fix for one intent from changing another intent's route,
reply contract, or tool path.

Rule: after every KB, prompt, router, MCP, or runtime change that affects live
Boondi behavior, rerun the smallest stable regression pack that covers the
changed surface plus known fragile boundaries. A target scenario can be marked
`Passed` only when the target scenario and regression pack pass together.

Stable pack as of 2026-06-20:

| Guarded boundary | Representative intent | Expected invariant |
| --- | --- | --- |
| Personal gifting remains website-first | PRE-06 birthday/roka under budget | At most 3 alternatives, under budget, no fake live-stock claim, no combined hamper unless asked. |
| Bulk/event gifting stays team-routed | PRE-07 wedding/baby announcement 25+ | Capture quantity, budget, location, timeline, customisation; no personal gift draft or product shortlist unless asked. |
| Corporate/B2B does not fan out | PRE-08 25+ / GST / logo | Capture quote brief; no Shopify search or CRM lookup unless continuing a known record or product examples are requested. |
| Customisation is not over-promised | PRE-09 message card / logo sleeve | Team/source confirmation boundary; no "definitely", "available", "possible", or feasibility promise without evidence. |
| Non-gifting order support stays non-gifting | DEL-01 order status | Uses order source, not gifting language or gifting MCP paths. |
| Product-care/allergen uses KB/source facts | PRE-04 allergen/product-care | Uses confirmed KB/source facts; no general-knowledge substitution when `boondi-kb` governs the answer. |
| Customer-chat tool path stays minimal | Any above | No `mcp_list_tools`, no skill-as-MCP calls, no broad discovery/fanout when a direct route exists. |

Evidence required for the pack:

- signed webhook ACK for every rerun scenario;
- actual Boondi reply captured from admin/API or persisted transcript;
- LLM payload shape for at least one representative run after the change;
- flow-log or trace evidence of called MCP tools, including the absence of
  calls when no MCP should be used;
- explicit pass/fail note for every guarded boundary.

Failure handling:

- If a regression fails, the target fix remains `In progress` even if its own
  scenario reply looked correct.
- Record the failed phone number/conversation id in Phase 4 or the active phase
  evidence table.
- Fix the smallest responsible layer: KB, router prompt, MCP tool contract,
  guardrail, CRM extraction, Shopify source adapter, or Gantry runtime.
- Rerun the failed target and the impacted stable pack members before marking
  any row `Passed`.

## Phase 0: Baseline Evidence

Status: Evidence ready for static payload baseline; live baseline pending.

Purpose: record the current system before changing prompt or KB structure.

Scope:

- Inspect current LLM payload shape from `llm-sdk-query-args.json`.
- Record `systemPrompt.append` size and selected SDK skills.
- Capture current `CLAUDE.md` gifting section size.
- Run current live behavior for a small scenario bundle.

Evidence to collect:

- Payload size and `systemPrompt.append` character count.
- `skills` array from payload.
- Whether `boondi-kb` body appears in `systemPrompt.append`.
- Signed webhook replies for:
  - personal birthday gift under Rs 500
  - 30 wedding hampers
  - custom message card
  - one non-gifting order-support turn
- Admin transcript links and flow-log snippets.

Static evidence captured on 2026-06-20 from `llm-sdk-query-args.json`:

- 17 captured SDK query payloads.
- `options.skills` contained `["boondi-kb","gantry-admin"]` in every captured
  payload.
- `systemPrompt.append` sizes were 14,892 chars for captures 0-14, 12,594 chars
  for capture 15, and 13,212 chars for capture 16.
- `systemPrompt.append` did not contain the `boondi-kb` body, did not contain
  `[[INSTALLED_SKILLS_AVAILABLE_THIS_SESSION]]`, and did not contain the KB
  phrase `Gifting & business-interest cues`.
- Whole-payload JSON did not contain the KB body phrase `The five gifting
  questions`; it contained only the skill names.

Code evidence checked:

- Agent-folder SDK skills are materialized from
  `agents/boondi_support/skills/<id>/SKILL.md` only when the id is declared
  under `plugins.skills` in runtime settings.
- `agents/boondi_support/kb/*.md` is not automatically copied into the SDK
  skill folder by the materializer.
- Current live runtime settings under `/Users/caw-d/gantry/settings.yaml`
  enable only `boondi-kb` under `agents.boondi_support.plugins.skills`.
- Current runtime folder `/Users/caw-d/gantry/agents/boondi_support` symlinks
  `CLAUDE.md`, `SOUL.md`, `skills/`, `commands/`, `guardrails/`,
  `memory_extractor/`, and `pre-run-context/`, but not the newly created `kb/`
  directory. Therefore `kb/gifting.md` is the repo source, while
  `boondi-kb/SKILL.md` carries the runtime-critical gifting projection for the
  first live proof.

Acceptance:

- Baseline is documented here with exact commands, timestamps, payload metrics,
and actual Boondi replies.

## Phase 1: Minimal KB Source Shape

Status: Evidence ready for source shape; runtime behavior still under Phase 4.

Purpose: create a human-owned knowledge source without changing runtime behavior
more than necessary.

Proposed source:

```text
agents/boondi_support/kb/gifting.md
```

Content limit:

- PRE-06 to PRE-09 only.
- Routing rules, intake fields, handoff rules, and MCP boundaries.
- No large product catalogue.
- No transcript dump.

Acceptance:

- The file is readable by a Boondi business owner.
- The file clearly separates:
  - under-25 personal gifting
  - occasion/event gifting
  - 25+ corporate/bulk gifting
  - custom message/customisation/gift wrapping
- It states when Shopify MCP is required and when a human handoff is required.

Files changed:

- `agents/boondi_support/kb/gifting.md` created as the Boondi-owned source KB
  for PRE-06 through PRE-09.
- `agents/boondi_support/skills/boondi-kb/SKILL.md` changed to progressive
  disclosure and updated as the runtime entry point with a compact PRE-06 to
  PRE-09 projection, because the live runtime folder does not yet symlink
  `kb/`.
- `agents/boondi_support/CLAUDE.md` reduced from detailed gifting scenario
  rules to a compact router.

Evidence still required before marking Passed:

- Live run proves Boondi can use the gifting KB path after the `boondi-kb` skill
  is opened.
- Payload capture proves the KB body is not added to `systemPrompt.append`.
- Reply evidence proves non-gifting turns do not become gifting-flavored.

Evidence captured:

- Live payload entries on 2026-06-20 showed append sizes 14,674 and 14,717
  chars with `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`.
- Those payloads included `boondi-kb` description only and did not include the
  full PRE-06 to PRE-09 skill body.
- Runtime prompt sync confirmed `CLAUDE.md@v6`.
- Latest live payload capture on 2026-06-20 05:02 IST:
  - 4 SDK payload entries
  - append chars: 14,915 for each entry
  - skills: `["boondi-kb","gantry-admin"]`
  - `hasAgentFolderBlock:true`
  - `hasFullKbBody:false`
  - `hasBoondiKbDescription:true`
  - tested prompts: personal birthday gift, bulk wedding hampers before/after
    MCP draft suppression, and order support.

## Phase 2: Runtime Projection Proof

Status: Evidence ready for selected mechanism and gifting live bundle; reviewer
decision pending.

Purpose: prove the cleanest way to expose `kb/gifting.md` to the LLM without
polluting always-on context or adding unnecessary MCP loops.

Options to test:

1. Agent-folder Claude SDK skill projection.
2. Gantry-controlled pre-run retrieval or MCP KB lookup.
3. Hybrid: short SDK skill router plus controlled KB lookup.
4. MCP aggregate/read enhancement when a live scenario needs fresh data and the
  current tool path requires multiple calls or oversized tool results.

Evidence to collect for each option:

- Payload `systemPrompt.append` size before and after.
- Whether the full gifting KB body appears in always-on prompt text.
- Live reply quality on the same Phase 0 scenario bundle.
- Flow-log proof of any tool/MCP calls.
- MCP call count per customer turn.
- Tool result payload size or compactness notes.
- Latency and `replySeconds`.

Acceptance:

- Pick one mechanism only after evidence shows it keeps prompt growth bounded
and preserves reply quality.
- If MCP enhancement is selected, the design must name the exact customer
question, required data, one-call shape, response envelope, identity boundary,
and live scenario that proves it.

Decision from evidence:

- Use a hybrid:
  - Gantry generic runtime adds a compact agent-folder skill summary block for
    selected skills.
  - Boondi keeps human-owned KB under `agents/boondi_support/kb/`.
  - Boondi-owned SDK skill `boondi-kb` remains the runtime pointer/projection.
  - Shopify/CRM MCPs remain the live truth for product/order/customer data.

Payload evidence:

- `/tmp/boondi-kb-llm-sdk-query-args.json` entries for phones `000000788`,
  `000000789`, and `000000790` had:
  - `skills:["boondi-kb","gantry-admin"]`
  - `hasAgentFolderBlock:true`
  - `hasFullKbBody:false`
  - append chars: 14,674 to 14,717
- `/tmp/boondi-kb-llm-sdk-query-args.json` latest capture had 4 entries for:
  - `000000791` personal birthday gift
  - `000000792` bulk wedding-hamper regression before MCP draft suppression
  - `000000794` bulk wedding-hamper replay after MCP draft suppression
  - `000000795` non-gifting order support
- All 4 latest payload entries had append chars 14,915,
  `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`, selected skills
  `["boondi-kb","gantry-admin"]`, and no full `boondi-kb` body in
  `systemPrompt.append`.

Code evidence:

- `apps/core/src/runtime/session-resume-runtime.ts` builds the generic
  `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION` block.
- Progressive agent-folder skill entries expose id/description/pointer only.
- Non-progressive agent-folder skill entries are bounded and explicit.

## Phase 2A: MCP Call Path Review

Status: Evidence ready for gifting and full Template_BA coverage.

Purpose: decide whether the promising `gifting.md` path needs CRM or Shopify MCP
changes before broader migration.

Known starting point:

- CRM already has `boondi-crm.get_last_query_or_lead({})` for compact returning
query/lead context.
- Shopify has `shopify-api.get_gifting_context` for compact gifting-related
order/product context, but it has not been redesigned as part of this plan.

Review questions:


| Question                                                                       | Evidence needed                                              | Possible action                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Does Boondi need latest CRM query/lead before the LLM answers?                 | Flow logs show repeated live LLM CRM discovery/calls.        | Use or extend server-side pre-run context with `get_last_query_or_lead`. |
| Does a gifting turn require latest order plus product guidance?                | Flow logs show multiple Shopify calls or large tool results. | Enhance `get_gifting_context` or add a narrower aggregate read.          |
| Does the model call broad search/list tools when a compact default would work? | MCP trace shows fanout or oversized results.                 | Add a compact default tool or tighten tool descriptions.                 |
| Does KB duplicate live product/order truth?                                    | KB includes stock/price/order facts.                         | Move those facts behind Shopify/CRM MCP.                                 |


Acceptance:

- Every proposed MCP change is tied to a live scenario failure or measured
tool-loop inefficiency.
- No MCP change is accepted just because it is architecturally neat.
- The preferred path minimizes LLM decisions, MCP calls, and tool-result size.

Changes made from live evidence:

- `packages/mcp-shopify/src/tools/search-products.ts`
  - default `limit` changed to 3
  - `maxPrice` alias added
  - tool description tightened to one targeted query and no guaranteed live
    stock wording
  - 24h product search cache support added through `ProductSearchCache`
  - common gift/birthday empty-search fallback added inside the tool so the LLM
    should not need extra search fanout
  - personal gifting `customerReplyDraft` and `replyContract` added for simple
    gifting product searches, so website-first wording is deterministic without
    growing `CLAUDE.md`
  - personal gifting draft is suppressed for bulk/event/corporate terms such as
    wedding, guest, client, employee, GST, branding, quote, multi-city, or
    pan-India
  - personal gifting responses are capped to the same three products used in
    the customer-safe draft, even if the LLM asks for a larger `limit`
  - tool description now explicitly says not to use product search for
    bulk/corporate quote routing, GST, logo/branding, or customisation-only
    questions unless the customer asks for product examples
- `packages/mcp-shopify/src/tools/get-gifting-context.ts`
  - `productQuery` alias added
  - `maxPrice` alias added
  - `includeLatestOrder` default changed to false so simple personal gifting
    does not leak previous-order context
  - shared product search cache wired for product query reads
- `packages/mcp-shopify/src/server.ts`
  - product search cache is process-owned and reused across per-request MCP
    server instances
- `packages/mcp-shopify/src/env.ts`
  - `SHOPIFY_PRODUCT_SEARCH_CACHE_TTL_MS` default: 86,400,000 ms
  - `SHOPIFY_PRODUCT_SEARCH_CACHE_REFRESH_LEAD_MS` default: 600,000 ms
- `packages/mcp-crm/src/tools/get-open-records.ts`
  - tool description narrowed so it is not advertised for brand-new one-off
    product, gift-message, policy, checkout, or customisation questions
- `packages/mcp-crm/src/tools/get-last-query-or-lead.ts`
  - tool description narrowed to prior-context continuation only, not clear
    standalone new quote/gift-message/product/order requests

Live evidence:

- `000000786`: one `search_products` call, compact 3-product result, no previous
  order leakage.
- `000000787`: cache-hit proof before later prompt fixes; same `gift` query
  returned in 22ms versus ~1081ms first-fill duration.
- `000000789`: before fallback code, LLM fanned out across three product
  searches after empty results. This was treated as a failure and fixed in MCP.
- `000000790`: after fallback code deployment, latest run used one
  `search_products` call with compact 3-product result. The fallback path was
  not exercised live because the model chose `query:"gift"`.
- `000000791`: after reply-contract change, one `search_products` call returned
  3 compact products, `customerReplyDraft`, and `replyContract`; outbound reply
  led with "You can order directly on our website".
- `000000792`: bulk wedding-hamper run exposed cross-scenario pollution: the
  final reply routed correctly to bulk/corporate, but `search_products` returned
  a personal birthday-gift draft for `query:"gift hamper wedding"`.
- `000000794`: after MCP draft suppression, the same bulk wedding-hamper replay
  returned only `products` and `matchedQuery`, no `customerReplyDraft` or
  `replyContract`; outbound reply stayed bulk/corporate.
- `000000795`: non-gifting order support called `shopify-api.get_order`, did
  not call product/gifting tools, and replied with order status only.
- `000000796`: roka/personal-occasion first run exposed a product-response
  safety bug: the model requested `limit:5`, MCP returned five products, and
  the final reply claimed all options were under ₹900 while including a ₹990
  option. Fixed by capping personal-gifting response products to the draft's
  three products.
- `000000800`: roka replay after response cap returned three products only,
  included `mustSuggestAtMostThreeProducts`, and final reply was
  occasion-led, website/self-serve, and within budget.
- `000000797`: corporate 100-unit first run replied correctly but made one
  unnecessary `search_products` call. Fixed by tightening Shopify
  `search_products` description away from bulk/corporate quote routing.
- `000000801`: corporate retest removed Shopify product search but still made
  one unnecessary `boondi-crm.get_last_query_or_lead` returning `{found:false}`.
  Fixed by tightening CRM latest-record description to prior-context only.
- `000000803`: corporate final retest made no MCP calls and replied with direct
  B2B brief capture.
- `000000798`: GST/logo branding live run made no MCP calls, routed to
  corporate gifting, and captured missing budget/location/date.
- `000000799`: custom message first run replied acceptably but made an
  unnecessary `boondi-crm.get_open_records` call. Fixed by narrowing CRM
  open-record description.
- `000000802`: custom message replay made no MCP calls and replied with checkout
  gift-message guidance plus team confirmation boundary.

Remaining optimization:

- Bulk wedding-hamper replay still made one `search_products` call before
  routing correctly. This is acceptable for reply correctness after the MCP
  draft suppression, but it is not yet the minimum ideal MCP path.

## Phase 3: Minimal `CLAUDE.md` Router

Status: Evidence ready for tested gifting paths; reviewer decision pending.

Purpose: move detailed gifting behavior out of the always-on prompt while
keeping the runtime direction explicit.

Allowed `CLAUDE.md` responsibility:

- Tell Boondi that gifting/product/order factual guidance must come from the
relevant Boondi KB or MCP source.
- Preserve hard rules:
  - no invented stock
  - no invented price
  - no delivery promise
  - no firm quote
  - no customisation feasibility promise
  - under-25 personal gifting is website/self-serve first

Not allowed:

- Large PRE-06 to PRE-09 scenario detail.
- Full recommendation tables.
- Transcript examples.

Acceptance:

- `CLAUDE.md` gets smaller or stays roughly flat.
- Gifting rules are still recoverable through the chosen KB path.
- Non-gifting turns do not become gifting-flavored.

## Phase 4: Live Gifting Proof

Status: Evidence ready; full regression passed; human reviewer decision pending.

Purpose: prove customer-visible behavior with actual inbound webhook calls.

Required live scenarios:


| Scenario                              | Expected behavior                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Birthday gift under Rs 500            | Warm personal-gifting answer, max 3 options, website-first, no fake stock claim.           |
| Roka or anniversary gift              | Occasion-led tone, asks only missing useful detail, no corporate over-routing.             |
| 30 wedding hampers                    | Bulk/event route, captures quantity/budget/location/date, hands off if needed.             |
| Corporate 100 units with GST/branding | Efficient B2B route, handoff brief, no firm quote promise.                                 |
| Custom message card                   | Explains checkout gift-message route if self-serve; handoff only if feasibility is needed. |
| Non-gifting order support             | Uses order-support behavior, not gifting KB language.                                      |


Evidence to collect:

- Raw signed webhook command or script invocation.
- Admin/API transcript.
- Flow-log lines for guardrail, LLM, MCP/tool calls, and outbound reply.
- MCP call count and called tool names.
- Tool result payload notes for any CRM or Shopify response used by Boondi.
- `replySeconds` and latency stages where available.
- Payload capture for at least one gifting turn after the change.

Acceptance:

- Every scenario produces one customer-visible reply.
- Replies match Boondi voice and expected route.
- No internal prompt/tool/config leakage.
- Tool use matches the scenario need.
- The turn uses the minimum useful MCP path. Extra discovery/fanout is treated
as a failure to diagnose before scaling.

Live PRE-06 evidence:

- `000000788`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - MCP duration: 1091ms first fill
  - Reply did not say "available right now"
  - Failure: website/self-serve not first
- `000000789`
  - Webhook ACK: 200
  - Tool path: three `shopify-api.search_products` calls after empty searches
  - Failure: tool fanout; fixed with internal MCP fallback after this run
- `000000790`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - MCP duration: 1078ms first fill after Shopify restart
  - Admin API: `/api/conversations` returned conversation
    `conversation:wa:000000790` with one inbound and one outbound
  - Reply: "All three are listed on our website..." appears after options
  - Failure: website/self-serve still not first sentence
- `000000791`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - MCP duration: 1583ms first fill after Shopify restart
  - Tool response: compact 3 products plus customer-safe
    `customerReplyDraft` and `replyContract`
  - Payload: latest SDK capture entry had `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
    selected skills `["boondi-kb","gantry-admin"]`, and no full KB body in
    `systemPrompt.append`
  - Admin API: `/api/conversations` returned `conversation:wa:000000791` with
    one inbound and one outbound
  - Reply: "You can order directly on our website..." first sentence
  - Result: PRE-06 birthday gift under Rs 500 passed for this live run

Live regression evidence:

- `000000792`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Failure caught: tool response included a personal birthday-gift
    `customerReplyDraft` for a bulk wedding-hamper query, even though the final
    customer reply routed correctly as bulk/corporate
- `000000794`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Tool response after fix: `products` plus `matchedQuery`, no
    `customerReplyDraft`, no `replyContract`
  - Admin API: `/api/conversations` returned `conversation:wa:000000794` with
    one inbound and one outbound
  - Reply: bulk/corporate route, captured delivery/date/customisation, no
    personal-gift recommendation language
  - Result: bulk wedding-hamper regression passed for reply correctness and MCP
    response shape; one unnecessary product call remains to optimize later
- `000000795`
  - Webhook ACK: 200
  - Tool path: one `shopify-api.get_order`
  - Admin API: `/api/conversations` returned `conversation:wa:000000795` with
    one inbound and one outbound
  - Reply: order status and item summary only
  - Result: non-gifting order-support regression passed

Additional Phase 4 live evidence:

- `000000796`
  - Scenario: PRE-06 roka/personal occasion
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Failure caught: MCP returned five products after `limit:5`; final reply
    included a ₹990 product while saying options were under ₹900
  - Fix: cap personal-gifting MCP response products to the same three products
    used in the customer-safe draft
- `000000800`
  - Scenario: PRE-06 roka/personal occasion rerun
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Tool response: 3 products only, `customerReplyDraft`, `replyContract`, and
    `mustSuggestAtMostThreeProducts:true`
  - Admin API: `/api/conversations` returned `conversation:wa:000000800` with
    one inbound and one outbound
  - Reply: occasion-led, website/self-serve, within the ₹900 budget, no fake
    live-stock claim
  - Result: passed
- `000000797`
  - Scenario: PRE-08 corporate 100-unit quote
  - Webhook ACK: 200
  - Tool path: one unnecessary `shopify-api.search_products`
  - Reply: corporate route and brief capture, but tool path was not minimal
  - Fix: narrow `search_products` description away from bulk/corporate quote,
    GST, logo/branding, and customisation-only routing
- `000000801`
  - Scenario: PRE-08 corporate 100-unit quote rerun
  - Webhook ACK: 200
  - Tool path: unnecessary `boondi-crm.get_last_query_or_lead`, returning
    `{found:false}`; no Shopify product search
  - Reply: corporate route and brief capture, but CRM path was still not
    minimal
  - Fix: narrow `get_last_query_or_lead` to prior-context continuation only
- `000000803`
  - Scenario: PRE-08 corporate 100-unit quote final rerun
  - Webhook ACK: 200
  - Tool path: no MCP calls
  - Payload: SDK capture had append chars 14,915,
    `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
    `skills:["boondi-kb","gantry-admin"]`, and no full KB body
  - Admin API: `/api/conversations` returned `conversation:wa:000000803` with
    one inbound and one outbound
  - Reply: B2B route, captured budget/branding/date, no product-search fanout
  - Result: passed
- `000000798`
  - Scenario: PRE-08 GST invoice + logo branding
  - Webhook ACK: 200
  - Tool path: no MCP calls
  - Admin API: `/api/conversations` returned `conversation:wa:000000798` with
    one inbound and one outbound
  - Reply: corporate gifting route, captured budget/location/date, did not
    promise GST/branding feasibility
  - Result: passed
- `000000799`
  - Scenario: PRE-09 custom message card
  - Webhook ACK: 200
  - Tool path: unnecessary `boondi-crm.get_open_records`, returning
    `{found:false,records:[]}`
  - Reply: acceptable content, but tool path was not minimal
  - Fix: narrow `get_open_records` away from brand-new one-off gift-message,
    product, policy, checkout, or customisation questions
- `000000802`
  - Scenario: PRE-09 custom message card rerun
  - Webhook ACK: 200
  - Tool path: no MCP calls
  - Payload: SDK capture had append chars 14,915,
    `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
    `skills:["boondi-kb","gantry-admin"]`, and no full KB body
  - Admin API: `/api/conversations` returned `conversation:wa:000000802` with
    one inbound and one outbound
  - Reply: checkout gift-message guidance, team-confirmation boundary, asks
    order state and occasion only
  - Result: passed
- `000000804`
  - Scenario: PRE-07 baby announcement gifting, about 40 boxes
  - Webhook ACK: 200
  - Tool path: no MCP calls
  - Reply: warm baby-occasion tone, treated 40 boxes as bulk/team route,
    captured budget/timeline/customisation
  - Result: passed
- `000000805`
  - Scenario: PRE-07 haldi/personal ceremony
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Reply: website-first, personal route, options under budget, no stock
    guarantee
  - Result: passed
- `000000806`, `000000807`, `000000808`, `000000811`, `000000816`,
  `000000817`
  - Scenarios: PRE-09 branded sleeve/logo and custom message card regressions
  - Webhook ACK: 200 for each
  - Failures caught:
    - logo/custom-box replies used unconfirmed feasibility wording such as
      "definitely" and "what's possible"
    - gift-message reply used loose source wording such as "usually" and
      "what's available"
    - one gift-message replay made an unnecessary failed
      `shopify-api.list_tools` call
  - Fixes:
    - tightened `CLAUDE.md` customisation/message-card answer shape
    - forbade customer-chat tool discovery calls in the Boondi router
  - Result: failed intermediate evidence; kept as regression proof
- `000000809`
  - Scenario: PRE-06 roka regression after first product cap fix
  - Webhook ACK: 200
  - Tool path: one `shopify-api.search_products`
  - Failure caught: final reply converted three alternatives into a combined
    ₹925 set, exceeding the ₹900 budget
  - Fix: Shopify MCP gift draft now says products are alternatives, excludes
    accessory-only gift bags from personal gift recommendations, and returns
    `mustPresentProductsAsAlternatives:true`
  - Result: failed intermediate evidence; kept as regression proof
- `000000812`, `000000813`, `000000814`, `000000815`
  - Scenarios: logo/custom box, roka, corporate 100-unit quote, custom message
    card replay after MCP/prompt fixes
  - Webhook ACK: 200 for each
  - Passing evidence:
    - `000000812`: no MCP calls; logo/custom-box reply routed to team
      confirmation without "possible/available/doable/guaranteed"
    - `000000813`: one `search_products`; tool returned two non-accessory
      alternatives under ₹900 with `mustPresentProductsAsAlternatives:true`;
      reply did not combine them
    - `000000814`: no MCP calls; corporate route captured quote brief
    - `000000815`: reply content safe, but this run exposed an unnecessary
      failed `shopify-api.list_tools` call
  - Result: partial pass; led to the final `list_tools` prompt fix
- `000000820`, `000000821`, `000000822`
  - Scenarios: final custom message card, final logo/custom box, final roka
    product recommendation replay using `CLAUDE.md@v12`
  - Webhook ACK: 200 for each
  - Tool path:
    - `000000820`: no MCP calls
    - `000000821`: no MCP calls
    - `000000822`: one `shopify-api.search_products`
  - Tool response for `000000822`: two products only, no accessory-only gift
    bag, `customerReplyDraft`, `mustSuggestAtMostThreeProducts:true`, and
    `mustPresentProductsAsAlternatives:true`
  - Replies:
    - `000000820`: gift-message details need team confirmation for the order;
      asks product/order, quantity, and delivery date
    - `000000821`: customisation needs team confirmation; asks quantity,
      timeline, occasion, and delivery city
    - `000000822`: roka reply is website-first, lists two individual options
      under ₹900, and states they are not a combined hamper
  - Result: passed final regression bundle
- `000000824`
  - Scenario: bulk gifting intake checklist
  - Webhook ACK: 200
  - Payload: `skills:["boondi-kb","gantry-admin"]`, progressive
    `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION` block, no full KB body, and
    no `mcp_call_tool` / `read_skill_file` failure
  - Reply: asked occasion, quantity, budget, delivery locations, timeline, and
    customisation; no product search or source fanout
  - Result: passed prompt-pollution and MCP-boundary proof, but not sufficient
    alone for on-demand skill opening because the model could answer from
    visible router guidance
- `000000825`, `000000826`, `000000827`
  - Scenario: Kaju Katli allergen proof before native Skill exposure fix
  - Webhook ACK: 200 for each
  - Payload: selected SDK skills existed and the KB body was not injected, but
    `tools` was only `["ToolSearch"]`
  - Replies: answered from general knowledge and/or incorrectly mentioned
    Shopify/product lookup; this exposed the missing native `Skill` tool under
    Boondi's narrowed `tool_surface.native: [ToolSearch]`
  - Result: failed intermediate evidence; fixed by keeping `Skill` available
    whenever materialized SDK skills are enabled
- `000000828`
  - Scenario: Kaju Katli allergen proof after native Skill exposure fix
  - Webhook ACK: 200
  - Payload: `skills:["boondi-kb","gantry-admin"]`,
    `tools:["ToolSearch","Skill"]`, progressive skill pointer present, no full
    KB body (`Kaju Katli — contains tree nuts`, `PRE-06 to PRE-09 runtime
    gifting projection`, and `The five gifting questions` absent from
    `systemPrompt.append`)
  - Reply: "Kaju Katli contains cashew (tree nuts). It does not contain dairy"
    with label-check caveat
  - Result: passed first on-demand KB proof by live payload and reply behavior.
    No `mcp_call_tool`, `read_skill_file`, or `MCP server is not approved`
    failure appeared. Persisted `message_traces` did not expose a separate
    native Skill call. Code review confirms surfaced SDK `tool_use` blocks are
    already recorded, and `GANTRY_CLAUDE_SDK_DEBUG_FILE=<path>` is now available
    for live debug-file proof when Claude Code hides native Skill internals.
- `000000829`
  - Scenario: PRE-04 product-care/allergen proof after adding SDK debug-file
    bridge and Phase 6 runtime projections
  - Webhook ACK: 200
  - Payload: `skills:["boondi-kb","gantry-admin"]`,
    `tools:["ToolSearch","Skill"]`, `debugFile` present, progressive skill
    pointer present, no full KB body in `systemPrompt.append`
  - Debug file: `/tmp/boondi-skill-debug-proof.log` showed skills loaded from
    `/Users/caw-d/gantry/agents/boondi_support/.llm-runtime/claude/skills` and
    `SkillTool returning ... for skill boondi-kb`
  - Persisted trace: `message_traces.timings_json` recorded a `tool` stage
    labeled `Skill`, `server:"sdk"`, `ok:true`; `payloads_json` recorded request
    `{skill:"boondi-kb", args:"Kaju Katli ingredients allergens cashew dairy product care"}`
  - Reply: Kaju Katli contains cashew/tree nuts; dairy needs product-label/team
    confirmation for the specific recipe
  - Result: passed native Skill traceability proof and first PRE-04
    product-care/allergen smoke proof. This does not mark PRE-04 or Phase 6
    `Passed`; full row bundle and regression pack are still required.

Decision:

- Phase 4 has live evidence for every PRE-06 through PRE-09 gifting behavior
  row. Keep status `Evidence ready` until reviewer accepts the evidence and
  moves it to `Passed`.
- On-demand KB access has first live proof through payload and reply behavior:
  the full KB body stays out of the prompt, native `Skill` is available, and the
  KB-backed allergen answer changed only after that exposure fix. Trace
  visibility for native Skill calls is now confirmed by `000000829`. Treat this
  as `Evidence ready`, not final `Passed`, until reviewer accepts it.
- Do not mark additional KB groups passed until their own live signed-webhook
  bundles meet the same evidence standard.

## Phase 5: Scenario Playbook

Status: Evidence ready for all 59 Template_BA rows; human reviewer decision
pending.

Purpose: create the offline truth used to judge Boondi behavior as intents grow.

Proposed source:

```text
agents/boondi_support/docs/boondi-intent-scenario-playbook.md
```

Minimum fields per scenario:

- `intentId`
- `subflow`
- `userIntent`
- `knownInputs`
- `expectedDecision`
- `replyIntent`
- `toolExpectations`
- `handoffBrief`
- `testIntent`

Acceptance:

- Playbook is not injected into live prompt.
- Each scenario maps to an observable live-run check.
- PRE-06 to PRE-09 are covered before expanding to other intents.

Files changed:

- `agents/boondi_support/docs/boondi-intent-scenario-playbook.md` created.
- The playbook maps all 59 `Template_BA` rows to expected decisions, reply
  intent, tool expectations, handoff brief shape, and status.
- Every row is mapped; live evidence now exists through the Phase 7 full replay
  and merged strict review.

Evidence still required before marking Passed:

- Human review of the Phase 7 evidence bundle.

## Phase 6: Scale Pattern

Status: Evidence ready for product-care, mixed gifting/order, orders,
store/aggregator, misc-policy, latest cross-scenario regression subsets, and
the merged 59-row Template_BA strict review.

Purpose: apply the proven KB pattern beyond gifting only after
`kb/gifting.md` shows promising live results.

Candidate KB sources:

```text
agents/boondi_support/kb/gifting.md
agents/boondi_support/kb/orders.md
agents/boondi_support/kb/product-care.md
agents/boondi_support/kb/store-aggregator.md
agents/boondi_support/kb/misc-policy.md
```

Template_BA coverage target:


| Group              | Scenario rows | Candidate KB                                 |
| ------------------ | ------------- | -------------------------------------------- |
| PRE-01 to PRE-05   | 12            | `product-care.md` plus shared commerce rules |
| PRE-06 to PRE-09   | 9             | `gifting.md`                                 |
| PRE-10             | 2             | `orders.md`                                  |
| DEL-01 to DEL-05   | 10            | `orders.md`                                  |
| POST-01 to POST-06 | 10            | `orders.md`                                  |
| CAFE-01 to CAFE-06 | 7             | `store-aggregator.md`                        |
| MISC-01 to MISC-04 | 5             | `misc-policy.md` if needed                   |
| AGG-01 to AGG-04   | 4             | `store-aggregator.md`                        |
| Total              | 59            | All rows in `Template_BA`                    |


Files changed:

- `agents/boondi_support/evals/template-ba-live-scenarios.json` maps all 59
  `Template_BA` rows to scenario id, group, KB, test text, expected decision,
  and tool policy.
- `agents/boondi_support/evals/run-template-ba-live.ts` sends signed Interakt
  webhooks for selected rows/groups, polls Gantry Postgres for outbound replies
  and `message_traces`, and writes evidence JSON.
- `agents/boondi_support/kb/product-care.md` covers PRE-01 through PRE-05 as a
  Boondi-owned source KB.
- `agents/boondi_support/kb/orders.md` covers PRE-10, DEL-01 through DEL-05,
  and POST-01 through POST-06 as a Boondi-owned source KB.
- `agents/boondi_support/kb/store-aggregator.md` covers CAFE-01 through
  CAFE-06 and AGG-01 through AGG-04 as a Boondi-owned source KB.
- `agents/boondi_support/kb/misc-policy.md` covers MISC-01 through MISC-04 as a
  Boondi-owned source KB.
- `agents/boondi_support/skills/boondi-kb/SKILL.md` now lists all human-owned KB
  files and includes compact runtime projections for product-care, orders,
  store/aggregator, and misc routing, because the live runtime still symlinks
  `skills/` but not the separate `kb/` directory.

Evidence still required before marking Passed:

- Signed-webhook bundle for each new KB group.
- Cross-scenario regression pack after every behavior-affecting fix.
- Payload proof that the full KB body remains outside `systemPrompt.append`
  until `boondi-kb` is opened.
- Trace proof for representative Skill/tool paths, using `message_traces` for
  surfaced SDK tool calls and `GANTRY_CLAUDE_SDK_DEBUG_FILE` only when native
  Skill internals are hidden.

Evidence captured:

- `000000829` is a PRE-04 product-care/allergen smoke proof only:
  signed-webhook ACK 200, progressive payload with `Skill`, persisted
  `message_traces` SDK `Skill` tool stage, and KB-consistent reply. This proves
  the new runtime projection can be reached through `boondi-kb`; it does not
  cover the full PRE-01 to PRE-05 bundle.
- Harness dry-run validation passed:
  - manifest has 59 rows and 59 unique scenario ids
  - group counts are product-care 12, gifting 9, orders 22, store-aggregator 11,
    misc-policy 5
  - `--dry-run --all --limit 3`, `--dry-run --id ...`, and
    `--dry-run --group orders --limit 2` selected the expected scenarios and
    generated fake `000*` phones without sending traffic.
- Harness live validation passed for `000000830`:
  - Command:
    `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --id pre-04-allergen-jain --phone 000000830 --wait-ms 90000 --out /tmp/boondi-live-harness-proof-evidence.json`
  - Webhook status: 200
  - Evidence file: `/tmp/boondi-live-harness-proof-evidence.json`
  - Payload file: `/tmp/boondi-live-harness-proof-llm-sdk-query-args.json`
  - SDK debug file: `/tmp/boondi-live-harness-proof-sdk-debug.log`
  - Result: outbound reply was collected and `message_traces` included
    `Skill`, `server:"sdk"`, `ok:true`.
  - Scope: harness validation and PRE-04 smoke proof only; not a full PRE-04
    pass.
- Product-care bundle baseline failed for `000001200` through `000001211`:
  - Command:
    `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --group product-care --start-phone 000001200 --wait-ms 120000 --out /tmp/boondi-product-care-bundle-evidence.json`
  - Evidence file: `/tmp/boondi-product-care-bundle-evidence.json`
  - Payload file: `/tmp/boondi-product-care-bundle-llm-sdk-query-args.json`
  - SDK debug file: `/tmp/boondi-product-care-bundle-sdk-debug.log`
  - Passed architecture checks: every payload had
    `skills:["boondi-kb","gantry-admin"]`, `tools:["ToolSearch","Skill"]`,
    progressive skill pointer present, and no full KB body in
    `systemPrompt.append`.
  - Failed behavior/tool checks:
    - `pre-01-shelf-life`, `pre-01-refrigeration`, and
      `pre-01-travel-suitability` invented unsupported shelf-life, storage, or
      travel promises.
    - `pre-04-allergen-jain` correctly mentioned cashew/tree nuts but
      over-asserted dairy-free status.
    - `pre-05-missed-window` explained a general offer-window rule without a
      source.
    - `pre-02-deliverability`, `pre-02-delivery-eta`,
      `pre-03-piece-count`, `pre-03-custom-pack-size`, and
      `pre-05-apply-discount` used `mcp_list_tools`, which violates the
      customer-chat minimal-tool path.
  - Fix in progress: tightened `skills/boondi-kb/SKILL.md` and
    `kb/product-care.md` so unsupported product-care facts route to source/team
    confirmation, Kaju Katli only confirms cashew/tree nuts, known Shopify tool
    routes are explicit, and `mcp_list_tools` remains forbidden in customer
    chat. Acceptance now requires a rerun of the failed rows plus the
  cross-scenario regression pack.
- Full product-care rerun passed after targeted fixes:
  - Evidence file:
    `/tmp/boondi-product-care-full-rerun17-evidence.json`
  - Scope: all 12 PRE-01 through PRE-05 rows:
    `pre-01-shelf-life`, `pre-01-refrigeration`,
    `pre-01-travel-suitability`, `pre-02-deliverability`,
    `pre-02-delivery-eta`, `pre-03-piece-count`,
    `pre-03-custom-pack-size`, `pre-04-sugar-free`,
    `pre-04-allergen-jain`, `pre-04-ingredients-missing`,
    `pre-05-apply-discount`, and `pre-05-missed-window`.
  - Result: strict parser passed; no `mcp_list_tools`, no KB/process leakage,
    no unsupported travel/delivery/product-care promises, and expected
    product/discount tool paths were preserved.
- Mixed gifting/order focused rerun passed after the latest process-text and
  order-identity fixes:
  - Evidence file:
    `/tmp/boondi-mixed-focused-rerun3-evidence.json`
  - Scope: `pre-08-gst-logo` and `del-01-order-status`.
  - Result: PRE-08 reply no longer leaked classifier/routing narration; DEL-01
    asked only for order number and did not ask for phone/email.
- Mixed gifting/order regression pack passed:
  - Evidence file:
    `/tmp/boondi-mixed-gifting-orders-rerun2-evidence.json`
  - Scope: `pre-06-gift-budget`, `pre-06-roka-anniversary`,
    `pre-07-wedding-hampers`, `pre-07-baby-announcement`, `pre-07-haldi`,
    `pre-08-corporate-quote`, `pre-08-gst-logo`,
    `pre-09-message-card`, `pre-09-branded-sleeve`, and
    `del-01-order-status`.
  - Result: strict parser passed using `evidence.trace.toolStages` for tool
    route checks. PRE-06/PRE-07 personal shortlist rows used Shopify search
    where expected; PRE-08/PRE-09/DEL-01 avoided product search; replies had no
    process/meta leakage or customisation/stock/price overpromise.
- Mixed payload proof:
  - Payload file:
    `/tmp/boondi-mixed-rerun3-llm-sdk-query-args.json`
  - Scope: 12 captured SDK queries across focused and full mixed reruns.
  - Result: every query exposed `tools:["ToolSearch","Skill"]`,
    `skills:["boondi-kb","gantry-admin"]`,
    `AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION=true`,
    `INSTALLED_SKILLS_AVAILABLE_THIS_SESSION=false`, and no sampled full KB body
    markers in `systemPrompt.append`.
- Store/aggregator bundle rerun passed light review:
  - Evidence file:
    `/tmp/boondi-store-aggregator-rerun7-evidence.json`
  - Scope: all 11 CAFE-01 through CAFE-06 and AGG-01 through AGG-04 rows.
  - Result: live replies were captured for every row. CAFE location/menu/valet
    rows used native `Skill` where expected; aggregator issue/bill rows avoided
    Shopify web-order lookup and collected platform/order details.
- Misc-policy bundle rerun passed light review:
  - Evidence file:
    `/tmp/boondi-misc-policy-rerun15-evidence.json`
  - Scope: all 5 MISC-01 through MISC-04 rows.
  - Result: spam used only the BSS-scope response; opt-out rows avoided
    unsubscribed/removed/actioned/message-stop claims and did not ask for
    phone/email/WhatsApp again; franchise/jobs stayed bounded to team
    confirmation.
- Latest cross-scenario rerun passed strict parser:
  - Evidence file:
    `/tmp/boondi-cross-regression-rerun17-evidence.json`
  - Scope: `pre-03-custom-pack-size`, `pre-05-missed-window`,
    `pre-08-gst-logo`, `pre-09-branded-sleeve`, `del-01-order-status`,
    `cafe-02-nearest-store`, `misc-02-repeat-opt-out`, and `agg-04-bill`.
  - Result: 8/8 parser pass. No process/internal leakage, no unexpected
    non-Skill tool calls, PRE-08 stayed customer-facing after process-narration
    trimming, CAFE-02 nearest-store stayed in store-support fallback, and
    repeat opt-out stayed in the safe review shape.

Acceptance:

- Each KB has a clear trigger boundary.
- No KB duplicates live MCP truth.
- `CLAUDE.md` remains a router, not a knowledge dump.
- Each KB has a matching live scenario bundle.
- Each KB group declares its regression-pack subset before the first live fix,
  and that subset is rerun after every behavior-affecting change.
- Every `Template_BA` row is covered by at least one live signed-webhook
scenario before its KB group is marked `Passed`.
- For every covered row, evidence includes the LLM payload shape/size and the
actual Boondi reply. No row is accepted from static prompt review alone.
- For every KB group, record whether the best path is KB-only, MCP-only,
pre-run MCP context, or KB + MCP. Do not default everything to prompt or KB.

## Phase 7: Full Template_BA Live Regression

Status: Evidence ready; full live regression passed with focused recovery and
post-fix cross-scenario regression.

Purpose: prove the scaled KB architecture across the full `Template_BA` tab.

Scope:

- All 59 rows from `Template_BA`.
- One live signed-webhook run per row unless several adjacent subflows are
explicitly merged and the transcript proves each expected behavior.
- Payload capture for representative turns in every KB group.
- Admin/API transcript and flow-log evidence for every run.
- Use `agents/boondi_support/evals/run-template-ba-live.ts` for repeatable
  signed webhook sends and evidence collection. The harness records facts; it
  does not decide pass/fail.

Acceptance:

- Every row has a recorded live reply and reviewer decision.
- Payload evidence shows the KB architecture did not reintroduce broad always-on
context growth.
- MCP evidence shows customer turns use purpose-built compact calls rather than
broad discovery/fanout when a narrower path exists.
- The full regression pack passes after the final row-level fix, proving the
  latest correction did not break an earlier accepted scenario.
- Failures are assigned to the right layer: KB, `CLAUDE.md` router, MCP/tool,
guardrail, CRM extraction, or live runtime.
- No KB group is marked `Passed` until all blocker failures in that group are
fixed and rerun live.

Evidence:

- Full run: `/tmp/boondi-template-ba-full-rerun1-evidence.json` captured 59/59
  live replies.
- Focused recovery: `/tmp/boondi-template-ba-focused-rerun2-evidence.json`
  passed 3/3 for the full-run blockers.
- Merged decision: `/tmp/boondi-template-ba-merged-rerun2-evidence.json` passed
  59/59 strict review.
- Post-fix cross-scenario regression:
  `/tmp/boondi-template-ba-cross-rerun19-evidence.json` passed 8/8 strict
  review.
- Payload proof:
  `/tmp/boondi-template-ba-full-rerun1-llm-sdk-query-args.json` and
  `/tmp/boondi-template-ba-focused-rerun2-llm-sdk-query-args.json`.

## Phase 8: Warmth And Semantic Closeness Pass

Status: In progress; first and second surgical batches passed focused live
testing and cross-regression. Multi-core live canary passed after fixing
runtime skill materialization isolation.

Purpose: improve Boondi's warmth and semantic closeness to the `Template_BA`
sample lines and Shreya suggestions without weakening safety, tool correctness,
or regression stability.

Scope of first surgical batch:

- `pre-01-refrigeration`
- `pre-04-sugar-free`
- `pre-09-message-card`
- `cafe-01-reservation`
- `agg-03-availability`
- adjacent cross-regression rows:
  `pre-01-travel-suitability`, `pre-09-branded-sleeve`,
  `cafe-02-nearest-store`, `del-01-order-status`,
  and `misc-02-repeat-opt-out`

Changes made:

- Warmed source-bounded product-care fallbacks without adding unconfirmed shelf
  life, refrigeration, travel, sugar-free, or diabetic-safe promises.
- Warmed gift-message fallback while keeping gift-note feasibility source/team
  confirmed.
- Tightened cafe reservation wording so Boondi does not say a table is booked,
  held, sorted, or that the store will confirm a booking without source proof.
- Allowed safe Swiggy/Zomato outlet-check guidance while forbidding delivery
  address manipulation or enablement promises.
- Tightened `del-01-order-status` wording so Boondi does not say "I'll pull up"
  or "I'll check" before an order identifier or verified source result exists.
- Added reviewer checks for the new known-risk phrases.

Evidence:

- Baseline guard proof:
  `/tmp/boondi-template-ba-merged-rerun2-evidence.json` now fails only
  `cafe-01-reservation` under the tightened booking/table wording check. This
  proves the reviewer catches the known old "table sorted / confirm the booking"
  issue.
- Focused live batch 1:
  `/tmp/boondi-warmth-focused-rerun1-evidence.json`
  - 5/5 strict parser pass before the second wording tightening.
  - Human review accepted stronger warmth for refrigeration, gift-message, and
    cafe reservation.
  - Human review rejected two phrases for further tightening:
    `actually safe` in `pre-04-sugar-free`, and
    `switching the delivery address` in `agg-03-availability`.
- Focused live batch 2:
  `/tmp/boondi-warmth-focused-rerun2-evidence.json`
  - 2/2 strict parser pass after tightening sugar-free and aggregator wording.
  - `pre-04-sugar-free` used suitable/dietary-fit language, not medical safety.
  - `agg-03-availability` avoided delivery-address manipulation language.
- Cross-regression:
  `/tmp/boondi-warmth-cross-rerun1-evidence.json`
  - 8/8 strict parser pass before the DEL-01 wording tightening.
  - Human review rejected `del-01-order-status` phrase
    "I'll pull up the details right away" as unnecessary process wording.
- DEL-01 focused rerun:
  `/tmp/boondi-warmth-del01-rerun1-evidence.json`
  - 1/1 strict parser pass.
  - Reply used verified Shopify context via
    `shopify-api.get_recent_orders_with_details` and avoided "I'll pull up" /
    "I'll check" process wording.
- Accepted merged cross-regression:
  `/tmp/boondi-warmth-cross-rerun1-merged-evidence.json`
  - 8/8 strict parser pass after replacing the superseded DEL-01 row with
    `/tmp/boondi-warmth-del01-rerun1-evidence.json`.
- Second focused warmth batch:
  `/tmp/boondi-warmth-focused-rerun6-merged-evidence.json`
  - 6/6 strict parser pass.
  - Covered `del-03-date-request`, `del-05-cancel-refund`,
    `post-02-card-missing`, `post-06-delivered-not-received`,
    `misc-02-opt-out`, and `cafe-01-reservation`.
  - Tightened order complaint warmth, unsupported opt-out wording, and
    delivery-date missing-order-number opener without adding new tool calls.
- Multi-core architecture canary:
  `/tmp/boondi-warmth-cross-rerun7-merged-evidence.json`
  - 8/8 strict parser pass across two live Gantry cores on ports `4710` and
    `4711`.
  - Core `4710` shard:
    `/tmp/boondi-warmth-cross-core4710-rerun7-evidence.json`
    covered delivery/order complaint scenarios.
  - Core `4711` shard:
    `/tmp/boondi-warmth-cross-core4711-rerun7-evidence.json`
    covered opt-out, cafe, sugar-free, and Swiggy availability scenarios.
  - Live replies used the expected mix of no-tool and `sdk:Skill` paths, with
    no unsupported Shopify fanout for missing-card complaint and no tools for
    opt-out.
  - Runtime evidence showed separate materialized skill directories under
    `/Users/caw-d/gantry/agents/boondi_support/.llm-runtime/runs/...`, and both
    cores logged `Warm pool prewarm ready` / `Warm-pool route prewarm ready`.
- Multi-core defect found and fixed:
  - Previous manual two-core startup exposed a race where both cores used the
    same `.llm-runtime/claude/skills` materialization path and could delete each
    other's skill files during prewarm.
  - Fix isolates runtime materialization under per-run directories derived from
    the spawned process name.
  - Static verification passed:
    `npm run test:unit -- apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/adapters/claude-config-materializer.test.ts apps/core/test/unit/adapters/anthropic-execution-adapter.test.ts`
    and `npm run typecheck -- --pretty false`.
- Linked-worktree stack-script defect fixed:
  - `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime` previously failed in this
    linked worktree because `scripts/lib/phones.mjs` was missing before startup.
  - `scripts/lib/phones.mjs` now provides the test-phone/operator allowlist
    helper used by the stack script, so the reusable multi-core command starts
    from this worktree.
- Full `Template_BA` live regression:
  `/tmp/boondi-template-ba-full-rerun10-accepted-merged-evidence.json`
  - 59/59 strict parser pass after focused replacement reruns.
  - Base two-core full run:
    `/tmp/boondi-template-ba-full-rerun8-merged-evidence.json` captured 59 rows
    but failed 10 rows.
  - Eight of the failures were late replies, not lost replies. Postgres trace
    inspection showed queue delays up to roughly 278s before the LLM began on
    some rows; the replies were eventually persisted with traces.
  - Focused replacement rerun:
    `/tmp/boondi-template-ba-focused-rerun9-merged-evidence.json` covered the
    10 failed rows with a 300s evidence window and passed 9/10.
  - Final spam replacement:
    `/tmp/boondi-template-ba-spam-rerun10-evidence.json` passed 1/1 after adding
    deterministic sanitizer coverage for spam/process wording.
  - Final accepted merge:
    `/tmp/boondi-template-ba-full-rerun10-accepted-merged-evidence.json` passed
    59/59 strict review.
- Runtime/load findings from the full run:
  - Active `/Users/caw-d/gantry/settings.yaml` used
    `runtime.queue.max_message_runs: 5`, `warm_pool.size: 5`, and
    `warm_pool.max_bound_workers: 5`, not the 10-worker values from the test
    prompt. This means the full run did not exercise the intended final
    capacity.
  - Child runner stderr included repeated inspector-port conflicts on `9230`,
    and Gantry reported them as `.llm-runtime` access failures after output had
    already been sent. This is a runtime diagnostics/classification issue to
    fix separately; it did not block persisted replies in the accepted evidence.
- Exact 10-worker multi-core canary after runtime fixes:
  `/tmp/boondi-10worker-multicore-canary-rerun12-merged-evidence.json`
  - 8/8 strict parser pass across two live Gantry cores on ports `4710` and
    `4711`.
  - Tested under temporary active runtime settings matching the requested
    shape: `runtime.queue.max_message_runs: 10`,
    `runtime.queue.max_job_runs: 10`, `runtime.queue.max_retries: 5`,
    `runtime.queue.base_retry_ms: 5000`, `runtime.runner.idle_timeout_ms:
    300000`, `runtime.warm_pool.enabled: true`, `runtime.warm_pool.size: 10`,
    `runtime.warm_pool.max_bound_workers: 10`,
    `runtime.warm_pool.cache_prewarm_enabled: true`, and
    `runtime.warm_pool.cache_prewarm_concurrency: 1`.
  - Covered product-care, gift customisation, delivery-date change,
    delivered-not-received complaint, personal gifting, cafe reservation,
    opt-out, and aggregator availability rows.
  - Runtime logs for the patched rerun showed `Warm pool prewarm ready` and
    `Warm-pool route prewarm ready` with `size:10` on both cores.
  - Log review found no `No conversation found with session ID`,
    `.llm-runtime`, `EADDRINUSE`, `9230`, `copyfile`, host-agent, or
    materialization error lines in the patched rerun logs.
  - Runtime-home settings were restored to their prior 5-worker local values
    after the canary.
- Runtime stale-provider-session fix:
  - Rerun11 exposed a real post-stream failure mode: the SDK had already
    streamed a customer-visible reply, then returned `No conversation found
    with session ID`. Gantry expired the stale handle path only before output,
    so this late error was logged as a false runtime failure.
  - The runtime now expires that stale provider handle and records the already
    delivered streamed reply as the successful turn result.
  - Regression proof:
    `npm run test:unit -- apps/core/test/unit/runtime/group-processing.test.ts -t "expires a stale provider session after streamed output"`
    passed 1/1.
- Four-core / 20 warm-worker full-concurrency test:
  `/tmp/boondi-4core-20warm-full-concurrency-rerun1-evidence.json`
  - Shape: four Gantry cores on ports `4710`, `4711`, `4712`, and `4713`,
    active runtime settings `warm_pool.size: 5` and
    `warm_pool.max_bound_workers: 5` per core, total 20 warm workers.
  - Launch method: all 59 Template_BA customers were sent concurrently by
    signed Interakt webhook and round-robin routed across the four cores.
  - Warm-worker proof: logs showed `Warm pool prewarm ready` with `size:5` on
    all four cores before launch, and the first wave produced roughly 20
    replies/traces quickly.
  - Result: strict reviewer failed the run, 50/59 passed and 9 failed.
    Eight rows had no persisted outbound reply or trace by the 600s evidence
    window; one row (`pre-03-piece-count`) replied but used unexpected
    `sdk:ToolSearch`.
  - Missing persisted outbound rows:
    `pre-01-travel-suitability`, `pre-04-sugar-free`,
    `pre-05-missed-window`, `pre-07-baby-announcement`, `post-01-stale`,
    `post-03-damaged-packaging`, `cafe-03-dine-in-menu`, and `misc-01-spam`.
  - Per-core completion:
    `4710` completed 15/15, `4711` completed 14/15, `4712` completed 11/15,
    and `4713` completed 11/14.
  - Runtime signals: multiple active runs were stopped around 307s-327s with
    `Stop requested for active run (SIGTERM process group)` followed by
    `Host agent stopped by request`, often with `hadStreamingOutput:true`.
    Core `4713` also logged `pg-boss scheduler error` with
    `Connection terminated due to connection timeout`.
  - Decision: not accepted as healthy. The 20 warm-worker architecture needs
    follow-up debugging around active-run stop/idle-timeout behavior, tail
    persistence after streamed output, and Postgres/pg-boss connection pressure
    before using this as production-load confidence.
- Final verification:
  - `npm run test:unit -- apps/core/test/unit/application/customer-output/customer-safe-output.test.ts`
    passed 76/76 tests.
  - `npm run typecheck -- --pretty false` passed after all surgical changes.
  - Latest verification after the 10-worker runtime fix:
    `npm run test:unit -- apps/core/test/unit/application/customer-output/customer-safe-output.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/adapters/anthropic-execution-adapter.test.ts`
    passed 154/154 tests.
  - Latest stale-session regression:
    `npm run test:unit -- apps/core/test/unit/runtime/group-processing.test.ts`
    passed 129/129 tests.
  - Latest `npm run typecheck -- --pretty false` and `git diff --check` both
    passed.
- Payload checks for focused and cross reruns found no sampled full KB body
  markers such as `Runtime-critical projections`,
  `PRE-01 to PRE-05 runtime product-care projection`, or
  `CAFE and AGG runtime` in trace payload JSON.

Reviewer decision:

- First warmth batch is accepted for focused live evidence.
- Final `Template_BA` strict-review acceptance is claimed from the merged
  59-row live evidence bundle plus focused replacement rows.
- The 10-worker multi-core architecture canary is accepted for runtime
  confidence after the post-stream stale-session fix.
- Owner review is still required before committing these uncommitted workspace
  changes.

Known tradeoffs:

- Store/outlet answers remain source-bounded, so they may not name outlets from
  the spreadsheet sample unless a current source confirms the outlet.
- Product-care and dietary replies intentionally trade exact sample wording for
  safety because the current KB does not confirm exact shelf-life,
  refrigeration, sugar-free, or diabetic-safe facts.
- The Swiggy/Zomato availability reply may be shorter than the sample when the
  model does not open the Skill, but it stayed within allowed router semantics
  and avoided unsupported promises.

## Phase 9: Generic Customer-Live Prompt Surface

Status: Evidence ready for one live Boondi gifting webhook; broader
Template_BA regression is deferred until reviewer asks for release-grade
confidence on this prompt-surface change.

Purpose: give customer-facing agents a compact Gantry-owned prompt surface that
removes generic admin/runtime scaffolding from the always-on SDK prompt while
preserving safety boundaries, Boondi-owned voice, progressive skill pointers,
scope checks, and approved MCP service guidance.

Design decision:

- Gantry owns the generic `promptSurface: customer_live` architecture.
- Boondi opts in through active runtime desired state, currently
  `/Users/caw-d/gantry/settings.yaml` with `prompt_surface: customer_live`.
- Core runtime must not hard-code `boondi_support`. Any customer-facing agent
  can choose `customer_live`; non-customer/admin agents can stay on the default
  full prompt surface.
- `customer_live` removes heavy generic Gantry blocks:
  `[[CAPABILITY_GUIDANCE]]`, `[[OPERATING_GUIDANCE]]`, full
  `# Gantry Runtime Rules`, and full `## Gantry Durable Memory Boundary`.
- `customer_live` keeps the minimum live-customer contract:
  compact memory boundary, compact runtime rules, `[[SOUL]]`,
  `[[GROUP_CONTEXT]]`, progressive skill disclosure, turn scope check, and
  approved MCP services.
- SDK payload logging is split by intent: `llm-sdk-query-args.json` is latest
  only and overwritten every SDK query; optional JSONL history remains separate
  for forensic debugging.

Implementation evidence:

- Prompt surface type and parser:
  `apps/core/src/shared/prompt-surface.ts`.
- Prompt compiler:
  `apps/core/src/application/agents/prompt-profile-service.ts`.
- Compact memory boundary:
  `apps/core/src/runner/memory-boundary.ts` and
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/system-prompt.ts`.
- Warm-worker prompt/log correctness:
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`.
  The warm bound path now uses the bind-delivered guardrail/scope preface in the
  effective prompt and in the payload log.
- Latest-only payload writer:
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/sdk-query-args-log.ts`.
- Runtime plumbing:
  config parser/renderer, desired-state export, route binding, startup, channel
  persistence, group runner, and agent spawn inputs now carry `promptSurface`.

Verification evidence:

- Focused unit command:
  `npm run test:unit -- apps/core/test/unit/runtime/prompt-profile.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/runner/sdk-query-args-log.test.ts apps/core/test/unit/runner/system-prompt.test.ts`
  passed 98 tests across 4 files.
- TypeScript verification: `npm run typecheck` passed.
- Live command:
  `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --id pre-06-gift-budget --out /tmp/boondi-customer-live-prompt-surface-evidence-final.json`.
- Live result:
  webhook status `200`, `replyReceived:true`, native `Skill` used, and
  `shopify-api.search_products` used.
- Payload result:
  `llm-sdk-query-args.json` parsed as one latest object, not an array. It had
  `rawPrompt` because the warm worker's raw prompt and effective prompt differed
  after bind-time preface application.
- Prompt absence check passed for:
  `[[CAPABILITY_GUIDANCE]]`, `[[OPERATING_GUIDANCE]]`,
  `# Gantry Runtime Rules`, and `## Gantry Durable Memory Boundary`.
- Prompt presence check passed for:
  `## Memory Boundary`, `[[RUNTIME_RULES]]`, `# Runtime Rules`, `[[SOUL]]`,
  `[[GROUP_CONTEXT]]`, `[[AGENT_FOLDER_SKILLS_AVAILABLE_THIS_SESSION]]`,
  `## Boondi Scope Check For This Turn`, `## Approved MCP Services`,
  `shopify-api`, and `boondi-crm`.

Known caveats:

- This phase has one live `pre-06-gift-budget` proof, not a full Template_BA
  rerun. That is enough to prove the architecture and payload shape, not enough
  to claim broad reply-quality regression coverage.
- `npm run smoke:boondi-runtime` could not be used in this linked worktree
  because `scripts/boondi-runtime-smoke.mjs` was missing. The existing
  Template_BA live harness was used instead.
- `.codex/scripts/check_task_completion.py` was also missing in this linked
  worktree, so that optional completion helper could not run.
- The active Boondi opt-in currently lives outside the repo in
  `/Users/caw-d/gantry/settings.yaml`; before release, make sure the intended
  deployment desired state also selects `prompt_surface: customer_live`.
- Future work should run the focused prompt payload check first, then a small
  cross-scenario pack, then full Template_BA only if the reviewer wants
  release-grade confidence. Do not spend live LLM tokens on repeated full runs
  after tiny prompt-surface edits unless the blast radius justifies it.

## Phase 10: Provider-Neutral Identity And Order-Number UX

Status: Evidence ready; focused live signed-webhook review passed, human
reviewer decision pending.

Purpose: remove provider-specific business wording from Boondi's prompt surface,
keep MCP reply drafts narrow, preserve Shopify catalogue-cache safety, and make
order-number collection more customer-natural without weakening complaint/order
safety.

Scope:

- `agents/boondi_support/CLAUDE.md`
- `agents/boondi_support/skills/boondi-kb/SKILL.md`
- `agents/boondi_support/kb/orders.md`
- `agents/boondi_support/kb/product-care.md`
- `agents/boondi_support/AGENTS.md`

Changes made:

- Replaced Interakt-specific Boondi behavior wording with provider-neutral
  `verified channel sender context` / `verified sender identity` wording.
- Replaced the remaining `Gantry has supplied` runtime wording in `CLAUDE.md`
  with `the runtime has supplied`.
- Updated order-status guidance to prefer verified sender identity lookup when
  a real order-source tool supports it.
- Updated complaint/support guidance so Boondi asks for the order number first,
  but offers a natural recent-order lookup fallback if the customer does not
  have the order number handy.
- Tightened DEL-01 so "where is my order", "ETA", or "my latest order" cannot
  end with only an order-number ask while `shopify-api.get_recent_orders_with_details`
  is approved in the run.
- Tightened missing item/card complaints so the same fallback appears when the
  order number is missing.
- Preserved the safety boundary that complaint/exception routes must not guess a
  recent order silently.

Static evidence captured:

- `rg -n "Interakt|interakt|Gantry|gantry" agents/boondi_support/CLAUDE.md
  agents/boondi_support/skills/boondi-kb/SKILL.md
  agents/boondi_support/kb/orders.md agents/boondi_support/kb/product-care.md
  agents/boondi_support/AGENTS.md -S`
  returned only two Boondi-local KB status comments:
  `not Gantry runtime logic` in `kb/orders.md` and `kb/product-care.md`.
  No provider-specific customer behavior wording remains in `CLAUDE.md`.
- `rg -n "recent-order lookup|recent orders linked to this chat|verified sender
  identity|verified channel sender"` confirmed the new order-number fallback and
  provider-neutral identity wording in `CLAUDE.md`, `SKILL.md`, and `kb/orders.md`.
- Shopify MCP focused unit suite passed:
  `npx vitest run -c vitest.unit.config.ts
  packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts
  packages/mcp-shopify/test/unit/tools/gifting-context.test.ts
  packages/mcp-shopify/test/unit/tools/get-recent-orders-with-details.test.ts`
  -> 3 files passed, 34 tests passed.
- Focused live-pack dry run passed:
  `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --dry-run --id
  del-01-order-status,post-02-missing-item,pre-06-gift-budget,agg-04-bill --out
  /tmp/boondi-phase10-dry-run-evidence.json`
  selected:
  `pre-06-gift-budget`, `del-01-order-status`, `post-02-missing-item`, and
  `agg-04-bill`.

Static caveat:

- `npx vitest run -c vitest.unit.config.ts
  apps/core/test/unit/repo/boondi-scenarios.test.ts` is not currently a valid
  regression gate in this linked worktree. It failed because expected legacy
  files under `scripts/` are absent, including `scripts/boondi-scenarios.json`,
  `scripts/boondi-regression.mjs`, `scripts/boondi-test-setup.sh`,
  `scripts/boondi-isolation.mjs`, `scripts/boondi-runtime-smoke.mjs`, and
  `scripts/measure-latency.mjs`. This does not prove a behavior regression, but
  it means this repo-level suite cannot be used as acceptance evidence until the
  harness path is repaired or the test is updated to the current `evals/`
  location.

Live evidence captured:

- First focused pack:
  `/tmp/boondi-phase10-focused-live-evidence.json`
  - `pre-06-gift-budget`: passed with `sdk:Skill` +
    `shopify-api.search_products`, website-first recommendation wording, no
    live-stock overclaim.
  - `agg-04-bill`: passed with no Shopify web-order lookup and customer-facing
    platform-order detail collection.
  - Initial `del-01-order-status`: returned the fallback but did not call the
    verified sender order-source path, so it was not accepted as final evidence.
  - Initial `post-02-missing-item`: asked for order number but missed the
    fallback, so it was not accepted as final evidence.
- DEL-01 verified sender lookup replacement:
  `/tmp/boondi-phase10-del01-tool-rerun-evidence.json`
  - Tool path: `shopify-api.get_recent_orders_with_details`.
  - Reply mentioned latest order `#109260`, avoided order-number-first behavior,
    and did not use Shopify product search.
- POST-02 missing-item fallback replacement:
  `/tmp/boondi-phase10-post02-fallback-rerun-evidence.json`
  - Tool path: none.
  - Reply included empathy, order-number ask, useful photo ask, and "recent
    orders linked to this chat" fallback without silently guessing an order.
- Merged focused review:
  `/tmp/boondi-phase10-focused-merged-rerun2-evidence.json`
  - `npx tsx agents/boondi_support/evals/review-template-ba-evidence.ts
    --evidence /tmp/boondi-phase10-focused-merged-rerun2-evidence.json
    --expect-count 4`
  - Result: 4 rows, 4 passed, 0 failed.
- Payload proof:
  `/tmp/boondi-phase10-final-llm-sdk-query-args.json` copied from the latest
  `llm-sdk-query-args.json` after the focused reruns had
  `skills:["boondi-kb","gantry-admin"]`, `tools:["ToolSearch","Skill"]`, no
  `Interakt`/`interakt` in `systemPrompt.append`, no `Gantry has supplied`,
  provider-neutral verified sender wording, and the exact fallback
  `finding recent orders linked to this chat`.

Acceptance audit:

| Requirement | Evidence | Status |
| --- | --- | --- |
| No Interakt-specific Boondi business rule in prompt | `rg` over `CLAUDE.md`, `SKILL.md`, `kb/orders.md`, `kb/product-care.md`, and `AGENTS.md`; payload proof has no `Interakt`/`interakt` in `systemPrompt.append`. | Evidence ready |
| Provider-neutral verified sender context wording | `CLAUDE.md` and payload proof include verified sender/channel wording. | Evidence ready |
| MCP reply drafts stay narrow | Shopify focused unit suite passed; live PRE-06 used `search_products` draft path, DEL-01 used latest-order draft path, AGG/POST rows had no broad draft/tool fanout. | Evidence ready |
| Shopify catalogue recommendation is fast and no live-stock overclaim | PRE-06 live row used one `shopify-api.search_products` call and reply avoided "available right now"; cache defaults and tests remain in Shopify MCP. | Evidence ready |
| Customer can proceed without remembering order number | DEL-01 and POST-02 replacement rows include "recent orders linked to this chat" fallback. | Evidence ready |
| Latest/status uses verified sender identity when supported | DEL-01 replacement row called `shopify-api.get_recent_orders_with_details` and mentioned latest order `#109260`. | Evidence ready |
| Complaint route does not silently guess order | POST-02 replacement row used no Shopify order lookup, asked for order number/evidence, and offered fallback. | Evidence ready |
| No internal/process leakage or unsupported promises | Strict reviewer passed 4/4; local phrase checks found no process leakage, stock guarantee, or tool-contract wording in accepted rows. | Evidence ready |
| No broad tool fanout | Accepted rows used expected paths: PRE-06 `sdk:Skill` + `shopify-api.search_products`; DEL-01 `shopify-api.get_recent_orders_with_details`; POST-02 no tools; AGG-04 no tools. | Evidence ready |
| Live webhook tests pass | `/tmp/boondi-phase10-focused-merged-rerun2-evidence.json` strict review: 4 rows, 4 passed, 0 failed. | Evidence ready |
| LLM payload shows expected prompt/tool behavior | `/tmp/boondi-phase10-final-llm-sdk-query-args.json` has expected skills/tools and provider-neutral prompt append. | Evidence ready |
| Evidence stored with reviewer decision | This section records scenario ids, evidence paths, payload path, tool paths, replacement decisions, and reviewer state. | Owner review pending |

Owner review checklist:

- Open `/tmp/boondi-phase10-focused-merged-rerun2-evidence.json`.
- Review the four accepted customer replies:
  `pre-06-gift-budget`, `del-01-order-status`, `post-02-missing-item`, and
  `agg-04-bill`.
- Confirm the replies are customer-natural and provider-neutral.
- Confirm DEL-01 using the latest order is acceptable for this synthetic sender
  identity, because it uses `shopify-api.get_recent_orders_with_details`.
- Confirm POST-02 should offer recent-order lookup but not silently guess the
  complaint order.
- Confirm the minimum focused evidence scope is sufficient for this Phase 10
  architecture change, per the token-scope decision.
- Reviewer decision: pending.

Decision:

- Keep Phase 10 at `Evidence ready` until human review accepts the focused
  bundle. Do not mark `Passed` from automated review alone.
- Current live scope is intentionally the minimum focused evidence bundle after
  reviewer instruction to avoid broader scenario testing/token spend.

## Surface Impact Matrix


| Surface                     | Status                       | Reason                                                                                                      |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed after proof          | Only the selected KB exposure mechanism should affect live replies.                                         |
| `settings.yaml`             | Deferred                     | Required only if attaching a new runtime skill/capability needs activation.                                 |
| Postgres/runtime projection | Read-only/observable         | Used for traces, records, transcripts, and evidence only.                                                   |
| Control API                 | Unchanged by design          | No new admin API is needed for the first proof.                                                             |
| CLI                         | Unchanged by design          | Existing dev/test commands should be used.                                                                  |
| Gantry MCP/admin tools      | Unchanged by design          | Boondi knowledge should not require new Gantry admin capability.                                            |
| Boondi CRM MCP              | Changed if evidence requires | Compact query/lead reads such as `get_last_query_or_lead` are allowed when they reduce live LLM/tool loops. |
| Shopify MCP                 | Changed if evidence requires | Add or adjust compact aggregate reads only when live gifting/order/product scenarios prove the need.        |
| Channel/provider adapters   | Unchanged by design          | Existing signed Interakt path is the proof path.                                                            |
| SDK/contracts               | Read-only first              | Verify actual skill/projection behavior before depending on it.                                             |
| Docs/prompts                | Changed                      | Plan, KB source, and minimal `CLAUDE.md` router may change.                                                 |
| Audit/events                | Read-only/observable         | Evidence must come from flow logs and persisted traces.                                                     |
| Tests/verification          | Changed                      | Live webhook scenarios, LLM payload captures, and actual replies are the only acceptance gate.              |


## Phase Gate Template

Use this before advancing any phase:

```text
Phase:
Status:
Files changed:
Payload evidence:
Webhook evidence:
Admin/API evidence:
Flow-log evidence:
MCP evidence:
Regression pack evidence:
Latency evidence:
Decision:
Reviewer notes:
Next phase allowed: yes/no
```

## Open Decisions

1. Whether the first runtime proof uses SDK skill projection, MCP KB lookup, or a
  hybrid.
2. Whether `kb/gifting.md` is directly read by runtime or compiled/projected
  into a runtime skill artifact.
3. Whether scenario playbook lives as Markdown first or structured JSON after
  the PRE-06 to PRE-09 proof.
4. Whether Shopify needs a new compact aggregate tool after `gifting.md` live
  proof, or whether existing `get_gifting_context` is enough.
