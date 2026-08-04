CREATE TABLE storage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group BOOLEAN NOT NULL DEFAULT FALSE
);
--> statement-breakpoint
CREATE TABLE messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  thread_id TEXT,
  reply_to_message_id TEXT,
  reply_to_message_content TEXT,
  reply_to_sender_name TEXT,
  is_from_me BOOLEAN NOT NULL DEFAULT FALSE,
  is_bot_message BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id, chat_jid)
);
--> statement-breakpoint
CREATE INDEX idx_timestamp ON messages(timestamp);
--> statement-breakpoint
CREATE INDEX idx_messages_global_cursor ON messages(timestamp, chat_jid, id);
--> statement-breakpoint
CREATE INDEX idx_messages_chat_cursor ON messages(chat_jid, timestamp, id);
--> statement-breakpoint
CREATE INDEX idx_messages_chat_thread ON messages(chat_jid, thread_id);
--> statement-breakpoint
CREATE INDEX idx_messages_chat_thread_cursor ON messages(chat_jid, thread_id, timestamp, id);
--> statement-breakpoint
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  linked_sessions TEXT NOT NULL,
  session_id TEXT,
  thread_id TEXT,
  group_scope TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run TEXT,
  last_run TEXT,
  silent BOOLEAN NOT NULL DEFAULT FALSE,
  cleanup_after_ms INTEGER NOT NULL DEFAULT 86400000,
  timeout_ms INTEGER NOT NULL DEFAULT 300000,
  max_retries INTEGER NOT NULL DEFAULT 3,
  retry_backoff_ms INTEGER NOT NULL DEFAULT 5000,
  max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  execution_mode TEXT NOT NULL DEFAULT 'parallel',
  lease_run_id TEXT,
  lease_expires_at TEXT,
  pause_reason TEXT
);
--> statement-breakpoint
CREATE INDEX idx_jobs_status_next_run ON jobs(status, next_run);
--> statement-breakpoint
CREATE INDEX idx_jobs_group_scope ON jobs(group_scope);
--> statement-breakpoint
CREATE TABLE job_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  result_summary TEXT,
  error_summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  UNIQUE (job_id, scheduled_for)
);
--> statement-breakpoint
CREATE INDEX idx_job_runs_job_started ON job_runs(job_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX idx_job_runs_started_at ON job_runs(started_at DESC);
--> statement-breakpoint
CREATE INDEX idx_job_runs_status ON job_runs(status);
--> statement-breakpoint
CREATE TABLE job_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_job_events_job_id ON job_events(job_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX idx_job_events_created_at ON job_events(created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE sessions (
  scope_key TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  thread_id TEXT,
  session_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger BOOLEAN DEFAULT TRUE,
  is_main BOOLEAN DEFAULT FALSE
);
