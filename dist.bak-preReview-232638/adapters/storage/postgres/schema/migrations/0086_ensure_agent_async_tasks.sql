CREATE TABLE IF NOT EXISTS "agent_async_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "conversation_id" text,
  "thread_id" text,
  "parent_run_id" text,
  "parent_job_id" text,
  "parent_job_run_id" text,
  "kind" text DEFAULT 'async_command' NOT NULL,
  "status" text NOT NULL,
  "admission_class" text NOT NULL,
  "authority_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "private_correlation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "lease_token" text DEFAULT '' NOT NULL,
  "fencing_version" integer DEFAULT 1 NOT NULL,
  "heartbeat_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "terminal_at" timestamp with time zone,
  "summary" text,
  "output_summary" text,
  "error_summary" text,
  "receipt_json" jsonb
);

ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'async_command' NOT NULL;
ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "authority_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "private_correlation_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "lease_token" text DEFAULT '' NOT NULL;
ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "fencing_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "agent_async_tasks" ADD COLUMN IF NOT EXISTS "receipt_json" jsonb;

ALTER TABLE "agent_async_tasks" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "agent_async_tasks" ALTER COLUMN "authority_snapshot_json" DROP DEFAULT;
ALTER TABLE "agent_async_tasks" ALTER COLUMN "private_correlation_json" DROP DEFAULT;
ALTER TABLE "agent_async_tasks" ALTER COLUMN "lease_token" DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_async_tasks_app_id_apps_id_fk'
  ) THEN
    ALTER TABLE "agent_async_tasks"
      ADD CONSTRAINT "agent_async_tasks_app_id_apps_id_fk"
      FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_async_tasks_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "agent_async_tasks"
      ADD CONSTRAINT "agent_async_tasks_agent_id_agents_id_fk"
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_async_tasks_parent_run_id_agent_runs_id_fk'
  ) THEN
    ALTER TABLE "agent_async_tasks"
      ADD CONSTRAINT "agent_async_tasks_parent_run_id_agent_runs_id_fk"
      FOREIGN KEY ("parent_run_id") REFERENCES "agent_runs"("id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_async_tasks_parent_job_id_jobs_id_fk'
  ) THEN
    ALTER TABLE "agent_async_tasks"
      ADD CONSTRAINT "agent_async_tasks_parent_job_id_jobs_id_fk"
      FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_async_tasks_parent_job_run_id_job_runs_id_fk'
  ) THEN
    ALTER TABLE "agent_async_tasks"
      ADD CONSTRAINT "agent_async_tasks_parent_job_run_id_job_runs_id_fk"
      FOREIGN KEY ("parent_job_run_id") REFERENCES "job_runs"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agent_async_tasks_app_status_updated"
  ON "agent_async_tasks" ("app_id", "status", "updated_at");

CREATE INDEX IF NOT EXISTS "idx_agent_async_tasks_scope_updated"
  ON "agent_async_tasks" (
    "app_id",
    "agent_id",
    "conversation_id",
    "thread_id",
    "updated_at"
  );

CREATE INDEX IF NOT EXISTS "idx_agent_async_tasks_parent_run"
  ON "agent_async_tasks" ("parent_run_id", "updated_at");

CREATE INDEX IF NOT EXISTS "idx_agent_async_tasks_parent_job_run"
  ON "agent_async_tasks" ("parent_job_run_id", "updated_at");
