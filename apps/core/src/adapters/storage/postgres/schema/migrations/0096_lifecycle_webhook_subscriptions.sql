ALTER TABLE control_http_webhooks
  ADD COLUMN IF NOT EXISTS event_types text[],
  ADD COLUMN IF NOT EXISTS agent_id text,
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS job_id text;
--> statement-breakpoint
ALTER TABLE control_http_webhooks
  ADD CONSTRAINT control_http_webhooks_event_types_nonempty_check
  CHECK (event_types IS NULL OR cardinality(event_types) > 0);
--> statement-breakpoint
ALTER TABLE control_http_webhooks
  ADD CONSTRAINT control_http_webhooks_subject_requires_events_check
  CHECK (
    event_types IS NOT NULL OR
    (agent_id IS NULL AND session_id IS NULL AND job_id IS NULL)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_control_http_webhooks_subscription_app
  ON control_http_webhooks (app_id, enabled)
  WHERE event_types IS NOT NULL;
