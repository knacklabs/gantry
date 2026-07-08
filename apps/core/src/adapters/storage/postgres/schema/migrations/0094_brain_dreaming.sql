CREATE TABLE IF NOT EXISTS brain_dream_state (
  app_id text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  cursor_updated_at timestamptz,
  cursor_page_id text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS brain_dream_decisions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  page_id text REFERENCES brain_pages(id) ON DELETE SET NULL,
  op_json jsonb NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brain_dream_decisions_run
  ON brain_dream_decisions(run_id);

CREATE INDEX IF NOT EXISTS idx_brain_dream_decisions_app
  ON brain_dream_decisions(app_id, created_at);
