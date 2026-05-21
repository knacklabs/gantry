import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const externalPlatformEventsPostgres = pgTable(
  'external_platform_events',
  {
    eventId: text('event_id').primaryKey(),
    integrationId: text('integration_id').notNull(),
    eventType: text('event_type').notNull(),
    targetJid: text('target_jid'),
    status: text('status').notNull(),
    payloadJson: text('payload_json').notNull(),
    responseJson: text('response_json'),
    error: text('error'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }),
    deliveredAt: timestamp('delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    statusIdx: index('idx_external_platform_events_status').on(
      table.status,
      table.updatedAt,
    ),
    targetIdx: index('idx_external_platform_events_target').on(
      table.targetJid,
      table.updatedAt,
    ),
    nextAttemptIdx: index('idx_external_platform_events_next_attempt').on(
      table.status,
      table.nextAttemptAt,
    ),
  }),
);

export const externalPlatformCardActionsPostgres = pgTable(
  'external_platform_card_actions',
  {
    nonce: text('nonce').primaryKey(),
    integrationId: text('integration_id').notNull(),
    eventId: text('event_id').notNull(),
    actionType: text('action_type').notNull(),
    actorId: text('actor_id').notNull(),
    sourceChannelId: text('source_channel_id').notNull(),
    status: text('status').notNull(),
    error: text('error'),
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
    eventIdx: index('idx_external_platform_card_actions_event').on(
      table.eventId,
      table.createdAt,
    ),
  }),
);
