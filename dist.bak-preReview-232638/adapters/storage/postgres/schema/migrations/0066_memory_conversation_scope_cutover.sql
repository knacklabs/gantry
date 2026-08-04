-- Clean cut: memory is scoped only to a DM/user or a whole group/channel.
-- Provider threads/topics remain runtime routing metadata, not memory identity.

UPDATE memory_dream_runs
SET
  status = 'failed',
  completed_at = COALESCE(completed_at, now())
WHERE status = 'running';

WITH ranked_active_items AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        app_id,
        COALESCE(agent_id, ''),
        subject_type,
        subject_id,
        kind,
        key
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rank
  FROM memory_items
  WHERE status = 'active'
)
UPDATE memory_items items
SET
  status = 'deleted',
  updated_at = now()
FROM ranked_active_items ranked
WHERE items.id = ranked.id
  AND ranked.rank > 1;

UPDATE memory_items
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

UPDATE memory_evidence
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

UPDATE memory_candidates
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

UPDATE memory_dream_runs
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

UPDATE memory_dream_decisions
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

UPDATE memory_review_requests
SET thread_id = NULL
WHERE thread_id IS NOT NULL;

DROP INDEX IF EXISTS memory_items_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_unique
  ON memory_items(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    kind,
    key
  )
  WHERE status = 'active';

DROP INDEX IF EXISTS idx_memory_items_subject_updated;
CREATE INDEX IF NOT EXISTS idx_memory_items_subject_updated
  ON memory_items(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    status,
    updated_at DESC
  );

DROP INDEX IF EXISTS idx_memory_evidence_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_evidence_boundary
  ON memory_evidence(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    created_at DESC
  );

DROP INDEX IF EXISTS idx_memory_candidates_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_candidates_boundary
  ON memory_candidates(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    status,
    confidence DESC,
    updated_at DESC
  );

DROP INDEX IF EXISTS idx_memory_dream_runs_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_dream_runs_boundary
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    started_at DESC
  );

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
    ('light'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'light');

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_rem_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    ('rem'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'rem');

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_runs_running_deep_unique
  ON memory_dream_runs(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    ('deep'::text)
  )
  WHERE status = 'running' AND phase IN ('all', 'deep');

DROP INDEX IF EXISTS idx_memory_review_requests_pending_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_review_requests_pending_boundary
  ON memory_review_requests(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    status,
    created_at
  );
