ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS app_id text NOT NULL DEFAULT 'personal';
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main';
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS subject_type text NOT NULL DEFAULT 'group';
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS subject_id text NOT NULL DEFAULT 'default';
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS user_id_canonical text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS group_id_canonical text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS channel_id_canonical text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS thread_id_canonical text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS evidence_ids_json text NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_memory_items_app_subject
  ON memory_items(app_id, agent_id, subject_type, subject_id, thread_id_canonical, updated_at DESC);
DROP INDEX IF EXISTS idx_memory_items_active_unique_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_unique_key
  ON memory_items(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    scope,
    group_folder,
    COALESCE(user_id, ''),
    COALESCE(topic_id, ''),
    key
  )
  WHERE is_deleted = false;

CREATE TABLE IF NOT EXISTS memory_subjects (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  external_id text,
  label text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_subjects_unique
  ON memory_subjects(app_id, agent_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_memory_subjects_app
  ON memory_subjects(app_id, agent_id);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  user_id text,
  group_id text,
  channel_id text,
  thread_id text,
  source_type text NOT NULL,
  source_id text,
  actor_id text,
  text text NOT NULL,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_boundary
  ON memory_evidence(app_id, agent_id, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_search
  ON memory_evidence USING gin (to_tsvector('english', text));

CREATE TABLE IF NOT EXISTS memory_candidates (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  thread_id text,
  kind text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  reason text,
  evidence_ids_json text NOT NULL DEFAULT '[]',
  confidence double precision NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'staged',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_boundary
  ON memory_candidates(app_id, agent_id, subject_type, subject_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_recall_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  item_id text NOT NULL,
  query_hash text NOT NULL,
  score double precision NOT NULL,
  subject_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_events_item
  ON memory_recall_events(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_recall_events_app
  ON memory_recall_events(app_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_dream_runs (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  phase text NOT NULL,
  status text NOT NULL,
  summary_json text NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_dream_runs_boundary
  ON memory_dream_runs(app_id, agent_id, subject_type, subject_id, started_at DESC);

CREATE TABLE IF NOT EXISTS memory_dream_decisions (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  item_id text,
  candidate_id text,
  action text NOT NULL,
  rationale text NOT NULL,
  evidence_ids_json text NOT NULL DEFAULT '[]',
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_dream_decisions_run
  ON memory_dream_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_dream_decisions_app
  ON memory_dream_decisions(app_id, agent_id, created_at DESC);
