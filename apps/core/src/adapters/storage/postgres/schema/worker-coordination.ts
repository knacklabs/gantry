import { sql } from 'drizzle-orm';
import {
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
