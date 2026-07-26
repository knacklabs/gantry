import { sql } from 'drizzle-orm';
import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const observerDeliveriesPostgres = pgTable(
  'observer_deliveries',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    recipient: text('recipient').notNull(),
    localDay: date('local_day', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    conversationJid: text('conversation_jid'),
    providerAccountId: text('provider_account_id'),
    threadId: text('thread_id'),
    timezone: text('timezone'),
    renderedDigest: text('rendered_digest'),
    renderedView: jsonb('rendered_view'),
    contentHash: text('content_hash'),
    outboundDeliveryId: text('outbound_delivery_id'),
    state: text('state').notNull().default('reserved'),
    reservedAt: timestamp('reserved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    sentAt: timestamp('sent_at', {
      withTimezone: true,
      mode: 'string',
    }),
    settledAt: timestamp('settled_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    recipientDayUnique: uniqueIndex(
      'observer_deliveries_app_recipient_day_unique',
    ).on(table.appId, table.recipient, table.localDay),
    stateCheck: check(
      'observer_deliveries_state_check',
      sql`${table.state} IN ('reserved', 'sent', 'settled', 'failed')`,
    ),
  }),
);

export const observerDeliveryInsightsPostgres = pgTable(
  'observer_delivery_insights',
  {
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => observerDeliveriesPostgres.id, { onDelete: 'cascade' }),
    insightId: text('insight_id')
      .notNull()
      .references(() => proactiveInsightsPostgres.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    position: integer('position').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.deliveryId, table.insightId],
      name: 'observer_delivery_insights_pk',
    }),
    insightIdx: index('idx_observer_delivery_insights_insight').on(
      table.insightId,
    ),
  }),
);

export const observerInsightCursorsPostgres = pgTable(
  'observer_insight_cursors',
  {
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    cursorUpdatedAt: timestamp('cursor_updated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    cursorPageId: text('cursor_page_id'),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.appId, table.subject],
      name: 'observer_insight_cursors_pk',
    }),
    completeCursorCheck: check(
      'observer_insight_cursors_complete_cursor_check',
      sql`(${table.cursorUpdatedAt} IS NULL) = (${table.cursorPageId} IS NULL)`,
    ),
  }),
);

export const proactiveInsightsPostgres = pgTable(
  'proactive_insights',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    insightType: text('insight_type').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    evidenceRefs: jsonb('evidence_refs')
      .notNull()
      .default(sql`'[]'::jsonb`),
    batchSnapshotAt: timestamp('batch_snapshot_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    evidenceVersion: integer('evidence_version').notNull(),
    canonicalSignature: text('canonical_signature').notNull(),
    signatureEmbeddingRef: text('signature_embedding_ref'),
    confidence: doublePrecision('confidence').notNull(),
    priorityScore: doublePrecision('priority_score').notNull(),
    state: text('state').notNull().default('pending'),
    cooldownUntil: timestamp('cooldown_until', {
      withTimezone: true,
      mode: 'string',
    }),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    surfacedAt: timestamp('surfaced_at', {
      withTimezone: true,
      mode: 'string',
    }),
    recipient: text('recipient').notNull(),
    deliveryId: text('delivery_id').references(
      () => observerDeliveriesPostgres.id,
      { onDelete: 'set null' },
    ),
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
    queueIdx: index('idx_proactive_insights_queue').on(
      table.appId,
      table.subject,
      table.state,
      table.priorityScore.desc(),
      table.createdAt,
    ),
    signatureIdx: uniqueIndex('idx_proactive_insights_app_signature')
      .on(table.appId, table.canonicalSignature)
      .where(sql`${table.state} IN ('pending', 'claimed', 'sent', 'cooldown')`),
    insightTypeCheck: check(
      'proactive_insights_insight_type_check',
      sql`${table.insightType} IN ('commitment', 'contradiction', 'open_question', 'stale_fact', 'decision_without_owner', 'duplicated_work', 'repetition')`,
    ),
    stateCheck: check(
      'proactive_insights_state_check',
      sql`${table.state} IN ('pending', 'claimed', 'sent', 'cooldown', 'resolved', 'dropped')`,
    ),
    evidenceVersionCheck: check(
      'proactive_insights_evidence_version_check',
      sql`${table.evidenceVersion} > 0`,
    ),
    confidenceCheck: check(
      'proactive_insights_confidence_check',
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  }),
);

// Owner feedback on delivered insights. The unique (insight, actor, action)
// index is the idempotency key: channel retries of the same button click
// can't double-count a negative signal or re-drop an insight.
export const observerInsightFeedbackPostgres = pgTable(
  'observer_insight_feedback',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    recipient: text('recipient').notNull(),
    insightId: text('insight_id')
      .notNull()
      .references(() => proactiveInsightsPostgres.id, { onDelete: 'cascade' }),
    deliveryId: text('delivery_id').references(
      () => observerDeliveriesPostgres.id,
      { onDelete: 'set null' },
    ),
    actorUserId: text('actor_user_id').notNull(),
    insightType: text('insight_type').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    insightActorActionUnique: uniqueIndex(
      'observer_insight_feedback_insight_actor_action_unique',
    ).on(table.insightId, table.actorUserId, table.action),
    actionCheck: check(
      'observer_insight_feedback_action_check',
      sql`${table.action} IN ('resolve', 'dismiss', 'snooze', 'less_like_this')`,
    ),
  }),
);

// Time-boxed per-type suppression: once negative feedback for an (app,
// recipient, insight_type) crosses the caller's threshold, suppressed_until
// holds the auto-expiry after which the type surfaces again.
export const observerInsightTypeSuppressionsPostgres = pgTable(
  'observer_insight_type_suppressions',
  {
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    recipient: text('recipient').notNull(),
    insightType: text('insight_type').notNull(),
    negativeCount: integer('negative_count').notNull().default(0),
    suppressedUntil: timestamp('suppressed_until', {
      withTimezone: true,
      mode: 'string',
    }),
    lastFeedbackAt: timestamp('last_feedback_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.appId, table.recipient, table.insightType],
      name: 'observer_insight_type_suppressions_pk',
    }),
  }),
);
