CREATE TABLE "onboarding_intake_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onboarding_intake_id" uuid NOT NULL,
	"approver_external_user_id" text NOT NULL,
	"decision" varchar(30) NOT NULL,
	"comment" text,
	"source" varchar(80) DEFAULT 'slack' NOT NULL,
	"gantry_conversation_id" text,
	"gantry_runtime_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_intake_approvals" ADD CONSTRAINT "onboarding_intake_approvals_onboarding_intake_id_onboarding_intakes_id_fk" FOREIGN KEY ("onboarding_intake_id") REFERENCES "public"."onboarding_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_intake_approvals_onboarding_intake_id_idx" ON "onboarding_intake_approvals" USING btree ("onboarding_intake_id");--> statement-breakpoint
CREATE INDEX "onboarding_intake_approvals_approver_external_user_id_idx" ON "onboarding_intake_approvals" USING btree ("approver_external_user_id");--> statement-breakpoint
CREATE INDEX "onboarding_intake_approvals_decision_idx" ON "onboarding_intake_approvals" USING btree ("decision");