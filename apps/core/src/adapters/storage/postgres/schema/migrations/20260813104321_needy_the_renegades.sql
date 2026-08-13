ALTER TABLE "outbound_deliveries" ADD COLUMN "cancellation_reason_json" jsonb;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD COLUMN "permission_prompt_id" text;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD COLUMN "send_begun_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD COLUMN "cancellation_reason_json" jsonb;--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD COLUMN "setup_fingerprint" text;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD CONSTRAINT "outbound_delivery_items_permission_prompt_id_permission_prompts_id_fk" FOREIGN KEY ("permission_prompt_id") REFERENCES "permission_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_delivery_items_prompt_generation" ON "outbound_delivery_items" USING btree ("permission_prompt_id","generation") WHERE "outbound_delivery_items"."permission_prompt_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_delivery_items_active_prompt" ON "outbound_delivery_items" USING btree ("permission_prompt_id") WHERE "outbound_delivery_items"."permission_prompt_id" IS NOT NULL AND "outbound_delivery_items"."status" IN ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_job" ON "permission_prompts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permission_prompts_active_setup" ON "permission_prompts" USING btree ("job_id","setup_fingerprint") WHERE "permission_prompts"."job_id" IS NOT NULL AND "permission_prompts"."setup_fingerprint" IS NOT NULL AND "permission_prompts"."settlement_state" IN ('open', 'claimed');