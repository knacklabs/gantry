import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const externalIngressesPostgres = pgTable(
  'external_ingresses',
  {
    ingressId: text('ingress_id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    signatureAlgorithm: text('signature_algorithm')
      .notNull()
      .default('ed25519'),
    publicKey: text('public_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appNameUnique: unique('external_ingresses_app_id_name_key').on(
      table.appId,
      table.name,
    ),
    appEnabledIdx: index('idx_external_ingresses_app_enabled').on(
      table.appId,
      table.enabled,
    ),
  }),
);

export const externalIngressInvocationsPostgres = pgTable(
  'external_ingress_invocations',
  {
    invocationId: text('invocation_id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    ingressId: text('ingress_id')
      .notNull()
      .references(() => externalIngressesPostgres.ingressId, {
        onDelete: 'cascade',
      }),
    idempotencyKey: text('idempotency_key').notNull(),
    nonce: text('nonce').notNull(),
    requestMethod: text('request_method').notNull(),
    requestPath: text('request_path').notNull(),
    requestTimestamp: timestamp('request_timestamp', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    bodyHash: text('body_hash').notNull(),
    requestBody: text('request_body').notNull(),
    signature: text('signature').notNull(),
    status: text('status').notNull().default('pending'),
    responseJson: text('response_json'),
    error: text('error'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    idempotencyUnique: unique(
      'external_ingress_invocations_app_id_ingress_id_idempotency_key_key',
    ).on(table.appId, table.ingressId, table.idempotencyKey),
    appCreatedIdx: index('idx_external_ingress_invocations_app_created').on(
      table.appId,
      table.createdAt,
    ),
    ingressStatusCreatedIdx: index(
      'idx_external_ingress_invocations_ingress_status_created',
    ).on(table.ingressId, table.status, table.createdAt),
    expiresIdx: index('idx_external_ingress_invocations_expires').on(
      table.expiresAt,
    ),
  }),
);

export const externalIngressNoncesPostgres = pgTable(
  'external_ingress_nonces',
  {
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    ingressId: text('ingress_id')
      .notNull()
      .references(() => externalIngressesPostgres.ingressId, {
        onDelete: 'cascade',
      }),
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.appId, table.ingressId, table.nonce],
      name: 'external_ingress_nonces_pk',
    }),
    expiryIdx: index('idx_external_ingress_nonces_expiry').on(
      table.appId,
      table.ingressId,
      table.expiresAt,
    ),
    expiresOnlyIdx: index('idx_external_ingress_nonces_expires').on(
      table.expiresAt,
    ),
  }),
);
