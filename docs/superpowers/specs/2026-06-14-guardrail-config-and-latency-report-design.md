# Guardrail config contract + per-reply latency report — design spec

- Date: 2026-06-14
- Branch: `codex-lateny-fix`
- Status: approved design, pre-implementation
- Author: coding agent + operator (Samad)

## 1. Summary

Two **independent** production-hardening changes, brainstormed and delivered together:

- **WS1 — Guardrail config contract (core, generic).** Make `settings.yaml` say
  explicitly what happens to a guarded turn. Add an `unresolved` disposition to
  the guardrail config. Stop inferring "inline scope guardrail" behavior from
  whether a policy file happens to export `systemPromptAppend`. Boondi becomes
  `mode: deterministic` + `unresolved: inline`; classic classifier agents become
  `mode: both` + `unresolved: classifier`.

- **WS2 — Per-reply latency report (core capture + boondi-admin UI).** Capture a
  detailed, generic per-reply latency trace — guardrail time, each main-LLM turn
  (with token usage), and each MCP tool call (with request/response) — persist it
  next to the outbound reply, and surface it in the admin panel as a clickable
  badge that opens a waterfall + collapsible payload report. Commands (which are
  also messages in the dashboard) get a trace too.

These share no runtime behavior. They are split only because both touch
`apps/core` and must be merged into one branch.

### Goals

- The guardrail YAML is self-describing and fail-fast; no hidden magic.
- Operators can see exactly where a reply's wall-clock time went, with full
  inputs/outputs for each step, to drive latency/cost optimization.
- `apps/core` stays agent-agnostic; only the admin panel is Boondi-specific.

### Non-goals (out of scope)

- Changing any guardrail business rule or Boondi prompt/policy content.
- Cross-conversation latency analytics / aggregation dashboards.
- Storing full payloads in production by default (gated behind a dev flag).
- Tracing background jobs (idle digest, dreaming, CRM watcher) beyond the
  operator-driven slash commands listed below.

## 2. Constraints (verified facts, code is SOT)

- **Boundary rule.** `apps/core`, channel adapters, and the plugin/command/skill
  registries are the generic runtime and must never hardcode Boondi/Shopify
  names, phones, prompts, or business logic. The latency-capture schema and code
  use generic field names (`server`, `tool`, `stage`). The admin panel
  (`~/Desktop/boondi-admin`) is Boondi-specific and may name things freely.
- **Dev-mode restart behavior** (answers the operator's question — verified, not
  assumed): the root `dev` script is `tsx apps/core/src/index.ts`
  (`package.json:54`) — plain `tsx`, **no `watch`**. Core reads `.env`,
  `settings.yaml`, `SOUL.md`/`CLAUDE.md`, and the guardrail policy file at **boot
  only**, and runs DB migrations at boot. Therefore **every core change in this
  spec (code, the guardrail config, the new migration) requires a manual core
  restart** in dev. The admin panel runs `npm run dev` (Next.js) and hot-reloads
  frontend/query/API changes with **no restart**. Runner-side (child) code obeys
  `GANTRY_CHILD_RUNNER_FROM_SOURCE` (set in dev → runs from TS source; otherwise
  needs `npm run build`).

## 3. WS1 — Guardrail config contract

### 3.1 Current behavior (verified)

- `GuardrailMode = 'both' | 'deterministic' | 'classifier'`;
  `GuardrailConfig = { file; model; mode? }`, default `mode = 'both'`
  (`apps/core/src/domain/types.ts:29`). No `unresolved` field exists.
- `evaluateAgentGuardrail` (`apps/core/src/application/guardrails/guardrail-service.ts`):
  in `mode: both`, when `evaluateDeterministic` returns `null`, it calls
  `policy.systemPromptAppend(...)` and goes **inline** purely because the policy
  exports that function, only falling through to the classifier when it does not.
  This is the "hidden magic" being removed.
- `allowInlineSystemPromptAppend` is `true` on the spawn path
  (`group-processing.ts`) and `false` on warm continuation
  (`apps/core/src/runtime/message-loop.ts:307`).
