CREATE TABLE "chat_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"gantry_batch_correlation_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'submission_intent' NOT NULL,
	"provider_batch_id" text,
	"request_snapshot" jsonb NOT NULL,
	"result_snapshot" jsonb,
	"request_count" integer NOT NULL,
	"snapshot_bytes" integer NOT NULL,
	"reserved_cost_usd" double precision NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision,
	"submit_attempts" integer DEFAULT 0 NOT NULL,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"result_attempts" integer DEFAULT 0 NOT NULL,
	"attention_required" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_batches_state_check" CHECK ("chat_batches"."state" IN ('submission_intent', 'preflight_failed', 'submission_unknown', 'submitted', 'processing', 'applied', 'failed', 'abandoned')),
	CONSTRAINT "chat_batches_content_hash_check" CHECK ("chat_batches"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_batches_count_check" CHECK ("chat_batches"."request_count" > 0 AND "chat_batches"."snapshot_bytes" > 0),
	CONSTRAINT "chat_batches_accounting_check" CHECK ("chat_batches"."reserved_cost_usd" >= 0 AND "chat_batches"."input_tokens" >= 0 AND "chat_batches"."output_tokens" >= 0 AND "chat_batches"."cache_read_tokens" >= 0 AND "chat_batches"."cache_write_tokens" >= 0 AND ("chat_batches"."estimated_cost_usd" IS NULL OR "chat_batches"."estimated_cost_usd" >= 0))
);
--> statement-breakpoint
ALTER TABLE "chat_batches" ADD CONSTRAINT "chat_batches_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_batches_correlation_unique" ON "chat_batches" USING btree ("app_id","provider_id","gantry_batch_correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_batches_provider_batch_unique" ON "chat_batches" USING btree ("app_id","provider_id","provider_batch_id") WHERE "chat_batches"."provider_batch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_chat_batches_recovery" ON "chat_batches" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_batches_app_created" ON "chat_batches" USING btree ("app_id","created_at");
