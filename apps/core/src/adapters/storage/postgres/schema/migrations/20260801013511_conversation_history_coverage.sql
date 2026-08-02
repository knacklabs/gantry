CREATE TABLE "conversation_history_coverage" (
	"provider_account_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"complete" boolean DEFAULT false NOT NULL,
	"covered_through_external_id" text,
	"covered_through_timestamp" timestamp with time zone,
	"provider_generation" bigint NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uniq_conversation_history_coverage_scope" UNIQUE NULLS NOT DISTINCT("provider_account_id","conversation_id","scope_kind","scope_id"),
	CONSTRAINT "conversation_history_coverage_scope_check" CHECK (("conversation_history_coverage"."scope_kind" = 'channel' AND "conversation_history_coverage"."scope_id" IS NULL) OR ("conversation_history_coverage"."scope_kind" = 'thread' AND "conversation_history_coverage"."scope_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "conversation_history_coverage" ADD CONSTRAINT "conversation_history_coverage_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_history_coverage" ADD CONSTRAINT "conversation_history_coverage_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;