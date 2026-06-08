import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const modelCredentialsPostgres = pgTable(
  'model_credentials',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    authMode: text('auth_mode').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payloadEncrypted: text('payload_encrypted').notNull(),
    fingerprint: text('fingerprint').notNull(),
    fieldFingerprintsJson: text('field_fingerprints_json').notNull(),
    status: text('status').notNull().default('active'),
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
    appProviderUnique: uniqueIndex('idx_model_credentials_app_provider').on(
      table.appId,
      table.providerId,
    ),
    appUpdatedIdx: index('idx_model_credentials_app_updated').on(
      table.appId,
      table.updatedAt,
    ),
  }),
);