- Boondi's policy (`agents/boondi_support/guardrails/guardrail.ts`) always returns
  a non-null `systemPromptAppend`, so today it always goes inline. Policy file is
  self-contained (no core imports) and stays untouched by this change.

### 3.2 New contract

Add `unresolved` to the guardrail config:

```
unresolved: clarify | allow | reject | inline | classifier
```

- `mode` = **which stages exist**.
- `unresolved` = **what happens to a turn the deterministic stage did NOT
  resolve** (deterministic returned `null`).
- The inline scope block (`policy.systemPromptAppend`) is attached **only when
  `unresolved: inline`** — never inferred from the policy's shape. Under any
  other `unresolved` value, a policy's `systemPromptAppend` is ignored.

Behavior when `evaluateDeterministic` returns `null`:

| `unresolved` | Behavior |
| --- | --- |
| `classifier` | Call the LLM classifier (today's `both` fallthrough). No classifier wired → `direct_response` `scope_clarification`, reason `ambiguous_without_classifier`. |
| `inline` | Allow + attach `systemPromptAppend`, reason `inconclusive_inline_guardrail`. Warm path (`allowInlineSystemPromptAppend === false`) → allow plain, reason `inconclusive_inline_guardrail_unattached` (never silently escalates to classifier). Policy provides no `systemPromptAppend` → `direct_response` `scope_clarification`, reason `inline_guardrail_unconfigured`. |
| `allow` | Allow plain, reason `unresolved_allow`. |
| `reject` | `direct_response` `scope_rejection`, reason `unresolved_reject`. |
| `clarify` | `direct_response` `scope_clarification`, reason `unresolved_clarify`. |

When `evaluateDeterministic` **resolves** with `action: 'allow'`, the inline
block is attached **iff `unresolved === 'inline'`** (and inline is attachable and
the policy provides it); otherwise the deterministic decision is returned as-is.

### 3.3 Validation (fail-fast at parse — operator chose "reject at parse time")

In `runtime-settings-agents-parser.ts`, after parsing `mode` and `unresolved`,
enforce:

- `mode: classifier` → `unresolved` must be **absent** (classifier runs every
  turn; nothing is "unresolved"). Present → error.
- `mode: both` → `unresolved` absent or `classifier`; defaults to `classifier`.
  Any other value → error.
- `mode: deterministic` → `unresolved` **required** and ∈
  `{clarify, allow, reject, inline}`. Absent → error. `classifier` → error
  ("use `mode: both` for classifier escalation").
- Both omitted → `mode: both`, `unresolved: classifier` (exact legacy behavior
  preserved).

Error messages list the valid combinations.

### 3.4 Control flow (pseudocode for `evaluateAgentGuardrail`)

```
mode = config.mode ?? 'both'
unresolved = config.unresolved ?? 'classifier'   // parser guarantees a valid pairing

if (mode === 'classifier') return runClassifier()   // every turn, no deterministic

det = policy.evaluateDeterministic?.(messages, context) ?? null
if (det) {
  if (det.action === 'allow' && unresolved === 'inline')
    return attachInlineOnResolvedAllow(det)   // append if attachable+present; else allow plain
  return det
}

switch (unresolved) {
  case 'classifier': return runClassifier()                 // mode === 'both'
  case 'inline':     return inlineUnresolved()              // mode === 'deterministic'
  case 'allow':      return { action:'allow', reason:'unresolved_allow' }
  case 'reject':     return { action:'direct_response', responseKind:'scope_rejection',     reason:'unresolved_reject' }
  case 'clarify':    return { action:'direct_response', responseKind:'scope_clarification', reason:'unresolved_clarify' }
}

inlineUnresolved():
  if (allowInlineSystemPromptAppend === false)
    return { action:'allow', reason:'inconclusive_inline_guardrail_unattached' }   // no classifier
  append = policy.systemPromptAppend?.(...)?.trim()
  if (append) return { action:'allow', reason:'inconclusive_inline_guardrail', systemPromptAppend: append }
  return { action:'direct_response', responseKind:'scope_clarification', reason:'inline_guardrail_unconfigured' }
```

Preserved reason strings: `inconclusive_inline_guardrail`,
`inconclusive_inline_guardrail_unattached`, `ambiguous_without_classifier`,
`classifier_failed`. New: `unresolved_allow`, `unresolved_reject`,
`unresolved_clarify`, `inline_guardrail_unconfigured`.

### 3.5 Files (WS1)

- `apps/core/src/domain/types.ts` — add `GuardrailUnresolved` type + `unresolved?`
  on `GuardrailConfig`.
- `apps/core/src/application/guardrails/types.ts` — update the `systemPromptAppend`
  comment (it no longer drives `both`-mode behavior; only `unresolved: inline`
  uses it).
- `apps/core/src/application/guardrails/guardrail-service.ts` — rewrite per §3.4.
- `apps/core/src/config/settings/runtime-settings-agents-parser.ts` — parse +
  validate `unresolved` per §3.3.
- `apps/core/src/config/settings/runtime-settings-renderer.ts` — render
  `unresolved` (emit when set; keep defaults clean).
- Tests: `apps/core/test/unit/config/agent-plugins-settings.test.ts`,
  `apps/core/test/unit/application/guardrails/customer-support-guardrails.test.ts`,
  `apps/core/test/unit/runtime/group-guardrail-inline.test.ts` (update to
  `unresolved: inline`) + new cases (see §6).
- Runtime config: `~/gantry/settings.yaml` → Boondi `mode: deterministic` +
  `unresolved: inline`. Repo `settings.example.yaml` → document Boondi
  (deterministic+inline) and a generic classifier agent (both+classifier).
- Docs/prompt collateral: `agents/boondi_support/AGENTS.md`,
  `agents/boondi_support/CLAUDE.md`, `docs/BOONDI-E2E-TESTING.md` §6a,
  `docs/BOONDI-LLM-CONTEXT-FLOW.md`, `README.md` (YAML examples).
- **Boundary**: `agents/boondi_support/guardrails/guardrail.ts` is NOT modified.

## 4. WS2 — Per-reply latency report

### 4.1 Capture architecture (grounded in verified anchors)

Core mediates all three stages, so the trace is assembled in core and persisted
with the outbound reply:

- **Guardrail stage** — timed in core where `evaluateAgentGuardrail` is invoked
  (`apps/core/src/runtime/group-guardrail.ts`). Records: `mode`, decision,
  reason, whether the inline block was attached, duration.
- **MCP tool-call stages** — captured at the core IPC proxy handler
  `mcpCallToolHandler` (`apps/core/src/jobs/ipc-admin-handlers.ts:288`), which
  **already** computes `startedAt`/`durationMs` and has `serverName`, `toolName`,
  and the chat JID; request + response payloads are visible in
  `McpToolProxy.callTool()` (`apps/core/src/application/mcp/mcp-tool-proxy.ts:100`).
  Each call is appended to a per-run collector keyed by run id / chat JID, with a
  wall-clock start timestamp for ordering.
- **Main-LLM turn stages** — the child runner's SDK loop
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:351`)
  is extended to record, per assistant turn: start/end wall-clock time, model,
  stop reason, and token usage (input/output/cache via `normalizeModelUsage`,
  already used at `query-loop.ts:486`). The ordered array is added to the stdout
  output envelope the child already writes; core parses it at
  `agent-spawn-process.ts:286` and includes it in `AgentOutput`.
- **Merge + persist** — in `group-processing.ts`, after the outbound reply is sent
  (`sendMessageToChannel`, ~`group-processing.ts:514`), core merges the guardrail
  stage + child LLM turns + collected MCP calls into one timestamp-ordered
  `stages` array and writes a `message_traces` row keyed by the outbound message
  id (`message:${chatJid}:${id}`, `canonical-message-repository.postgres.ts:34`).
- **Commands** — wrap command handling (`session-commands.ts`) with a timer;
  persist a trace on the command reply message: a single `command` stage plus any
  sub-call stages (e.g. `/extract-leads-queries` POST to mcp-crm as a `tool`
  stage). Built-ins (`/new`, `/digest-session`) produce just the `command` stage.
  Commands create no `agent_runs` row (verified) — the trace is the only timing
  record.

A small in-memory `RunTraceCollector` (core, generic) accumulates MCP-call
records during a run and is drained at persist time. It is keyed by run id and
bounded/evicted to avoid leaks if a run never completes.

### 4.2 Token capture choice

Per the operator's choice, include per-call token usage (input, output, cache
read, cache write) where the SDK exposes it; omit when unavailable. Best-effort,
never blocks a reply.

### 4.3 Storage (generic, core-owned)

New migration (next sequential file in
`apps/core/src/adapters/storage/postgres/schema/migrations/`) + a Drizzle table
def (`schema/message-traces.ts`, modeled on `schema/runs.ts`) registered in the
schema index.

```sql
CREATE TABLE message_traces (
  message_id      text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  app_id          text NOT NULL,
  conversation_id text NOT NULL,
  kind            text NOT NULL,            -- 'reply' | 'command'
  total_ms        integer NOT NULL,
  timings_json    jsonb NOT NULL,           -- ALWAYS written: stages, durations, tokens, sizes, decisions
  payloads_json   jsonb,                    -- NULLABLE: full req/resp + LLM input/output; only when GANTRY_TRACE_PAYLOADS=1
  created_at      timestamptz NOT NULL
);
CREATE INDEX message_traces_conversation_id_idx ON message_traces (conversation_id);
```

- `timings_json` (always) and `payloads_json` (flag-gated) are split so the hot
  path stays lean and payloads are independently prunable.
- The `messages` table is untouched.

`timings_json` shape (v1, generic):

```json
{
  "version": 1,
  "totalMs": 10600,
  "stages": [
    { "kind": "guardrail", "label": "guardrail", "ms": 180,
      "detail": { "mode": "deterministic", "decision": "allow", "reason": "inconclusive_inline_guardrail", "inlineAttached": true } },
    { "kind": "llm", "label": "main LLM · turn 1", "ms": 3000,
      "detail": { "model": "sonnet", "stopReason": "tool_use",
        "tokens": { "in": 17940, "out": 96, "cacheRead": 16800, "cacheWrite": 0 } } },
    { "kind": "tool", "label": "search_products", "ms": 2100,
      "detail": { "server": "shopify-api", "tool": "search_products", "ok": true, "status": 200, "requestBytes": 42, "responseBytes": 2150 } },
    { "kind": "llm", "label": "main LLM · turn 2", "ms": 5300,
      "detail": { "model": "sonnet", "stopReason": "end_turn", "tokens": { "in": 18420, "out": 64, "cacheRead": 17900, "cacheWrite": 0 } } }
  ]
}
```

`payloads_json` shape (flag-only): keyed by stage index →
`{ request, response }` for `tool` stages, and for `llm` stages
`{ systemPrompt: { hash, chars }, input, output }` (full assembled input/output;
the large static system prompt is kept by hash + size rather than duplicated
verbatim per turn to keep dev rows sane).

### 4.4 Flag

New boot-hydrated dev flag `GANTRY_TRACE_PAYLOADS` (default off). Add to the
`hydrateDynamicRuntimeEnv([...])` array (`apps/core/src/app/index.ts:50`); read
via `envValueDynamic('GANTRY_TRACE_PAYLOADS')`. Timings are captured
unconditionally; only payload capture is gated.

### 4.5 Admin integration (boondi-admin, Boondi-specific)

- `lib/queries.ts` `getMessages` → `LEFT JOIN gantry.message_traces` on the
  message id; select `total_ms`, `timings_json`, and whether `payloads_json IS
  NOT NULL` (as `payloadsAvailable`). Do NOT select `payloads_json` in the list
  query (kept out of the hot path).
- `lib/types.ts` `ChatMessage` → add
  `latency?: { totalMs: number; stages: Stage[]; payloadsAvailable: boolean }`.
- `app/api/messages/route.ts` → include `latency` in each message.
- New `app/api/trace/route.ts` (`GET ?messageId=`) → returns `payloads_json` for a
  single message, fetched lazily only when the user expands "show full payload".
- Components (`components/ChatPane.tsx`): the existing `ReplyBadge` becomes the
  clickable trigger (keeps its color/latency-level styling); a new
  `LatencyReport` modal built on the existing `ResponseCommentDialog` overlay
  pattern renders the waterfall + collapsible per-stage sections (per the
  approved mockup). Payload sections show an "enable trace flag" hint when
  `payloadsAvailable` is false; otherwise they lazy-fetch `/api/trace`.
- Read-only DB invariant preserved (no writes from the panel).

## 5. Testing & verification

- **WS1 unit:**
  `npm run test:unit -- apps/core/test/unit/application/guardrails/customer-support-guardrails.test.ts apps/core/test/unit/runtime/group-guardrail-inline.test.ts apps/core/test/unit/config/agent-plugins-settings.test.ts`
  and the propagation tests
  `npm run test:unit -- apps/core/test/unit/runtime/message-loop.test.ts apps/core/test/unit/runner/system-prompt.test.ts`.
  New cases: both+classifier escalates when deterministic is null;
  deterministic+inline attaches append; deterministic+clarify sends
  clarification; classifier mode calls classifier directly; inline NOT used
  unless `unresolved: inline`; invalid combos rejected at parse;
  inline-configured-but-no-`systemPromptAppend` → clarification.
- **WS2 unit:** trace assembly/merge ordering; flag on/off controls
  `payloads_json`; command trace has a `command` stage; admin query maps
  `latency` and `payloadsAvailable`; `/api/trace` returns payloads.
- **Typecheck / hygiene:** `npm run typecheck`; `git diff --check`.
- **Boundary scan (must return nothing in core):**
  `rg -n "Boondi|boondi|Bombay Sweet Shop|BSS|gifting|gift boxes|mithai|kaju|Diwali|Eid|shopify-api|get_gifting_context|bss_customer_support" apps/core/src`
- **E2E** per `docs/BOONDI-E2E-TESTING.md`: signed webhook from a fake operator
  number → confirm guardrail/agent/Shopify path; confirm a `message_traces` row
  is written; open the admin panel and confirm the badge + report render for both
  a chat reply and a command reply; toggle `GANTRY_TRACE_PAYLOADS` and confirm
  the payload sections appear/disappear. Restart core after config/migration
  changes (admin needs no restart).

## 6. Parallelization & merge (operator approved worktrees)

- **W2-frontend** (`~/Desktop/boondi-admin`, separate repo) runs fully in parallel
  from the start — zero conflict with core.
- **W1** (core guardrail) and **W2-backend** (core capture) run in isolated git
  worktrees off `codex-lateny-fix`; the coding agent owns the merge back into the
  branch. The only expected overlap is `group-guardrail.ts` / `group-processing.ts`
  (W1 touches guardrail decision flow; W2 wraps it with a timer + assembles the
  trace) — merged by hand, then the full unit suite + boundary scan + e2e run once
  on the merged stack.
- The pre-existing uncommitted changes on the branch (`runtime-services.ts` and
  two test files) are left as-is and not swept into spec/feature commits.

## 7. Risks / items to pin at execution (no assumptions)

- **Per-turn LLM token availability**: confirm the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk@0.3.156`) exposes usage on each `assistant`
  message (not only the final `result`). If only the final result carries usage,
  per-turn rows show duration + stop reason and attribute tokens to the final
  turn, with a one-line note in the report. Verify against the SDK message types
  at implementation.
- **Stage ordering across processes**: child (LLM turns) and core (MCP calls)
  both stamp wall-clock timestamps on one machine; merge by start time. Verify
  clocks are comparable (same process host) — they are in this single-host dev/
  prod topology.
- **Trace FK timing**: confirm the outbound message row is committed before the
  `message_traces` insert (FK), or insert in the same unit of work; derive the id
  via `messageIdFor(chatJid, msg.id)`.
- **Next migration number**: list the migrations dir at implementation and pick
  the next sequential `NNNN_message_traces.sql`.
- **`direct_response` (guardrail-canned) replies**: these never spawn the agent;
  their trace is just the guardrail stage. Confirm they still persist an outbound
  message to attach to (they do — verified canned greeting persists).
