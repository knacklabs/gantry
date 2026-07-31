ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "file_name" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "provider_fetch_json" jsonb;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
