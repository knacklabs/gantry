import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const runtimeEventsPostgres = pgTable('runtime_events', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  actorId: text('actor_id'),
  payloadJson: text('payload_json').notNull(),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
});
