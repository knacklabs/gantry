import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const agentSetupDraftsPostgres = pgTable('agent_setup_drafts', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  purpose: text('purpose'),
  modelAlias: text('model_alias'),
  connectionJson: jsonb('connection_json'),
  conversationJson: jsonb('conversation_json'),
  currentStage: text('current_stage').notNull().default('agent'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});
