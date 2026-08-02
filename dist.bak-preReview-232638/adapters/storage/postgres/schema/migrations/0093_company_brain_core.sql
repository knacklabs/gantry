CREATE TABLE IF NOT EXISTS brain_pages (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  source_kind text NOT NULL,
  source_ref text,
  author_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_pages_app_slug_unique
  ON brain_pages(app_id, slug);

CREATE INDEX IF NOT EXISTS idx_brain_pages_app_updated
  ON brain_pages(app_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_pages_search
  ON brain_pages
  USING gin (to_tsvector('english', title || ' ' || markdown));

CREATE TABLE IF NOT EXISTS brain_entities (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_entities_app_kind_name_unique
  ON brain_entities(app_id, kind, normalized_name);

CREATE INDEX IF NOT EXISTS idx_brain_entities_lookup
  ON brain_entities(app_id, kind, normalized_name);

CREATE TABLE IF NOT EXISTS brain_edges (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  type text NOT NULL,
  from_entity_id text NOT NULL REFERENCES brain_entities(id) ON DELETE CASCADE,
  to_entity_id text NOT NULL REFERENCES brain_entities(id) ON DELETE CASCADE,
  evidence_page_id text NOT NULL REFERENCES brain_pages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brain_edges_page
  ON brain_edges(app_id, evidence_page_id);

CREATE INDEX IF NOT EXISTS idx_brain_edges_from
  ON brain_edges(app_id, from_entity_id);

CREATE INDEX IF NOT EXISTS idx_brain_edges_to
  ON brain_edges(app_id, to_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_edges_unique
  ON brain_edges(app_id, type, from_entity_id, to_entity_id, evidence_page_id);

CREATE TABLE IF NOT EXISTS brain_page_embeddings (
  page_id text NOT NULL REFERENCES brain_pages(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  content_hash text NOT NULL,
  embedding_json text,
  embedding vector(1536),
  dimensions integer NOT NULL DEFAULT 1536,
  status text NOT NULL DEFAULT 'ready',
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT brain_page_embeddings_pk PRIMARY KEY (page_id, provider, model, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_brain_page_embeddings_status
  ON brain_page_embeddings(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_page_embeddings_ready_lookup
  ON brain_page_embeddings(provider, model, dimensions, status, page_id)
  WHERE status = 'ready' AND embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_page_embeddings_hnsw
  ON brain_page_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'ready' AND embedding IS NOT NULL;
