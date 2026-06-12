CREATE TABLE IF NOT EXISTS live_turns (
  id text PRIMARY KEY,
  scope_key text NOT NULL,
  app_id text NOT NULL,
  agent_session_id text,
  conversation_id text NOT NULL,
  thread_id text,
  run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'claimed',
  pending_message_json jsonb,
  stop_alias_jids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_continuation_user_id text,
  retry_count integer NOT NULL DEFAULT 0,
  next_command_seq integer NOT NULL DEFAULT 1,
  worker_instance_id text,
  lease_token text,
  fencing_version integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_turns_active_scope ON live_turns(scope_key) WHERE state NOT IN ('completed', 'failed', 'timed_out');
CREATE INDEX IF NOT EXISTS idx_live_turns_scope ON live_turns(scope_key, created_at);
CREATE INDEX IF NOT EXISTS idx_live_turns_run ON live_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_live_turns_state ON live_turns(state, updated_at);

CREATE TABLE IF NOT EXISTS live_turn_commands (
  id text PRIMARY KEY,
  live_turn_id text NOT NULL REFERENCES live_turns(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  command_type text NOT NULL,
  seq integer NOT NULL,
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  fencing_version integer,
  created_by_worker_id text,
  applied_by_worker_id text,
  rejected_reason text,
  created_at timestamptz NOT NULL,
  applied_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_turn_commands_idempotency ON live_turn_commands(live_turn_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_turn_commands_turn_seq ON live_turn_commands(live_turn_id, seq);
CREATE INDEX IF NOT EXISTS idx_live_turn_commands_pending ON live_turn_commands(live_turn_id, seq) WHERE status = 'pending';
