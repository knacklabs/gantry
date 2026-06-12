import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentRunsPostgres } from './runs.js';

export const liveTurnsPostgres = pgTable(
  'live_turns',
  {
    id: text('id').primaryKey(),
    // Deterministic key over (appId, agentSessionId, conversationId,
    // threadId); see makeLiveTurnScopeKey.
    scopeKey: text('scope_key').notNull(),
    appId: text('app_id').notNull(),
    agentSessionId: text('agent_session_id'),
    conversationId: text('conversation_id').notNull(),
    threadId: text('thread_id'),
    runId: text('run_id').references(() => agentRunsPostgres.id, {
      onDelete: 'set null',
    }),
    // state is application-constrained to:
    // claimed | running | awaiting_interaction | setup_required | recovered |
    // completed | failed | timed_out.
    state: text('state').notNull().default('claimed'),
    pendingMessageJson: jsonb('pending_message_json'),
    stopAliasJidsJson: jsonb('stop_alias_jids_json')
      .notNull()
      .default(sql`'[]'::jsonb`),
    requiredContinuationUserId: text('required_continuation_user_id'),
    retryCount: integer('retry_count').notNull().default(0),
    // Per-turn command sequence allocator; bumped row-locked inside the
    // command append transaction.
    nextCommandSeq: integer('next_command_seq').notNull().default(1),
    // Owner projection only; run_leases stays the fencing authority.
    workerInstanceId: text('worker_instance_id'),
    leaseToken: text('lease_token'),
    fencingVersion: integer('fencing_version'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    endedAt: timestamp('ended_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    // One non-terminal live turn per scope; concurrent claimers lose via
    // unique violation on this partial index.
    activeScopeUnique: uniqueIndex('uq_live_turns_active_scope')
      .on(table.scopeKey)
      .where(sql`${table.state} NOT IN ('completed', 'failed', 'timed_out')`),
    scopeCreatedIdx: index('idx_live_turns_scope').on(
      table.scopeKey,
      table.createdAt,
    ),
    runIdx: index('idx_live_turns_run').on(table.runId),
    stateIdx: index('idx_live_turns_state').on(table.state, table.updatedAt),
  }),
);

export const liveTurnCommandsPostgres = pgTable(
  'live_turn_commands',
  {
    id: text('id').primaryKey(),
    liveTurnId: text('live_turn_id')
      .notNull()
      .references(() => liveTurnsPostgres.id, { onDelete: 'cascade' }),
    scopeKey: text('scope_key').notNull(),
    // command_type is application-constrained to: continuation | stop |
    // close_stdin | new_session | compact | interaction_resolved.
    commandType: text('command_type').notNull(),
    seq: integer('seq').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // status is application-constrained to: pending | applied | rejected.
    status: text('status').notNull().default('pending'),
    // Fence snapshot of the turn at append time, for observability.
    fencingVersion: integer('fencing_version'),
    createdByWorkerId: text('created_by_worker_id'),
    appliedByWorkerId: text('applied_by_worker_id'),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    appliedAt: timestamp('applied_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex('uq_live_turn_commands_idempotency').on(
      table.liveTurnId,
      table.idempotencyKey,
    ),
    turnSeqUnique: uniqueIndex('uq_live_turn_commands_turn_seq').on(
      table.liveTurnId,
      table.seq,
    ),
    pendingIdx: index('idx_live_turn_commands_pending')
      .on(table.liveTurnId, table.seq)
      .where(sql`${table.status} = 'pending'`),
  }),
);
