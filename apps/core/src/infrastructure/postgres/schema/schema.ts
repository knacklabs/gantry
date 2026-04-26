import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

export * from './canonical-schema.js';
export * from './canonical-runtime-schema.js';

export const storageMetaPostgres = pgTable('storage_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatsPostgres = pgTable('chats', {
  jid: text('jid').primaryKey(),
  name: text('name'),
  lastMessageTime: text('last_message_time'),
  channel: text('channel'),
  isGroup: boolean('is_group').notNull().default(false),
});

export const messagesPostgres = pgTable(
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
    globalCursorIdx: index('idx_messages_global_cursor').on(
      table.timestamp,
      table.chatJid,
      table.id,
    ),
    pollCursorIdx: index('idx_messages_poll_cursor')
      .on(table.timestamp, table.chatJid, table.id)
      .where(
        sql`${table.isBotMessage} = false AND ${table.content} IS NOT NULL AND ${table.content} <> ''`,
      ),
    chatCursorIdx: index('idx_messages_chat_cursor').on(
      table.chatJid,
      table.timestamp,
      table.id,
    ),
    chatThreadIdx: index('idx_messages_chat_thread').on(
      table.chatJid,
      table.threadId,
    ),
    chatThreadCursorIdx: index('idx_messages_chat_thread_cursor').on(
      table.chatJid,
      table.threadId,
      table.timestamp,
      table.id,
    ),
  }),
);

export const jobsPostgres = pgTable(
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
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    nextRun: timestamp('next_run', { withTimezone: true, mode: 'string' }),
    lastRun: timestamp('last_run', { withTimezone: true, mode: 'string' }),
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
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    pauseReason: text('pause_reason'),
  },
  (table) => ({
    statusNextRunIdx: index('idx_jobs_status_next_run').on(
      table.status,
      table.nextRun,
    ),
    statusLeaseExpiresIdx: index('idx_jobs_status_lease_expires').on(
      table.status,
      table.leaseExpiresAt,
    ),
    groupScopeIdx: index('idx_jobs_group_scope').on(table.groupScope),
    statusDomain: check(
      'jobs_status_domain',
      sql`${table.status} IN ('active', 'paused', 'running', 'completed', 'dead_lettered')`,
    ),
    createdByDomain: check(
      'jobs_created_by_domain',
      sql`${table.createdBy} IN ('agent', 'human')`,
    ),
    executionModeDomain: check(
      'jobs_execution_mode_domain',
      sql`${table.executionMode} IN ('parallel', 'serialized')`,
    ),
    scheduleTypeDomain: check(
      'jobs_schedule_type_domain',
      sql`${table.scheduleType} IN ('manual', 'cron', 'interval', 'once')`,
    ),
    scheduleValueDomain: check(
      'jobs_schedule_value_domain',
      sql`CASE
        WHEN ${table.scheduleType} = 'manual' THEN ${table.scheduleValue} = 'manual'
        WHEN ${table.scheduleType} = 'cron' THEN length(trim(${table.scheduleValue})) > 0
        WHEN ${table.scheduleType} = 'interval' THEN ${table.scheduleValue} ~ '^[0-9]+$' AND (${table.scheduleValue})::bigint > 0
        WHEN ${table.scheduleType} = 'once' THEN ${table.scheduleValue} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        ELSE FALSE
      END`,
    ),
  }),
);

export const jobRunsPostgres = pgTable(
  'job_runs',
  {
    runId: text('run_id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsPostgres.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    status: text('status').notNull(),
    resultSummary: text('result_summary'),
    errorSummary: text('error_summary'),
    retryCount: integer('retry_count').notNull().default(0),
    notifiedAt: timestamp('notified_at', {
      withTimezone: true,
      mode: 'string',
    }),
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
    startedAtIdx: index('idx_job_runs_started_at').on(table.startedAt),
    statusIdx: index('idx_job_runs_status').on(table.status),
    statusDomain: check(
      'job_runs_status_domain',
      sql`${table.status} IN ('running', 'completed', 'failed', 'timeout', 'dead_lettered')`,
    ),
  }),
);

export const jobEventsPostgres = pgTable(
  'job_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    eventType: text('event_type').notNull(),
    payload: text('payload'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    jobIdCreatedAtIdx: index('idx_job_events_job_id').on(
      table.jobId,
      table.createdAt,
    ),
    createdAtIdx: index('idx_job_events_created_at').on(
      table.createdAt,
      table.id,
    ),
  }),
);

