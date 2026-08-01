CREATE TABLE "message_attachment_deletion_markers" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_message_attachment_deletion_markers_scope_pair_unique" ON "message_attachment_deletion_markers" USING btree ("app_id","provider","provider_account_id","channel_id","external_message_id");--> statement-breakpoint
CREATE INDEX "idx_message_attachment_deletion_markers_pending" ON "message_attachment_deletion_markers" USING btree ("created_at","id");