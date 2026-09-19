CREATE TABLE "onboarding_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'setup_incomplete' NOT NULL,
	"current_step" integer DEFAULT 1 NOT NULL,
	"model_candidate_id" uuid,
	"provider_account_candidate_id" uuid,
	"provider_account_id" text,
	"conversation_id" text,
	"approver_person_id" text,
	"desired_state_revision" integer,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_model_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"auth_mode" text NOT NULL,
	"model_alias" text,
	"route_id" text,
	"payload_encrypted" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_provider_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"payload_encrypted" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_identity_json" jsonb,
	"failure_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_verification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"deployment_version" integer NOT NULL,
	"challenge_hash" text NOT NULL,
	"challenge_text" text NOT NULL,
	"state" text DEFAULT 'waiting_for_message' NOT NULL,
	"inbound_message_id" text,
	"run_id" text,
	"delivery_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_revision_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_credentials" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_deployments" ADD CONSTRAINT "onboarding_deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_deployments" ADD CONSTRAINT "onboarding_deployments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_model_candidates" ADD CONSTRAINT "onboarding_model_candidates_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_operations" ADD CONSTRAINT "onboarding_operations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_provider_candidates" ADD CONSTRAINT "onboarding_provider_candidates_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_provider_candidates" ADD CONSTRAINT "onboarding_provider_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verification_attempts" ADD CONSTRAINT "onboarding_verification_attempts_deployment_id_onboarding_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "onboarding_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verification_attempts" ADD CONSTRAINT "onboarding_verification_attempts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_revision_receipts" ADD CONSTRAINT "settings_revision_receipts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_deployments_app_user_uq" ON "onboarding_deployments" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "onboarding_deployments_state_idx" ON "onboarding_deployments" USING btree ("app_id","state");--> statement-breakpoint
CREATE INDEX "onboarding_model_candidates_active_idx" ON "onboarding_model_candidates" USING btree ("app_id","user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_operations_replay_uq" ON "onboarding_operations" USING btree ("app_id","user_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "onboarding_provider_candidates_active_idx" ON "onboarding_provider_candidates" USING btree ("app_id","user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_attempts_active_deployment_uq" ON "onboarding_verification_attempts" USING btree ("deployment_id") WHERE "onboarding_verification_attempts"."state" IN ('waiting_for_message', 'queued', 'running', 'awaiting_delivery');--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_attempts_challenge_hash_uq" ON "onboarding_verification_attempts" USING btree ("app_id","challenge_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_revision_receipts_app_revision_uq" ON "settings_revision_receipts" USING btree ("app_id","revision");
