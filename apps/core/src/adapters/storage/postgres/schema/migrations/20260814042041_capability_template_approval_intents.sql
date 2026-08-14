CREATE TABLE "capability_template_approval_intent_targets" (
	"intent_id" text NOT NULL,
	"job_id" text NOT NULL,
	"expected_setup_fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "capability_template_approval_intent_targets_intent_id_job_id_pk" PRIMARY KEY("intent_id","job_id"),
	CONSTRAINT "capability_template_approval_intent_targets_status_check" CHECK ("capability_template_approval_intent_targets"."status" IN ('pending', 'resumed', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "capability_template_approval_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"last_error" text,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "capability_template_approval_intents_status_check" CHECK ("capability_template_approval_intents"."status" IN ('pending', 'completed', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "capability_template_approval_intent_targets" ADD CONSTRAINT "capability_template_approval_intent_targets_intent_id_capability_template_approval_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "capability_template_approval_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_template_approval_intents" ADD CONSTRAINT "capability_template_approval_intents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_template_approval_intents" ADD CONSTRAINT "capability_template_approval_intents_proposal_id_capability_template_amendment_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "capability_template_amendment_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_capability_template_approval_targets_pending" ON "capability_template_approval_intent_targets" USING btree ("intent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_template_approval_intents_proposal_unique" ON "capability_template_approval_intents" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "idx_capability_template_approval_intents_due" ON "capability_template_approval_intents" USING btree ("status","next_attempt_at");