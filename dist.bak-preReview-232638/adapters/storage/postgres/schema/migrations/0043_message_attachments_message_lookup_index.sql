CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
  ON message_attachments(message_id, id);
