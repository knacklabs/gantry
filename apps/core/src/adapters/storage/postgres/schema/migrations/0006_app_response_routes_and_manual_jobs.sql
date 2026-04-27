ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_schedule_type_domain;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_schedule_value_domain;
--> statement-breakpoint
ALTER TABLE jobs
  ADD CONSTRAINT jobs_schedule_type_domain
    CHECK (schedule_type IN ('manual', 'cron', 'interval', 'once')),
  ADD CONSTRAINT jobs_schedule_value_domain
    CHECK (
      CASE
        WHEN schedule_type = 'manual' THEN schedule_value = 'manual'
        WHEN schedule_type = 'cron' THEN length(trim(schedule_value)) > 0
        WHEN schedule_type = 'interval' THEN CASE
          WHEN schedule_value ~ '^[0-9]+$' THEN schedule_value::bigint > 0
          ELSE FALSE
        END
        WHEN schedule_type = 'once' THEN schedule_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        ELSE FALSE
      END
    );
--> statement-breakpoint
CREATE TABLE app_response_routes (
  session_id TEXT NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL DEFAULT '',
  response_mode TEXT NOT NULL,
  webhook_id TEXT,
  correlation_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, thread_id)
);
