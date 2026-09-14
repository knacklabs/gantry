CREATE TABLE "onboarding_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"desired_state_revision" integer NOT NULL,
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setup_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"thread_id" text,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inbound_message_id" text,
	"outbound_message_id" text,
	"onboarding_run_id" text,
	"projection_failure_code" text,
	"satisfied_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_setups" ADD CONSTRAINT "onboarding_setups_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_setups" ADD CONSTRAINT "onboarding_setups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_setup_id_onboarding_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "onboarding_setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_inbound_message_id_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_outbound_message_id_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_setups_app_unique" ON "onboarding_setups" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_setups_agent_unique" ON "onboarding_setups" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_setups_app_idempotency_unique" ON "onboarding_setups" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_verifications_active_challenge_unique" ON "onboarding_verifications" USING btree ("app_id","challenge") WHERE "onboarding_verifications"."status" IN ('pending', 'inbound_received', 'satisfied', 'projection_failed');--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_verifications_active_conversation_unique" ON "onboarding_verifications" USING btree ("app_id","conversation_id") WHERE "onboarding_verifications"."status" IN ('pending', 'inbound_received', 'satisfied', 'projection_failed');--> statement-breakpoint
CREATE INDEX "idx_onboarding_verifications_conversation_status" ON "onboarding_verifications" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "idx_onboarding_verifications_expiry" ON "onboarding_verifications" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_onboarding_verifications_correlation" ON "onboarding_verifications" USING btree ("provider_account_id","conversation_id","thread_id","status");
