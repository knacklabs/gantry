import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { appsPostgres } from './apps.js';

export const pendingAccessRequestsPostgres = pgTable(
  'pending_access_requests',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    targetJson: text('target_json').notNull(),
    // status is application-constrained to: pending | approved | denied.
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    // A pending row only counts while expires_at is in the future, so a
    // crashed-mid-approval row drops out of the count with no sweeper.
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    pendingByAppIdx: index('idx_pending_access_requests_app_status').on(
      table.appId,
      table.status,
      table.expiresAt,
    ),
  }),
);
