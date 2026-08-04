DROP INDEX IF EXISTS idx_control_http_sessions_external_ref;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_control_http_sessions_chat_jid;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jobs_target_session_updated;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jobs_target_group_scope_updated;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jobs_target_thread_normalized_updated;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jobs_target_notification_routes;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_memory_items_search;
--> statement-breakpoint

ALTER TABLE messages
  ALTER COLUMN external_ref_json TYPE jsonb USING external_ref_json::jsonb;
--> statement-breakpoint
ALTER TABLE message_parts
  ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
--> statement-breakpoint
ALTER TABLE message_attachments
  ALTER COLUMN external_ref_json TYPE jsonb USING external_ref_json::jsonb;
--> statement-breakpoint

ALTER TABLE provider_sessions
  ALTER COLUMN provider_ref_json DROP DEFAULT,
  ALTER COLUMN provider_ref_json TYPE jsonb USING provider_ref_json::jsonb,
  ALTER COLUMN provider_ref_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE agent_session_digests
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE control_http_sessions
  ALTER COLUMN external_ref_json DROP DEFAULT,
  ALTER COLUMN external_ref_json TYPE jsonb USING external_ref_json::jsonb,
  ALTER COLUMN external_ref_json SET DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE jobs
  ALTER COLUMN schedule_json TYPE jsonb USING schedule_json::jsonb,
  ALTER COLUMN target_json DROP DEFAULT,
  ALTER COLUMN target_json TYPE jsonb USING target_json::jsonb,
  ALTER COLUMN target_json SET DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE memory_items
  ALTER COLUMN value_json TYPE jsonb USING value_json::jsonb,
  ALTER COLUMN source_ref_json DROP DEFAULT,
  ALTER COLUMN source_ref_json TYPE jsonb USING source_ref_json::jsonb,
  ALTER COLUMN source_ref_json SET DEFAULT '{}'::jsonb;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_control_http_sessions_chat_jid
  ON control_http_sessions ((external_ref_json->>'chatJid'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_session_updated
  ON jobs ((target_json #>> '{executionContext,sessionId}'), updated_at DESC, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jobs_target_group_scope_updated
  ON jobs (
    (target_json #>> '{executionContext,groupScope}'),
    updated_at DESC,
    created_at DESC
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jobs_target_thread_normalized_updated
  ON jobs (
    (coalesce(target_json #>> '{executionContext,threadId}', '')),
    updated_at DESC,
    created_at DESC
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jobs_target_notification_routes
  ON jobs USING gin ((coalesce(target_json -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_memory_items_search
  ON memory_items USING gin (
    to_tsvector(
      'english',
      key || ' ' ||
      COALESCE(value_json->>'value', '') || ' ' ||
      COALESCE(value_json->>'why', '')
    )
  );
