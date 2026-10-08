CREATE TABLE "inbound_events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"event_key" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "inbound_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"raw_channel_id" text NOT NULL,
	"raw_thread_id" text,
	"raw_message_id" text,
	"payload" jsonb,
	"control_json" jsonb,
	"unpacked_json" jsonb,
	"route_receipts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"failed_operation" text,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "inbound_events_state_check" CHECK ("inbound_events"."state" IN ('pending', 'claimed', 'completed', 'set_aside')),
	CONSTRAINT "inbound_events_attempts_check" CHECK ("inbound_events"."attempts" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_events_identity" ON "inbound_events" USING btree ("app_id","provider_id","connection_id","kind","event_key");--> statement-breakpoint
CREATE INDEX "idx_inbound_events_heads" ON "inbound_events" USING btree ("app_id","provider_id","connection_id","raw_channel_id","raw_thread_id","seq") WHERE "inbound_events"."state" IN ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "idx_inbound_events_controls" ON "inbound_events" USING btree ("app_id","seq") WHERE "inbound_events"."control_json" IS NOT NULL AND "inbound_events"."state" IN ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "idx_inbound_events_held_delete" ON "inbound_events" USING btree ("app_id","provider_id","connection_id","raw_channel_id","raw_message_id") WHERE "inbound_events"."state" IN ('pending', 'claimed', 'set_aside');--> statement-breakpoint
CREATE INDEX "idx_inbound_events_retention" ON "inbound_events" USING btree ("settled_at","id") WHERE "inbound_events"."state" = 'completed';