ALTER TABLE jobs
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
  ALTER COLUMN next_run TYPE TIMESTAMPTZ USING CASE WHEN next_run IS NULL THEN NULL ELSE next_run::timestamptz END,
  ALTER COLUMN last_run TYPE TIMESTAMPTZ USING CASE WHEN last_run IS NULL THEN NULL ELSE last_run::timestamptz END,
  ALTER COLUMN lease_expires_at TYPE TIMESTAMPTZ USING CASE WHEN lease_expires_at IS NULL THEN NULL ELSE lease_expires_at::timestamptz END;
--> statement-breakpoint
ALTER TABLE job_runs
  ALTER COLUMN scheduled_for TYPE TIMESTAMPTZ USING scheduled_for::timestamptz,
  ALTER COLUMN started_at TYPE TIMESTAMPTZ USING started_at::timestamptz,
  ALTER COLUMN ended_at TYPE TIMESTAMPTZ USING CASE WHEN ended_at IS NULL THEN NULL ELSE ended_at::timestamptz END,
  ALTER COLUMN notified_at TYPE TIMESTAMPTZ USING CASE WHEN notified_at IS NULL THEN NULL ELSE notified_at::timestamptz END;
--> statement-breakpoint
ALTER TABLE job_events
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_domain;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_created_by_domain;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_execution_mode_domain;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_schedule_type_domain;
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_schedule_value_domain;
--> statement-breakpoint
ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_status_domain;
--> statement-breakpoint
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_domain
    CHECK (status IN ('active', 'paused', 'running', 'completed', 'dead_lettered')),
  ADD CONSTRAINT jobs_created_by_domain
    CHECK (created_by IN ('agent', 'human')),
  ADD CONSTRAINT jobs_execution_mode_domain
    CHECK (execution_mode IN ('parallel', 'serialized')),
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
ALTER TABLE job_runs
  ADD CONSTRAINT job_runs_status_domain
    CHECK (status IN ('running', 'completed', 'failed', 'timeout', 'dead_lettered'));
