CREATE TABLE IF NOT EXISTS memory_review_requests (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  thread_id text,
  phase text NOT NULL,
  proposal_json text NOT NULL,
  item_versions_json text NOT NULL DEFAULT '{}',
  candidate_versions_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending_review',
  validation_summary text NOT NULL,
  reviewer_id text,
  decision text,
  edited_value text,
  edited_reason text,
  apply_outcome text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_review_requests_pending_boundary
  ON memory_review_requests(app_id, agent_id, subject_type, subject_id, thread_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_review_requests_run
  ON memory_review_requests(run_id);
