UPDATE "agent_async_tasks" AS task
SET "parent_run_id" = coalesce(task."parent_run_id", result."agent_run_id"),
    "parent_job_id" = coalesce(task."parent_job_id", result."job_id")
FROM "job_runs" AS result
WHERE task."parent_job_run_id" = result."id";
--> statement-breakpoint
ALTER TABLE "agent_async_tasks" DROP CONSTRAINT "agent_async_tasks_parent_job_run_id_job_runs_id_fk";
--> statement-breakpoint
DROP INDEX "idx_agent_async_tasks_parent_job_run";--> statement-breakpoint
ALTER TABLE "agent_async_tasks" DROP COLUMN "parent_job_run_id";--> statement-breakpoint
DROP TABLE "job_runs";
