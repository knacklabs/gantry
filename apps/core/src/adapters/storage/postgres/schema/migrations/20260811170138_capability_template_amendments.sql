CREATE TABLE "capability_template_amendment_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"canonical_key" text NOT NULL,
	"current_templates" jsonb NOT NULL,
	"proposed_templates" jsonb NOT NULL,
	"observed_argv" jsonb NOT NULL,
	"reviewed_schema_hash" text NOT NULL,
	"widening" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"job_id" text,
	"conversation_jid" text,
	"thread_id" text,
	"decided_by" text,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "capability_template_amendment_proposals_status_check" CHECK ("capability_template_amendment_proposals"."status" IN ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "capability_template_amendment_proposals" ADD CONSTRAINT "capability_template_amendment_proposals_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_template_amendment_proposals" ADD CONSTRAINT "capability_template_amendment_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_template_amendment_proposals_canonical_unique" ON "capability_template_amendment_proposals" USING btree ("app_id","canonical_key") WHERE "capability_template_amendment_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_capability_template_amendment_proposals_status" ON "capability_template_amendment_proposals" USING btree ("app_id","status","created_at");