export const routerStatePostgres = pgTable('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const memoryItemsPostgres = pgTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull().default('personal'),
    agentId: text('agent_id').notNull().default('main'),
    subjectType: text('subject_type').notNull().default('group'),
    subjectId: text('subject_id').notNull().default('default'),
    userIdCanonical: text('user_id_canonical'),
    groupIdCanonical: text('group_id_canonical'),
    channelIdCanonical: text('channel_id_canonical'),
    threadIdCanonical: text('thread_id_canonical'),
    scope: text('scope').notNull(),
    groupFolder: text('group_folder').notNull(),
    userId: text('user_id'),
    topicId: text('topic_id'),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    why: text('why'),
    loadBearing: boolean('load_bearing').notNull().default(false),
    sourceTurnId: text('source_turn_id'),
    evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
    source: text('source').notNull(),
    sourceFolder: text('source_folder').notNull().default('items'),
    filePath: text('file_path').notNull().default(''),
    contentHash: text('content_hash').notNull().default(''),
    indexedAt: timestamp('indexed_at', { withTimezone: true, mode: 'string' }),
    embeddingPending: boolean('embedding_pending').notNull().default(false),
    blockedReason: text('blocked_reason'),
    confidence: doublePrecision('confidence').notNull().default(0.5),
    isPinned: boolean('is_pinned').notNull().default(false),
    usedCount: integer('used_count').notNull().default(0),
    supersededBy: text('superseded_by'),
    version: integer('version').notNull().default(1),
    lastUsedAt: timestamp('last_used_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastRetrievedAt: timestamp('last_retrieved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    retrievalCount: integer('retrieval_count').notNull().default(0),
    totalScore: doublePrecision('total_score').notNull().default(0),
    maxScore: doublePrecision('max_score').notNull().default(0),
    queryHashesJson: text('query_hashes_json').notNull().default('[]'),
    recallDaysJson: text('recall_days_json').notNull().default('[]'),
    embeddingJson: text('embedding_json'),
    embedding: vector('embedding', { dimensions: 3072 }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    lastReviewedAt: timestamp('last_reviewed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    appSubjectIdx: index('idx_memory_items_app_subject').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.threadIdCanonical,
      table.updatedAt,
    ),
    scopeGroupIdx: index('idx_memory_items_scope_group').on(
      table.scope,
      table.groupFolder,
      table.topicId,
      table.updatedAt,
    ),
    filePathIdx: index('idx_memory_items_file_path').on(table.filePath),
    activeUniqueKey: uniqueIndex('idx_memory_items_active_unique_key')
      .on(
        table.appId,
        table.agentId,
        table.subjectType,
        table.subjectId,
        table.scope,
        table.groupFolder,
        table.userId,
        table.topicId,
        table.key,
      )
      .where(sql`${table.isDeleted} = false`),
    searchIdx: index('idx_memory_items_search').using(
      'gin',
      sql`to_tsvector('english', ${table.key} || ' ' || ${table.value} || ' ' || COALESCE(${table.why}, ''))`,
    ),
  }),
);

export const memorySubjectsPostgres = pgTable(
  'memory_subjects',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    externalId: text('external_id'),
    label: text('label'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    uniqueSubject: uniqueIndex('idx_memory_subjects_unique').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
    ),
    appIdx: index('idx_memory_subjects_app').on(table.appId, table.agentId),
  }),
);

export const memoryEvidencePostgres = pgTable(
  'memory_evidence',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    userId: text('user_id'),
    groupId: text('group_id'),
    channelId: text('channel_id'),
    threadId: text('thread_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    actorId: text('actor_id'),
    text: text('text').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_evidence_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
    searchIdx: index('idx_memory_evidence_search').using(
      'gin',
      sql`to_tsvector('english', ${table.text})`,
    ),
  }),
);

export const memoryCandidatesPostgres = pgTable(
  'memory_candidates',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    threadId: text('thread_id'),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    reason: text('reason'),
    evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
    confidence: doublePrecision('confidence').notNull().default(0.5),
    status: text('status').notNull().default('staged'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_candidates_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const memoryRecallEventsPostgres = pgTable(
  'memory_recall_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    itemId: text('item_id').notNull(),
    queryHash: text('query_hash').notNull(),
    score: doublePrecision('score').notNull(),
    subjectJson: text('subject_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    itemIdx: index('idx_memory_recall_events_item').on(
      table.itemId,
      table.createdAt,
    ),
    appIdx: index('idx_memory_recall_events_app').on(
      table.appId,
      table.agentId,
      table.createdAt,
    ),
  }),
);

export const memoryDreamRunsPostgres = pgTable(
  'memory_dream_runs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    summaryJson: text('summary_json').notNull().default('{}'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_dream_runs_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.startedAt,
    ),
  }),
);

