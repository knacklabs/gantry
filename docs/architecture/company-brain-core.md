# Company Brain Core

Gantry company brain is app-scoped shared memory for durable company facts that must be visible across agents. It is separate from scoped user/group memory:

- `brain_pages` stores canonical markdown pages keyed by `(app_id, slug)`.
- `brain_entities` stores normalized people, companies, projects, topics, and documents.
- `brain_edges` stores extracted graph facts with an evidence page.
- `brain_page_embeddings` stores page vectors keyed by provider, model, and content hash.
- `brain_dream_decisions` stores every applied, no-op, proposed, or rejected brain dreaming operation.

Write paths are `gantry brain import <dir>`, `POST /v1/brain/import`, and the agent-facing `brain_write` MCP tool. All writes re-extract entities and replace the page's evidence edges.

Channel harvest is opt-in per configured conversation with `brain_harvest: true`. Default is off. Turning it on is the admin disclosure decision for that conversation. The settings-control-plane path keeps the flag in `settings.yaml`, projects it through runtime settings, preserves it during desired-state export/import, and exposes it read-only in public settings plus `gantry brain status` / `GET /v1/brain/status` counts. The tap is channel-neutral and runs at the canonical inbound message persistence seam. It writes `sourceKind: channel` pages without embeddings on write:

- threaded messages append to `chan-<account-conversation>-<threadId>-<hash>`;
- unthreaded messages append to `chan-<account-conversation>-<YYYY-MM-DD>-<hash>`;
- the trailing hash anchors `(provider account, conversation, thread/day)`
  identity so long provider ids can never truncate into colliding slugs;
- page frontmatter accumulates sender display names in `people:`.

Harvest rides the canonical inbound persistence path, which only processes
messages for conversations with an active installed-agent route. In this
slice, `brain_harvest: true` therefore only takes effect for conversations an
agent is installed in; harvesting agent-less sources arrives with the
connector subscription pollers (Stage 3), which decouple ingestion from agent
routes.

Brain dreaming is registered as the trusted system job `system:brain-dreaming` with prompt `__system:brain_dream`. It follows the existing memory dreaming enable/cron settings, reads channel/import/agent/user pages since the durable brain cursor, calls the memory LLM lane for schema-validated operation proposals, and applies additive operations only. Dream-created fact/entity pages use `sourceKind: dream`. Destructive proposals are journaled in `brain_dream_decisions` and not applied.

Read paths are `gantry brain status`, `GET /v1/brain/status`, `brain_search`, and `brain_query`. Search uses lexical recall and, when memory embeddings are configured, vector recall with reciprocal-rank fusion. Query synthesis only cites retrieved brain pages; direct graph questions such as "who works at X?" are answered from `works_at` edges.

Embedding backfill is registered as the trusted system job `system:brain-embedding-backfill` with prompt `__system:brain_embedding_backfill`. It uses the same memory embedding provider configuration and scans pages whose current content hash has no ready embedding.

Verification for this slice:

- `npm run test:unit -- apps/core/test/unit/brain/`
- `npm run test:integration:postgres -- apps/core/test/integration/brain-core.postgres.integration.test.ts`
- `npm run test:integration:postgres -- apps/core/test/integration/brain-harvest-dreaming.postgres.integration.test.ts`
- `python3 .codex/scripts/check_architecture.py`
