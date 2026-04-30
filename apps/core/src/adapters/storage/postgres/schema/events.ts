import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
