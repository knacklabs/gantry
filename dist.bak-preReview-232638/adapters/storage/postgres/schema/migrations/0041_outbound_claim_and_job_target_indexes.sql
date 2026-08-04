CREATE INDEX IF NOT EXISTS idx_outbound_delivery_items_claimed_expired
  ON outbound_delivery_items(claim_expires_at, updated_at, id)
  WHERE status = 'claimed' AND claim_expires_at IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_group_scope_updated
  ON jobs (
    (target_json::jsonb #>> '{executionContext,groupScope}'),
    updated_at DESC,
    created_at DESC
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_thread_normalized_updated
  ON jobs (
    (coalesce(target_json::jsonb #>> '{executionContext,threadId}', '')),
    updated_at DESC,
    created_at DESC
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_notification_routes
  ON jobs
  USING gin ((coalesce(target_json::jsonb -> 'notificationRoutes', '[]'::jsonb)));
