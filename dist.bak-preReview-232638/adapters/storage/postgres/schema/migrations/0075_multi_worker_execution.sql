CREATE TABLE IF NOT EXISTS worker_instances (
  id text PRIMARY KEY,
  image_digest text,
  boot_nonce text NOT NULL,
  version text,
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'starting',
  heartbeat_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_instances_status_heartbeat ON worker_instances(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS run_leases (
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  job_id text,
  worker_instance_id text NOT NULL REFERENCES worker_instances(id),
  lease_token text NOT NULL,
  fencing_version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  CONSTRAINT run_leases_pk PRIMARY KEY (run_id, fencing_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_leases_lease_token ON run_leases(lease_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_leases_active_run ON run_leases(run_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_leases_active_job ON run_leases(job_id) WHERE status = 'active' AND job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_leases_status_expires ON run_leases(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_run_leases_worker ON run_leases(worker_instance_id, status);

CREATE TABLE IF NOT EXISTS run_slots (
  slot_key text NOT NULL,
  holder_id text NOT NULL,
  run_id text,
  worker_instance_id text,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT run_slots_pk PRIMARY KEY (slot_key, holder_id)
);
CREATE INDEX IF NOT EXISTS idx_run_slots_expires ON run_slots(expires_at);

CREATE TABLE IF NOT EXISTS pending_interactions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload_json jsonb NOT NULL,
  callback_route_json jsonb,
  idempotency_key text NOT NULL,
  approver_ref text,
  resolution_json jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_interactions_idempotency ON pending_interactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pending_interactions_app_status ON pending_interactions(app_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_interactions_run ON pending_interactions(run_id, status);

CREATE TABLE IF NOT EXISTS runner_control_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  job_id text,
  worker_instance_id text NOT NULL,
  fencing_version integer NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL,
  exposed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_runner_control_events_run ON runner_control_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runner_control_events_unexposed ON runner_control_events(created_at) WHERE exposed_at IS NULL;

CREATE TABLE IF NOT EXISTS runner_control_nonces (
  nonce text PRIMARY KEY,
  run_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_control_nonces_expires ON runner_control_nonces(expires_at);

CREATE TABLE IF NOT EXISTS transient_grants (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  lease_token text NOT NULL,
  grant_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transient_grants_run ON transient_grants(run_id, expires_at);
