# Goal Prompt: Company Brain Core (Stage 1)

## Objective

Implement the org-scoped company brain core for Gantry: a shared knowledge store
(pages + entities + typed edges + embeddings) that all agents in an app can read
and write, with a day-1 manual import path and three curated agent tools.

Today all memory is per-agent (`memory_items` is always filtered by `agentId`).
The brain is the first cross-agent knowledge surface: pages are app-scoped and
never agent-filtered. Design reference: gbrain (github.com/garrytan/gbrain, MIT)
— port its page model, zero-LLM self-wiring entity graph, and synthesis-with-
citations-and-gaps shape onto Gantry's existing memory substrate. Do not vendor
gbrain code wholesale; reuse Gantry's embedding pipeline, hybrid recall pattern,
pg-boss jobs, and MCP tool surface.

Use ponytail. Keep the change surgical. No compatibility shims.

**Out of scope (later stages):** Slack channel harvesting, brain dream/
consolidation job, connector delta-pollers, subscriptions, per-source ACLs,
web UI, host-side webhooks. Do not build placeholders for them.

## Required Behavior

- A brain page is markdown + frontmatter provenance: source kind
  (`import | agent | user`), source ref, author (agent id or user id),
  timestamps. Pages are keyed by `(appId, slug)`; re-writing a slug updates the
  page (no duplicates).
- Page write path (deterministic, zero LLM calls): persist page → extract
  entity refs structurally → upsert entities → upsert typed edges with the page
  as evidence. Structural extraction sources:
  - frontmatter fields: `people`, `companies`, `projects`, plus typed relation
    fields like `works_at`, `assignee`, `from`, `to`, `mentions`
  - `[[wiki-links]]` in the body (entity name refs)
- Entities are `(appId, kind, normalizedName)`-unique; kinds v1:
  `person | company | project | topic`. Edges are typed
  (`works_at | member_of | mentions | authored | assigned_to | relates_to`)
  with `evidencePageId`.
- Embeddings: reuse the existing embedding provider/cache machinery
  (`apps/core/src/memory/memory-embeddings.ts` provider factory and the
  `memory_item_embeddings` + partial HNSW pattern from migration
  `0070_semantic_memory_vectors.sql`). New `brain_page_embeddings` table,
  1536-dim, embed on write when embeddings are enabled, backfill job for the
  rest. When embeddings are disabled, everything works lexical-only.
- `brain_search` (agent tool): hybrid lexical+vector retrieval with RRF (port
  the shape of `app-memory-recall-hybrid.ts`) over pages, returning page id,
  title, snippet, provenance, plus directly-connected entities/edges. Lexical
  fallback when no query embedding is available.
- `brain_query` (agent tool): retrieval + one-hop graph expansion, then a
  host-side LLM synthesis call (reuse the same model-call lane
  `app-memory-dreaming.ts` uses) returning: synthesized answer, citations
  (page ids/titles), and an explicit "gaps" note for what the brain does not
  know. Stub-friendly: synthesis behind a small port so tests stub the model.
- `brain_write` (agent tool): agents persist durable org facts as pages with
  author provenance. A page written by agent A is immediately retrievable by
  agent B in the same app.
- Entity questions ("who works at Acme?") are answerable from edges alone —
  a repository query, no LLM.
- CLI: `gantry brain import <dir>` (recursively imports `.md` files; filename →
  slug, frontmatter + wikilinks → entities/edges; idempotent re-run) and
  `gantry brain status` (page/entity/edge/embedding counts). Follow the
  existing gantry CLI command + control API patterns.

## Implementation Shape

- New `apps/core/src/brain/` module mirroring the memory module's layering:
  `brain-types.ts`, `brain-service.ts`, `brain-page-ingest.ts` (normalize +
  structural extraction), `brain-recall.ts` (hybrid RRF), `brain-synthesis.ts`
  (port + prompt). The brain layer must not import adapter repositories —
  depend on a repository port, same as memory does.
