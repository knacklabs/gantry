CREATE TABLE IF NOT EXISTS runtime_worker_inventory_snapshots (
  app_id text NOT NULL,
  instance_id text NOT NULL,
  hostname text NOT NULL,
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  warm_pool_json jsonb NOT NULL,
  queue_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_worker_inventory_heartbeat
  ON runtime_worker_inventory_snapshots (app_id, last_heartbeat_at);
