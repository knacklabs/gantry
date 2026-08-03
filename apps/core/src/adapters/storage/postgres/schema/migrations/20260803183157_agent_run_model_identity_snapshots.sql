ALTER TABLE "agent_runs" ADD COLUMN "model_alias_snapshot" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_provider_snapshot" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "provider_model_id_snapshot" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_display_name_snapshot" text;