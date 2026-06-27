import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

/**
 * Per-conversation proactive-surfacing opt-in keyed on the normalized subject
 * tuple; `conversation_jid` is audit-only.
 */
export const proactiveSurfacingOptInsPostgres = pgTable(
  'proactive_surfacing_opt_ins',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    conversationJid: text('conversation_jid'),
    proactiveSurfacingEnabled: boolean('proactive_surfacing_enabled')
      .notNull()
      .default(false),
    enabledAt: timestamp('enabled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    optedOutAt: timestamp('opted_out_at', {
      withTimezone: true,
      mode: 'string',
    }),
    enabledByActorId: text('enabled_by_actor_id'),
    optedOutByActorId: text('opted_out_by_actor_id'),
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
    subjectUnique: uniqueIndex('proactive_surfacing_opt_ins_subject_unique').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
    ),
  }),
);
