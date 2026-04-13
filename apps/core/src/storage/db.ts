import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from '../core/config.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { logger } from '../core/logger.js';
import {
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../core/types.js';

let db: Database.Database;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRegisteredGroupAgentConfig(
  rawConfig: string | null,
  context: { jid: string; folder: string },
): RegisteredGroup['agentConfig'] | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('container_config must be a JSON object');
    }

    const config: NonNullable<RegisteredGroup['agentConfig']> = {};
    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      config.model = parsed.model.trim().slice(0, 120);
    }
    if (
      typeof parsed.timeout === 'number' &&
      Number.isFinite(parsed.timeout) &&
      parsed.timeout >= 1_000 &&
      parsed.timeout <= 3_600_000
    ) {
      config.timeout = Math.round(parsed.timeout);
    }
    if (Array.isArray(parsed.additionalMounts)) {
      const mounts = parsed.additionalMounts
        .filter((item) => isPlainObject(item))
        .map((item) => {
          const hostPath =
            typeof item.hostPath === 'string' ? item.hostPath.trim() : '';
          if (!hostPath) return null;
          const mount: {
            hostPath: string;
            containerPath?: string;
            readonly?: boolean;
          } = { hostPath };
          if (
            typeof item.containerPath === 'string' &&
            item.containerPath.trim().length > 0
          ) {
            mount.containerPath = item.containerPath.trim();
          }
          if (typeof item.readonly === 'boolean') {
            mount.readonly = item.readonly;
          }
          return mount;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (mounts.length > 0) {
        config.additionalMounts = mounts;
      }
    }

    if (isPlainObject(parsed.thinking)) {
      const mode = parsed.thinking.mode;
      if (mode === 'adaptive' || mode === 'enabled' || mode === 'disabled') {
        config.thinking = { mode };
        if (
          parsed.thinking.effort === 'low' ||
          parsed.thinking.effort === 'medium' ||
          parsed.thinking.effort === 'high' ||
          parsed.thinking.effort === 'max'
        ) {
          config.thinking.effort = parsed.thinking.effort;
        }
        if (
          typeof parsed.thinking.budgetTokens === 'number' &&
          Number.isFinite(parsed.thinking.budgetTokens) &&
          parsed.thinking.budgetTokens >= 0
        ) {
          config.thinking.budgetTokens = Math.round(
            parsed.thinking.budgetTokens,
          );
        }
        if (
          parsed.thinking.display === 'summarized' ||
          parsed.thinking.display === 'omitted'
        ) {
          config.thinking.display = parsed.thinking.display;
        }
      }
    }

    return Object.keys(config).length > 0 ? config : undefined;
  } catch (err) {
    logger.warn(
      { jid: context.jid, folder: context.folder, err },
      'Ignoring invalid registered group container_config JSON',
    );
    return undefined;
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

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
      group_scope TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_backoff_ms INTEGER NOT NULL DEFAULT 5000,
      max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      lease_run_id TEXT,
      lease_expires_at TEXT,
      pause_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run);
    CREATE INDEX IF NOT EXISTS idx_jobs_group_scope ON jobs(group_scope);

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
    CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON job_runs(job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Remove legacy scheduler tables now that job-based scheduling is the only path.
  database.exec(`
    DROP TABLE IF EXISTS task_run_logs;
    DROP TABLE IF EXISTS scheduled_tasks;
  `);

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Add per-job model override column if it doesn't exist.
  try {
    database.exec(`ALTER TABLE jobs ADD COLUMN model TEXT DEFAULT NULL`);
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

type RawJobRow = Omit<Job, 'linked_sessions'> & { linked_sessions: string };

function mapJobRow(row: RawJobRow): Job {
  let linkedSessions: string[] = [];
  try {
    const parsed = JSON.parse(row.linked_sessions);
    if (Array.isArray(parsed)) {
      linkedSessions = parsed.filter((item) => typeof item === 'string');
    }
  } catch {
    linkedSessions = [];
  }
  return {
    ...row,
    linked_sessions: linkedSessions,
  };
}

export interface JobUpsertInput {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  script?: string | null;
  schedule_type: Job['schedule_type'];
  schedule_value: string;
  linked_sessions: string[];
  group_scope: string;
  created_by: Job['created_by'];
  status?: Job['status'];
  next_run: string | null;
  timeout_ms?: number;
  max_retries?: number;
  retry_backoff_ms?: number;
  max_consecutive_failures?: number;
}

export function upsertJob(job: JobUpsertInput): { created: boolean } {
  const existing = db
    .prepare('SELECT id FROM jobs WHERE id = ?')
    .get(job.id) as { id: string } | undefined;
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO jobs (
      id, name, prompt, model, script, schedule_type, schedule_value, status,
      linked_sessions, group_scope, created_by, created_at, updated_at,
      next_run, timeout_ms, max_retries, retry_backoff_ms, max_consecutive_failures
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      prompt = excluded.prompt,
      model = excluded.model,
      script = excluded.script,
      schedule_type = excluded.schedule_type,
      schedule_value = excluded.schedule_value,
      status = CASE
        WHEN jobs.status IN ('running', 'dead_lettered') THEN jobs.status
        ELSE excluded.status
      END,
      linked_sessions = excluded.linked_sessions,
      group_scope = excluded.group_scope,
      updated_at = excluded.updated_at,
      next_run = excluded.next_run,
      timeout_ms = excluded.timeout_ms,
      max_retries = excluded.max_retries,
      retry_backoff_ms = excluded.retry_backoff_ms,
      max_consecutive_failures = excluded.max_consecutive_failures
  `,
  ).run(
    job.id,
    job.name,
    job.prompt,
    job.model || null,
    job.script || null,
    job.schedule_type,
    job.schedule_value,
    job.status || 'active',
    JSON.stringify(job.linked_sessions),
    job.group_scope,
    job.created_by,
    now,
    now,
    job.next_run,
    job.timeout_ms ?? 300000,
    job.max_retries ?? 3,
    job.retry_backoff_ms ?? 5000,
    job.max_consecutive_failures ?? 5,
  );

  return { created: !existing };
}

export function getJobById(id: string): Job | undefined {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | RawJobRow
    | undefined;
  return row ? mapJobRow(row) : undefined;
}

export function getAllJobs(): Job[] {
  return db
    .prepare('SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC')
    .all()
    .map((row) => mapJobRow(row as RawJobRow));
}

export function getRecentJobRuns(limit: number = 200): JobRun[] {
  return listJobRuns(undefined, limit);
}

export function updateJob(
  id: string,
  updates: Partial<
    Pick<
      Job,
      | 'name'
      | 'prompt'
      | 'model'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'status'
      | 'linked_sessions'
      | 'group_scope'
      | 'next_run'
      | 'last_run'
      | 'timeout_ms'
      | 'max_retries'
      | 'retry_backoff_ms'
      | 'max_consecutive_failures'
      | 'consecutive_failures'
      | 'pause_reason'
      | 'lease_run_id'
      | 'lease_expires_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model || null);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.linked_sessions !== undefined) {
    fields.push('linked_sessions = ?');
    values.push(JSON.stringify(updates.linked_sessions));
  }
  if (updates.group_scope !== undefined) {
    fields.push('group_scope = ?');
    values.push(updates.group_scope);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.last_run !== undefined) {
    fields.push('last_run = ?');
    values.push(updates.last_run);
  }
  if (updates.timeout_ms !== undefined) {
    fields.push('timeout_ms = ?');
    values.push(updates.timeout_ms);
  }
  if (updates.max_retries !== undefined) {
    fields.push('max_retries = ?');
    values.push(updates.max_retries);
  }
  if (updates.retry_backoff_ms !== undefined) {
    fields.push('retry_backoff_ms = ?');
    values.push(updates.retry_backoff_ms);
  }
  if (updates.max_consecutive_failures !== undefined) {
    fields.push('max_consecutive_failures = ?');
    values.push(updates.max_consecutive_failures);
  }
  if (updates.consecutive_failures !== undefined) {
    fields.push('consecutive_failures = ?');
    values.push(updates.consecutive_failures);
  }
  if (updates.pause_reason !== undefined) {
    fields.push('pause_reason = ?');
    values.push(updates.pause_reason);
  }
  if (updates.lease_run_id !== undefined) {
    fields.push('lease_run_id = ?');
    values.push(updates.lease_run_id);
  }
  if (updates.lease_expires_at !== undefined) {
    fields.push('lease_expires_at = ?');
    values.push(updates.lease_expires_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteJob(id: string): void {
  db.prepare('DELETE FROM job_events WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM job_runs WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

export function listDueJobs(nowIso: string = new Date().toISOString()): Job[] {
  return db
    .prepare(
      `
      SELECT * FROM jobs
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run ASC, updated_at ASC
    `,
    )
    .all(nowIso)
    .map((row) => mapJobRow(row as RawJobRow));
}

export function markJobRunning(
  id: string,
  runId: string,
  leaseExpiresAt: string,
): boolean {
  const changes = db
    .prepare(
      `
      UPDATE jobs
      SET status = 'running',
          lease_run_id = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'active'
    `,
    )
    .run(runId, leaseExpiresAt, new Date().toISOString(), id).changes;
  return changes > 0;
}

export function releaseStaleJobLeases(
  nowIso: string = new Date().toISOString(),
): number {
  return db
    .prepare(
      `
      UPDATE jobs
      SET status = 'active',
          lease_run_id = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `,
    )
    .run(nowIso, nowIso).changes;
}

export function createJobRun(run: JobRun): boolean {
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO job_runs (
        run_id, job_id, scheduled_for, started_at, ended_at, status,
        result_summary, error_summary, retry_count, notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      run.run_id,
      run.job_id,
      run.scheduled_for,
      run.started_at,
      run.ended_at,
      run.status,
      run.result_summary,
      run.error_summary,
      run.retry_count,
      run.notified_at,
    );
  return result.changes > 0;
}

export function completeJobRun(
  runId: string,
  status: JobRun['status'],
  resultSummary: string | null,
  errorSummary: string | null,
): void {
  db.prepare(
    `
      UPDATE job_runs
      SET status = ?, ended_at = ?, result_summary = ?, error_summary = ?
      WHERE run_id = ?
    `,
  ).run(status, new Date().toISOString(), resultSummary, errorSummary, runId);
}

export function markJobRunNotified(runId: string): void {
  db.prepare('UPDATE job_runs SET notified_at = ? WHERE run_id = ?').run(
    new Date().toISOString(),
    runId,
  );
}

export function listJobRuns(jobId?: string, limit: number = 50): JobRun[] {
  const clampedLimit = Math.max(1, Math.min(limit, 500));
  if (jobId) {
    return db
      .prepare(
        `
          SELECT * FROM job_runs WHERE job_id = ?
          ORDER BY started_at DESC LIMIT ?
        `,
      )
      .all(jobId, clampedLimit) as JobRun[];
  }

  return db
    .prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?')
    .all(clampedLimit) as JobRun[];
}

export function listDeadLetterRuns(limit: number = 50): JobRun[] {
  const clampedLimit = Math.max(1, Math.min(limit, 500));
  return db
    .prepare(
      `
        SELECT * FROM job_runs
        WHERE status = 'dead_lettered'
        ORDER BY started_at DESC LIMIT ?
      `,
    )
    .all(clampedLimit) as JobRun[];
}

export function addJobEvent(event: Omit<JobEvent, 'id'>): void {
  db.prepare(
    `
      INSERT INTO job_events (job_id, run_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    event.job_id,
    event.run_id,
    event.event_type,
    event.payload,
    event.created_at,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: parseRegisteredGroupAgentConfig(row.container_config, {
      jid: row.jid,
      folder: row.folder,
    }),
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.agentConfig ? JSON.stringify(group.agentConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      agentConfig: parseRegisteredGroupAgentConfig(row.container_config, {
        jid: row.jid,
        folder: row.folder,
      }),
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
