import {
  boolean,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { STORAGE_POSTGRES_SCHEMA } from '../../core/config.js';

const myclawSchema = pgSchema(STORAGE_POSTGRES_SCHEMA);

export const storageMetaPostgres = myclawSchema.table('storage_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatsPostgres = myclawSchema.table('chats', {
  jid: text('jid').primaryKey(),
  name: text('name'),
  lastMessageTime: text('last_message_time'),
  channel: text('channel'),
  isGroup: boolean('is_group').notNull().default(false),
});

export const messagesPostgres = myclawSchema.table(
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
    isFromMe: boolean('is_from_me').notNull().default(false),
    isBotMessage: boolean('is_bot_message').notNull().default(false),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.chatJid], name: 'messages_pk' }),
    timestampIdx: index('idx_timestamp').on(table.timestamp),
    chatThreadIdx: index('idx_messages_chat_thread').on(
      table.chatJid,
      table.threadId,
    ),
  }),
);

export const jobsPostgres = myclawSchema.table(
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
    silent: boolean('silent').notNull().default(false),
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

export const jobRunsPostgres = myclawSchema.table(
  'job_runs',
  {
    runId: text('run_id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsPostgres.id, { onDelete: 'cascade' }),
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

export const jobEventsPostgres = myclawSchema.table(
  'job_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsPostgres.id, { onDelete: 'cascade' }),
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

export const routerStatePostgres = myclawSchema.table('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessionsPostgres = myclawSchema.table('sessions', {
  scopeKey: text('scope_key').primaryKey(),
  groupFolder: text('group_folder').notNull(),
  threadId: text('thread_id'),
  sessionId: text('session_id').notNull(),
});

export const registeredGroupsPostgres = myclawSchema.table(
  'registered_groups',
  {
    jid: text('jid').primaryKey(),
    name: text('name').notNull(),
    folder: text('folder').notNull().unique(),
    triggerPattern: text('trigger_pattern').notNull(),
    addedAt: text('added_at').notNull(),
    containerConfig: text('container_config'),
    requiresTrigger: boolean('requires_trigger').default(true),
    isMain: boolean('is_main').default(false),
  },
);
