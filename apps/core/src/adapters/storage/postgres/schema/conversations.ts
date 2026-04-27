import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { appsPostgres, usersPostgres } from './apps.js';

export const conversationsPostgres = pgTable(
  'channel_conversations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    channelInstallationId: text('channel_installation_id').notNull(),
    externalRefJson: text('external_ref_json'),
    kind: text('kind').notNull(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    installationIdx: index('idx_channel_conversations_installation').on(
      table.channelInstallationId,
    ),
  }),
);

export const conversationThreadsPostgres = pgTable(
  'conversation_threads',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    externalRefJson: text('external_ref_json'),
    title: text('title'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_conversation_threads_conversation').on(
      table.conversationId,
    ),
  }),
);

export const conversationParticipantsPostgres = pgTable(
  'conversation_participants',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => usersPostgres.id, {
      onDelete: 'cascade',
    }),
    externalUserId: text('external_user_id'),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_conversation_participants_conversation').on(
      table.conversationId,
      table.userId,
    ),
  }),
);
