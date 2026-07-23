CREATE TABLE "group_join_onboarding" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_account" text NOT NULL,
	"chat_jid" text NOT NULL,
	"status" text DEFAULT 'prompted' NOT NULL,
	"adder" text NOT NULL,
	"approver" text NOT NULL,
	"prompt_conversation_jid" text NOT NULL,
	"prompt_agent_folder" text NOT NULL,
	"prompted_at" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_join_onboarding_status_check" CHECK ("group_join_onboarding"."status" IN ('prompted', 'dismissed', 'registered'))
);
--> statement-breakpoint
ALTER TABLE "group_join_onboarding" ADD CONSTRAINT "group_join_onboarding_provider_account_provider_accounts_id_fk" FOREIGN KEY ("provider_account") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_join_onboarding_provider_chat_unique" ON "group_join_onboarding" USING btree ("provider_account","chat_jid");--> statement-breakpoint
CREATE INDEX "idx_group_join_onboarding_status" ON "group_join_onboarding" USING btree ("status");