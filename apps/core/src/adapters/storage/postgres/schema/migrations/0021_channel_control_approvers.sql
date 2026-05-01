CREATE TABLE IF NOT EXISTS channel_control_approvers (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_control_approvers_conversation
  ON channel_control_approvers(conversation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_control_approvers_user
  ON channel_control_approvers(app_id, conversation_id, external_user_id);
