ALTER TABLE model_credentials
  ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'api_key';
