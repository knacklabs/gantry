CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

ALTER TABLE outbound_deliveries
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

UPDATE outbound_deliveries
SET idempotency_fingerprint = 'sha256:' || encode(
  digest(
    app_id || ':' || idempotency_key || ':' || conversation_id || ':' ||
    coalesce(thread_id, '') || ':' || profile_id,
    'sha256'
  ),
  'hex'
)
WHERE idempotency_fingerprint IS NULL;

ALTER TABLE outbound_deliveries
  ALTER COLUMN idempotency_fingerprint SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_app_profile_status_updated
  ON outbound_deliveries(app_id, profile_id, status, updated_at);
