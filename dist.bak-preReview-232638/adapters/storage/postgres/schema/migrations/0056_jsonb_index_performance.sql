DROP INDEX IF EXISTS idx_control_http_sessions_external_ref;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jobs_target_notification_routes;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jobs_target_notification_routes
  ON jobs USING gin ((coalesce(target_json -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops);
--> statement-breakpoint
