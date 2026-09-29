DROP INDEX "idx_live_admission_work_items_unconsumed";--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_unconsumed" ON "live_admission_work_items" USING btree ("app_id","conversation_id","thread_id","agent_id","provider_account_id","receive_order") WHERE "live_admission_work_items"."consumed_at" IS NULL;
