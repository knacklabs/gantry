# MCP Tool Design Guide

This is the production standard for Gantry MCP servers and tools. Use it when
creating a new MCP, adding a tool to an existing MCP, or optimizing an MCP that
is already in the main chat path.

The goal is not "more tools." The goal is fewer LLM/tool loops, smaller tool
responses, safer data boundaries, and predictable production behavior.

## 1. Core Principles

### 1.1 Optimize The Customer Turn, Not The Tool List

Every tool exposed to a customer-facing agent is part of the LLM's action
space. A large, vague, overlapping tool surface makes the model spend tokens
discovering options, choosing between similar calls, parsing oversized results,
and recovering from wrong calls.

Design tools around the question the customer is likely asking:

- "What was my latest order?" should be one call.
- "Continue my previous gifting query" should be one compact pre-run fetch.
- "Plan a gifting order with products and prior order context" can be one
  aggregate call if the data is usually needed together.
- "List everything in the database" is not a customer-facing default.

### 1.2 Prefer One Useful Aggregate Call Over Several Tiny Calls

The LLM/tool loop is expensive because every tool call usually means:

1. LLM decides to call a tool.
2. Tool request is serialized through the SDK/MCP path.
3. MCP server fetches data.
4. Tool result is injected back into the SDK session.
5. LLM reads the result and composes the next step.

If the common customer answer requires the same two or three reads every time,
make a purpose-built aggregate tool. Keep the aggregate response compact and
task-shaped.

Good examples:

- `shopify-api.get_recent_orders_with_details`: latest order plus line items,
  total, and fulfillment status by default. This avoids `lookup_customer` +
  `list_orders_for_customer` + `get_order`.
- `shopify-api.get_gifting_context`: latest order plus compact product context
  when the gifting brief justifies it.
- `boondi-crm.get_last_query_or_lead`: one latest CRM record for returning
  greeting personalization.

Bad pattern:

```text
lookup_customer -> list_orders -> get_order -> search_products -> get_product
```

Use that only when the user explicitly needs each separate step.

### 1.3 Minimize Discovery In The Main LLM Loop

If the runtime already knows which MCP tool is needed, do not force the main LLM
to discover it.

Avoid this for known customer flows:

```text
LLM -> mcp_list_tools -> mcp_call_tool(get_last_query_or_lead) -> LLM reply
```

Prefer this:

```text
Runtime precondition is true -> server-side MCP call -> compact context block
-> main LLM reply
```

Use `mcp_list_tools` only when the agent genuinely does not know which approved
server/tool exists. Do not encourage a blanket "list tools first" habit in
prompts or tool descriptions.

### 1.4 Compact JSON Is The Default Response Format

Tool responses are LLM context. Treat every field as a token cost and a possible
confusion source.

Return:

- fields needed to answer the current class of question
- stable ids that enable follow-up detail calls
- short summaries when they replace several raw fields
- structured booleans/statuses such as `found`, `status`, `matchedVia`
- customer-safe drafts/contracts only when they prevent bad phrasing or
  unnecessary second calls

Do not return by default:

- raw database rows
- internal columns
- full transcripts
- full product descriptions
- all images
- all variants
- raw GraphQL payloads
- stack traces
- secrets, headers, tokens, or signing material
- broad history when one latest item answers the question

## 2. Tool Surface Design

### 2.1 Start With Use Cases

Before adding a tool, write the top customer/operator questions it must answer.

Use this shape:

| Question | Required data | One-call possible? | Tool |
| --- | --- | --- | --- |
| "Can we continue my gifting plan?" | latest active CRM query/lead | yes | `get_last_query_or_lead` |
| "Where is my latest order?" | latest order status plus items | yes | `get_recent_orders_with_details` |
| "Show all active opportunities" | all open CRM records | yes, but not default greeting | `get_open_records` |

If two tools answer the same normal question, either merge them or make one the
clear preferred default and explain when the other is needed.

### 2.2 Name Tools By Action And Object

Good names:

- `get_last_query_or_lead`
- `get_recent_orders_with_details`
- `get_gifting_context`
- `search_products`
- `validate_discount_code`

Avoid:

- `crm`
- `lookup`
- `query`
- `search`
- `get_data`
- `helper`

The name should make the right call obvious without opening docs.

### 2.3 Tool Description Must Route The LLM

Tool descriptions should be short, specific, and decision-oriented.

Include:

- when to use it
- what it returns
- default arguments
- when not to use it
- whether it avoids another call

Example:

