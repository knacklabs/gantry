import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres, usersPostgres } from './apps.js';

export const memoryItemsPostgres = pgTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    userId: text('user_id'),
    conversationId: text('conversation_id'),
    threadId: text('thread_id'),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    valueJson: jsonb('value_json').notNull(),
    confidence: doublePrecision('confidence').notNull().default(1),
    sourceRefJson: jsonb('source_ref_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('active'),
    lastObservedAt: timestamp('last_observed_at', {
      withTimezone: true,
      mode: 'string',
    }),
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
    activeSubjectKey: uniqueIndex('memory_items_active_unique')
      .on(
        table.appId,
        table.agentId,
        table.subjectType,
        table.subjectId,
        table.kind,
        table.key,
      )
      .where(sql`${table.status} = 'active'`),
    subjectUpdatedIdx: index('idx_memory_items_subject_updated').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.status,
      table.updatedAt.desc(),
    ),
    personStatusIdx: index('idx_memory_items_person_status_key')
      .on(
        table.appId,
        table.userId,
        table.status,
        table.agentId,
        table.kind,
        table.key,
      )
      .where(sql`${table.subjectType} = 'user'`),
    appScopedPerson: foreignKey({
      name: 'memory_items_app_user_fk',
      columns: [table.appId, table.userId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }),
    searchIdx: index('idx_memory_items_search').using(
      'gin',
      sql`to_tsvector('english', ${table.key} || ' ' || COALESCE(${table.valueJson}->>'value', '') || ' ' || COALESCE(${table.valueJson}->>'why', ''))`,
    ),
  }),
);
