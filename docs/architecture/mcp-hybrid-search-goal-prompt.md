# MCP tool search: hybrid FTS + optional semantic — goal prompt

Status: GRILL-LOCKED 2026-07-21. Folds into #237 (develop) — extends R3's
`mcp_search_tools`. Build on develop AFTER the capability-authoring feature
commits (both touch mcp-tool-proxy — avoid concurrent edits).

## Locked decisions

1. **Union + blended score.** FTS produces exact-term candidates; semantic
   (cosine over embeddings) produces intent candidates; merge both sets and
   rank by a blended score = normalized weighted-FTS + cosine. Semantic
   RECALLS tools FTS missed (synonyms/paraphrases); FTS keeps exact-name
   precision.
2. **Optional + degradable like memory.** Reuse the SAME embeddings provider
   memory/brain use (`createEmbeddingProvider`, `settings.embeddings` /
   MEMORY*EMBED*\*); NO new provider config. One opt-in boolean
   `mcp.tool_search.semantic_enabled` (default OFF, restart-owned). "Available"
   = flag on AND provider configured AND the embed call succeeds THIS request;
   any miss (no provider/key, timeout, error) silently falls back to pure FTS,
   exactly like memory. Never mandatory, never a hard dependency.
3. **Lazy embed, cache by text_hash.** Only when semantic is on and a search
   runs: embed the query (1 call) and cosine-rank inventory tools. Each tool
   vector = embed of `name\n description [\n server]`, cached in the EXISTING
   `embedding_cache` (text_hash+model -> vector, 1536-dim pgvector) — embedded
   once, reused across sessions even though inventory is an in-memory Map. Only
   cache-miss (new/changed) tools embed, in a bounded-concurrency batch. No new
   table, no background job. Embed failure -> FTS for that request.
4. **FTS quality: ranking + field-weighting + light stemming.** Score by
   weighted term hits (name > description > server) — required so the blend has
   an FTS score and best-match ranks first, not just "any match". Add light
   stemming (issue<->issues, create<->creating) so the FTS-ONLY default (semantic
   off) handles morphological variants in descriptions. DEFER prefix matching +
   trigram/typo fuzzy (semantic covers fuzzy recall when on; add later on real
   miss-rate).
5. **Landing: fold into #237/develop.** Extends `mcp_search_tools`; depends on
   develop's R3, so cannot reach main before #237 merges regardless.

## Implementation defaults (bake in unless overridden)

- **Exact/high-FTS name match always ranks at/near the top** — cosine can add
  recall and break ties but must never bury an exact tool-name match (precision
  wins). Concretely: an exact name or full-token-name match floors above all
  semantic-only hits.
- **Blend weight is a tunable constant** (single knob, sensible default, no new
  settings key unless a real need appears — YAGNI).
- **Embed text** = tool name + description (+ server as light trailing context);
  same fields FTS ranks over.
- Preserve `mcp_search_tools`' existing result cap, the callable-now vs
  acquire-first signaling (honest, ties to receipts), and R5's cold multi-server
  inventory fetch + bounded concurrency.
- Semantic path reuses memory's embedding-cache store
  (`apps/core/src/memory/memory-embedding-cache-store.ts` PostgresEmbeddingCacheStore) — do
  not reimplement caching.

## Cache-safety / scope

- Pure additive: default OFF = today's FTS behavior byte-for-byte. No change to
  the prompt static/dynamic boundary (search is a runtime tool call, not prompt
  text).
- Runtime-agnostic: `mcp_search_tools` is reachable from both lanes; the hybrid
  ranking lives in the shared inventory/proxy layer, so both the Claude-SDK and
  DeepAgents lanes benefit (relates to the tool-awareness plan).

## Tests (behavioral, pin each)

- FTS-only (semantic off) default: unchanged for exact matches; stemming makes
  `issue` match a tool described "Open an issue"; ranking puts the best-named
  tool first.
- Semantic on: a query with NO shared term ("file a bug") recalls a tool
  described "Open an issue" that FTS alone misses; exact-name query still ranks
  the exact tool first (precision floor).
- Degradation: semantic enabled but provider unconfigured / embed throws ->
  identical results to FTS-only (no error surfaced to the agent).
- Cache: same tool text embedded once (embedding_cache hit on 2nd search);
  query embedded per search.

## Non-goals

- No new embeddings provider or model config (reuse memory's).
- No prefix/trigram FTS now. No background pre-embedding. No new table.
- No semantic for skills in v1 (MCP tools only; same interface later if needed).
