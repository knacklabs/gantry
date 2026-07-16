# Goal Prompt: Dev Guardrails & Usage (Tier 2)

## Objective

Close the Tier-2 set from `docs/architecture/dev-experience-gap-analysis.md`:
declarative per-agent tool rules (programmatic enforcement instead of prompt
hope), validation-retry for `response_schema`, and a `/v1/usage` query API over
durable normalized usage events. Plus one hygiene fix: declare the `langchain`
dependency `apps/core` already imports.

Use ponytail. Keep changes surgical. No compatibility shims.

## Locked decisions (do not re-litigate)

- Hooks are **declarative rules only** (user decision): reviewed settings
  config evaluated in the existing provider-neutral tool gate. No arbitrary
  code execution, no outbound HTTP decision hooks (deferred).
- Blocked tool calls return the Tier-1 structured error envelope
  (`category: 'permission'` or `'validation'`, `isRetryable: false`, message
  naming the rule) — the agent can reason about the denial.
- Validation-retry is bounded and feeds the validation error back to the model;
  the terminal failure carries the last candidate output instead of
  suppressing it.
- Usage API is read-only aggregation over one normalized usage event stream;
  no billing math beyond token counts and request counts.

## Stage A — Declarative tool rules

1. New per-agent `tool_rules` list in settings (reader-version conventions),
   each rule one of:
   - `block`: `{ tool: <name or glob>, when?: { arg: <dot.path>, matches: <regex> }, action: block, reason: <string> }`
   - `require_prior`: `{ tool: <name or glob>, action: require_prior, prior: <tool name>, reason: <string> }` —
     the named prior tool must have completed successfully earlier in the same
     run (run-scoped success ledger).
2. Evaluate in the shared neutral gate (`apps/core/src/runner/tool-gate-core.ts`
   seam) so worker and inline lanes both enforce; wire a run-scoped
   prior-success ledger where tool results already flow.
3. Denials return the structured error envelope and are visible in the
   existing tool-activity audit events.
4. No result transforms / PostToolUse redaction in v1 (deferred; document).

Acceptance: unit tests prove block-by-name, block-by-arg-match,
require_prior unmet → denial with envelope + reason, require_prior met →
allowed, rules absent → behavior unchanged; one integration case on each lane
(worker path unit-level is acceptable if the gate is shared and covered);
settings validation rejects malformed rules naming the field.

## Stage B — response_schema validation-retry

1. Compile the JSON schema at session-message admission
   (`apps/core/src/control/server/routes/sessions.ts` seam) — invalid schema →
   shaped 400 naming the failure, before any model call.
2. Validate final lane output against the compiled schema at the shared lane
   boundary (both lanes). On structural failure, retry once (bounded constant,
   not configurable in v1) with the validation error appended to the
   conversation as corrective context.
3. Retry exhaustion → terminal error via the Tier-1 failure envelope carrying
   the last candidate text (additive field), not a bare string, and the
   existing `status:"error"` semantics.

Acceptance: unit tests for compile-reject at admission, single-retry success
path (first output invalid, corrected second output returned), retry
exhaustion carrying last candidate; integration case in the inline suite with
a mocked model producing invalid-then-valid output.

## Stage C — /v1/usage API

