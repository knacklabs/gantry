CREATE TABLE "capability_template_amendment_history" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"prior_templates" jsonb NOT NULL,
	"amended_templates" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"audit_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capability_template_amendment_history" ADD CONSTRAINT "capability_template_amendment_history_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_template_amendment_history" ADD CONSTRAINT "capability_template_amendment_history_proposal_id_capability_template_amendment_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "capability_template_amendment_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_template_amendment_history" ADD CONSTRAINT "capability_template_amendment_history_audit_event_id_permission_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "permission_audit_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_template_amendment_history_proposal_unique" ON "capability_template_amendment_history" USING btree ("proposal_id");
--> statement-breakpoint
ALTER TABLE "capability_template_amendment_proposals" ADD COLUMN "provider_account_id" text;
