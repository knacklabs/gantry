export const SQLITE_MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS storage_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TEXT,
    channel TEXT,
    is_group INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS messages (
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
    is_from_me INTEGER NOT NULL DEFAULT 0,
    is_bot_message INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, chat_jid)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_thread ON messages(chat_jid, thread_id);`,
  `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT DEFAULT NULL,
    script TEXT,
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
    silent INTEGER NOT NULL DEFAULT 0,
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
  `,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run);`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_group_scope ON jobs(group_scope);`,
  `
  CREATE TABLE IF NOT EXISTS job_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    result_summary TEXT,
    error_summary TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    notified_at TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, scheduled_for)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON job_runs(job_id, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);`,
  `
  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    run_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, created_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS router_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    scope_key TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    thread_id TEXT,
    session_id TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    is_main INTEGER DEFAULT 0
  );
  `,
];

function quotePostgresIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Invalid PostgreSQL schema identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function POSTGRES_MIGRATIONS(schemaName = 'myclaw'): string[] {
  const schema = quotePostgresIdentifier(schemaName);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema};`,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.storage_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TEXT,
    channel TEXT,
    is_group BOOLEAN NOT NULL DEFAULT FALSE
  );
  `,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.messages (
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
  `,
    `CREATE INDEX IF NOT EXISTS idx_timestamp ON ${schema}.messages(timestamp);`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_thread ON ${schema}.messages(chat_jid, thread_id);`,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    script TEXT,
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
  `,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON ${schema}.jobs(status, next_run);`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_group_scope ON ${schema}.jobs(group_scope);`,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.job_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES ${schema}.jobs(id) ON DELETE CASCADE,
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
  `,
    `CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON ${schema}.job_runs(job_id, started_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_job_runs_status ON ${schema}.job_runs(status);`,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.job_events (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES ${schema}.jobs(id) ON DELETE CASCADE,
    run_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
  );
  `,
    `CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON ${schema}.job_events(job_id, created_at DESC);`,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.router_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.sessions (
    scope_key TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    thread_id TEXT,
    session_id TEXT NOT NULL
  );
  `,
    `
  CREATE TABLE IF NOT EXISTS ${schema}.registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger BOOLEAN DEFAULT TRUE,
    is_main BOOLEAN DEFAULT FALSE
  );
  `,
  ];
}
