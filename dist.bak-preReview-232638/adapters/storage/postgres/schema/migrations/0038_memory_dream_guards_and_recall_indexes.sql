DROP INDEX IF EXISTS idx_memory_dream_runs_running_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    COALESCE(thread_id, ''),
    phase
  )
  WHERE status = 'running';

DROP INDEX IF EXISTS idx_memory_items_subject_updated;
CREATE INDEX IF NOT EXISTS idx_memory_items_subject_updated
  ON memory_items(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    status,
    thread_id,
    updated_at DESC
  );

DROP INDEX IF EXISTS idx_messages_conversation_recent;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_recent
  ON messages(conversation_id, created_at DESC, id DESC);
