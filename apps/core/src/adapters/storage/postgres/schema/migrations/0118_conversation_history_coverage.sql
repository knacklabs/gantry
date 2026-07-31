CREATE TABLE IF NOT EXISTS "conversation_history_coverage" (
	"provider_account_id" text NOT NULL REFERENCES "provider_accounts"("id") ON DELETE CASCADE,
	"conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"complete" boolean DEFAULT false NOT NULL,
	"covered_through_external_id" text,
	"covered_through_timestamp" timestamp with time zone,
	"provider_generation" bigint NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uniq_conversation_history_coverage_scope" UNIQUE NULLS NOT DISTINCT ("provider_account_id", "conversation_id", "scope_kind", "scope_id"),
	CONSTRAINT "conversation_history_coverage_scope_check" CHECK (("scope_kind" = 'channel' AND "scope_id" IS NULL) OR ("scope_kind" = 'thread' AND "scope_id" IS NOT NULL))
);
