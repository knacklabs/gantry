import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { providerAccountsPostgres } from './providers.js';

export const groupJoinOnboardingPostgres = pgTable(
  'group_join_onboarding',
  {
    id: text('id').primaryKey(),
    providerAccountId: text('provider_account')
      .notNull()
      .references(() => providerAccountsPostgres.id, { onDelete: 'cascade' }),
    chatJid: text('chat_jid').notNull(),
    status: text('status').notNull().default('prompted'),
    adder: text('adder').notNull(),
    approver: text('approver').notNull(),
    promptConversationJid: text('prompt_conversation_jid').notNull(),
    promptAgentFolder: text('prompt_agent_folder').notNull(),
    promptedAt: timestamp('prompted_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    dismissedAt: timestamp('dismissed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    registeredAt: timestamp('registered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'string' }),
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
    providerChatUnique: uniqueIndex(
      'group_join_onboarding_provider_chat_unique',
    ).on(table.providerAccountId, table.chatJid),
    statusIdx: index('idx_group_join_onboarding_status').on(table.status),
    statusCheck: check(
      'group_join_onboarding_status_check',
      sql`${table.status} IN ('prompted', 'dismissed', 'registered')`,
    ),
  }),
);
