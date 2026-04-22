import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const storageMetaSqlite = sqliteTable('storage_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const chatsSqlite = sqliteTable('chats', {
  jid: text('jid').primaryKey(),
  name: text('name'),
  lastMessageTime: text('last_message_time'),
  channel: text('channel'),
  isGroup: integer('is_group').notNull().default(0),
});

export const messagesSqlite = sqliteTable(
  'messages',
  {
    id: text('id').notNull(),
    chatJid: text('chat_jid').notNull(),
    sender: text('sender'),
    senderName: text('sender_name'),
    content: text('content'),
    timestamp: text('timestamp'),
    threadId: text('thread_id'),
    replyToMessageId: text('reply_to_message_id'),
    replyToMessageContent: text('reply_to_message_content'),
    replyToSenderName: text('reply_to_sender_name'),
    isFromMe: integer('is_from_me').notNull().default(0),
    isBotMessage: integer('is_bot_message').notNull().default(0),
  },
  (table) => ({
    pk: uniqueIndex('messages_pk').on(table.id, table.chatJid),
    timestampIdx: index('idx_timestamp').on(table.timestamp),
    chatThreadIdx: index('idx_messages_chat_thread').on(
      table.chatJid,
      table.threadId,
    ),
  }),
);

export const jobsSqlite = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model'),
    script: text('script'),
    scheduleType: text('schedule_type').notNull(),
    scheduleValue: text('schedule_value').notNull(),
    status: text('status').notNull().default('active'),
    linkedSessions: text('linked_sessions').notNull(),
    sessionId: text('session_id'),
    threadId: text('thread_id'),
    groupScope: text('group_scope').notNull(),
    createdBy: text('created_by').notNull().default('agent'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    nextRun: text('next_run'),
    lastRun: text('last_run'),
    silent: integer('silent').notNull().default(0),
    cleanupAfterMs: integer('cleanup_after_ms').notNull().default(86400000),
    timeoutMs: integer('timeout_ms').notNull().default(300000),
    maxRetries: integer('max_retries').notNull().default(3),
    retryBackoffMs: integer('retry_backoff_ms').notNull().default(5000),
    maxConsecutiveFailures: integer('max_consecutive_failures')
      .notNull()
      .default(5),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    executionMode: text('execution_mode').notNull().default('parallel'),
    leaseRunId: text('lease_run_id'),
    leaseExpiresAt: text('lease_expires_at'),
    pauseReason: text('pause_reason'),
  },
  (table) => ({
    statusNextRunIdx: index('idx_jobs_status_next_run').on(
      table.status,
      table.nextRun,
    ),
    groupScopeIdx: index('idx_jobs_group_scope').on(table.groupScope),
  }),
);

export const jobRunsSqlite = sqliteTable(
  'job_runs',
  {
    runId: text('run_id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsSqlite.id, { onDelete: 'cascade' }),
    scheduledFor: text('scheduled_for').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(),
    resultSummary: text('result_summary'),
    errorSummary: text('error_summary'),
    retryCount: integer('retry_count').notNull().default(0),
    notifiedAt: text('notified_at'),
  },
  (table) => ({
    uniqueJobSchedule: uniqueIndex('idx_job_runs_job_schedule').on(
      table.jobId,
      table.scheduledFor,
    ),
    jobStartedIdx: index('idx_job_runs_job_started').on(
      table.jobId,
      table.startedAt,
    ),
    statusIdx: index('idx_job_runs_status').on(table.status),
  }),
);

export const jobEventsSqlite = sqliteTable(
  'job_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsSqlite.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    eventType: text('event_type').notNull(),
    payload: text('payload'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    jobIdCreatedAtIdx: index('idx_job_events_job_id').on(
      table.jobId,
      table.createdAt,
    ),
  }),
);

export const routerStateSqlite = sqliteTable('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessionsSqlite = sqliteTable('sessions', {
  scopeKey: text('scope_key').primaryKey(),
  groupFolder: text('group_folder').notNull(),
  threadId: text('thread_id'),
  sessionId: text('session_id').notNull(),
});

export const registeredGroupsSqlite = sqliteTable('registered_groups', {
  jid: text('jid').primaryKey(),
  name: text('name').notNull(),
  folder: text('folder').notNull().unique(),
  triggerPattern: text('trigger_pattern').notNull(),
  addedAt: text('added_at').notNull(),
  containerConfig: text('container_config'),
  requiresTrigger: integer('requires_trigger').default(1),
  isMain: integer('is_main').default(0),
});
