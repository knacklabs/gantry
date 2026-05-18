import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const capabilitySecretsPostgres = pgTable(
  'capability_secrets',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    allowedCapabilityIdsJson: text('allowed_capability_ids_json')
      .notNull()
      .default('[]'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appNameUnique: uniqueIndex('idx_capability_secrets_app_name').on(
      table.appId,
      table.name,
    ),
    appUpdatedIdx: index('idx_capability_secrets_app_updated').on(
      table.appId,
      table.updatedAt,
    ),
  }),
);
