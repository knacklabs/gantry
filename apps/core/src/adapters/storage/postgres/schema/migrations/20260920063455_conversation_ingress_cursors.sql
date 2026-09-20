CREATE TABLE "conversation_ingress_cursors" (
	"provider_account_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"covered_through_external_id" text,
	"covered_through_timestamp" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_ingress_cursors_pkey" PRIMARY KEY("provider_account_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_ingress_cursors" ADD CONSTRAINT "conversation_ingress_cursors_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ingress_cursors" ADD CONSTRAINT "conversation_ingress_cursors_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;