export const memoryDreamDecisionsPostgres = pgTable(
  'memory_dream_decisions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    itemId: text('item_id'),
    candidateId: text('candidate_id'),
    action: text('action').notNull(),
    rationale: text('rationale').notNull(),
    evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
    applied: boolean('applied').notNull().default(false),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runIdx: index('idx_memory_dream_decisions_run').on(table.runId),
    appIdx: index('idx_memory_dream_decisions_app').on(
      table.appId,
      table.agentId,
      table.createdAt,
    ),
  }),
);

export const embeddingCachePostgres = pgTable(
  'embedding_cache',
  {
    textHash: text('text_hash').notNull(),
    model: text('model').notNull(),
    embeddingJson: text('embedding_json').notNull(),
    embedding: vector('embedding', { dimensions: 3072 }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.textHash, table.model],
      name: 'embedding_cache_pk',
    }),
  }),
);

export const sessionsPostgres = pgTable('sessions', {
  scopeKey: text('scope_key').primaryKey(),
  groupFolder: text('group_folder').notNull(),
  threadId: text('thread_id'),
  sessionId: text('session_id').notNull(),
});

export const appSessionsPostgres = pgTable(
  'app_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    appId: text('app_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    chatJid: text('chat_jid').notNull().unique(),
    groupFolder: text('group_folder').notNull(),
    title: text('title'),
    defaultResponseMode: text('default_response_mode').notNull().default('sse'),
    defaultWebhookId: text('default_webhook_id'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    appConversationIdx: uniqueIndex('idx_app_sessions_app_conversation').on(
      table.appId,
      table.conversationId,
    ),
  }),
);

export const controlEventsPostgres = pgTable(
  'control_events',
  {
    eventId: integer('event_id').generatedAlwaysAsIdentity().primaryKey(),
    eventType: text('event_type').notNull(),
    sessionId: text('session_id'),
    jobId: text('job_id'),
    runId: text('run_id'),
    triggerId: text('trigger_id'),
    correlationId: text('correlation_id'),
    actor: text('actor').notNull().default('runtime'),
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    createdAtIdx: index('idx_control_events_created_at').on(
      table.createdAt,
      table.eventId,
    ),
    sessionCreatedIdx: index('idx_control_events_session_created').on(
      table.sessionId,
      table.createdAt,
      table.eventId,
    ),
    sessionEventIdx: index('idx_control_events_session_event').on(
      table.sessionId,
      table.eventId,
    ),
    triggerIdx: index('idx_control_events_trigger').on(table.triggerId),
    runIdx: index('idx_control_events_run').on(table.runId),
    jobIdx: index('idx_control_events_job').on(table.jobId),
  }),
);

export const appResponseRoutesPostgres = pgTable(
  'app_response_routes',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => appSessionsPostgres.sessionId, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull().default(''),
    responseMode: text('response_mode').notNull(),
    webhookId: text('webhook_id'),
    correlationId: text('correlation_id'),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.threadId] }),
  }),
);

export const jobTriggersPostgres = pgTable(
  'job_triggers',
  {
    triggerId: text('trigger_id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    requestedAt: timestamp('requested_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    requestedBy: text('requested_by').notNull().default('sdk'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    jobRequestedIdx: index('idx_job_triggers_job_requested').on(
      table.jobId,
      table.requestedAt,
    ),
    runIdx: index('idx_job_triggers_run').on(table.runId),
  }),
);

export const webhookRegistrationsPostgres = pgTable(
  'webhook_registrations',
  {
    webhookId: text('webhook_id').primaryKey(),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    appNameIdx: uniqueIndex('idx_webhook_registrations_app_name').on(
      table.appId,
      table.name,
    ),
  }),
);

export const webhookDeliveriesPostgres = pgTable(
  'webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhookRegistrationsPostgres.webhookId, {
        onDelete: 'cascade',
      }),
    eventId: integer('event_id')
      .notNull()
      .references(() => controlEventsPostgres.eventId, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    lastAttemptAt: timestamp('last_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }),
    deliveredAt: timestamp('delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    webhookEventIdx: uniqueIndex('idx_webhook_deliveries_webhook_event').on(
      table.webhookId,
      table.eventId,
    ),
    dueIdx: index('idx_webhook_deliveries_due').on(
      table.status,
      table.nextAttemptAt,
    ),
  }),
);

export const registeredGroupsPostgres = pgTable('registered_groups', {
  jid: text('jid').primaryKey(),
  name: text('name').notNull(),
  folder: text('folder').notNull().unique(),
  triggerPattern: text('trigger_pattern').notNull(),
  addedAt: text('added_at').notNull(),
  containerConfig: text('container_config'),
  requiresTrigger: boolean('requires_trigger').default(true),
  isMain: boolean('is_main').default(false),
});
