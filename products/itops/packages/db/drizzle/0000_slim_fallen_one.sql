CREATE TYPE "public"."employee_status" AS ENUM('preboarding', 'active', 'offboarding', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('fte', 'contractor');--> statement-breakpoint
CREATE TYPE "public"."system_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."role_risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."access_request_action" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."access_request_status" AS ENUM('draft', 'waiting_for_approval', 'approved', 'rejected', 'provisioning', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."access_task_operation" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."access_task_status" AS ENUM('pending', 'running', 'completed', 'failed', 'retrying', 'skipped', 'cancelled', 'pending_manual');--> statement-breakpoint
CREATE TYPE "public"."access_grant_status" AS ENUM('pending', 'active', 'revocation_pending', 'revoked', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"work_email" varchar(255),
	"personal_email" varchar(255),
	"contact_no" varchar(50),
	"employment_type" "employment_type" NOT NULL,
	"designation" varchar(180) NOT NULL,
	"department" varchar(120),
	"status" "employee_status" DEFAULT 'preboarding' NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_work_email_unique" UNIQUE("work_email")
);
--> statement-breakpoint
CREATE TABLE "systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(80) NOT NULL,
	"name" varchar(180) NOT NULL,
	"status" "system_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "systems_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "access_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" varchar(180) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" varchar(180) NOT NULL,
	"risk_level" "role_risk_level" DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"action" "access_request_action" NOT NULL,
	"status" "access_request_status" DEFAULT 'draft' NOT NULL,
	"reason" text,
	"requested_by_external_user_id" text NOT NULL,
	"requested_from" varchar(80),
	"source_conversation_id" text,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_request_id" uuid NOT NULL,
	"approver_external_user_id" text NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"comment" text,
	"source" varchar(80) DEFAULT 'slack' NOT NULL,
	"gantry_conversation_id" text,
	"gantry_runtime_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_request_id" uuid NOT NULL,
	"operation" "access_task_operation" NOT NULL,
	"connector" varchar(120) NOT NULL,
	"status" "access_task_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"external_result_json" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tasks_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"status" "access_grant_status" DEFAULT 'pending' NOT NULL,
	"external_account_id" text,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_external_user_id" text NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"entity_type" varchar(120) NOT NULL,
	"entity_id" uuid,
	"before_json" jsonb,
	"after_json" jsonb,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_resources" ADD CONSTRAINT "access_resources_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_resource_id_access_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."access_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_access_request_id_access_requests_id_fk" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tasks" ADD CONSTRAINT "access_tasks_access_request_id_access_requests_id_fk" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_resource_id_access_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."access_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_resources_system_id_key_unique" ON "access_resources" USING btree ("system_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_system_id_key_unique" ON "roles" USING btree ("system_id","key");--> statement-breakpoint
CREATE INDEX "access_requests_employee_id_idx" ON "access_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "access_requests_status_idx" ON "access_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "access_requests_system_id_idx" ON "access_requests" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "access_requests_resource_id_idx" ON "access_requests" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "access_requests_role_id_idx" ON "access_requests" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "approvals_access_request_id_idx" ON "approvals" USING btree ("access_request_id");--> statement-breakpoint
CREATE INDEX "approvals_approver_external_user_id_idx" ON "approvals" USING btree ("approver_external_user_id");--> statement-breakpoint
CREATE INDEX "access_tasks_access_request_id_idx" ON "access_tasks" USING btree ("access_request_id");--> statement-breakpoint
CREATE INDEX "access_tasks_status_idx" ON "access_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "access_tasks_connector_idx" ON "access_tasks" USING btree ("connector");--> statement-breakpoint
CREATE INDEX "access_tasks_operation_idx" ON "access_tasks" USING btree ("operation");--> statement-breakpoint
CREATE INDEX "access_grants_employee_id_idx" ON "access_grants" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "access_grants_system_id_idx" ON "access_grants" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "access_grants_resource_id_idx" ON "access_grants" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "access_grants_role_id_idx" ON "access_grants" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "access_grants_status_idx" ON "access_grants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_employee_system_resource_role_unique" ON "access_grants" USING btree ("employee_id","system_id","resource_id","role_id");--> statement-breakpoint
CREATE INDEX "audit_events_event_type_idx" ON "audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_external_user_id_idx" ON "audit_events" USING btree ("actor_external_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");