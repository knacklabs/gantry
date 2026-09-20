import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { conversationsPostgres } from './conversations.js';
import { providerAccountsPostgres } from './providers.js';

export const conversationIngressCursorsPostgres = pgTable(
  'conversation_ingress_cursors',
  {
    providerAccountId: text('provider_account_id')
      .notNull()
      .references(() => providerAccountsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    coveredThroughExternalId: text('covered_through_external_id'),
    coveredThroughTimestamp: timestamp('covered_through_timestamp', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    primary: primaryKey({
      name: 'conversation_ingress_cursors_pkey',
      columns: [table.providerAccountId, table.conversationId],
    }),
  }),
);
