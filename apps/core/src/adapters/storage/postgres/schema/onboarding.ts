import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { messagesPostgres } from './messages.js';
import { providerAccountsPostgres } from './providers.js';

export const onboardingSetupsPostgres = pgTable(
  'onboarding_setups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    desiredStateRevision: integer('desired_state_revision').notNull(),
    progressJson: jsonb('progress_json').notNull().default({}),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    app: uniqueIndex('onboarding_setups_app_unique').on(table.appId),
    agent: uniqueIndex('onboarding_setups_agent_unique').on(table.agentId),
    idempotency: uniqueIndex('onboarding_setups_app_idempotency_unique').on(
      table.appId,
      table.idempotencyKey,
    ),
  }),
);

export const onboardingVerificationsPostgres = pgTable(
  'onboarding_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    setupId: uuid('setup_id')
      .notNull()
      .references(() => onboardingSetupsPostgres.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id')
      .notNull()
      .references(() => providerAccountsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
    ),
    challenge: text('challenge').notNull(),
    status: text('status').notNull().default('pending'),
    inboundMessageId: text('inbound_message_id').references(
      () => messagesPostgres.id,
      { onDelete: 'set null' },
    ),
    outboundMessageId: text('outbound_message_id').references(
      () => messagesPostgres.id,
      { onDelete: 'set null' },
    ),
    onboardingRunId: text('onboarding_run_id'),
    projectionFailureCode: text('projection_failure_code'),
    satisfiedAt: timestamp('satisfied_at', {
      withTimezone: true,
      mode: 'string',
    }),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    activeChallenge: uniqueIndex(
      'onboarding_verifications_active_challenge_unique',
    )
      .on(table.appId, table.challenge)
      .where(
        sql`${table.status} IN ('pending', 'inbound_received', 'satisfied', 'projection_failed')`,
      ),
    activeConversation: uniqueIndex(
      'onboarding_verifications_active_conversation_unique',
    )
      .on(table.appId, table.conversationId)
      .where(
        sql`${table.status} IN ('pending', 'inbound_received', 'satisfied', 'projection_failed')`,
      ),
    conversationStatus: index(
      'idx_onboarding_verifications_conversation_status',
    ).on(table.conversationId, table.status),
    expiry: index('idx_onboarding_verifications_expiry').on(
      table.status,
      table.expiresAt,
    ),
    correlation: index('idx_onboarding_verifications_correlation').on(
      table.providerAccountId,
      table.conversationId,
      table.threadId,
      table.status,
    ),
  }),
);
