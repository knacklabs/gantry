CREATE TABLE "message_attachment_deletion_markers" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_ids_json" jsonb NOT NULL,
	"conversation_jid" text NOT NULL,
	"thread_id" text,
	"external_message_ids_json" jsonb NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_message_attachment_deletion_markers_pending" ON "message_attachment_deletion_markers" USING btree ("created_at","id");