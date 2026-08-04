ALTER TABLE memory_dream_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE memory_dream_runs
  SET lease_expires_at = COALESCE(completed_at, started_at + interval '20 minutes')
  WHERE lease_expires_at IS NULL;

ALTER TABLE memory_dream_runs
  ALTER COLUMN lease_expires_at SET NOT NULL;

DROP INDEX IF EXISTS idx_memory_dream_runs_running_unique;
DROP INDEX IF EXISTS idx_memory_dream_runs_running_light_unique;
DROP INDEX IF EXISTS idx_memory_dream_runs_running_rem_unique;
DROP INDEX IF EXISTS idx_memory_dream_runs_running_deep_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_light_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    COALESCE(thread_id, ''),
    ('light'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'light');

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_rem_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    COALESCE(thread_id, ''),
    ('rem'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'rem');

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_deep_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    COALESCE(thread_id, ''),
    ('deep'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'deep');
