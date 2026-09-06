-- Context is King: new physical columns deliberately follow this table's established snake_case convention instead of the constitution's camelCase default.
ALTER TABLE "permission_decision_memory" DROP CONSTRAINT "permission_decision_memory_lookup_uq";--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD COLUMN "acting_person_id" text;--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD COLUMN "acting_person_label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_decision_memory_lookup_uq" ON "permission_decision_memory" USING btree ("app_id","agent_folder","kind","lookup_identity") WHERE "permission_decision_memory"."kind" <> 'human_decision';--> statement-breakpoint
CREATE UNIQUE INDEX "permission_decision_memory_human_uq" ON "permission_decision_memory" USING btree ("app_id","agent_folder","acting_person_id","scope","scope_key") WHERE "permission_decision_memory"."kind" = 'human_decision' AND "permission_decision_memory"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "permission_decision_memory" ADD CONSTRAINT "permission_decision_memory_human_row_ck" CHECK ("permission_decision_memory"."kind" <> 'human_decision' OR ("permission_decision_memory"."outcome" IS NOT NULL AND "permission_decision_memory"."scope" IS NOT NULL AND "permission_decision_memory"."scope_key" IS NOT NULL AND "permission_decision_memory"."acting_person_id" IS NOT NULL));
