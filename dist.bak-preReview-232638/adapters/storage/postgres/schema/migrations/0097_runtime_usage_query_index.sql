CREATE INDEX IF NOT EXISTS idx_runtime_events_usage_query
  ON runtime_events (app_id, event_type, created_at);
