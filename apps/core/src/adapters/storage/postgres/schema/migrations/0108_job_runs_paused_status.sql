ALTER TABLE job_runs
  DROP CONSTRAINT IF EXISTS job_runs_status_domain;
--> statement-breakpoint
ALTER TABLE job_runs
  ADD CONSTRAINT job_runs_status_domain
    CHECK (status IN ('running', 'paused', 'completed', 'failed', 'timeout', 'dead_lettered'));
