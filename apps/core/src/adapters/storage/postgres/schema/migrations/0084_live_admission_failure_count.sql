ALTER TABLE "live_admission_work_items"
  ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0 NOT NULL;
