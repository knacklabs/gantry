import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appsPostgres } from './apps.js';
import { agentsPostgres } from './agents.js';

export const agentCreationDraftsPostgres = pgTable(
  'agent_creation_drafts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('draft'),
    currentStep: text('current_step').notNull().default('identity'),
    documentJson: jsonb('document_json').notNull().default({}),
    progressJson: jsonb('progress_json').notNull().default({}),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    jobId: text('job_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    appStatusUpdatedIdx: index(
      'idx_agent_creation_drafts_app_status_updated',
    ).on(table.appId, table.status, table.updatedAt.desc(), table.id.desc()),
    completedIdx: index('idx_agent_creation_drafts_completed').on(
      table.status,
      table.completedAt,
    ),
  }),
);
