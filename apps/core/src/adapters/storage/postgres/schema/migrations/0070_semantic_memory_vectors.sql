-- Semantic memory vectors: pgvector storage for per-item embeddings, a partial
-- HNSW cosine index for live vector recall, and resumable backfill run state.
-- The `vector` and `pg_trgm` extensions are provisioned by ops/postgres init and
-- are already relied on by 0005_memory.sql, so no CREATE EXTENSION is needed here.

ALTER TABLE memory_item_embeddings
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS dimensions integer NOT NULL DEFAULT 1536,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS resume_after timestamptz,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS provider_batch_id text;

-- Live vector recall only ever reads ready rows that actually carry a vector.
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_hnsw
  ON memory_item_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'ready' AND embedding IS NOT NULL;

-- Scheduled provider-batch polling imports results by provider batch id.
DROP INDEX IF EXISTS idx_memory_item_embeddings_provider_batch;
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_provider_batch
  ON memory_item_embeddings(provider, model, status, provider_batch_id, updated_at, item_id)
  WHERE provider_batch_id IS NOT NULL;

-- Hybrid recall filters ready vectors by provider/model/dimensions before
-- applying tenant/subject visibility through memory_items.
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_ready_lookup
  ON memory_item_embeddings(provider, model, dimensions, status, item_id)
  WHERE status = 'ready' AND embedding IS NOT NULL;

-- Backfill candidate scanning revisits retryable/stuck rows by resume time.
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_resume
  ON memory_item_embeddings(status, resume_after);

CREATE TABLE IF NOT EXISTS memory_embedding_backfill_runs (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL,
  trigger text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  total_candidates integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  ready_count integer NOT NULL DEFAULT 0,
  skipped_ready_count integer NOT NULL DEFAULT 0,
  retryable_count integer NOT NULL DEFAULT 0,
  blocked_count integer NOT NULL DEFAULT 0,
  pause_reason text,
  last_error_code text,
  last_error_message text,
  resume_after timestamptz,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_backfill_runs_scope
  ON memory_embedding_backfill_runs(app_id, agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_backfill_runs_status
  ON memory_embedding_backfill_runs(status, updated_at DESC);

-- At most one running inline backfill per app/agent scope. Provider-batch runs
-- are excluded: they await async import (so would otherwise hold the lock for up
-- to the completion window) and are already protected from duplicate work by the
-- per-item `submitted` status the candidate scan skips.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embedding_backfill_runs_running
  ON memory_embedding_backfill_runs(app_id, (coalesce(agent_id, '')))
  WHERE status = 'running' AND mode = 'inline';

-- Normalize the stale embedding_cache vector(3072) column to the v1 dimension.
-- The table is unused today and is repurposed as the query-embedding cache.
ALTER TABLE embedding_cache
  DROP COLUMN IF EXISTS embedding;

ALTER TABLE embedding_cache
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

ALTER TABLE embedding_cache
  ADD COLUMN IF NOT EXISTS dimensions integer NOT NULL DEFAULT 1536;
