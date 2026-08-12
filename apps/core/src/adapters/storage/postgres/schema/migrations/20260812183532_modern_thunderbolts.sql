CREATE TABLE "job_semantic_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"job_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"worker_instance_id" text NOT NULL,
	"fencing_version" integer NOT NULL,
	"milestone" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_semantic_checkpoints" ADD CONSTRAINT "job_semantic_checkpoints_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_semantic_checkpoints" ADD CONSTRAINT "job_semantic_checkpoints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_semantic_checkpoints" ADD CONSTRAINT "job_semantic_checkpoints_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_semantic_checkpoints" ADD CONSTRAINT "job_semantic_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_semantic_checkpoints_run_sequence" ON "job_semantic_checkpoints" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_job_semantic_checkpoints_scope_sequence" ON "job_semantic_checkpoints" USING btree ("app_id","agent_id","job_id","run_id","sequence");
