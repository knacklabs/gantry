CREATE INDEX "idx_live_turns_recoverable_leased"
  ON "live_turns" ("updated_at", "id", "run_id")
  WHERE "state" NOT IN ('completed', 'failed', 'timed_out')
    AND "run_id" IS NOT NULL
    AND "lease_token" IS NOT NULL
    AND "fencing_version" IS NOT NULL;

CREATE INDEX "idx_live_turns_recoverable_unleased"
  ON "live_turns" ("updated_at", "id")
  WHERE "state" NOT IN ('completed', 'failed', 'timed_out')
    AND "lease_token" IS NULL;