```text
Return only the verified caller's newest active CRM query/lead for a
returning-customer greeting. Use empty arguments {}. Response is intentionally
compact; use get_open_records only when you need every active opportunity.
```

Do not write descriptions that make every tool sound equally useful.

### 2.4 Split Default Tools From Detail Tools

Use this pattern:

- default tool: compact answer for the common question
- detail tool: explicit deeper lookup when the customer asks for more
- admin/internal tool: not exposed to customer-facing agents unless selected and
  justified

Example:

| Tool | Default customer-facing? | Why |
| --- | --- | --- |
| `get_recent_orders_with_details` | Yes | Small, latest-order answer path. |
| `get_order` | Yes, but detail/follow-up | Specific order lookup after customer names an order. |
| `get_order_history` | No by default for normal greeting | Wider history is expensive and usually unnecessary. |

### 2.5 Avoid Tool Overlap

Overlap is allowed only when the difference is obvious:

- `get_last_query_or_lead`: one newest active record for greeting/prefetch.
- `get_open_records`: all active opportunities when the user/operator needs
  the set.

If the agent could reasonably call either for the same first-turn question, the
surface is too ambiguous.

## 3. Server Architecture And Runtime Boundary

### 3.1 Keep MCP Servers Domain-Owned

An MCP server should own access to one external/domain system and expose a small
task-shaped surface over it.

Examples:

- `packages/mcp-shopify`: Shopify customer/order/product reads.
- `packages/mcp-crm`: Boondi CRM query/lead records and extraction workflows.

Do not put Boondi-specific business logic into Gantry core when it belongs in a
Boondi-owned MCP or Boondi pre-run context provider. Gantry should own runtime
mechanics: identity projection, permission/capability materialization, MCP
proxying, traces, and sandbox/egress controls.

### 3.2 Prefer HTTP MCP For Independent Services

External domain MCPs should normally run as independent HTTP MCP servers:

- own process
- own `.env`
- own healthcheck
- own credentials
- reachable from Gantry through selected MCP server config

Core does not spawn external HTTP MCPs, so the MCP service must own its runtime
credentials. Gantry may project caller identity or selected capability secrets,
but the domain server is responsible for its own backend auth and safe logging.

Use stdio MCP only when the server is intentionally host-spawned by Gantry and
its lifecycle/credentials are reviewed as part of core capability projection.

### 3.3 Healthcheck And Startup Contract

Every production MCP server needs:

- `/healthz` or equivalent cheap readiness endpoint
- clear listen host/port env vars
- startup logs that identify server name and port without secrets
- fail-fast validation for required backend credentials
- tests for missing/invalid env

Healthcheck proves the process is reachable. It does not prove every backend
permission works; tool-level tests and live traces still need to exercise real
calls.

### 3.4 Timeouts, Retries, And Rate Limits

Every outbound backend call inside an MCP tool needs bounded behavior:

- explicit timeout
- retry only for safe transient failures
- no retry for privacy/identity failures or validation errors
- rate-limit handling with structured error
- no unbounded parallel fanout from one tool call

Customer-facing tools should fail quickly enough that Boondi can still answer
or ask a clarifying question. Optional context fetches must degrade to no
context rather than blocking the whole customer turn.

### 3.5 Data Ownership And Migrations

If the MCP owns tables, it owns:

- migrations
- repository APIs
- query indexes
- local test data builders
- admin/debug commands for that domain
- privacy-safe logs for those records

Do not make Gantry core reach directly into MCP-owned tables for business
logic. If runtime needs a small piece of domain context, expose a compact MCP
tool or an agent-owned pre-run context provider.

### 3.6 Versioning And Deprecation

Changing a tool response shape is a contract change. Before changing it:

- add tests for the new contract
- update tool description
- update design docs
- update live scenario expectations when customer behavior changes
- search for callers and prompt references

Prefer adding a new compact tool over silently changing a broad tool if the old
tool is still useful for operator/admin cases.

Deprecate tools by:

1. marking the preferred replacement in the old tool description
2. removing prompt guidance that encourages the old path
3. proving traces no longer use it for default flows
4. deleting only after references and tests are gone

## 4. Input Schema Rules

### 4.1 Make Common Calls Argument-Free

For customer conversations, the channel identity should usually decide the
customer. Do not require the LLM to pass phone/email/customer id when Gantry can
project verified caller identity.

Good:

```json
{}
```

for:

- latest CRM query/lead
- latest order for verified caller
- open CRM records for verified caller

Bad:

