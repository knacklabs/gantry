CREATE TYPE "public"."email_message_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"template_key" varchar(120) NOT NULL,
	"sender_type" varchar(80) NOT NULL,
	"from_email" varchar(255) NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"status" "email_message_status" DEFAULT 'pending' NOT NULL,
	"provider" varchar(80) NOT NULL,
	"provider_message_id" text,
	"related_entity_type" varchar(120),
	"related_entity_id" uuid,
	"error_message" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_idempotency_key_unique" ON "email_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "email_messages_status_idx" ON "email_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_messages_template_key_idx" ON "email_messages" USING btree ("template_key");--> statement-breakpoint
CREATE INDEX "email_messages_related_entity_idx" ON "email_messages" USING btree ("related_entity_type","related_entity_id");--> statement-breakpoint
CREATE INDEX "email_messages_to_email_idx" ON "email_messages" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "email_messages_created_at_idx" ON "email_messages" USING btree ("created_at");
