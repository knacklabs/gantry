DROP INDEX "idx_agent_tool_bindings_unique";--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_app_person_fk" FOREIGN KEY ("app_id","person_id") REFERENCES "public"."users"("app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "idx_agent_tool_bindings_unique" UNIQUE NULLS NOT DISTINCT("agent_id","tool_id","config_version_id","person_id");