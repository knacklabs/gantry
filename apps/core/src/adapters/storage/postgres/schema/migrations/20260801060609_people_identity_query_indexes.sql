CREATE INDEX IF NOT EXISTS idx_users_app_updated_id
  ON users(app_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_aliases_app_user_updated
  ON user_aliases(app_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_aliases_retired_provider_external
  ON user_aliases(
    app_id,
    provider,
    COALESCE(provider_account_id, ''),
    external_user_id,
    updated_at DESC
  )
  WHERE retired_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_items_person_status_key
  ON memory_items(app_id, user_id, status, agent_id, kind, key)
  WHERE subject_type = 'user';
