# Company Brain Core

Gantry company brain is app-scoped shared memory for durable company facts that must be visible across agents. It is separate from scoped user/group memory:

- `brain_pages` stores canonical markdown pages keyed by `(app_id, slug)`.
- `brain_entities` stores normalized people, companies, projects, topics, and documents.
- `brain_edges` stores extracted graph facts with an evidence page.
- `brain_page_embeddings` stores page vectors keyed by provider, model, and content hash.

Write paths are `gantry brain import <dir>`, `POST /v1/brain/import`, and the agent-facing `brain_write` MCP tool. All writes re-extract entities and replace the page's evidence edges.

Read paths are `gantry brain status`, `GET /v1/brain/status`, `brain_search`, and `brain_query`. Search uses lexical recall and, when memory embeddings are configured, vector recall with reciprocal-rank fusion. Query synthesis only cites retrieved brain pages; direct graph questions such as "who works at X?" are answered from `works_at` edges.

Embedding backfill is registered as the trusted system job `system:brain-embedding-backfill` with prompt `__system:brain_embedding_backfill`. It uses the same memory embedding provider configuration and scans pages whose current content hash has no ready embedding.

Verification for this slice:

- `npm run test:unit -- apps/core/test/unit/brain/`
- `npm run test:integration:postgres -- apps/core/test/integration/brain-core.postgres.integration.test.ts`
- `python3 .codex/scripts/check_architecture.py`
