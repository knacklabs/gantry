CREATE TABLE IF NOT EXISTS memory_extraction_cursor (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_id text NOT NULL,
  conversation_id text NOT NULL,
  thread_id text,
  covered_through_at timestamptz NOT NULL,
  covered_through_message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_cursor_lookup
  ON memory_extraction_cursor (conversation_id, thread_id, agent_id);
