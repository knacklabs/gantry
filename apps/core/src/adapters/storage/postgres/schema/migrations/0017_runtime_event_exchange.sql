DROP TABLE IF EXISTS runtime_events CASCADE;

CREATE TABLE runtime_events (
  event_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  job_id text,
  trigger_id text,
  conversation_id text REFERENCES channel_conversations(id) ON DELETE SET NULL,
  thread_id text REFERENCES conversation_threads(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  correlation_id text,
  response_mode text,
  webhook_id text,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_runtime_events_app_cursor
  ON runtime_events(app_id, event_id);

CREATE INDEX idx_runtime_events_session_cursor
  ON runtime_events(session_id, event_id);

CREATE INDEX idx_runtime_events_run_cursor
  ON runtime_events(run_id, event_id);

CREATE INDEX idx_runtime_events_job_cursor
  ON runtime_events(job_id, event_id);

CREATE INDEX idx_runtime_events_trigger_cursor
  ON runtime_events(trigger_id, event_id);

CREATE INDEX idx_runtime_events_conversation_thread_cursor
  ON runtime_events(conversation_id, thread_id, event_id);

CREATE INDEX idx_runtime_events_type_cursor
  ON runtime_events(event_type, event_id);

CREATE INDEX idx_runtime_events_webhook_projection
  ON runtime_events(webhook_id, response_mode, event_id);

DELETE FROM control_http_webhook_deliveries;

ALTER TABLE control_http_webhook_deliveries
  DROP CONSTRAINT IF EXISTS control_http_webhook_deliveries_event_id_fkey;

DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS control_http_events;

ALTER TABLE control_http_webhook_deliveries
  ADD CONSTRAINT control_http_webhook_deliveries_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES runtime_events(event_id) ON DELETE CASCADE;
