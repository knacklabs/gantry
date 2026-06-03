CREATE TABLE IF NOT EXISTS pending_access_requests (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  requested_by text NOT NULL,
  target_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pending_access_requests_app_status ON pending_access_requests(app_id, status, expires_at);
