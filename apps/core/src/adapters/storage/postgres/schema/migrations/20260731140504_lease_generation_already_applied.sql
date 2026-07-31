-- Snapshot catch-up for 0116_runtime_lease_generations.
--
-- Idempotent, NOT empty, because three upgrade paths converge here:
--   * a database that already applied 0116 — these statements do nothing;
--   * a fresh database — 0116 runs first, so these do nothing;
--   * a database that applied this branch's 20260728185503 baseline BEFORE
--     0116 was merged. Drizzle applies migrations newer than the last applied
--     timestamp, and 0116 (2026-07-25) is chronologically EARLIER than that
--     baseline (2026-07-28), so such a database skips 0116 permanently. Without
--     the DDL below it would be marked current while missing the table and
--     column the snapshot claims exist.
--
-- Mirrors 0116 exactly; both are written IF NOT EXISTS for the same reason.
CREATE TABLE IF NOT EXISTS "runtime_lease_generations" (
	"lease_key" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL,
	"holder" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD COLUMN IF NOT EXISTS "snapshot_lease_generation" bigint DEFAULT 0 NOT NULL;