- Storage: `apps/core/src/adapters/storage/postgres/schema/brain.ts` (tables:
  `brain_pages`, `brain_entities`, `brain_edges`, `brain_page_embeddings`) +
  one migration; repository implementation under
  `adapters/storage/postgres/repositories/`. Follow the `schema-change` skill:
  contracts, readiness, repository tests.
- Agent tools: register `brain_search`, `brain_query`, `brain_write` on the
  existing runner MCP tool surface (`apps/core/src/runner/gantry-mcp-tool-surface.ts`,
  `runner/mcp/tools/`) following existing memory/scheduler tool patterns.
- Embedding backfill: register a brain backfill cron next to the existing
  memory backfill in `apps/core/src/jobs/system-jobs.ts`, reusing its batch machinery.
- CLI + control API route for import/status following existing command
  patterns.
- Bounded write scope: `apps/core/src/brain/**`, storage schema/migrations/
  repositories for brain, runner MCP tool files, CLI brain command + its
  control API route, `apps/core/src/jobs/system-jobs.ts` (registration only), docs, tests.
  Do not modify `apps/core/src/memory/**` behavior; reuse via imports only.
  If reuse requires extracting a shared helper from memory code, extract it
  without changing memory behavior and keep the diff minimal.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | New brain service, page ingest, retrieval, synthesis. |
| `settings.yaml` | Unchanged by design | Embedding config is reused from memory embeddings; no new user config. |
| Postgres/runtime projection | Changed | Four new tables + migration; brain repository. |
| Control API | Changed | Import/status endpoints backing the CLI command. |
| SDK/contracts | Unchanged by design | No provider SDK contract change; synthesis reuses the existing model lane. |
| CLI | Changed | `gantry brain import`, `gantry brain status`. |
| Gantry MCP tools/admin skill | Changed | Three new agent tools on the existing surface. |
| Channel/provider adapters | Unchanged by design | No channel behavior changes in Stage 1. |
| Docs/prompts | Changed | This goal prompt + brain architecture doc; tool guidance where existing tools are documented. |
| Audit/events | Read-only/observable | Brain tool calls ride existing MCP tool audit; no new event kinds. |
| Tests/verification | Changed | Unit + Postgres integration coverage below. |

## Acceptance Criteria

- Unit: page ingest extracts entities/edges from frontmatter + wikilinks with
  zero LLM calls; entity names dedupe by normalized name; re-importing the same
  slug updates rather than duplicates.
- Integration (Postgres): importing a fixture dir creates expected pages,
  entities, edges; `brain_search` finds a page lexically; cross-agent
  visibility — a page written via `brain_write` as agent A is returned by
  `brain_search` as agent B; "who works at X" resolves from edges alone;
  brain embedding backfill enqueues pending pages.
- Unit: `brain_query` with a stubbed synthesis model returns answer +
  citations + gaps sections; citations reference real page ids from retrieval.
- Hybrid recall: with a stubbed embedding provider, vector+lexical fusion path
  executes and ranks a semantically-matched page (mirror the existing hybrid
  recall test approach).
- CLI import is idempotent (second run produces zero new rows).
- Architecture check remains clean (brain layer imports no adapters).

## Focused Verification

Run focused checks first:

```bash
npm run test:unit -- apps/core/test/unit/brain/
npm run test:integration:postgres -- apps/core/test/integration/brain-core.postgres.integration.test.ts
python3 .codex/scripts/check_architecture.py
```

Closeout pipeline:

```bash
npm run build
npm test
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Use disposable Postgres for DB-backed tests, never the developer's persistent
database.

## Assumptions

- Brain visibility is org-wide by design (D7): every agent in the app reads
  everything. Provenance (source kind/ref, author) is stored on every page so
  per-source ACLs can be added later without re-ingesting.
- Synthesis uses the same host-side model lane as memory dreaming; no new
  credential or provider surface.
- `memory_items` and its per-agent semantics are untouched; the brain is a new
  sibling store, not a memory migration.
- Harvesting pipelines (Slack tap, pollers, dream consolidation) are later
  stages and will build on `brain-service` write paths as-is.
