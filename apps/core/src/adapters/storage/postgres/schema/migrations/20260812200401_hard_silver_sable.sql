DROP INDEX "uq_job_semantic_checkpoints_run_sequence";--> statement-breakpoint
DROP INDEX "idx_job_semantic_checkpoints_scope_sequence";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_semantic_checkpoints_job_sequence" ON "job_semantic_checkpoints" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_job_semantic_checkpoints_scope_sequence" ON "job_semantic_checkpoints" USING btree ("app_id","agent_id","job_id","sequence");