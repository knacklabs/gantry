CREATE TABLE "onboarding_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inbound_message_id" text,
	"outbound_message_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_inbound_message_id_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_verifications" ADD CONSTRAINT "onboarding_verifications_outbound_message_id_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_verifications_active_challenge_unique" ON "onboarding_verifications" USING btree ("app_id","challenge");--> statement-breakpoint
CREATE INDEX "idx_onboarding_verifications_conversation_status" ON "onboarding_verifications" USING btree ("conversation_id","status");
