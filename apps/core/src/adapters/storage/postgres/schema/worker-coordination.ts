import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { agentRunsPostgres } from './runs.js';

export const workerInstancesPostgres = pgTable(
  'worker_instances',
  {
    id: text('id').primaryKey(),
    imageDigest: text('image_digest'),
    bootNonce: text('boot_nonce').notNull(),
    version: text('version'),
    capabilitiesJson: jsonb('capabilities_json')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // process_role is application-constrained to:
    // all | control | live-worker | job-worker.
    processRole: text('process_role').notNull().default('all'),
    // status is application-constrained to:
    // starting | healthy | unhealthy | draining | stopped.
    status: text('status').notNull().default('starting'),
    heartbeatAt: timestamp('heartbeat_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    lastSeenAt: timestamp('last_seen_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    statusHeartbeatIdx: index('idx_worker_instances_status_heartbeat').on(
      table.status,
      table.heartbeatAt,
    ),
  }),
);

export const runLeasesPostgres = pgTable(
  'run_leases',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    workerInstanceId: text('worker_instance_id')
      .notNull()
      .references(() => workerInstancesPostgres.id),
    leaseToken: text('lease_token').notNull(),
    // Monotonic per run. A recovered run is reclaimed at a strictly higher
    // fencing version; the old worker's (token, version) can never match again.
    fencingVersion: integer('fencing_version').notNull(),
    // status is application-constrained to:
    // active | expired | released | completed | failed.
    status: text('status').notNull().default('active'),
    claimedAt: timestamp('claimed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.runId, table.fencingVersion],
      name: 'run_leases_pk',
    }),
    leaseTokenUnique: uniqueIndex('uq_run_leases_lease_token').on(
      table.leaseToken,
    ),
    activeRunUnique: uniqueIndex('uq_run_leases_active_run')
      .on(table.runId)
      .where(sql`${table.status} = 'active'`),
    activeJobUnique: uniqueIndex('uq_run_leases_active_job')
      .on(table.jobId)
      .where(sql`${table.status} = 'active' AND ${table.jobId} IS NOT NULL`),
    statusExpiresIdx: index('idx_run_leases_status_expires').on(
      table.status,
      table.expiresAt,
    ),
    workerIdx: index('idx_run_leases_worker').on(
      table.workerInstanceId,
      table.status,
    ),
  }),
);

export const runSlotsPostgres = pgTable(
  'run_slots',
  {
    slotKey: text('slot_key').notNull(),
    holderId: text('holder_id').notNull(),
    runId: text('run_id'),
    workerInstanceId: text('worker_instance_id'),
    acquiredAt: timestamp('acquired_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    // Expired slot rows are reclaimable by any worker; a crashed holder can
    // never permanently pin a slot.
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.slotKey, table.holderId],
      name: 'run_slots_pk',
    }),
    expiresIdx: index('idx_run_slots_expires').on(table.expiresAt),
  }),
);

