CREATE TABLE "agent_setup_drafts" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"purpose" text,
	"model_alias" text,
	"connection_json" jsonb,
	"conversation_json" jsonb,
	"current_stage" text DEFAULT 'agent' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_setup_drafts_stage_check" CHECK ("agent_setup_drafts"."current_stage" IN ('agent', 'model', 'connection', 'conversation', 'profile', 'review'))
);
--> statement-breakpoint
ALTER TABLE "agent_setup_drafts" ADD CONSTRAINT "agent_setup_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_setup_drafts" ADD CONSTRAINT "agent_setup_drafts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agent_setup_drafts_app_updated" ON "agent_setup_drafts" USING btree ("app_id","updated_at");
