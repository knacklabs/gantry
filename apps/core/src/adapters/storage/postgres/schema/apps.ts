import { sql } from 'drizzle-orm';
import {
  integer,
  index,
  jsonb,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const appsPostgres = pgTable('apps', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const usersPostgres = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('human'),
    displayName: text('display_name'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appScopedIdentity: uniqueIndex('uniq_users_app_id_id').on(
      table.appId,
      table.id,
    ),
    peoplePageIdx: index('idx_users_app_updated_id').on(
      table.appId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
  }),
);

export const userAliasesPostgres = pgTable(
  'user_aliases',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id'),
    externalUserId: text('external_user_id').notNull(),
    displayName: text('display_name'),
    verificationStatus: text('verification_status')
      .notNull()
      .default('unverified'),
    verifiedAt: timestamp('verified_at', {
      withTimezone: true,
      mode: 'string',
    }),
    verifiedBy: text('verified_by'),
    retiredAt: timestamp('retired_at', {
      withTimezone: true,
      mode: 'string',
    }),
    retiredBy: text('retired_by'),
    evidenceJson: jsonb('evidence_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appScopedPerson: foreignKey({
      name: 'user_aliases_app_user_fk',
      columns: [table.appId, table.userId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }),
    personUpdatedIdx: index('idx_user_aliases_app_user_updated').on(
      table.appId,
      table.userId,
      table.updatedAt.desc(),
    ),
    providerAliasUnique: uniqueIndex(
      'idx_user_aliases_active_provider_external',
    )
      .on(
        table.appId,
        table.provider,
        sql`COALESCE(${table.providerAccountId}, '')`,
        table.externalUserId,
      )
      .where(sql`${table.retiredAt} IS NULL`),
    retiredProviderAliasIdx: index('idx_user_aliases_retired_provider_external')
      .on(
        table.appId,
        table.provider,
        sql`COALESCE(${table.providerAccountId}, '')`,
        table.externalUserId,
        table.updatedAt.desc(),
      )
      .where(sql`${table.retiredAt} IS NOT NULL`),
  }),
);

export const personMergeAuditPostgres = pgTable(
  'person_merge_audit',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    sourcePersonId: text('source_person_id').notNull(),
    targetPersonId: text('target_person_id').notNull(),
    actor: text('actor').notNull(),
    conflictResolution: text('conflict_resolution').notNull(),
    aliasesMoved: integer('aliases_moved').notNull().default(0),
    memoryRowsMoved: integer('memory_rows_moved').notNull().default(0),
    conflictsJson: jsonb('conflicts_json')
      .notNull()
      .default(sql`'[]'::jsonb`),
    resultJson: jsonb('result_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex('idx_person_merge_audit_app_idempotency').on(
      table.appId,
      table.idempotencyKey,
    ),
    sourcePersonAppScoped: foreignKey({
      name: 'person_merge_audit_app_source_person_fk',
      columns: [table.appId, table.sourcePersonId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }),
    targetPersonAppScoped: foreignKey({
      name: 'person_merge_audit_app_target_person_fk',
      columns: [table.appId, table.targetPersonId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }),
  }),
);
