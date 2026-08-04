CREATE TABLE IF NOT EXISTS memory_items (
  id text PRIMARY KEY,
  scope text NOT NULL,
  group_folder text NOT NULL,
  user_id text,
  topic_id text,
  kind text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  why text,
  load_bearing boolean NOT NULL DEFAULT false,
  source_turn_id text,
  source text NOT NULL,
  source_folder text NOT NULL DEFAULT 'items',
  file_path text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  indexed_at timestamptz,
  embedding_pending boolean NOT NULL DEFAULT false,
  blocked_reason text,
  confidence double precision NOT NULL DEFAULT 0.5,
  is_pinned boolean NOT NULL DEFAULT false,
  used_count integer NOT NULL DEFAULT 0,
  superseded_by text,
  version integer NOT NULL DEFAULT 1,
  last_used_at timestamptz,
  last_retrieved_at timestamptz,
  retrieval_count integer NOT NULL DEFAULT 0,
  total_score double precision NOT NULL DEFAULT 0,
  max_score double precision NOT NULL DEFAULT 0,
  query_hashes_json text NOT NULL DEFAULT '[]',
  recall_days_json text NOT NULL DEFAULT '[]',
  embedding_json text,
  embedding vector(3072),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  last_reviewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_items_scope_group
  ON memory_items(scope, group_folder, topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_file_path ON memory_items(file_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_unique_key
  ON memory_items(scope, group_folder, COALESCE(user_id, ''), COALESCE(topic_id, ''), key)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_memory_items_search
  ON memory_items USING gin (
    to_tsvector('english', key || ' ' || value || ' ' || COALESCE(why, ''))
  );
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash text NOT NULL,
  model text NOT NULL,
  embedding_json text NOT NULL,
  embedding vector(3072),
  created_at timestamptz NOT NULL,
  CONSTRAINT embedding_cache_pk PRIMARY KEY (text_hash, model)
);
