import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres, usersPostgres } from './apps.js';

export const conversationsPostgres = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull(),
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
    providerAccountIdx: index('idx_conversations_provider_account').on(
      table.providerAccountId,
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
    provider: text('provider').notNull().default(''),
    providerAccountId: text('provider_account_id').notNull().default(''),
    userId: text('user_id').references(() => usersPostgres.id, {
      onDelete: 'cascade',
    }),
    externalUserId: text('external_user_id').notNull(),
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
    identityUnique: uniqueIndex('uniq_conversation_participants_identity').on(
      table.appId,
      table.conversationId,
      table.provider,
      table.providerAccountId,
      table.externalUserId,
    ),
    appScopedPerson: foreignKey({
      name: 'conversation_participants_app_user_fk',
      columns: [table.appId, table.userId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }),
  }),
);

export const conversationApproversPostgres = pgTable(
  'conversation_approvers',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    externalUserId: text('external_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_conversation_approvers_conversation').on(
      table.conversationId,
    ),
    userIdx: uniqueIndex('uniq_conversation_approvers_user').on(
      table.appId,
      table.conversationId,
      table.externalUserId,
    ),
  }),
);