export const permissionPromptsPostgres = pgTable(
  'permission_prompts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    sourceAgentFolder: text('source_agent_folder').notNull(),
    interactionId: text('interaction_id').notNull(),
    // match_kind is application-constrained to: individual | batch.
    matchKind: text('match_kind').notNull(),
    memberCount: integer('member_count').notNull(),
    renderedDecisionOptionsJson: jsonb(
      'rendered_decision_options_json',
    ).notNull(),
    renderedRequestJson: jsonb('rendered_request_json').notNull(),
    targetJid: text('target_jid'),
    approvalContextJid: text('approval_context_jid'),
    threadId: text('thread_id'),
    decisionPolicy: text('decision_policy'),
    fullViewJson: jsonb('full_view_json'),
    externalPromptProvider: text('external_prompt_provider'),
    externalPromptConversationId: text('external_prompt_conversation_id'),
    externalPromptMessageId: text('external_prompt_message_id'),
    externalPromptThreadId: text('external_prompt_thread_id'),
    providerAliases: text('provider_aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    claimId: text('claim_id'),
    claimMode: text('claim_mode'),
    claimApproverRef: text('claim_approver_ref'),
    claimedAt: timestamp('claimed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    // settlement_state is application-constrained to:
    // open | claimed | settled | review_each_expired | superseded.
    settlementState: text('settlement_state').notNull().default('open'),
    settledAt: timestamp('settled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    canonicalBatchId: text('canonical_batch_id'),
    parentEnvelopeId: text('parent_envelope_id').references(
      (): AnyPgColumn => permissionPromptsPostgres.id,
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
    scopeIdx: index('idx_permission_prompts_scope').on(
      table.appId,
      table.sourceAgentFolder,
      table.interactionId,
      table.settlementState,
    ),
    promptMessageIdx: index('idx_permission_prompts_message').on(
      table.appId,
      table.externalPromptProvider,
      table.externalPromptConversationId,
      table.externalPromptMessageId,
      table.externalPromptThreadId,
    ),
    parentEnvelopeIdx: index('idx_permission_prompts_parent').on(
      table.parentEnvelopeId,
    ),
  }),
);

export const pendingInteractionsPostgres = pgTable(
  'pending_interactions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRunsPostgres.id, {
      onDelete: 'set null',
    }),
    envelopeId: text('envelope_id').references(
      () => permissionPromptsPostgres.id,
    ),
    memberIndex: integer('member_index'),
    sourceAgentFolder: text('source_agent_folder'),
    requestId: text('request_id'),
    runLeaseToken: text('run_lease_token'),
    runLeaseFencingVersion: integer('run_lease_fencing_version'),
    // kind is application-constrained to: permission | question.
    kind: text('kind').notNull(),
    // status is application-constrained to:
    // pending | resolved | expired | cancelled.
    status: text('status').notNull().default('pending'),
    payloadJson: jsonb('payload_json').notNull(),
    callbackRouteJson: jsonb('callback_route_json'),
    idempotencyKey: text('idempotency_key').notNull(),
    approverRef: text('approver_ref'),
    resolutionJson: jsonb('resolution_json'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex('uq_pending_interactions_idempotency').on(
      table.idempotencyKey,
    ),
    appStatusIdx: index('idx_pending_interactions_app_status').on(
      table.appId,
      table.status,
      table.expiresAt,
    ),
    runStatusIdx: index('idx_pending_interactions_run').on(
      table.runId,
      table.status,
    ),
    requestLookupIdx: index('idx_pending_interactions_request_lookup').on(
      table.appId,
      table.kind,
      table.sourceAgentFolder,
      table.requestId,
      table.status,
      table.expiresAt,
    ),
    envelopeMemberUnique: uniqueIndex(
      'uq_pending_interactions_envelope_member',
    ).on(table.envelopeId, table.memberIndex),
    envelopeRequestUnique: uniqueIndex(
      'uq_pending_interactions_envelope_request',
    ).on(table.envelopeId, table.requestId),
    envelopeStatusIdx: index('idx_pending_interactions_envelope_status').on(
      table.envelopeId,
      table.status,
      table.expiresAt,
    ),
  }),
);

export const runnerControlEventsPostgres = pgTable(
  'runner_control_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    workerInstanceId: text('worker_instance_id').notNull(),
    fencingVersion: integer('fencing_version').notNull(),
    // event_type is application-constrained to: claimed | heartbeat | output |
    // log | terminal_state | permission_requested | question_requested |
    // permission_resolved | stop | completed | failed.
    eventType: text('event_type').notNull(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    // Events are persisted first and only exposed externally after this is
    // stamped by the control plane.
    exposedAt: timestamp('exposed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    runCreatedIdx: index('idx_runner_control_events_run').on(
      table.runId,
      table.createdAt,
    ),
    unexposedIdx: index('idx_runner_control_events_unexposed')
      .on(table.createdAt)
      .where(sql`${table.exposedAt} IS NULL`),
  }),
);

export const runnerControlNoncesPostgres = pgTable(
  'runner_control_nonces',
  {
    nonce: text('nonce').primaryKey(),
    runId: text('run_id').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    expiresIdx: index('idx_runner_control_nonces_expires').on(table.expiresAt),
  }),
);

export const transientGrantsPostgres = pgTable(
  'transient_grants',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    // Bound to the claiming lease: a grant is only readable while the lease
    // that created it is still the active lease for the run.
    leaseToken: text('lease_token').notNull(),
    grantJson: jsonb('grant_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runIdx: index('idx_transient_grants_run').on(table.runId, table.expiresAt),
  }),
);
