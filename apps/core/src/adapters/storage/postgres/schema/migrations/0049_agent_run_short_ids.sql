ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS short_id integer;

WITH numbered AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY job_id
      ORDER BY created_at ASC, id ASC
    ) AS short_id
  FROM agent_runs
  WHERE job_id IS NOT NULL
)
UPDATE agent_runs runs
SET short_id = numbered.short_id
FROM numbered
WHERE runs.id = numbered.id
  AND runs.short_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_job_short_id_unique
  ON agent_runs(job_id, short_id);
