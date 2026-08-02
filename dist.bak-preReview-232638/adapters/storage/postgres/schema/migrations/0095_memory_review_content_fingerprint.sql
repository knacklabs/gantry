ALTER TABLE memory_review_requests
  ADD COLUMN IF NOT EXISTS flagged_content_hash text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_review_requests_content_hash
  ON memory_review_requests (app_id, agent_id, subject_type, subject_id, flagged_content_hash);
