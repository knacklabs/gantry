CREATE TABLE "agent_creation_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE cascade,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_step" text DEFAULT 'identity' NOT NULL,
	"document_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_id" text REFERENCES "agents"("id") ON DELETE set null,
	"job_id" text,
	"error_code" text,
	"error_message" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
CREATE INDEX "idx_agent_creation_drafts_app_status_updated" ON "agent_creation_drafts" USING btree ("app_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_creation_drafts_completed" ON "agent_creation_drafts" USING btree ("status","completed_at");
