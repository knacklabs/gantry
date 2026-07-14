import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import { conversationsPostgres } from './conversations.js';
import { runtimeEventsPostgres } from './events.js';
import { agentSessionsPostgres } from './sessions.js';

export const controlHttpSessionsPostgres = pgTable(
  'control_http_sessions',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => agentSessionsPostgres.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    externalConversationId: text('external_conversation_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    defaultResponseMode: text('default_response_mode').notNull().default('sse'),
    defaultWebhookId: text('default_webhook_id'),
    externalRefJson: jsonb('external_ref_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    appConversationUnique: unique(
      'control_http_sessions_app_id_external_conversation_id_key',
    ).on(table.appId, table.externalConversationId),
    chatJidIdx: index('idx_control_http_sessions_chat_jid').on(
      sql`(${table.externalRefJson}->>'chatJid')`,
    ),
  }),
);

export const controlHttpResponseRoutesPostgres = pgTable(
  'control_http_response_routes',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => controlHttpSessionsPostgres.sessionId, {
        onDelete: 'cascade',
      }),
    threadId: text('thread_id').notNull().default(''),
    responseMode: text('response_mode').notNull(),
    webhookId: text('webhook_id'),
    correlationId: text('correlation_id'),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.threadId] }),
  }),
);

export const controlHttpWebhooksPostgres = pgTable(
  'control_http_webhooks',
  {
    webhookId: text('webhook_id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    eventTypes: text('event_types').array(),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    jobId: text('job_id'),
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
    appNameUnique: unique('control_http_webhooks_app_id_name_key').on(
      table.appId,
      table.name,
    ),
    subscriptionAppIdx: index('idx_control_http_webhooks_subscription_app')
      .on(table.appId, table.enabled)
      .where(sql`${table.eventTypes} IS NOT NULL`),
  }),
);

export const controlHttpWebhookDeliveriesPostgres = pgTable(
  'control_http_webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => controlHttpWebhooksPostgres.webhookId, {
        onDelete: 'cascade',
      }),
    eventId: integer('event_id')
      .notNull()
      .references(() => runtimeEventsPostgres.eventId, {
        onDelete: 'cascade',
      }),
    status: text('status').notNull(),
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
    webhookEventUnique: unique(
      'control_http_webhook_deliveries_webhook_id_event_id_key',
    ).on(table.webhookId, table.eventId),
    dueIdx: index('idx_control_http_webhook_deliveries_due').on(
      table.status,
      table.nextAttemptAt,
    ),
  }),
);
