ALTER TABLE "messages" ADD COLUMN "source_generation" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_position" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_content_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_source_idempotency" ON "messages" USING btree ("conversation_id","source_generation","source_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_source_identity" ON "messages" USING btree ("conversation_id","source_generation","source_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_source_position" ON "messages" USING btree ("conversation_id","source_generation","source_position");