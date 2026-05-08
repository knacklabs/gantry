ALTER TABLE memory_dream_runs
  ADD COLUMN IF NOT EXISTS thread_id text;

ALTER TABLE memory_dream_decisions
  ADD COLUMN IF NOT EXISTS thread_id text;

UPDATE memory_dream_decisions decisions
SET thread_id = runs.thread_id
FROM memory_dream_runs runs
WHERE decisions.run_id = runs.id
  AND decisions.thread_id IS NULL;

DROP INDEX IF EXISTS idx_memory_dream_runs_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_dream_runs_boundary
  ON memory_dream_runs(app_id, agent_id, subject_type, subject_id, thread_id, started_at DESC);

DROP INDEX IF EXISTS memory_items_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_unique
  ON memory_items(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    COALESCE(thread_id, ''),
    kind,
    key
  )
  WHERE status = 'active';
