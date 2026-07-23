CREATE TABLE "offboarding_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by_external_user_id" text NOT NULL,
	"reason" text,
	"last_working_day" date,
	"notes" text,
	"status" varchar(80) DEFAULT 'waiting_for_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offboarding_intake_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offboarding_intake_id" uuid NOT NULL,
	"approver_external_user_id" text NOT NULL,
	"decision" varchar(30) NOT NULL,
	"comment" text,
	"source" varchar(80) DEFAULT 'slack' NOT NULL,
	"gantry_conversation_id" text,
	"gantry_runtime_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offboarding_revoke_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offboarding_intake_id" uuid NOT NULL,
	"access_grant_id" uuid NOT NULL,
	"access_request_id" uuid,
	"access_task_id" uuid,
	"system_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"status" varchar(80) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "offboarding_intakes" ADD CONSTRAINT "offboarding_intakes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_intake_approvals" ADD CONSTRAINT "offboarding_intake_approvals_offboarding_intake_id_offboarding_intakes_id_fk" FOREIGN KEY ("offboarding_intake_id") REFERENCES "public"."offboarding_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_offboarding_intake_id_offboarding_intakes_id_fk" FOREIGN KEY ("offboarding_intake_id") REFERENCES "public"."offboarding_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_access_grant_id_access_grants_id_fk" FOREIGN KEY ("access_grant_id") REFERENCES "public"."access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_access_request_id_access_requests_id_fk" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_access_task_id_access_tasks_id_fk" FOREIGN KEY ("access_task_id") REFERENCES "public"."access_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_resource_id_access_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."access_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_revoke_items" ADD CONSTRAINT "offboarding_revoke_items_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offboarding_intakes_employee_id_idx" ON "offboarding_intakes" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "offboarding_intakes_status_idx" ON "offboarding_intakes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "offboarding_intakes_requested_by_external_user_id_idx" ON "offboarding_intakes" USING btree ("requested_by_external_user_id");--> statement-breakpoint
CREATE INDEX "offboarding_intakes_created_at_idx" ON "offboarding_intakes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "offboarding_intake_approvals_offboarding_intake_id_idx" ON "offboarding_intake_approvals" USING btree ("offboarding_intake_id");--> statement-breakpoint
CREATE INDEX "offboarding_intake_approvals_approver_external_user_id_idx" ON "offboarding_intake_approvals" USING btree ("approver_external_user_id");--> statement-breakpoint
CREATE INDEX "offboarding_intake_approvals_decision_idx" ON "offboarding_intake_approvals" USING btree ("decision");--> statement-breakpoint
CREATE INDEX "offboarding_revoke_items_offboarding_intake_id_idx" ON "offboarding_revoke_items" USING btree ("offboarding_intake_id");--> statement-breakpoint
CREATE INDEX "offboarding_revoke_items_access_grant_id_idx" ON "offboarding_revoke_items" USING btree ("access_grant_id");--> statement-breakpoint
CREATE INDEX "offboarding_revoke_items_access_request_id_idx" ON "offboarding_revoke_items" USING btree ("access_request_id");--> statement-breakpoint
CREATE INDEX "offboarding_revoke_items_access_task_id_idx" ON "offboarding_revoke_items" USING btree ("access_task_id");--> statement-breakpoint
CREATE INDEX "offboarding_revoke_items_status_idx" ON "offboarding_revoke_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "offboarding_revoke_items_intake_grant_unique" ON "offboarding_revoke_items" USING btree ("offboarding_intake_id","access_grant_id");