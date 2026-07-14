CREATE TABLE IF NOT EXISTS run_permission_origin (
  run_id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_folder text NOT NULL,
  target_jid text,
  provider_account_id text,
  thread_id text,
  triggering_sender_id text,
  sender_is_approver boolean NOT NULL DEFAULT false,
  triggering_message_timestamp timestamptz,
  triggering_message_id text,
  is_scheduled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