```json
{ "phone": "..." }
```

when the phone is already available through verified caller identity. The LLM
should not be trusted to supply customer identity from the message text.

### 4.2 Validate Strictly But Tolerate Common LLM Shorthand

Use typed schemas, but accept common harmless shorthand that would otherwise
cause another repair loop.

Examples:

- accept `limit` as compatibility alias for `maxProductsPerQuery`
- accept `delivery_locations` as alias for `deliveryLocations`
- accept an array of city strings and join it when the stored field is free
  text

Do not tolerate ambiguity that changes authority, identity, money movement, or
write behavior.

### 4.3 Bound Every List Parameter

Every list/search/history tool must have hard limits:

- default small limit, usually `1` to `3`
- maximum enforced by schema
- sorted deterministic order
- explicit pagination only for admin/operator flows

If a tool can return unbounded data, it is not production-ready.

### 4.4 Prefer Semantic Inputs Over Raw Backend Inputs

LLMs should pass business intent, not backend query syntax.

Good:

```json
{
  "occasion": "Diwali",
  "quantity": 80,
  "budgetMax": 1200,
  "deliveryLocations": ["Mumbai", "Delhi"]
}
```

Bad:

```json
{
  "graphqlQuery": "products(first: 50, query: ...)"
}
```

Raw backend query tools are admin/debug tools, not customer-facing MCP tools.

## 5. Response Contract Rules

### 5.1 Use A Stable Envelope

Prefer predictable envelopes:

```json
{ "found": false }
```

```json
{
  "found": true,
  "record": {}
}
```

```json
{
  "orders": [],
  "matchedVia": "phone",
  "identitySource": "verified_header"
}
```

Avoid changing top-level shape based on incidental backend details.

### 5.2 Empty Is Not An Error

"No data found" is usually a normal business result, not a tool failure.

Use:

```json
{ "found": false }
```

or:

```json
{ "results": [] }
```

Reserve `isError: true` for actual invalid request, unavailable dependency,
privacy/identity failure, or internal failure.

### 5.3 Errors Must Be Structured And Customer-Safe

