DROP INDEX IF EXISTS idx_user_aliases_provider_external;
DROP INDEX IF EXISTS idx_users_app_display_name;

ALTER TABLE person_merge_audit
  ADD COLUMN IF NOT EXISTS result_json jsonb NOT NULL DEFAULT '{}'::jsonb;
