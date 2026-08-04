CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_id text REFERENCES conversation_threads(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  profile_id text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  settled_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_deliveries_app_id_idempotency_key_key
    UNIQUE (app_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_app_status_updated
  ON outbound_deliveries(app_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_conversation_updated
  ON outbound_deliveries(conversation_id, thread_id, updated_at);

CREATE TABLE IF NOT EXISTS outbound_delivery_final_answers (
  delivery_id text PRIMARY KEY REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
  canonical_text text NOT NULL,
  segment_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_delivery_items (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  canonical_text text NOT NULL,
  provider_payload_json text,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token text,
  claim_owner text,
  claim_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_delivery_items_delivery_id_ordinal_key
    UNIQUE (delivery_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_outbound_delivery_items_claim_due
  ON outbound_delivery_items(status, next_attempt_at, claim_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_delivery_items_delivery_status
  ON outbound_delivery_items(delivery_id, status, ordinal);

CREATE TABLE IF NOT EXISTS outbound_delivery_receipts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES outbound_delivery_items(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  provider_message_id text,
  provider_payload_json text,
  sent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_delivery_receipts_item_id_idempotency_key_key
    UNIQUE (item_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbound_delivery_receipts_delivery_sent
  ON outbound_delivery_receipts(delivery_id, sent_at);
