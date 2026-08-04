ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_session_id_fkey;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_session_id_fkey
  FOREIGN KEY (session_id)
  REFERENCES agent_sessions(id)
  ON DELETE SET NULL;
