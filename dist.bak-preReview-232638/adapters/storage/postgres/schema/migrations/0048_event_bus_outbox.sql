CREATE TABLE IF NOT EXISTS event_bus_outbox (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  source text NOT NULL,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  runtime_event_id integer UNIQUE REFERENCES runtime_events(event_id) ON DELETE CASCADE,
  correlation_id text,
  payload_json text NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_bus_outbox_claim_due
  ON event_bus_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_event_bus_outbox_app_event
  ON event_bus_outbox(app_id, event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_event_bus_outbox_runtime_event
  ON event_bus_outbox(runtime_event_id);

CREATE INDEX IF NOT EXISTS idx_event_bus_outbox_pending_runtime_event
  ON event_bus_outbox(runtime_event_id)
  WHERE runtime_event_id IS NOT NULL;
