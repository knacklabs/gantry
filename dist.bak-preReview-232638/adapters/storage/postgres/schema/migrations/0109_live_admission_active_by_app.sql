CREATE INDEX "idx_live_admission_work_items_active_by_app"
  ON "live_admission_work_items" ("app_id")
  WHERE "state" IN ('queued', 'claimed', 'deferred');
