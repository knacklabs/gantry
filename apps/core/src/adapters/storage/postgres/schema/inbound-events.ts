import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type {
  InboundControl,
  InboundEventInput,
  InboundRouteReceipt,
  InboundUnpackResult,
} from '../../../../domain/ports/inbound-events.js';

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const inboundEventsPostgres = pgTable(
  'inbound_events',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    providerId: text('provider_id')
      .$type<InboundEventInput['providerId']>()
      .notNull(),
    connectionId: text('connection_id').notNull(),
    kind: text('kind').$type<InboundEventInput['kind']>().notNull(),
    eventKey: text('event_key').notNull(),
    // Allocated only after the connection transaction lock, never a consumption cursor.
    seq: bigint('seq', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .notNull(),
    rawChannelId: text('raw_channel_id').notNull(),
    rawThreadId: text('raw_thread_id'),
    rawMessageId: text('raw_message_id'),
    payload: jsonb('payload').$type<InboundEventInput['payload']>(),
    control: jsonb('control_json').$type<InboundControl>(),
    unpacked: jsonb('unpacked_json').$type<InboundUnpackResult>(),
    routeReceipts: jsonb('route_receipts_json')
      .$type<InboundRouteReceipt[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: text('state')
      .$type<'pending' | 'claimed' | 'completed' | 'set_aside'>()
      .notNull()
      .default('pending'),
    deleted: boolean('deleted').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    claimToken: text('claim_token'),
    claimExpiresAt: time('claim_expires_at'),
    deadlineAt: time('deadline_at'),
    nextAttemptAt: time('next_attempt_at'),
    failedOperation: text('failed_operation'),
    receivedAt: time('received_at')
      .notNull()
      .default(sql`clock_timestamp()`),
    settledAt: time('settled_at'),
  },
  (table) => ({
    identity: uniqueIndex('uq_inbound_events_identity').on(
      table.appId,
      table.providerId,
      table.connectionId,
      table.kind,
      table.eventKey,
    ),
    heads: index('idx_inbound_events_heads')
      .on(
        table.appId,
        table.providerId,
        table.connectionId,
        table.rawChannelId,
        table.rawThreadId,
        table.seq,
      )
      .where(sql`${table.state} IN ('pending', 'claimed')`),
    controls: index('idx_inbound_events_controls')
      .on(table.appId, table.seq)
      .where(
        sql`${table.control} IS NOT NULL AND ${table.state} IN ('pending', 'claimed')`,
      ),
    heldDelete: index('idx_inbound_events_held_delete')
      .on(
        table.appId,
        table.providerId,
        table.connectionId,
        table.rawChannelId,
        table.rawMessageId,
      )
      .where(sql`${table.state} IN ('pending', 'claimed', 'set_aside')`),
    retention: index('idx_inbound_events_retention')
      .on(table.settledAt, table.id)
      .where(sql`${table.state} = 'completed'`),
    stateCheck: check(
      'inbound_events_state_check',
      sql`${table.state} IN ('pending', 'claimed', 'completed', 'set_aside')`,
    ),
    attemptsCheck: check(
      'inbound_events_attempts_check',
      sql`${table.attempts} BETWEEN 0 AND 6`,
    ),
  }),
);