Internal errors:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "..."
  }
}
```

Customer-facing privacy/identity denials must not expose:

- "privacy guard"
- "signed header"
- "HMAC"
- "Shopify Admin"
- internal policy names
- bypass instructions
- diagnostic ids

Use plain customer-safe wording, for example:

```text
I can only check details linked to the WhatsApp number you are messaging from.
```

### 5.4 Include Reply Drafts Only When They Reduce Risk

`customerReplyDraft` and `replyContract` are useful when:

- the tool has all facts needed for a narrow answer
- the model often phrases the answer badly
- a draft prevents another tool call
- customer-safe wording is important

They are not a replacement for the agent's voice. They are source material and
constraints.

Good reply contract:

```json
{
  "replyContract": {
    "status": "success",
    "useCustomerReplyDraft": true,
    "mustMentionLatestOrderName": "#109260",
    "mustNotUseHiccupWording": true
  }
}
```

Do not put broad prompt instructions or policy essays in every tool result.

### 5.5 Prefer Compact Summaries For Search Results

Search/list tools should return enough to choose next steps:

- id/handle
- title/name
- price/status
- availability
- short reason/matched query

Put bulky details behind a detail tool:

- long description
- all images
- all variants
- all tags
- full fulfillment objects

### 5.6 Preserve Data Freshness Signals

Compact does not mean vague. If the answer depends on freshness, include the
timestamp or status needed to avoid misleading the customer:

- `updatedAt`
- `createdAt`
- `fulfillmentStatus`
- `inventory checked at`
- `record status`

Do not include every audit timestamp. Include the one the LLM needs to phrase a
truthful answer.

## 6. Identity, Privacy, And Authority

### 6.1 Verified Identity Is The Trusted Source

Customer-facing MCP tools must use Gantry-projected caller identity where
available. Do not trust phone/email/customer id written by the customer into
the chat.

For external HTTP MCPs, Gantry projects identity with a signed caller identity
header. The MCP server verifies that header and stores identity in request-local
context. Tool handlers then read identity from context, not from LLM-provided
arguments.

Required behavior:

- missing required verified identity returns a safe failure
- bad signature returns unauthorized/safe failure
- prompt-supplied phone/email cannot broaden access
- logs do not print raw identity secrets or signed headers

### 6.2 Keep Admin Mode Separate From Customer Mode

Some tools can support operator/admin calls where the operator intentionally
passes customer ids. That mode must be explicit and configured separately from
customer verified-identity mode.

Do not silently let a customer-facing agent switch into admin mode by passing
arguments.

### 6.3 Read Tools And Write Tools Need Different Review

Read-only tools can be customer-facing after privacy review.

Write tools require a separate design review:

- exact business action
- idempotency key
- confirmation rules
- audit event
- rollback/cancel behavior
- permission/capability boundary
- customer-visible failure wording

Do not add write verbs to an existing read-only MCP surface casually.

Forbidden for read-only MCPs:

```text
apply*
create*
update*
delete*
cancel*
modify*
write*
set*
```

If a write graduates, do it as a reviewed new tool/server version with tests.

### 6.4 Permission And Capability Boundary

Tool availability is authority. A selected MCP source means the agent may see
and call the exposed tools through Gantry's policy layer. Do not rely on prompt
wording to hide dangerous tools.

For every tool, decide:

- customer-facing default
- customer-facing but explicit/follow-up only
- operator/admin only
- internal/pre-run only
- disabled/deprecated

If a tool is internal/pre-run only, prefer calling it server-side through the
runtime/provider path instead of advertising it as a normal LLM choice.

## 7. Tool-Loop Reduction Patterns

### 7.1 Runtime Prefetch For Known Context

Use runtime/server-side prefetch when all are true:

- the runtime has a deterministic trigger
- the needed tool is known
- the result is small
- the result is useful before the first LLM answer
- failure should not block the customer reply

Boondi example:

```text
recent digest exists -> call boondi-crm.get_last_query_or_lead({})
-> inject <boondi_crm_context> -> main LLM greets naturally
```

Do not make the LLM first discover and call that tool.

### 7.2 Aggregate Read For Common Answers

Use an aggregate tool when the common answer always needs related facts.

Example:

```text
latest order status = order name + items + total + fulfillment status
```

So `get_recent_orders_with_details` returns that in one call by default.

### 7.3 Narrow Detail Lookup For Explicit Follow-Up

Use detail tools when the customer asks for a specific deeper object:

- "show order #1234"
- "tell me more about this product"
- "compare these two products"

Do not return detail for every search result just in case.

### 7.4 Cache Inside The MCP When Safe

Short-lived request/process cache can reduce backend calls when:

- data is read-only for the answer window
- identity boundary is part of the cache key
- stale data risk is acceptable
- cache does not bypass privacy checks

Do not cache customer-private data globally without identity scoping.

### 7.5 Deterministic Routing Beats Prompt Hope

If a routing rule can be deterministic, make it deterministic:

- recent digest exists -> prefetch latest CRM record
- verified caller asks "latest order" -> latest-order aggregate tool
- duplicate provider message id -> dedupe before tool/LLM

Prompt guidance is useful, but it is not a substitute for deterministic routing
when the runtime already has the signal.

## 8. Observability And Evidence

### 8.1 Every Tool Needs Traceable Request/Response Evidence

Production debugging requires proof of:

- server name
- tool name
- conversation/customer reference, safely redacted where needed
- request started
- response returned
- duration
- error code when failed

Gantry flow logs should show `flow:mcp.request` and `flow:mcp.response` for
LLM-visible MCP calls. Server-side pre-run MCP calls should log provider success
or failure with safe metadata.

### 8.2 Logs Must Be Useful And Safe

Allowed logs:

- tool name
- record id
- count
- status/category
- duration
- high-level error code
- hashed or synthetic conversation refs

Do not log:

- raw phone numbers in production logs
- emails
- full transcripts
- database URLs
- access tokens
- HMAC secrets
- signed identity headers
- raw customer private payloads

### 8.3 Measure Customer Latency Separately From Tool Latency

For customer-facing changes, capture:

- `replySeconds`
- latency stages
- MCP request/response durations
- whether the turn needed one LLM call or multiple
- whether a tool result expanded SDK session context

Do not claim a tool optimization improved latency without live trace evidence.

## 9. Testing Requirements

### 9.1 Unit Tests For Every Tool

Cover:

- valid minimal input
- default limit behavior
- max limit enforcement
- empty result shape
- privacy/identity failure
- backend error shape
- compact response fields
- no forbidden fields

For aggregate tools, test that the common question can be answered from one
response.

### 9.2 Contract Tests For Tool Surface

Maintain tests that lock:

- tool name
- tool description intent
- input schema
- response envelope
- customer-safe errors
- read/write classification

This prevents accidental broadening.

### 9.3 Live Tests For Customer Paths

A production-level MCP change is not proven by unit tests alone. Use live
signed inbound traffic when the tool affects customer chat.

Capture:

- inbound persisted
- outbound persisted
- latency trace exists
- MCP request/response appears where expected
- no unexpected second tool call
- no duplicate reply
- no customer context leak
- settled worker state after reply

Boondi live regression source:

```text
agents/boondi_support/docs/customer-worker-flow-live-verification-plan.md
```

### 9.4 Failure Tests

Every customer-facing tool path must prove graceful degradation:

- MCP server down
- backend timeout
- empty result
- identity missing
- identity mismatch
- malformed args
- backend returns partial data

Failure should be structured, safe, and should not strand runtime work.

### 9.5 Build And Lint Gates

Before handing off an MCP change:

- build the changed package
- run its unit tests
- run relevant root typecheck/lint when the change touches shared contracts
- run live tests when customer behavior or runtime wiring changes

Generated `dist` files should not be treated as source of truth in review; check
the TypeScript source and tests.

## 10. Production Readiness Checklist

Use this before exposing or changing an MCP tool.

### Purpose

- [ ] The tool has one clear customer/operator job.
- [ ] The name is action + object.
- [ ] The description says when to use it and when not to.
- [ ] There is no ambiguous overlap with an existing default tool.

### LLM/Latency

- [ ] The common path is one call.
- [ ] The tool avoids a known multi-call chain.
- [ ] The response is compact by default.
- [ ] Lists have small defaults and hard maximums.
- [ ] The tool does not require `mcp_list_tools` in known flows.
- [ ] Tool result does not include fields the LLM does not need.

### Input

- [ ] Customer identity comes from verified runtime context where possible.
- [ ] Argument-free call works for the common customer path.
- [ ] Schema has strict bounds.
- [ ] Harmless model shorthand is accepted if it prevents repair loops.
- [ ] Backend query syntax is not exposed to the LLM.

### Response

- [ ] Empty result has a normal structured shape.
- [ ] Errors are structured.
- [ ] Customer-visible denial text is safe.
- [ ] No secrets, headers, internal diagnostics, raw rows, or full transcripts.
- [ ] Reply draft/contract exists only if it meaningfully reduces risk or calls.

### Authority

- [ ] Read/write classification is explicit.
- [ ] Write behavior, if any, has separate review, idempotency, audit, and
  permission design.
- [ ] Admin/operator mode is separate from customer mode.
- [ ] Caller identity cannot be widened by prompt arguments.

### Observability

- [ ] Request and response are traceable.
- [ ] Logs have safe metadata.
- [ ] Tool duration is visible.
- [ ] Live trace evidence can prove whether the optimization worked.

### Tests

- [ ] Unit tests cover success, empty, error, privacy, and compactness.
- [ ] Contract tests lock tool name/schema/response.
- [ ] Live customer-path test exists when customer chat behavior changes.
- [ ] Failure mode test proves no stranded runtime work.

### Operations

- [ ] MCP has a healthcheck.
- [ ] Required env is validated at startup.
- [ ] Backend calls have timeouts.
- [ ] Retry/rate-limit behavior is bounded and tested.
- [ ] Deployment/run instructions identify port and transport.

## 11. Design Templates

### 11.1 New Tool Proposal

Use this before implementation:

```markdown
## Tool Proposal: <server>.<tool_name>

