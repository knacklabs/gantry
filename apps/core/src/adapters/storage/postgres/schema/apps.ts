import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
    appDisplayNameIdx: uniqueIndex('idx_users_app_display_name').on(
      table.appId,
      table.displayName,
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
    userId: text('user_id')
      .notNull()
      .references(() => usersPostgres.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id'),
    externalUserId: text('external_user_id').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerAliasUnique: uniqueIndex('idx_user_aliases_provider_external').on(
      table.appId,
      table.provider,
      table.providerAccountId,
      table.externalUserId,
    ),
  }),
);
