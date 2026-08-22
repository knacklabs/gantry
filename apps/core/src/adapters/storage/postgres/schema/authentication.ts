import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres, usersPostgres } from './apps.js';

const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
};

export const localAuthorizationCodesPostgres = pgTable(
  'local_authorization_codes',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersPostgres.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    canonicalHost: text('canonical_host').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    ...auditColumns,
  },
  (table) => ({
    tokenUnique: uniqueIndex('local_authorization_codes_token_unique').on(
      table.tokenHash,
    ),
  }),
);

export const oidcTransactionsPostgres = pgTable('oidc_transactions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  stateHash: text('state_hash').notNull().unique(),
  nonceHash: text('nonce_hash').notNull(),
  encryptedPkceVerifier: text('encrypted_pkce_verifier').notNull(),
  oidcConfigJson: text('oidc_config_json'),
  configurationTest: boolean('configuration_test').notNull().default(false),
  invitationTokenHash: text('invitation_token_hash'),
  reauthenticateUserId: text('reauthenticate_user_id'),
  reauthenticateSessionHash: text('reauthenticate_session_hash'),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  ...auditColumns,
});

export const consoleAccessGrantsPostgres = pgTable(
  'console_access_grants',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersPostgres.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'),
    status: text('status').notNull().default('awaiting_approval'),
    accessReferenceHash: text('access_reference_hash'),
    accessReferenceExpiresAt: timestamp('access_reference_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    ...auditColumns,
  },
  (table) => ({
    appUserUnique: uniqueIndex('console_access_grants_app_user_unique').on(
      table.appId,
      table.userId,
    ),
    activeAdminIdx: index('console_access_grants_active_admin_idx').on(
      table.appId,
      table.status,
      table.role,
    ),
    accessReferenceUnique: uniqueIndex(
      'console_access_grants_access_reference_unique',
    )
      .on(table.accessReferenceHash)
      .where(sql`${table.accessReferenceHash} IS NOT NULL`),
    roleCheck: check(
      'console_access_grants_role_check',
      sql`${table.role} IN ('administrator', 'viewer')`,
    ),
    statusCheck: check(
      'console_access_grants_status_check',
      sql`${table.status} IN ('awaiting_approval', 'active', 'disabled')`,
    ),
  }),
);

export const browserSessionsPostgres = pgTable('browser_sessions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => usersPostgres.id, { onDelete: 'cascade' }),
  sessionHash: text('session_hash').notNull().unique(),
  csrfHash: text('csrf_hash').notNull(),
  idleExpiresAt: timestamp('idle_expires_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  reauthenticatedAt: timestamp('reauthenticated_at', {
    withTimezone: true,
    mode: 'string',
  }),
  ...auditColumns,
});

export const consoleInvitationsPostgres = pgTable(
  'console_invitations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    invitedEmail: text('invited_email').notNull(),
    role: text('role').notNull().default('viewer'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    ...auditColumns,
  },
  (table) => ({
    roleCheck: check(
      'console_invitations_role_check',
      sql`${table.role} IN ('administrator', 'viewer')`,
    ),
  }),
);
