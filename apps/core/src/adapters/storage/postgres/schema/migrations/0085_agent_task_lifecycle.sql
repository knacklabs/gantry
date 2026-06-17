CREATE TABLE IF NOT EXISTS agent_delegated_tasks (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  thread_id text,
  parent_run_id text,
  run_handle text,
  idempotency_key text NOT NULL,
  capability_scope text NOT NULL,
  owner_worker_id text,
  lease_token text,
  fencing_version integer,
  status text NOT NULL DEFAULT 'running',
  provider_correlation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress_cursor text,
  title text NOT NULL,
  task text NOT NULL,
  expected_output text NOT NULL,
  context text,
  result_summary text,
  error_summary text,
  terminal_receipt_json jsonb,
  cancel_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_delegated_tasks_idempotency ON agent_delegated_tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_agent_delegated_tasks_agent_status ON agent_delegated_tasks(app_id, agent_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_delegated_tasks_scope ON agent_delegated_tasks(app_id, agent_id, conversation_id, thread_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_delegated_tasks_parent ON agent_delegated_tasks(parent_run_id, run_handle, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_delegated_tasks_active_parent ON agent_delegated_tasks(parent_run_id, run_handle, id) WHERE status NOT IN ('completed', 'failed', 'cancelled');

CREATE TABLE IF NOT EXISTS agent_todo_updates (
  id text PRIMARY KEY,
  delegated_task_id text REFERENCES agent_delegated_tasks(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  thread_id text,
  parent_run_id text,
  run_handle text,
  seq integer NOT NULL,
  idempotency_key text NOT NULL,
  fencing_version integer,
  kind text NOT NULL DEFAULT 'todo_update',
  status text NOT NULL DEFAULT 'accepted',
  summary text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_todo_updates_idempotency ON agent_todo_updates(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_agent_todo_updates_task_seq ON agent_todo_updates(delegated_task_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_todo_updates_scope ON agent_todo_updates(app_id, agent_id, conversation_id, thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_todo_updates_parent ON agent_todo_updates(parent_run_id, run_handle, created_at);
