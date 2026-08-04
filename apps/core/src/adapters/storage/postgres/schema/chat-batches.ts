import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const chatBatchesPostgres = pgTable(
  'chat_batches',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    correlationId: text('gantry_batch_correlation_id').notNull(),
    contentHash: text('content_hash').notNull(),
    state: text('state').notNull().default('submission_intent'),
    providerBatchId: text('provider_batch_id'),
    requestSnapshot: jsonb('request_snapshot').notNull(),
    resultSnapshot: jsonb('result_snapshot'),
    requestCount: integer('request_count').notNull(),
    snapshotBytes: integer('snapshot_bytes').notNull(),
    reservedCostUsd: doublePrecision('reserved_cost_usd').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    estimatedCostUsd: doublePrecision('estimated_cost_usd'),
    submitAttempts: integer('submit_attempts').notNull().default(0),
    pollAttempts: integer('poll_attempts').notNull().default(0),
    resultAttempts: integer('result_attempts').notNull().default(0),
    attentionRequired: boolean('attention_required').notNull().default(false),
    lastError: text('last_error'),
    submittedAt: timestamp('submitted_at', {
      withTimezone: true,
      mode: 'string',
    }),
    appliedAt: timestamp('applied_at', {
      withTimezone: true,
      mode: 'string',
    }),
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
    correlationUnique: uniqueIndex('chat_batches_correlation_unique').on(
      table.appId,
      table.providerId,
      table.correlationId,
    ),
    providerBatchUnique: uniqueIndex('chat_batches_provider_batch_unique')
      .on(table.appId, table.providerId, table.providerBatchId)
      .where(sql`${table.providerBatchId} IS NOT NULL`),
    recoveryIdx: index('idx_chat_batches_recovery').on(
      table.state,
      table.createdAt,
    ),
    appCreatedIdx: index('idx_chat_batches_app_created').on(
      table.appId,
      table.createdAt,
    ),
    stateCheck: check(
      'chat_batches_state_check',
      sql`${table.state} IN ('submission_intent', 'preflight_failed', 'submission_unknown', 'submitted', 'processing', 'applied', 'failed', 'abandoned')`,
    ),
    contentHashCheck: check(
      'chat_batches_content_hash_check',
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    countCheck: check(
      'chat_batches_count_check',
      sql`${table.requestCount} > 0 AND ${table.snapshotBytes} > 0`,
    ),
    accountingCheck: check(
      'chat_batches_accounting_check',
      sql`${table.reservedCostUsd} >= 0 AND ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.cacheReadTokens} >= 0 AND ${table.cacheWriteTokens} >= 0 AND (${table.estimatedCostUsd} IS NULL OR ${table.estimatedCostUsd} >= 0)`,
    ),
  }),
);
