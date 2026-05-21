CREATE TABLE IF NOT EXISTS "external_platform_events" (
  "event_id" text PRIMARY KEY,
  "integration_id" text NOT NULL,
  "event_type" text NOT NULL,
  "target_jid" text,
  "status" text NOT NULL,
  "payload_json" text NOT NULL,
  "response_json" text,
  "error" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "received_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_external_platform_events_status"
  ON "external_platform_events" ("status", "updated_at");

CREATE INDEX IF NOT EXISTS "idx_external_platform_events_target"
  ON "external_platform_events" ("target_jid", "updated_at");

CREATE INDEX IF NOT EXISTS "idx_external_platform_events_next_attempt"
  ON "external_platform_events" ("status", "next_attempt_at");

CREATE TABLE IF NOT EXISTS "external_platform_card_actions" (
  "nonce" text PRIMARY KEY,
  "integration_id" text NOT NULL,
  "event_id" text NOT NULL REFERENCES "external_platform_events" ("event_id") ON DELETE CASCADE,
  "action_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "source_channel_id" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_external_platform_card_actions_event"
  ON "external_platform_card_actions" ("event_id", "created_at");
