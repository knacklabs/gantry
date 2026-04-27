ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_error text;

CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
  ON messages(delivery_status, delivered_at);
