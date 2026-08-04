CREATE INDEX idx_messages_poll_cursor
ON messages(timestamp, chat_jid, id)
WHERE is_bot_message = false AND content IS NOT NULL AND content <> '';
