ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "conversation_jid" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "timezone" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "rendered_digest" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "outbound_delivery_id" text;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'reserved' NOT NULL;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD CONSTRAINT "observer_deliveries_state_check" CHECK ("observer_deliveries"."state" IN ('reserved', 'sent', 'settled', 'failed'));--> statement-breakpoint
CREATE TABLE "observer_delivery_insights" (
	"delivery_id" text NOT NULL,
	"insight_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "observer_delivery_insights_pk" PRIMARY KEY("delivery_id","insight_id")
);
--> statement-breakpoint
ALTER TABLE "observer_delivery_insights" ADD CONSTRAINT "observer_delivery_insights_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "observer_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observer_delivery_insights" ADD CONSTRAINT "observer_delivery_insights_insight_id_fk" FOREIGN KEY ("insight_id") REFERENCES "proactive_insights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_observer_delivery_insights_insight" ON "observer_delivery_insights" USING btree ("insight_id");
