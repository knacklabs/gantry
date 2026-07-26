ALTER TABLE "memory_evidence" ADD COLUMN IF NOT EXISTS "source_uri" text;--> statement-breakpoint
ALTER TABLE "memory_review_requests" ADD COLUMN IF NOT EXISTS "review_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "memory_review_requests" ADD COLUMN IF NOT EXISTS "decision_source" text;--> statement-breakpoint
UPDATE "memory_review_requests" SET "status" = 'failed', "apply_outcome" = 'superseded by review-artifact upgrade; will be re-proposed by dreaming', "updated_at" = now() WHERE "status" = 'pending_review';
