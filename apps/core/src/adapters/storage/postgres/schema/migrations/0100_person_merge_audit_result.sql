ALTER TABLE person_merge_audit
  ADD COLUMN IF NOT EXISTS result_json jsonb NOT NULL DEFAULT '{}'::jsonb;
