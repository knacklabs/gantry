-- Runtime Event Exchange clean cut.
--
-- Gantry is still pre-production, so this migration intentionally does not
-- backfill split historical streams. Any non-empty pre-cutover event table is
-- operator-owned state and must be exported or deleted explicitly before this
-- schema cut can run.

DO $$
DECLARE
  checked_table text;
  refusal_message text;
  has_rows boolean;
BEGIN
  FOR checked_table, refusal_message IN
    VALUES
      (
        'runtime_events',
        '0018 refuses to replace non-empty runtime_events; export or clear rows explicitly before applying Runtime Event Exchange cutover'
      ),
      (
        'control_http_events',
        '0018 refuses to drop non-empty control_http_events; export or clear rows explicitly before applying Runtime Event Exchange cutover'
      ),
      (
        'agent_run_events',
        '0018 refuses to drop non-empty agent_run_events; export or clear rows explicitly before applying Runtime Event Exchange cutover'
      ),
      (
        'control_http_webhook_deliveries',
        '0018 refuses to retarget non-empty control_http_webhook_deliveries; export or clear rows explicitly before applying Runtime Event Exchange cutover'
      )
  LOOP
    IF to_regclass(checked_table) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', checked_table)
        INTO has_rows;
      IF has_rows THEN
        RAISE EXCEPTION '%', refusal_message;
      END IF;
    END IF;
  END LOOP;
END $$;

ALTER TABLE IF EXISTS control_http_webhook_deliveries
  DROP CONSTRAINT IF EXISTS control_http_webhook_deliveries_event_id_fkey;

DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS control_http_events;
DROP TABLE IF EXISTS runtime_events;

CREATE TABLE runtime_events (
  event_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id text REFERENCES agent_runs(id) ON DELETE CASCADE,
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
  ON runtime_events(app_id, session_id, event_id);

CREATE INDEX idx_runtime_events_run_cursor
  ON runtime_events(app_id, run_id, event_id);

CREATE INDEX idx_runtime_events_job_cursor
  ON runtime_events(app_id, job_id, event_id);

CREATE INDEX idx_runtime_events_trigger_cursor
  ON runtime_events(app_id, trigger_id, event_id);

CREATE INDEX idx_runtime_events_conversation_thread_cursor
  ON runtime_events(app_id, conversation_id, thread_id, event_id);

CREATE INDEX idx_runtime_events_type_cursor
  ON runtime_events(app_id, event_type, event_id);

CREATE INDEX idx_runtime_events_webhook_projection
  ON runtime_events(app_id, webhook_id, response_mode, event_id);

ALTER TABLE IF EXISTS control_http_webhook_deliveries
  ADD CONSTRAINT control_http_webhook_deliveries_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES runtime_events(event_id) ON DELETE CASCADE;
