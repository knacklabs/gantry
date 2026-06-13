-- Per-reply latency trace, persisted next to the outbound reply message.
-- timings_json is ALWAYS written (stages, durations, tokens, sizes, decisions);
-- payloads_json is NULLABLE and only populated when GANTRY_TRACE_PAYLOADS=1, so
-- the hot path stays lean and payloads are independently prunable. Generic /
-- agent-agnostic: server and tool names are stored as data inside the JSON.

CREATE TABLE message_traces (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  conversation_id text NOT NULL,
  kind text NOT NULL,
  total_ms integer NOT NULL,
  timings_json jsonb NOT NULL,
  payloads_json jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX message_traces_conversation_id_idx ON message_traces (conversation_id);
