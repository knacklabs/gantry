# Goal Prompt: /status Cost + Cache Visibility For All Models

## Objective

Make `/status` always show estimated cost, and correct cache accounting, for every model in the catalog — regardless of execution lane or billing mode.

Use ponytail. Keep the change surgical. No compatibility shims. Do not touch either runner process.

## Root Cause (already traced — do not re-investigate)

- `formatUsageLine` (`apps/core/src/session/session-command-format.ts:245`) silently drops the `, estimated cost $…` suffix when `usage.estimatedCostUsd` is undefined.
- Claude Agent SDK lane only carries SDK-reported `costUSD`/`total_cost_usd` (`apps/core/src/shared/model-usage.ts:112,151`); under Claude OAuth/subscription the SDK reports no dollar cost, so the field is undefined.
- DeepAgents lane (`apps/core/src/adapters/llm/deepagents-langchain/runner/stream-normalizer.ts:396 normalizedUsage`) never sets `estimatedCostUsd` at all.
- Every `/status` usage event flows through `recordRuntimeModelUsage` (`apps/core/src/runtime/model-status-output.ts:10`), which already resolves the catalog entry via `findModelByRunnerModel`. `/status` is the only consumer of `estimatedCostUsd`.
- Cache tokens are plumbed correctly on both lanes; no cache-token changes are needed in the runners.

## Required Behavior

- `/status` shows `estimated cost $N.NNNN` on both `Current turn tokens` and `Session tokens` lines for every catalog model with declared base prices, on both execution lanes, under both API-key and OAuth billing.
- When the runner reports a real positive cost (Anthropic API-key billing), that value wins — never overwrite it.
- When the catalog entry lacks base prices (e.g. a `settings:` alias without prices), the suffix stays absent. Never render a fake `$0.0000`.
- Cost estimates account for cache traffic using per-model cache prices from the catalog.

## Implementation Shape

### 1. Catalog: cache pricing as data

Add two optional fields to `ModelCatalogEntry` and the openai-compatible entry shape (`apps/core/src/shared/model-catalog.ts`, `apps/core/src/shared/model-catalog-openai-compatible.ts`):

- `cachedInputUsdPerMillionTokens`
- `cacheWriteUsdPerMillionTokens`

Fill them only where the provider publishes cache pricing (verify against provider pricing pages; leave unset when unverifiable):

| Model | cache read $/1M | cache write $/1M (5m TTL) |
| --- | --- | --- |
| anthropic:opus-4.8 / 4.7 / 4.6 | 0.50 | 6.25 |
| anthropic:sonnet-4.6 | 0.30 | 3.75 |
| anthropic:haiku-4.5 | 0.10 | 1.25 |
| openai:gpt-5.5 | 0.50 | — (automatic, unmetered) |
| openai:gpt-5.4 | 0.25 | — |
| openai:gpt-5.4-mini | 0.075 | — |
| openrouter/groq/deepseek/xai/together/fireworks/cerebras | set where published, else unset | — |
| perplexity:sonar*, vertex:flash-3.5 | n/a (`cacheMode: 'none'`) | n/a |

Extend the `settings:` alias parser (`apps/core/src/config/settings/runtime-settings-model-aliases-parser.ts`) and renderer with the same two optional fields, following the existing optional-price pattern.

### 2. Estimator: export + make cache-aware

In `apps/core/src/shared/model-usage.ts`, export `estimateUsageCostUsd` and extend it to take the token quartet (input, output, cacheRead, cacheWrite) plus the cache provider. One uniform rule, branching only on lane semantics already carried in `usage.cacheProvider`:

- `anthropic` lane: `input_tokens` excludes cache tokens → `input·in + cacheRead·(cachedIn ?? in) + cacheWrite·(cacheWrite$ ?? in) + output·out`.
- all other lanes (`openai`, `openrouter-provider`): prompt includes cached reads → `(input − cacheRead)·in + cacheRead·(cachedIn ?? in) + output·out`; writes unmetered.
- Return `undefined` unless the entry declares both base prices.

Update the existing internal call site (`model-usage.ts:192`) to pass cache tokens.

### 3. Backfill at the single host choke point

In `recordRuntimeModelUsage` (`apps/core/src/runtime/model-status-output.ts`), before `updateRuntimeModelStatus`:

- If `input.usage.estimatedCostUsd` is a positive number, keep it.
- Otherwise (undefined or 0) backfill: `{ ...input.usage, estimatedCostUsd: estimateUsageCostUsd(billedModel ?? findModelByRunnerModel(selectedModel), usageTokens) }`.

Do not modify the runner processes, the store accumulation (`model-status-store.ts` already sums cost per event), or `session-command-format.ts`.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | `/status` cost suffix now appears for all priced models on all lanes. |
| `settings.yaml` | Optional additive | `model_aliases` gain two optional cache-price keys. |
| Postgres/runtime projection | Unchanged | In-memory status store only. |
| Control API | Unchanged | No contract change. |
| SDK/contracts | Changed internally | `ModelCatalogEntry` gains two optional fields; `estimateUsageCostUsd` exported. |
| CLI | Unchanged | No new command. |
| Gantry MCP tools/admin skill | Unchanged | Not agent-facing. |
| Channel/provider adapters | Unchanged | Rendering already correct. |
| Docs/prompts | Unchanged by design | Behavior matches existing `/status` help text. |
| Tests/verification | Changed | New unit coverage for backfill + estimator. |

## Acceptance Criteria

- A test proves anthropic-lane usage without reported cost gets an estimate that includes cache read/write at catalog cache prices.
- A test proves openai-lane usage bills `(input − cacheRead)` at input price plus `cacheRead` at the cached price.
- A test proves a runner-reported positive cost is never overwritten by the backfill.
- A test proves a zero reported cost is replaced by a catalog estimate.
- A test proves an entry without base prices yields `estimatedCostUsd` undefined (suffix absent).
- A test proves cache prices missing but base prices present falls back to full input price for cache tokens.
- `formatUsageLine` output shows the cost suffix for a backfilled snapshot (existing format tests keep passing).
- Architecture check remains clean.

## Focused Verification

```bash
npm run test:unit -- apps/core/test/unit/runtime/model-status-store.test.ts apps/core/test/unit/session/session-command-format.test.ts apps/core/test/unit/models/model-catalog.test.ts
npm run build
python3 .codex/scripts/check_architecture.py
```

New test file: `apps/core/test/unit/runtime/model-status-output.test.ts` (mirror `model-status-store.test.ts` style).

Runtime smoke (manual): chat turn on the opus default → `/status` shows the cost suffix on both token lines; repeat on a gpt model to confirm the DeepAgents lane.
