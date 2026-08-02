ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS metadata_json text NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  item_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  content_hash text NOT NULL,
  embedding_json text,
  status text NOT NULL DEFAULT 'ready',
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT memory_item_embeddings_pk PRIMARY KEY (item_id, provider, model, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_item
  ON memory_item_embeddings(item_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_status
  ON memory_item_embeddings(status, updated_at DESC);
