CREATE TABLE "agent_creation_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_step" text DEFAULT 'identity' NOT NULL,
	"document_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_id" text,
	"job_id" text,
	"error_code" text,
	"error_message" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_creation_drafts" ADD CONSTRAINT "agent_creation_drafts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_creation_drafts" ADD CONSTRAINT "agent_creation_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_creation_drafts_app_status_updated" ON "agent_creation_drafts" USING btree ("app_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_creation_drafts_completed" ON "agent_creation_drafts" USING btree ("status","completed_at");