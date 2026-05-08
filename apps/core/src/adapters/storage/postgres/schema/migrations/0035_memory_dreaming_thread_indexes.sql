DROP INDEX IF EXISTS idx_memory_evidence_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_evidence_boundary
  ON memory_evidence(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    thread_id,
    created_at DESC
  );

DROP INDEX IF EXISTS idx_memory_candidates_boundary;
CREATE INDEX IF NOT EXISTS idx_memory_candidates_boundary
  ON memory_candidates(
    app_id,
    agent_id,
    subject_type,
    subject_id,
    thread_id,
    status,
    confidence DESC,
    updated_at DESC
  );
