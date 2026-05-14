import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appsPostgres } from './apps.js';
import { agentsPostgres } from './agents.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { agentRunsPostgres } from './runs.js';
import { agentSessionsPostgres } from './sessions.js';

export const runtimeEventsPostgres = pgTable(
  'runtime_events',
  {
    eventId: integer('event_id').generatedAlwaysAsIdentity().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    sessionId: text('session_id').references(() => agentSessionsPostgres.id, {
      onDelete: 'set null',
    }),
    runId: text('run_id').references(() => agentRunsPostgres.id, {
      onDelete: 'cascade',
    }),
    jobId: text('job_id'),
    triggerId: text('trigger_id'),
    conversationId: text('conversation_id').references(
      () => conversationsPostgres.id,
      { onDelete: 'set null' },
    ),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      { onDelete: 'set null' },
    ),
    eventType: text('event_type').notNull(),
    actor: text('actor').notNull(),
    correlationId: text('correlation_id'),
    responseMode: text('response_mode'),
    webhookId: text('webhook_id'),
    payloadJson: text('payload_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appCursorIdx: index('idx_runtime_events_app_cursor').on(
      table.appId,
      table.eventId,
    ),
    sessionCursorIdx: index('idx_runtime_events_session_cursor').on(
      table.appId,
      table.sessionId,
      table.eventId,
    ),
    runCursorIdx: index('idx_runtime_events_run_cursor').on(
      table.appId,
      table.runId,
      table.eventId,
    ),
    jobCursorIdx: index('idx_runtime_events_job_cursor').on(
      table.appId,
      table.jobId,
      table.eventId,
    ),
    triggerCursorIdx: index('idx_runtime_events_trigger_cursor').on(
      table.appId,
      table.triggerId,
      table.eventId,
    ),
    conversationThreadCursorIdx: index(
      'idx_runtime_events_conversation_thread_cursor',
    ).on(table.appId, table.conversationId, table.threadId, table.eventId),
    eventTypeCursorIdx: index('idx_runtime_events_type_cursor').on(
      table.appId,
      table.eventType,
      table.eventId,
    ),
    webhookProjectionIdx: index('idx_runtime_events_webhook_projection').on(
      table.appId,
      table.webhookId,
      table.responseMode,
      table.eventId,
    ),
  }),
);

export const eventBusOutboxPostgres = pgTable(
  'event_bus_outbox',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    source: text('source').notNull(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runtimeEventId: integer('runtime_event_id').references(
      () => runtimeEventsPostgres.eventId,
      { onDelete: 'cascade' },
    ),
    correlationId: text('correlation_id'),
    payloadJson: text('payload_json').notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runtimeEventUnique: unique('event_bus_outbox_runtime_event_id_key').on(
      table.runtimeEventId,
    ),
    claimDueIdx: index('idx_event_bus_outbox_claim_due').on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    appEventIdx: index('idx_event_bus_outbox_app_event').on(
      table.appId,
      table.eventType,
      table.occurredAt,
    ),
    runtimeEventIdx: index('idx_event_bus_outbox_runtime_event').on(
      table.runtimeEventId,
    ),
    pendingRuntimeEventIdx: index('idx_event_bus_outbox_pending_runtime_event')
      .on(table.runtimeEventId)
      .where(sql`${table.runtimeEventId} IS NOT NULL`),
  }),
);
