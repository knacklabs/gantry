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

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const onboardingDeploymentsPostgres = pgTable(
  'onboarding_deployments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'cascade',
    }),
    version: integer('version').notNull().default(1),
    state: text('state').notNull().default('setup_incomplete'),
    currentStep: integer('current_step').notNull().default(1),
    modelCandidateId: uuid('model_candidate_id'),
    providerAccountCandidateId: uuid('provider_account_candidate_id'),
    providerAccountId: text('provider_account_id'),
    conversationId: text('conversation_id'),
    approverPersonId: text('approver_person_id'),
    desiredStateRevision: integer('desired_state_revision'),
    readyAt: timestamp('ready_at', { withTimezone: true, mode: 'string' }),
    ...timestamps(),
  },
  (table) => ({
    userUnique: uniqueIndex('onboarding_deployments_app_user_uq').on(
      table.appId,
      table.userId,
    ),
    stateIdx: index('onboarding_deployments_state_idx').on(
      table.appId,
      table.state,
    ),
  }),
);

export const onboardingModelCandidatesPostgres = pgTable(
  'onboarding_model_candidates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    providerId: text('provider_id').notNull(),
    authMode: text('auth_mode').notNull(),
    modelAlias: text('model_alias'),
    routeId: text('route_id'),
    payloadEncrypted: text('payload_encrypted').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('staged'),
    checksJson: jsonb('checks_json').notNull().default([]),
    failureCode: text('failure_code'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    verifiedAt: timestamp('verified_at', {
      withTimezone: true,
      mode: 'string',
    }),
    verificationExpiresAt: timestamp('verification_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    ...timestamps(),
  },
  (table) => ({
    activeIdx: index('onboarding_model_candidates_active_idx').on(
      table.appId,
      table.userId,
      table.state,
    ),
  }),
);

export const onboardingProviderCandidatesPostgres = pgTable(
  'onboarding_provider_candidates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    payloadEncrypted: text('payload_encrypted').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('staged'),
    checksJson: jsonb('checks_json').notNull().default([]),
    externalIdentityJson: jsonb('external_identity_json'),
    failureCode: text('failure_code'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    verifiedAt: timestamp('verified_at', {
      withTimezone: true,
      mode: 'string',
    }),
    ...timestamps(),
  },
  (table) => ({
    activeIdx: index('onboarding_provider_candidates_active_idx').on(
      table.appId,
      table.userId,
      table.state,
    ),
  }),
);

export const onboardingVerificationAttemptsPostgres = pgTable(
  'onboarding_verification_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => onboardingDeploymentsPostgres.id, {
        onDelete: 'cascade',
      }),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    deploymentVersion: integer('deployment_version').notNull(),
    challengeHash: text('challenge_hash').notNull(),
    challengeText: text('challenge_text').notNull(),
    state: text('state').notNull().default('waiting_for_message'),
    inboundMessageId: text('inbound_message_id'),
    runId: text('run_id'),
    deliveryId: text('delivery_id'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    succeededAt: timestamp('succeeded_at', {
      withTimezone: true,
      mode: 'string',
    }),
    ...timestamps(),
  },
  (table) => ({
    activeDeployment: uniqueIndex('onboarding_attempts_active_deployment_uq')
      .on(table.deploymentId)
      .where(
        sql`${table.state} IN ('waiting_for_message', 'queued', 'running', 'awaiting_delivery')`,
      ),
    challenge: uniqueIndex('onboarding_attempts_challenge_hash_uq').on(
      table.appId,
      table.challengeHash,
    ),
  }),
);

export const onboardingOperationsPostgres = pgTable(
  'onboarding_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    replay: uniqueIndex('onboarding_operations_replay_uq').on(
      table.appId,
      table.userId,
      table.operation,
      table.idempotencyKey,
    ),
  }),
);

export const settingsRevisionReceiptsPostgres = pgTable(
  'settings_revision_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    failureCode: text('failure_code'),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    revision: uniqueIndex('settings_revision_receipts_app_revision_uq').on(
      table.appId,
      table.revision,
    ),
  }),
);
