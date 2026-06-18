CREATE TABLE "live_admission_work_items" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "agent_id" text,
  "agent_session_id" text,
  "conversation_id" text NOT NULL,
  "thread_id" text,
  "queue_jid" text NOT NULL,
  "message_id" text NOT NULL,
  "message_cursor" text NOT NULL,
  "sender_user_id" text,
  "sender_display_name" text,
  "idempotency_key" text NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "source_kind" text DEFAULT 'message' NOT NULL,
  "trigger_decision_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "claim_worker_instance_id" text,
  "claim_token" text,
  "claim_expires_at" timestamp with time zone,
  "fencing_version" integer DEFAULT 0 NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "defer_until" timestamp with time zone,
  "deferred_reason" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "ended_at" timestamp with time zone
);

CREATE UNIQUE INDEX "uq_live_admission_work_items_idempotency"
  ON "live_admission_work_items" ("idempotency_key");

CREATE INDEX "idx_live_admission_work_items_queued_fifo"
  ON "live_admission_work_items" ("app_id", "created_at", "id")
  WHERE "state" = 'queued';

CREATE INDEX "idx_live_admission_work_items_deferred_due"
  ON "live_admission_work_items" ("app_id", "defer_until", "created_at", "id")
  WHERE "state" = 'deferred'
    AND "defer_until" IS NOT NULL;

CREATE INDEX "idx_live_admission_work_items_deferred_null_fifo"
  ON "live_admission_work_items" ("app_id", "created_at", "id")
  WHERE "state" = 'deferred'
    AND "defer_until" IS NULL;

CREATE INDEX "idx_live_admission_work_items_claimed_expired"
  ON "live_admission_work_items" ("app_id", "claim_expires_at", "created_at", "id")
  WHERE "state" = 'claimed'
    AND "claim_expires_at" IS NOT NULL;
