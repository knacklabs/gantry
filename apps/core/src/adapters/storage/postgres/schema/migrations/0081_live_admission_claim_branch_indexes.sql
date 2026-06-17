DROP INDEX IF EXISTS "idx_live_admission_work_items_due";
DROP INDEX IF EXISTS "idx_live_admission_work_items_claim_expiry";

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
