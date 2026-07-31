import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { conversationsPostgres } from './conversations.js';
import { providerAccountsPostgres } from './providers.js';

export const conversationHistoryCoveragePostgres = pgTable(
  'conversation_history_coverage',
  {
    providerAccountId: text('provider_account_id')
      .notNull()
      .references(() => providerAccountsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id'),
    complete: boolean('complete').notNull().default(false),
    coveredThroughExternalId: text('covered_through_external_id'),
    coveredThroughTimestamp: timestamp('covered_through_timestamp', {
      withTimezone: true,
      mode: 'string',
    }),
    providerGeneration: bigint('provider_generation', {
      mode: 'number',
    }).notNull(),
    recordedAt: timestamp('recorded_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    scopeUnique: unique('uniq_conversation_history_coverage_scope')
      .on(
        table.providerAccountId,
        table.conversationId,
        table.scopeKind,
        table.scopeId,
      )
      .nullsNotDistinct(),
    scopeCheck: check(
      'conversation_history_coverage_scope_check',
      sql`(${table.scopeKind} = 'channel' AND ${table.scopeId} IS NULL) OR (${table.scopeKind} = 'thread' AND ${table.scopeId} IS NOT NULL)`,
    ),
  }),
);