1. One normalized usage event (tokens in/out, model alias, provider, plus
   correlation: appId, apiKeyId?, agentId?, runId?, jobId?) persisted durably
   from the three paths: live turns (usage already on `AgentOutput` in
   `apps/core/src/runtime/group-agent-runner.ts`), scheduler jobs (already
   durable in terminal events — reuse, don't duplicate), and the LLM
   passthrough (gateway audit seam in
   `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts`
   gains token counts parsed from provider responses where present).
2. `GET /v1/usage`: time-range required, filters (agentId, apiKeyId, runId,
   jobId, model), `group_by` (agent | api_key | model | day), scoped by the
   API key's app access; new `usage:read` scope. OpenAPI + regenerated SDK
   types + typed client resource.
3. No backfill of historical runs; the API serves events from deployment
   forward (document).

Acceptance: integration test on disposable Postgres proves a live turn, a
scheduled job, and an LLM passthrough call each produce exactly one normalized
usage event with correct correlation; route tests for filters, grouping,
scope enforcement (403 without `usage:read`), and app scoping.

## Stage D — dependency hygiene

Declare `langchain` (pin matching the currently hoisted resolution) in the
root manifest — `apps/core` imports `langchain/chat_models/universal` today as
an undeclared transitive. The lockfile resolution must not change (tree
already hoists it); `npm ci` stays green under latest npm. Orchestrator-owned
(lockfile regeneration needs network the implementation sandbox lacks).

## Stage E — runnable example app

A clonable Next.js example under `examples/` exercising the real developer
journey against a local Gantry sidecar: chat turn with send/wait, SSE
streaming proxy, a structured workflow step (`response_schema` + per-request
`effort`), a signed lifecycle-webhook receiver (`run.completed`,
`interaction.pending`), one Direct LLM API call through the passthrough, and a
`GET /v1/usage` readout of what the demo spent (Stage C). Uses `@gantry/sdk`
via workspace reference; a README walks setup (register agent, mint key with
scopes, register webhook). CI-buildable: a workspace build/typecheck script
covers it so the example cannot rot — no e2e harness against a live runtime in
v1.

Acceptance: `npm run build` (or a dedicated `build:examples` script wired into
the root build) compiles the example; the example imports only public SDK
surface (`@gantry/sdk`) — no `apps/core` internals; README setup steps name
the exact scopes and settings the flows require.

## Non-goals

HTTP decision hooks, PostToolUse result transforms, configurable retry counts,
usage backfill, cost/pricing computation, budgets beyond Tier 1, session fork,
MCP resources, batches, replay/eval.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Tool-rule gate, validation-retry loop, usage event emission. |
| `settings.yaml` | Additive | `tool_rules` per agent; reader version bump. |
| Postgres | Additive | Usage events table (or reuse runtime_events with a typed payload — decide at the seam, prefer reuse). |
| Control API | Additive | `GET /v1/usage`; `usage:read` scope. |
| SDK/contracts | Additive | Generated types + usage client resource. |
| Docs | Changed | Orchestrator-owned: capability-management (tool rules, retry), SDK reference (usage API), agent-internals (denial envelope). |
| Tests | Changed | Per-stage coverage above. |

## Pipeline notes (from Tier 1)

- Codex handoffs: STOP and ask on any scope mismatch before editing; no
  self-started autoreview; no git commits; no background processes.
- When adding exports to a module that tests mock (`agent-spawn-host` class of
  break): update EVERY `vi.mock`/`vi.doMock` site across unit, integration,
  AND e2e trees in the same change — grep for the module path.
- Generated SDK files are prettier-ignored; regenerate + `check:generated`
  after OpenAPI changes.
- Don't pin "latest migration/last event" style assertions — assert contains.

## Focused Verification

```bash
npm run build
npm test
GANTRY_TEST_DATABASE_URL=... npm run test:e2e:postgres
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
npm run check:generated --workspace @gantry/sdk
```

Disposable Postgres for DB-backed tests. Event-parity snapshot stays green.

## Runtime Smoke

Build + `launchctl kickstart` + `gantry status`. Then: an agent with a `block`
rule observably denied with the envelope reason; a `require_prior` rule
allowing after the prior succeeds; one `GET /v1/usage` returning the smoke
turn's event. Knacklabs lead-gen job to successful terminal result. Capture
exact blockers.

## PR Closeout

One PR; stages as sequential commits; docs are orchestrator-owned commits.
Final section: implementation summary, verification evidence, smoke results,
autoreview clean result (branch mode vs origin/main), remaining risks.

## Bounded Write Scope

- `apps/core/src/config/settings/**` (tool_rules parsing + reader version)
- `apps/core/src/runner/tool-gate-core.ts` + the rule threading and
  post-execution ledger seams: `apps/core/src/runtime/agent-spawn-types.ts`,
  `apps/core/src/runtime/agent-spawn-host.ts`,
  `apps/core/src/runtime/agent-inline.ts`,
  `apps/core/src/runtime/core-tools/registry.ts`,
  `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/types.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`,
  `apps/core/src/adapters/llm/deepagents-langchain/runner/types.ts`,
  `apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts`,
  `apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts`
  (success is only observable at the tool-result seams; rules ride the run
  input contracts)
- `apps/core/src/control/server/routes/sessions.ts` (schema compile),
  shared lane boundary modules for validation-retry
  (`apps/core/src/adapters/llm/**` lane output paths)
- `apps/core/src/runtime/group-agent-runner.ts`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts`
  (usage emission)
- New usage route module under `apps/core/src/control/server/routes/`,
  `apps/core/src/control/server/index.ts` (route registration),
  OpenAPI modules, `apps/core/src/shared/control-api-keys.ts` (usage:read)
- `apps/core/src/adapters/storage/postgres/**` (usage persistence/read)
- `packages/sdk/**` (generated types + usage resource), `packages/contracts/**`
  if settings contract requires
- Root `package.json` + lockfile (langchain declaration only)
- `examples/**` + root build script wiring (Stage E)
- Tests + docs for the above. Nothing else — STOP and ask for anything more.
