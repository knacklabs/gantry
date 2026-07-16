CREATE TABLE IF NOT EXISTS "teams_conversation_references" (
  "conversation_jid" text PRIMARY KEY,
  "conversation_id" text NOT NULL,
  "service_url" text NOT NULL,
  "tenant_id" text,
  "bot_id" text,
  "raw_reference_json" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_teams_conversation_references_conversation_id"
  ON "teams_conversation_references" ("conversation_id");
