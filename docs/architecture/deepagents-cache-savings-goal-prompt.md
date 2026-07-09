# Goal Prompt: DeepAgents Cache Savings + Honest Cache Declarations

## Objective

Capture the two concrete prompt-cache cost findings from the provider-documentation research: send stable cache-locality keys where providers document them (xAI, Fireworks), and narrow cache declarations for models whose caching is not documented, so `/status` cache labels and cost estimates never overstate savings.

Use ponytail. Keep the change surgical. No compatibility shims. Explicitly out of scope: Vertex AI and Bedrock stay `NO_CACHE_SUPPORT` / `cacheMode: 'none'` exactly as they are (per research: Bedrock's OpenAI-compatible endpoint documents no cachePoint; Vertex explicit CachedContent would add storage charges).

## Background (already researched — verify doc claims only where noted)

- xAI documents `prompt_cache_key` / `x-grok-conv-id` for cache locality: https://docs.x.ai/developers/advanced-api-usage/prompt-caching
- Fireworks documents `prompt_cache_key`: https://docs.fireworks.ai/guides/prompt-caching
- Groq documents prompt caching for GPT-OSS models only: https://console.groq.com/docs/prompt-caching
- Cerebras documents caching for GPT-OSS models; cached tokens billed at input price: https://inference-docs.cerebras.ai/models/openai-oss
- Together caching is model-specific (cached-input pricing on the pricing table): https://docs.together.ai/docs/inference/pricing
- OpenRouter's supported-provider list does not back GLM prompt caching: https://openrouter.ai/docs/features/prompt-caching

## Required Behavior

1. **Cache-locality key**: chat-completions requests to xAI and Fireworks carry a stable `prompt_cache_key` scoped to the Gantry conversation/thread, so repeated turns land on the same cache shard. Other providers are unaffected. Key must be stable across turns of the same thread and must not leak message content (an opaque conversation/thread identifier is fine).
2. **Honest declarations**: models whose prompt caching is not documented get `cacheMode: 'none'` so `/status` shows `Cache: unsupported` instead of claiming automatic caching:
   - `groq:llama-3.3-70b-versatile`, `groq:llama-3.1-8b-instant` (keep `groq:gpt-oss-120b`)
   - `cerebras:zai-glm-4.7` (keep `cerebras:gpt-oss-120b`)
   - `openrouter:glm-5.2` — unless model-specific docs prove support (check during implementation; cite in the entry's source comment if kept)
   - Together entries without cached-input pricing on the official pricing table (check both shipped entries during implementation)
   - Do not touch: deepseek, xai, fireworks, openai, gemini-direct, anthropic, kimi entries; vertex and bedrock stay as-is.

## Implementation Shape

- **Host → runner projection** (the runner must not import the catalog): follow the existing `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL` pattern (`apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts:152` → `deep-agent-runner.ts:204`). Add one env (e.g. `GANTRY_DEEPAGENTS_PROMPT_CACHE_KEY`) that the host sets ONLY for providers documented to accept it (xai, fireworks — drive this from the provider definition, e.g. a small optional flag on the provider's cacheSupport.prompt, not a hardcoded id list in the adapter). Value: stable opaque key derived from the conversation/thread identifiers the adapter already has.
- **Runner**: `apps/core/src/adapters/llm/deepagents-langchain/runner/model-factory.ts` (ChatOpenAI construction, `configuration: { baseURL }` at line ~120) passes the key through `modelKwargs: { prompt_cache_key }` when the env is present. No catalog import, no provider names in the runner.
- **Catalog narrowing**: flip `cacheMode` to `'none'` (and drop `cacheTokenFields`/`cachedInputUsdPerMillionTokens` on those entries) in `apps/core/src/shared/model-catalog-openai-compatible.ts` and `apps/core/src/shared/model-catalog.ts` (glm-5.2) per the list above.
- Remember the runtime policy allowlist: new runner env vars must be added to `apps/core/src/runtime/agent-spawn-runtime-policy.ts` (see `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL` at line 88).

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | xAI/Fireworks requests carry `prompt_cache_key`; `/status` cache labels become honest for narrowed models. |
| `settings.yaml` | Unchanged | No new user config. |
| Postgres/runtime projection | Unchanged | No persistence change. |
| Control API / SDK / CLI | Unchanged | No contract change. |
| Channel/provider adapters | Unchanged | DeepAgents lane only. |
| Docs/prompts | Unchanged by design | Behavior matches existing cache docs. |
| Tests/verification | Changed | Unit coverage for env projection, modelKwargs pass-through, narrowed catalog entries. |

## Acceptance Criteria

- A test proves the execution adapter projects the cache-key env for an xai-routed model and a fireworks-routed model, and does NOT project it for openai/groq/deepseek/vertex/bedrock.
- A test proves the key is stable across two prepares of the same conversation/thread and differs across threads.
- A test proves model-factory adds `prompt_cache_key` to modelKwargs when the env is set and omits it otherwise.
- A test (or updated existing catalog test) proves the narrowed entries resolve `cacheProvider 'none'` and `/status` label `unsupported`.
- Runner still imports no catalog module (architecture check clean).
- No changes under vertex/bedrock definitions.

## Focused Verification

```bash
npm run test:unit -- apps/core/test/unit/models/model-catalog.test.ts apps/core/test/unit/session/session-command-format.test.ts
npm run test:unit -- apps/core/test/unit  # broaden only if the focused set is green
npm run build
python3 .codex/scripts/check_architecture.py
```

Runtime smoke (manual, later): a chat turn on an xAI model with request logging confirms `prompt_cache_key` in the body and rising `cached_tokens` on the second turn.
