DELETE FROM "memory_review_requests"
WHERE "review_snapshot_json" IS NULL;--> statement-breakpoint
ALTER TABLE "memory_review_requests" ALTER COLUMN "review_snapshot_json" SET NOT NULL;