Customer/operator question:

Common answer path:

Why this is one call:

Why existing tools are insufficient:

Inputs:

Default response fields:

Fields intentionally excluded:

Empty result shape:

Error shapes:

Identity/authority boundary:

Read/write classification:

Expected latency impact:

Transport/config impact:

Tests:

Live evidence plan:
```

### 11.2 Response Shape Template

```json
{
  "found": true,
  "record": {
    "id": "stable-id",
    "status": "qualifying",
    "summaryBrief": "One short useful line",
    "updatedAt": "2026-06-20T00:00:00.000Z"
  }
}
```

Empty:

```json
{ "found": false }
```

Error:

```json
{
  "error": {
    "code": "IDENTITY_REQUIRED",
    "message": "No verified caller identity on this request."
  }
}
```

### 11.3 Tool Description Template

```text
PREFERRED single call for <common customer question>: returns <compact data>
for the verified caller by default. Use empty arguments {} in customer
conversations. Pass <optional arg> only when <explicit condition>. Use
<other_tool> only when <detail/broad condition>.
```

## 12. Anti-Patterns

Avoid these in production MCPs:

- broad `list_all_*` tools exposed to customer chat
- raw database rows as tool results
- raw GraphQL/REST payloads as tool results
- requiring phone/email args when verified identity exists
- tool descriptions that say only "use this to get data"
- overlapping tools with no preferred default
- default limits above what the common answer needs
- including all images, descriptions, variants, tags, or transcript lines by
  default
- asking the LLM to call `mcp_list_tools` before known tools
- returning internal policy names to customers
- adding write verbs to read-only MCPs without a separate review
- making an empty result an exception
- making optional context fetches block customer replies
- optimizing based on intuition without trace evidence
- sharing admin/debug tools with customer agents by prompt convention only
- changing response shape without contract tests and caller search
- adding a tool because the backend has an endpoint, not because the agent has a
  clear job
- hiding a data-model problem by asking the LLM to reconcile broad raw results

## 13. Examples From This Repo

### 13.1 CRM Returning-Customer Greeting

Problem:

Returning customers should get a personalized greeting, but asking the LLM to
discover CRM tools and fetch all open records adds avoidable latency and tokens.

Design:

- trigger server-side only when recent digest evidence exists
- call `boondi-crm.get_last_query_or_lead({})`
- return one latest active record
- keep compact fields only
- inject `<boondi_crm_context>` before main chat LLM
- skip or degrade silently on `found:false` or CRM failure

Why it is good:

- no `mcp_list_tools` round trip
- no broad `get_open_records` result
- no second LLM/tool loop just to greet
- one latest record prevents older opportunity leakage
- failure does not block customer reply

### 13.2 Shopify Latest Order

Problem:

"Where is my order?" used to tempt a chain of customer lookup, order list, and
order detail calls.

Design:

- `get_recent_orders_with_details` defaults to the verified caller
- default `limit` is `1`
- returns latest order details needed for the answer
- includes a customer-safe draft/contract where useful
- avoids a follow-up `get_order` for the common case

Why it is good:

- one call for the common order-status question
- compact enough for chat
- identity is verified at the data layer
- broader history still requires explicit intent

### 13.3 Shopify Gifting Context

Problem:

Gifting answers often need both customer history and product context, but
product search can explode response size.

Design:

- aggregate latest order plus product search only when brief is qualified
- bound product query count and max products per query
- return compact product summaries
- keep returned fields as source data, not final customer copy

Why it is good:

- avoids several tool calls for qualified gifting flows
- does not run speculative broad product search for weak briefs
- keeps the output customer-safe and bounded

## 14. Surface Impact Matrix For MCP Changes

Every MCP change should classify these surfaces before implementation:

| Surface | Classification | Questions |
| --- | --- | --- |
| Runtime behavior | Changed / Unchanged | Does this alter customer chat, pre-run context, retries, or failure behavior? |
| `settings.yaml` | Changed / Unchanged | Is a new MCP source/capability/config required? |
| Postgres/runtime projection | Changed / Unchanged | Are new rows, migrations, cursors, or records needed? |
| Control API | Changed / Unchanged | Does admin/API expose or configure this tool? |
| SDK/contracts | Changed / Unchanged | Does the LLM payload, tool schema, or response contract change? |
| CLI | Changed / Unchanged | Is there a debug/migration command? |
| Gantry MCP/admin skill | Changed / Unchanged | Does agent-facing Gantry MCP authority change? |
| Channel/provider adapters | Changed / Unchanged | Does caller identity or channel data projection change? |
| Docs/prompts | Changed / Unchanged | Are prompt guidance or design docs updated? |
| Audit/events/logs | Changed / Unchanged | Can request/response/failure be traced safely? |
| Tests/verification | Changed / Unchanged | What unit, contract, and live checks prove it? |

Do not leave a surface implicit. If it is unchanged, say why.

## 15. Self-Review Checklist

Before calling an MCP design production-ready, read the guide again and answer:

1. Can the common customer question be answered in one tool call?
2. Did we remove or avoid a known LLM/tool loop?
3. Is the response smaller than the raw backend object by design?
4. Are all returned fields directly useful to the LLM?
5. Could an older/private customer record leak into a different customer's
   answer?
6. Can prompt-supplied identity widen access?
7. Does empty data produce a normal response?
8. Does dependency failure avoid blocking unrelated customer replies?
9. Can logs/traces prove exactly which tool ran and why?
10. Do tests lock the schema and compact response?
11. Is there live evidence for customer-facing behavior?
12. Would a future engineer know which tool is preferred without asking?

If any answer is weak, fix the design before adding more prompt instructions.
