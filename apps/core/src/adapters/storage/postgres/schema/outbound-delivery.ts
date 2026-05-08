import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { agentRunsPostgres } from './runs.js';

export const outboundDeliveriesPostgres = pgTable(
  'outbound_deliveries',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      { onDelete: 'cascade' },
    ),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    runId: text('run_id').references(() => agentRunsPostgres.id, {
      onDelete: 'set null',
    }),
    profileId: text('profile_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
    status: text('status').notNull(),
    settledAt: timestamp('settled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
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
    appIdempotencyUnique: unique(
      'outbound_deliveries_app_id_idempotency_key_key',
    ).on(table.appId, table.idempotencyKey),
    appStatusUpdatedIdx: index('idx_outbound_deliveries_app_status_updated').on(
      table.appId,
      table.status,
      table.updatedAt,
    ),
    appProfileStatusUpdatedIdx: index(
      'idx_outbound_deliveries_app_profile_status_updated',
    ).on(table.appId, table.profileId, table.status, table.updatedAt),
    conversationUpdatedIdx: index(
      'idx_outbound_deliveries_conversation_updated',
    ).on(table.conversationId, table.threadId, table.updatedAt),
  }),
);

export const outboundDeliveryFinalAnswersPostgres = pgTable(
  'outbound_delivery_final_answers',
  {
    deliveryId: text('delivery_id')
      .primaryKey()
      .references(() => outboundDeliveriesPostgres.id, { onDelete: 'cascade' }),
    canonicalText: text('canonical_text').notNull(),
    segmentCount: integer('segment_count').notNull(),
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
);

export const outboundDeliveryItemsPostgres = pgTable(
  'outbound_delivery_items',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => outboundDeliveriesPostgres.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    canonicalText: text('canonical_text').notNull(),
    providerPayloadJson: text('provider_payload_json'),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    claimToken: text('claim_token'),
    claimOwner: text('claim_owner'),
    claimExpiresAt: timestamp('claim_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    sentAt: timestamp('sent_at', {
      withTimezone: true,
      mode: 'string',
    }),
    failedAt: timestamp('failed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
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
    deliveryOrdinalUnique: unique(
      'outbound_delivery_items_delivery_id_ordinal_key',
    ).on(table.deliveryId, table.ordinal),
    claimDueIdx: index('idx_outbound_delivery_items_claim_due').on(
      table.status,
      table.nextAttemptAt,
      table.claimExpiresAt,
      table.createdAt,
    ),
    claimedExpiredIdx: index('idx_outbound_delivery_items_claimed_expired')
      .on(table.claimExpiresAt, table.updatedAt, table.id)
      .where(
        sql`${table.status} = 'claimed' AND ${table.claimExpiresAt} IS NOT NULL`,
      ),
    deliveryStatusIdx: index('idx_outbound_delivery_items_delivery_status').on(
      table.deliveryId,
      table.status,
      table.ordinal,
    ),
  }),
);

export const outboundDeliveryReceiptsPostgres = pgTable(
  'outbound_delivery_receipts',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => outboundDeliveriesPostgres.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => outboundDeliveryItemsPostgres.id, {
        onDelete: 'cascade',
      }),
    idempotencyKey: text('idempotency_key').notNull(),
    providerMessageId: text('provider_message_id'),
    providerPayloadJson: text('provider_payload_json'),
    sentAt: timestamp('sent_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    itemIdempotencyUnique: unique(
      'outbound_delivery_receipts_item_id_idempotency_key_key',
    ).on(table.itemId, table.idempotencyKey),
    deliverySentIdx: index('idx_outbound_delivery_receipts_delivery_sent').on(
      table.deliveryId,
      table.sentAt,
    ),
  }),
);
