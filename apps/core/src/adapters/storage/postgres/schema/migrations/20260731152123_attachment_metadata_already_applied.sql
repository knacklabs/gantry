-- Snapshot catch-up for 0117_message_attachment_metadata.
--
-- SCHEMA ONLY, and deliberately so. 0117 also performs a data backfill and an
-- attachment-id rewrite; those belong to 0117 alone and are not duplicated here.
-- This file exists so the drizzle snapshot records the three columns, which it
-- otherwise would not, causing every later `generate` to re-emit them.
--
-- IF NOT EXISTS for the same reason as the sibling catch-up: a database that
-- already applied 0117 must see these as no-ops.
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "file_name" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "provider_fetch_json" jsonb;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
