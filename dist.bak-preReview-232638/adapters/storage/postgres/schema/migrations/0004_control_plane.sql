CREATE TABLE app_sessions (
  session_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL UNIQUE,
  group_folder TEXT NOT NULL,
  title TEXT,
  default_response_mode TEXT NOT NULL DEFAULT 'sse',
  default_webhook_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_app_sessions_app_conversation
  ON app_sessions(app_id, conversation_id);
--> statement-breakpoint
CREATE TABLE control_events (
  event_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL,
  session_id TEXT,
  job_id TEXT,
  run_id TEXT,
  trigger_id TEXT,
  correlation_id TEXT,
  actor TEXT NOT NULL DEFAULT 'runtime',
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_control_events_created_at
  ON control_events(created_at, event_id);
--> statement-breakpoint
CREATE INDEX idx_control_events_session_created
  ON control_events(session_id, created_at, event_id);
--> statement-breakpoint
CREATE INDEX idx_control_events_session_event
  ON control_events(session_id, event_id);
--> statement-breakpoint
CREATE INDEX idx_control_events_trigger
  ON control_events(trigger_id);
--> statement-breakpoint
CREATE INDEX idx_control_events_run
  ON control_events(run_id);
--> statement-breakpoint
CREATE INDEX idx_control_events_job
  ON control_events(job_id);
--> statement-breakpoint
CREATE TABLE job_triggers (
  trigger_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'sdk',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_job_triggers_job_requested
  ON job_triggers(job_id, requested_at);
--> statement-breakpoint
CREATE INDEX idx_job_triggers_run
  ON job_triggers(run_id);
--> statement-breakpoint
CREATE TABLE webhook_registrations (
  webhook_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_webhook_registrations_app_name
  ON webhook_registrations(app_id, name);
--> statement-breakpoint
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhook_registrations(webhook_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES control_events(event_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_webhook_deliveries_webhook_event
  ON webhook_deliveries(webhook_id, event_id);
--> statement-breakpoint
CREATE INDEX idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);
