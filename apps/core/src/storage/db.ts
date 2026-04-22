import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { STORAGE_PROVIDER, STORAGE_SQLITE_PATH } from '../core/config.js';
import { nowIso as currentIso } from '../core/datetime.js';
import {
  decodeGlobalMessageCursor,
  decodeGroupMessageCursor,
  encodeGlobalMessageCursor,
  toGlobalMessageCursor,
} from '../core/message-cursor.js';
import { logger } from '../core/logger.js';
import { isPlainObject } from '../core/object.js';
import {
  Job,
  JobEvent,
  JobExecutionMode,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../core/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { SQLITE_MIGRATIONS } from './migrations.js';
import * as sqliteSchema from './schema/sqlite.js';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof sqliteSchema>;

function toSqliteBool(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

function fromSqliteBool(value: unknown): boolean {
  return value === true || value === 1;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

function normalizeJobExecutionMode(value: unknown): JobExecutionMode {
  return value === 'serialized' ? 'serialized' : 'parallel';
}

export function makeSessionScopeKey(
  groupFolder: string,
  threadId?: string | null,
): string {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId
    ? `${groupFolder}::thread:${normalizedThreadId}`
    : groupFolder;
}

function applySqliteMigrations(database: Database.Database): void {
  for (const statement of SQLITE_MIGRATIONS) {
    database.exec(statement);
  }
}

const REQUIRED_SCHEMA_COLUMNS = {
  chats: ['jid', 'name', 'last_message_time', 'channel', 'is_group'],
  messages: [
    'id',
    'chat_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'thread_id',
    'reply_to_message_id',
    'reply_to_message_content',
    'reply_to_sender_name',
    'is_from_me',
    'is_bot_message',
  ],
  jobs: [
    'id',
    'name',
    'prompt',
    'model',
    'script',
    'schedule_type',
    'schedule_value',
    'status',
    'linked_sessions',
    'session_id',
    'thread_id',
    'group_scope',
    'created_by',
    'created_at',
    'updated_at',
    'next_run',
    'last_run',
    'silent',
    'cleanup_after_ms',
    'timeout_ms',
    'max_retries',
    'retry_backoff_ms',
    'max_consecutive_failures',
    'consecutive_failures',
    'execution_mode',
    'lease_run_id',
    'lease_expires_at',
    'pause_reason',
  ],
  registered_groups: [
    'jid',
    'name',
    'folder',
    'trigger_pattern',
    'added_at',
    'container_config',
    'requires_trigger',
    'is_main',
  ],
  sessions: ['scope_key', 'group_folder', 'thread_id', 'session_id'],
} as const;

function assertTableColumns(
  database: Database.Database,
  tableName: string,
  requiredColumns: readonly string[],
): void {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  const present = new Set(rows.map((row) => String(row.name || '')));
  const missing = requiredColumns.filter((column) => !present.has(column));
  if (missing.length === 0) return;

  throw new Error(
    `[MyClaw] incompatible SQLite schema in ${tableName}; missing columns: ${missing.join(
      ', ',
    )}. Recreate storage.sqlite.path with the current schema.`,
  );
}

function assertSchemaCompatibility(database: Database.Database): void {
  assertTableColumns(database, 'chats', REQUIRED_SCHEMA_COLUMNS.chats);
  assertTableColumns(database, 'messages', REQUIRED_SCHEMA_COLUMNS.messages);
  assertTableColumns(database, 'jobs', REQUIRED_SCHEMA_COLUMNS.jobs);
  assertTableColumns(
    database,
    'registered_groups',
    REQUIRED_SCHEMA_COLUMNS.registered_groups,
  );
  assertTableColumns(database, 'sessions', REQUIRED_SCHEMA_COLUMNS.sessions);
}

function mapMessageRow(
  row: typeof sqliteSchema.messagesSqlite.$inferSelect,
): NewMessage {
  return {
    id: row.id,
    chat_jid: row.chatJid,
    sender: row.sender || '',
    sender_name: row.senderName || '',
    content: row.content || '',
    timestamp: row.timestamp || '',
    is_from_me: fromSqliteBool(row.isFromMe),
    thread_id: row.threadId || undefined,
    reply_to_message_id: row.replyToMessageId || null,
    reply_to_message_content: row.replyToMessageContent || null,
    reply_to_sender_name: row.replyToSenderName || null,
  } as NewMessage;
}

type JobRow = typeof sqliteSchema.jobsSqlite.$inferSelect;

function mapJobRow(row: JobRow): Job {
  let linkedSessions: string[] = [];
  try {
    const parsed = JSON.parse(row.linkedSessions);
    if (Array.isArray(parsed)) {
      linkedSessions = parsed.filter((item) => typeof item === 'string');
    }
  } catch {
    linkedSessions = [];
  }

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    script: row.script,
    schedule_type: row.scheduleType as Job['schedule_type'],
    schedule_value: row.scheduleValue,
    status: row.status as Job['status'],
    linked_sessions: linkedSessions,
    session_id: row.sessionId,
    thread_id: row.threadId,
    group_scope: row.groupScope,
    created_by: (row.createdBy as Job['created_by']) || 'agent',
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    next_run: row.nextRun,
    last_run: row.lastRun,
    silent: fromSqliteBool(row.silent),
    cleanup_after_ms: row.cleanupAfterMs,
    timeout_ms: row.timeoutMs,
    max_retries: row.maxRetries,
    retry_backoff_ms: row.retryBackoffMs,
    max_consecutive_failures: row.maxConsecutiveFailures,
    consecutive_failures: row.consecutiveFailures,
    execution_mode: normalizeJobExecutionMode(row.executionMode),
    lease_run_id: row.leaseRunId,
    lease_expires_at: row.leaseExpiresAt,
    pause_reason: row.pauseReason,
  };
}

function mapJobRunRow(
  row: typeof sqliteSchema.jobRunsSqlite.$inferSelect,
): JobRun {
  return {
    run_id: row.runId,
    job_id: row.jobId,
    scheduled_for: row.scheduledFor,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    status: row.status as JobRun['status'],
    result_summary: row.resultSummary,
    error_summary: row.errorSummary,
    retry_count: row.retryCount,
    notified_at: row.notifiedAt,
  };
}

function mapJobEventRow(
  row: typeof sqliteSchema.jobEventsSqlite.$inferSelect,
): JobEvent {
  return {
    id: row.id,
    job_id: row.jobId,
    run_id: row.runId,
    event_type: row.eventType,
    payload: row.payload,
    created_at: row.createdAt,
  };
}

export function initDatabase(): void {
  if (STORAGE_PROVIDER !== 'sqlite') {
    throw new Error(
      'storage.provider=postgres is not available in host runtime yet. Runtime persistence cutover is in progress; use storage.provider=sqlite for now.',
    );
  }
  const dbPath = STORAGE_SQLITE_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  applySqliteMigrations(sqlite);
  assertSchemaCompatibility(sqlite);
  db = drizzleSqlite(sqlite, { schema: sqliteSchema });
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applySqliteMigrations(sqlite);
  assertSchemaCompatibility(sqlite);
  db = drizzleSqlite(sqlite, { schema: sqliteSchema });
}

/** @internal - for tests only. Applies schema/migrations to a provided DB. */
export function _createSchemaForTest(database: Database.Database): void {
  applySqliteMigrations(database);
  assertSchemaCompatibility(database);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  sqlite?.close();
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
  const effectiveTimestamp = timestamp || currentIso();
  const chat = sqliteSchema.chatsSqlite;

  db.insert(chat)
    .values({
      jid: chatJid,
      name: name || chatJid,
      lastMessageTime: effectiveTimestamp,
      channel: channel ?? null,
      isGroup: toSqliteBool(isGroup),
    })
    .onConflictDoUpdate({
      target: chat.jid,
      set: {
        name: name
          ? sql`excluded.name`
          : sql`COALESCE(${chat.name}, excluded.name)`,
        lastMessageTime: sql`CASE
          WHEN ${chat.lastMessageTime} IS NOT NULL
            AND ${chat.lastMessageTime} > excluded.last_message_time
          THEN ${chat.lastMessageTime}
          ELSE excluded.last_message_time
        END`,
        channel:
          channel === undefined ? sql`${chat.channel}` : sql`excluded.channel`,
        isGroup:
          isGroup === undefined ? sql`${chat.isGroup}` : sql`excluded.is_group`,
      },
    })
    .run();
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
    .select()
    .from(sqliteSchema.chatsSqlite)
    .orderBy(desc(sqliteSchema.chatsSqlite.lastMessageTime))
    .all()
    .map((row) => ({
      jid: row.jid,
      name: row.name || row.jid,
      last_message_time: row.lastMessageTime || '',
      channel: row.channel || '',
      is_group: fromSqliteBool(row.isGroup) ? 1 : 0,
    }));
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.insert(sqliteSchema.messagesSqlite)
    .values({
      id: msg.id,
      chatJid: msg.chat_jid,
      sender: msg.sender,
      senderName: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      threadId: msg.thread_id ?? null,
      isFromMe: toSqliteBool(Boolean(msg.is_from_me)),
      isBotMessage: toSqliteBool(Boolean(msg.is_bot_message)),
      replyToMessageId: msg.reply_to_message_id ?? null,
      replyToMessageContent: msg.reply_to_message_content ?? null,
      replyToSenderName: msg.reply_to_sender_name ?? null,
    })
    .onConflictDoUpdate({
      target: [
        sqliteSchema.messagesSqlite.id,
        sqliteSchema.messagesSqlite.chatJid,
      ],
      set: {
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        threadId: msg.thread_id ?? null,
        isFromMe: toSqliteBool(Boolean(msg.is_from_me)),
        isBotMessage: toSqliteBool(Boolean(msg.is_bot_message)),
        replyToMessageId: msg.reply_to_message_id ?? null,
        replyToMessageContent: msg.reply_to_message_content ?? null,
        replyToSenderName: msg.reply_to_sender_name ?? null,
      },
    })
    .run();
}

export function getNewMessages(
  jids: string[],
  lastCursor: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastCursor };

  const cursor = decodeGlobalMessageCursor(lastCursor);
  const m = sqliteSchema.messagesSqlite;

  const rows = db
    .select()
    .from(m)
    .where(
      and(
        inArray(m.chatJid, jids),
        sql<boolean>`(
          ${m.timestamp} > ${cursor.timestamp}
          OR (
            ${m.timestamp} = ${cursor.timestamp}
            AND (
              ${m.chatJid} > ${cursor.chatJid}
              OR (${m.chatJid} = ${cursor.chatJid} AND ${m.id} > ${cursor.id})
            )
          )
        )`,
        eq(m.isBotMessage, 0),
        isNotNull(m.content),
        sql<boolean>`${m.content} != ''`,
      ),
    )
    .orderBy(asc(m.timestamp), asc(m.chatJid), asc(m.id))
    .limit(limit)
    .all();

  const messages = rows.map((row) => mapMessageRow(row));

  let newTimestamp = lastCursor;
  const latest = messages[messages.length - 1];
  if (latest) {
    newTimestamp = encodeGlobalMessageCursor(toGlobalMessageCursor(latest));
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceCursor: string,
  limit: number = 200,
  options: { threadId?: string | null } = {},
): NewMessage[] {
  const cursor = decodeGroupMessageCursor(sinceCursor);
  const m = sqliteSchema.messagesSqlite;
  const hasThreadFilter = Object.prototype.hasOwnProperty.call(
    options,
    'threadId',
  );
  const threadId = options.threadId?.trim() || null;

  const threadFilter = hasThreadFilter
    ? threadId
      ? eq(m.threadId, threadId)
      : or(
          sql<boolean>`${m.threadId} IS NULL`,
          sql<boolean>`TRIM(${m.threadId}) = ''`,
        )
    : undefined;

  const where = and(
    eq(m.chatJid, chatJid),
    or(
      gt(m.timestamp, cursor.timestamp),
      and(eq(m.timestamp, cursor.timestamp), gt(m.id, cursor.id)),
    ),
    eq(m.isBotMessage, 0),
    isNotNull(m.content),
    sql<boolean>`${m.content} != ''`,
    threadFilter,
  );

  return db
    .select()
    .from(m)
    .where(where)
    .orderBy(asc(m.timestamp), asc(m.id))
    .limit(limit)
    .all()
    .map((row) => mapMessageRow(row));
}

export function getMessageThreadIds(chatJid: string): Array<string | null> {
  const m = sqliteSchema.messagesSqlite;
  const rows = db
    .selectDistinct({ threadId: m.threadId })
    .from(m)
    .where(
      and(
        eq(m.chatJid, chatJid),
        eq(m.isBotMessage, 0),
        isNotNull(m.content),
        sql<boolean>`${m.content} != ''`,
      ),
    )
    .orderBy(asc(m.threadId))
    .all();

  const seen = new Set<string>();
  const threads: Array<string | null> = [];
  for (const row of rows) {
    const normalized = normalizeText(row.threadId);
    const key = normalized ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    threads.push(normalized);
  }
  return threads;
}

export function getLastBotMessageCursor(
  chatJid: string,
): { timestamp: string; id: string } | undefined {
  const row = db
    .select({
      timestamp: sqliteSchema.messagesSqlite.timestamp,
      id: sqliteSchema.messagesSqlite.id,
    })
    .from(sqliteSchema.messagesSqlite)
    .where(
      and(
        eq(sqliteSchema.messagesSqlite.chatJid, chatJid),
        eq(sqliteSchema.messagesSqlite.isBotMessage, 1),
      ),
    )
    .orderBy(
      desc(sqliteSchema.messagesSqlite.timestamp),
      desc(sqliteSchema.messagesSqlite.id),
    )
    .limit(1)
    .get();
  if (!row || !row.timestamp) return undefined;
  return { timestamp: row.timestamp, id: row.id };
}

export function getLastBotMessageTimestamp(
  chatJid: string,
): string | undefined {
  return getLastBotMessageCursor(chatJid)?.timestamp;
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
  session_id?: string | null;
  thread_id?: string | null;
  group_scope: string;
  created_by: Job['created_by'];
  status?: Job['status'];
  next_run: string | null;
  silent?: boolean;
  cleanup_after_ms?: number;
  timeout_ms?: number;
  max_retries?: number;
  retry_backoff_ms?: number;
  max_consecutive_failures?: number;
  execution_mode?: JobExecutionMode;
}

export function upsertJob(job: JobUpsertInput): { created: boolean } {
  const j = sqliteSchema.jobsSqlite;
  const now = currentIso();
  const existing = db
    .select({ id: j.id })
    .from(j)
    .where(eq(j.id, job.id))
    .limit(1)
    .get();

  db.insert(j)
    .values({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      model: job.model || null,
      script: job.script || null,
      scheduleType: job.schedule_type,
      scheduleValue: job.schedule_value,
      status: job.status || 'active',
      linkedSessions: JSON.stringify(job.linked_sessions),
      sessionId: job.session_id || null,
      threadId: job.thread_id || null,
      groupScope: job.group_scope,
      createdBy: job.created_by,
      createdAt: now,
      updatedAt: now,
      nextRun: job.next_run,
      silent: toSqliteBool(Boolean(job.silent)),
      cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
      timeoutMs: job.timeout_ms ?? 300000,
      maxRetries: job.max_retries ?? 3,
      retryBackoffMs: job.retry_backoff_ms ?? 5000,
      maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
      executionMode: normalizeJobExecutionMode(job.execution_mode),
    })
    .onConflictDoUpdate({
      target: j.id,
      set: {
        name: job.name,
        prompt: job.prompt,
        model: job.model || null,
        script: job.script || null,
        scheduleType: job.schedule_type,
        scheduleValue: job.schedule_value,
        status: sql`CASE
          WHEN ${j.status} IN ('running', 'dead_lettered') THEN ${j.status}
          ELSE excluded.status
        END`,
        linkedSessions: JSON.stringify(job.linked_sessions),
        sessionId: job.session_id || null,
        threadId: job.thread_id || null,
        groupScope: job.group_scope,
        updatedAt: now,
        nextRun: job.next_run,
        silent: toSqliteBool(Boolean(job.silent)),
        cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
        timeoutMs: job.timeout_ms ?? 300000,
        maxRetries: job.max_retries ?? 3,
        retryBackoffMs: job.retry_backoff_ms ?? 5000,
        maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
        executionMode: normalizeJobExecutionMode(job.execution_mode),
      },
    })
    .run();

  return { created: !existing };
}

export function getJobById(id: string): Job | undefined {
  const row = db
    .select()
    .from(sqliteSchema.jobsSqlite)
    .where(eq(sqliteSchema.jobsSqlite.id, id))
    .limit(1)
    .get();
  return row ? mapJobRow(row) : undefined;
}

export function getAllJobs(): Job[] {
  return db
    .select()
    .from(sqliteSchema.jobsSqlite)
    .orderBy(
      desc(sqliteSchema.jobsSqlite.updatedAt),
      desc(sqliteSchema.jobsSqlite.createdAt),
    )
    .all()
    .map((row) => mapJobRow(row));
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
      | 'session_id'
      | 'thread_id'
      | 'group_scope'
      | 'next_run'
      | 'last_run'
      | 'silent'
      | 'cleanup_after_ms'
      | 'timeout_ms'
      | 'max_retries'
      | 'retry_backoff_ms'
      | 'max_consecutive_failures'
      | 'consecutive_failures'
      | 'execution_mode'
      | 'pause_reason'
      | 'lease_run_id'
      | 'lease_expires_at'
    >
  >,
): void {
  const setValues: Partial<typeof sqliteSchema.jobsSqlite.$inferInsert> = {
    updatedAt: currentIso(),
  };

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
  if (updates.model !== undefined) setValues.model = updates.model || null;
  if (updates.script !== undefined) setValues.script = updates.script || null;
  if (updates.schedule_type !== undefined)
    setValues.scheduleType = updates.schedule_type;
  if (updates.schedule_value !== undefined)
    setValues.scheduleValue = updates.schedule_value;
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.linked_sessions !== undefined)
    setValues.linkedSessions = JSON.stringify(updates.linked_sessions);
  if (updates.session_id !== undefined)
    setValues.sessionId = updates.session_id;
  if (updates.thread_id !== undefined) setValues.threadId = updates.thread_id;
  if (updates.group_scope !== undefined)
    setValues.groupScope = updates.group_scope;
  if (updates.next_run !== undefined) setValues.nextRun = updates.next_run;
  if (updates.last_run !== undefined) setValues.lastRun = updates.last_run;
  if (updates.silent !== undefined)
    setValues.silent = toSqliteBool(Boolean(updates.silent));
  if (updates.cleanup_after_ms !== undefined)
    setValues.cleanupAfterMs = updates.cleanup_after_ms;
  if (updates.timeout_ms !== undefined)
    setValues.timeoutMs = updates.timeout_ms;
  if (updates.max_retries !== undefined)
    setValues.maxRetries = updates.max_retries;
  if (updates.retry_backoff_ms !== undefined)
    setValues.retryBackoffMs = updates.retry_backoff_ms;
  if (updates.max_consecutive_failures !== undefined)
    setValues.maxConsecutiveFailures = updates.max_consecutive_failures;
  if (updates.consecutive_failures !== undefined)
    setValues.consecutiveFailures = updates.consecutive_failures;
  if (updates.execution_mode !== undefined)
    setValues.executionMode = normalizeJobExecutionMode(updates.execution_mode);
  if (updates.pause_reason !== undefined)
    setValues.pauseReason = updates.pause_reason;
  if (updates.lease_run_id !== undefined)
    setValues.leaseRunId = updates.lease_run_id;
  if (updates.lease_expires_at !== undefined)
    setValues.leaseExpiresAt = updates.lease_expires_at;

  if (Object.keys(setValues).length === 1) return;

  db.update(sqliteSchema.jobsSqlite)
    .set(setValues)
    .where(eq(sqliteSchema.jobsSqlite.id, id))
    .run();
}

export function deleteJob(id: string): void {
  db.delete(sqliteSchema.jobsSqlite)
    .where(eq(sqliteSchema.jobsSqlite.id, id))
    .run();
}

export function listDueJobs(nowIso: string = currentIso()): Job[] {
  const j = sqliteSchema.jobsSqlite;
  return db
    .select()
    .from(j)
    .where(
      and(eq(j.status, 'active'), isNotNull(j.nextRun), lte(j.nextRun, nowIso)),
    )
    .orderBy(asc(j.nextRun), asc(j.updatedAt))
    .all()
    .map((row) => mapJobRow(row));
}

export function markJobRunning(
  id: string,
  runId: string,
  leaseExpiresAt: string,
): boolean {
  const result = db
    .update(sqliteSchema.jobsSqlite)
    .set({
      status: 'running',
      leaseRunId: runId,
      leaseExpiresAt,
      updatedAt: currentIso(),
    })
    .where(
      and(
        eq(sqliteSchema.jobsSqlite.id, id),
        eq(sqliteSchema.jobsSqlite.status, 'active'),
      ),
    )
    .run();
  return result.changes > 0;
}

export function releaseStaleJobLeases(nowIso: string = currentIso()): number {
  const result = db
    .update(sqliteSchema.jobsSqlite)
    .set({
      status: 'active',
      leaseRunId: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(sqliteSchema.jobsSqlite.status, 'running'),
        isNotNull(sqliteSchema.jobsSqlite.leaseExpiresAt),
        lt(sqliteSchema.jobsSqlite.leaseExpiresAt, nowIso),
      ),
    )
    .run();
  return result.changes;
}

export function createJobRun(run: JobRun): boolean {
  const result = db
    .insert(sqliteSchema.jobRunsSqlite)
    .values({
      runId: run.run_id,
      jobId: run.job_id,
      scheduledFor: run.scheduled_for,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      status: run.status,
      resultSummary: run.result_summary,
      errorSummary: run.error_summary,
      retryCount: run.retry_count,
      notifiedAt: run.notified_at,
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

export function completeJobRun(
  runId: string,
  status: JobRun['status'],
  resultSummary: string | null,
  errorSummary: string | null,
): void {
  db.update(sqliteSchema.jobRunsSqlite)
    .set({
      status,
      endedAt: currentIso(),
      resultSummary,
      errorSummary,
    })
    .where(eq(sqliteSchema.jobRunsSqlite.runId, runId))
    .run();
}

export function markJobRunNotified(runId: string): void {
  db.update(sqliteSchema.jobRunsSqlite)
    .set({ notifiedAt: currentIso() })
    .where(eq(sqliteSchema.jobRunsSqlite.runId, runId))
    .run();
}

export function listJobRuns(jobId?: string, limit: number = 50): JobRun[] {
  const clampedLimit = Math.max(1, Math.min(limit, 500));

  const rows = jobId
    ? db
        .select()
        .from(sqliteSchema.jobRunsSqlite)
        .where(eq(sqliteSchema.jobRunsSqlite.jobId, jobId))
        .orderBy(desc(sqliteSchema.jobRunsSqlite.startedAt))
        .limit(clampedLimit)
        .all()
    : db
        .select()
        .from(sqliteSchema.jobRunsSqlite)
        .orderBy(desc(sqliteSchema.jobRunsSqlite.startedAt))
        .limit(clampedLimit)
        .all();

  return rows.map((row) => mapJobRunRow(row));
}

export function listDeadLetterRuns(limit: number = 50): JobRun[] {
  const clampedLimit = Math.max(1, Math.min(limit, 500));
  return db
    .select()
    .from(sqliteSchema.jobRunsSqlite)
    .where(eq(sqliteSchema.jobRunsSqlite.status, 'dead_lettered'))
    .orderBy(desc(sqliteSchema.jobRunsSqlite.startedAt))
    .limit(clampedLimit)
    .all()
    .map((row) => mapJobRunRow(row));
}

export function addJobEvent(event: Omit<JobEvent, 'id'>): void {
  db.insert(sqliteSchema.jobEventsSqlite)
    .values({
      jobId: event.job_id,
      runId: event.run_id,
      eventType: event.event_type,
      payload: event.payload,
      createdAt: event.created_at,
    })
    .run();
}

export function listRecentJobEvents(
  limit: number = 200,
  filters?: {
    job_id?: string;
    run_id?: string;
    event_type?: string;
  },
): JobEvent[] {
  const clampedLimit = Math.max(1, Math.min(limit, 2000));
  const conditions = [];
  if (filters?.job_id)
    conditions.push(eq(sqliteSchema.jobEventsSqlite.jobId, filters.job_id));
  if (filters?.run_id)
    conditions.push(eq(sqliteSchema.jobEventsSqlite.runId, filters.run_id));
  if (filters?.event_type)
    conditions.push(
      eq(sqliteSchema.jobEventsSqlite.eventType, filters.event_type),
    );

  return db
    .select()
    .from(sqliteSchema.jobEventsSqlite)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      desc(sqliteSchema.jobEventsSqlite.createdAt),
      desc(sqliteSchema.jobEventsSqlite.id),
    )
    .limit(clampedLimit)
    .all()
    .map((row) => mapJobEventRow(row));
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  return db
    .select({ value: sqliteSchema.routerStateSqlite.value })
    .from(sqliteSchema.routerStateSqlite)
    .where(eq(sqliteSchema.routerStateSqlite.key, key))
    .limit(1)
    .get()?.value;
}

export function setRouterState(key: string, value: string): void {
  db.insert(sqliteSchema.routerStateSqlite)
    .values({ key, value })
    .onConflictDoUpdate({
      target: sqliteSchema.routerStateSqlite.key,
      set: { value },
    })
    .run();
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  threadId?: string | null,
): string | undefined {
  return db
    .select({ sessionId: sqliteSchema.sessionsSqlite.sessionId })
    .from(sqliteSchema.sessionsSqlite)
    .where(
      eq(
        sqliteSchema.sessionsSqlite.scopeKey,
        makeSessionScopeKey(groupFolder, threadId),
      ),
    )
    .limit(1)
    .get()?.sessionId;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  threadId?: string | null,
): void {
  const normalizedThreadId = threadId?.trim() || null;
  db.insert(sqliteSchema.sessionsSqlite)
    .values({
      scopeKey: makeSessionScopeKey(groupFolder, normalizedThreadId),
      groupFolder,
      threadId: normalizedThreadId,
      sessionId,
    })
    .onConflictDoUpdate({
      target: sqliteSchema.sessionsSqlite.scopeKey,
      set: {
        groupFolder,
        threadId: normalizedThreadId,
        sessionId,
      },
    })
    .run();
}

export function deleteSession(
  groupFolder: string,
  threadId?: string | null,
): void {
  db.delete(sqliteSchema.sessionsSqlite)
    .where(
      eq(
        sqliteSchema.sessionsSqlite.scopeKey,
        makeSessionScopeKey(groupFolder, threadId),
      ),
    )
    .run();
}

export function getAllSessions(): Record<string, string> {
  const rows = db.select().from(sqliteSchema.sessionsSqlite).all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.scopeKey] = row.sessionId;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .select()
    .from(sqliteSchema.registeredGroupsSqlite)
    .where(eq(sqliteSchema.registeredGroupsSqlite.jid, jid))
    .limit(1)
    .get();
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
    trigger: row.triggerPattern,
    added_at: row.addedAt,
    agentConfig: parseRegisteredGroupAgentConfig(row.containerConfig, {
      jid: row.jid,
      folder: row.folder,
    }),
    requiresTrigger:
      row.requiresTrigger === null
        ? undefined
        : fromSqliteBool(row.requiresTrigger),
    isMain: fromSqliteBool(row.isMain) ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.insert(sqliteSchema.registeredGroupsSqlite)
    .values({
      jid,
      name: group.name,
      folder: group.folder,
      triggerPattern: group.trigger,
      addedAt: group.added_at,
      containerConfig: group.agentConfig
        ? JSON.stringify(group.agentConfig)
        : null,
      requiresTrigger:
        group.requiresTrigger === undefined
          ? 1
          : toSqliteBool(group.requiresTrigger),
      isMain: toSqliteBool(Boolean(group.isMain)),
    })
    .onConflictDoUpdate({
      target: sqliteSchema.registeredGroupsSqlite.jid,
      set: {
        name: group.name,
        folder: group.folder,
        triggerPattern: group.trigger,
        addedAt: group.added_at,
        containerConfig: group.agentConfig
          ? JSON.stringify(group.agentConfig)
          : null,
        requiresTrigger:
          group.requiresTrigger === undefined
            ? 1
            : toSqliteBool(group.requiresTrigger),
        isMain: toSqliteBool(Boolean(group.isMain)),
      },
    })
    .run();
}

export function deleteRegisteredGroup(jid: string): void {
  db.delete(sqliteSchema.registeredGroupsSqlite)
    .where(eq(sqliteSchema.registeredGroupsSqlite.jid, jid))
    .run();
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.select().from(sqliteSchema.registeredGroupsSqlite).all();
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
      trigger: row.triggerPattern,
      added_at: row.addedAt,
      agentConfig: parseRegisteredGroupAgentConfig(row.containerConfig, {
        jid: row.jid,
        folder: row.folder,
      }),
      requiresTrigger:
        row.requiresTrigger === null
          ? undefined
          : fromSqliteBool(row.requiresTrigger),
      isMain: fromSqliteBool(row.isMain) ? true : undefined,
    };
  }
  return result;
}
