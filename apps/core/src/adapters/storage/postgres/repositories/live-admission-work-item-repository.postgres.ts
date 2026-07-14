import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  LiveAdmissionWorkItem,
  LiveAdmissionWorkItemEnqueueResult,
} from '../../../../domain/ports/live-turns.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';

type LiveAdmissionWorkItemRow =
  typeof pgSchema.liveAdmissionWorkItemsPostgres.$inferSelect;

function toLiveAdmissionWorkItem(
  row: LiveAdmissionWorkItemRow,
): LiveAdmissionWorkItem {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    agentSessionId: row.agentSessionId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    queueJid: row.queueJid,
    messageId: row.messageId,
    messageCursor: row.messageCursor,
    senderUserId: row.senderUserId,
    senderDisplayName: row.senderDisplayName,
    idempotencyKey: row.idempotencyKey,
    state: row.state as LiveAdmissionWorkItem['state'],
    sourceKind: 'message',
    triggerDecision: (row.triggerDecisionJson ?? {}) as Record<string, unknown>,
    claimWorkerInstanceId: row.claimWorkerInstanceId,
    claimToken: row.claimToken,
    claimExpiresAt: row.claimExpiresAt,
    fencingVersion: row.fencingVersion,
    retryCount: row.retryCount,
    failureCount: row.failureCount,
    deferUntil: row.deferUntil,
    deferredReason: row.deferredReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    endedAt: row.endedAt,
  };
}

export async function enqueueLiveAdmissionWorkItem(
  db: CanonicalExecutor,
  input: {
    id: string;
    appId: string;
    agentId?: string | null;
    agentSessionId?: string | null;
    conversationId: string;
    threadId?: string | null;
    queueJid: string;
    messageId: string;
    messageCursor: string;
    senderUserId?: string | null;
    senderDisplayName?: string | null;
    idempotencyKey: string;
    triggerDecision?: Record<string, unknown>;
    now?: string;
  },
): Promise<LiveAdmissionWorkItemEnqueueResult> {
  const now = input.now ?? currentIso();
  const row: LiveAdmissionWorkItemRow = {
    id: input.id,
    appId: input.appId,
    agentId: input.agentId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    conversationId: input.conversationId,
    threadId: input.threadId ?? null,
    queueJid: input.queueJid,
    messageId: input.messageId,
    messageCursor: input.messageCursor,
    senderUserId: input.senderUserId ?? null,
    senderDisplayName: input.senderDisplayName ?? null,
    idempotencyKey: input.idempotencyKey,
    state: 'queued',
    sourceKind: 'message',
    triggerDecisionJson: input.triggerDecision ?? {},
    claimWorkerInstanceId: null,
    claimToken: null,
    claimExpiresAt: null,
    fencingVersion: 0,
    retryCount: 0,
    failureCount: 0,
    deferUntil: null,
    deferredReason: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    endedAt: null,
  };
  const inserted = await db
    .insert(pgSchema.liveAdmissionWorkItemsPostgres)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    return { outcome: 'enqueued', item: toLiveAdmissionWorkItem(row) };
  }
  const existing = await findLiveAdmissionWorkItemByIdempotencyKey(
    db,
    input.idempotencyKey,
  );
  const replayed =
    existing ?? (await findLiveAdmissionWorkItemById(db, input.id));
  if (!replayed) {
    throw new Error('Live admission work item conflict was not replayable.');
  }
  return { outcome: 'replayed', item: replayed };
}

export async function claimLiveAdmissionWorkItems(
  db: CanonicalDb,
  input: {
    appId: string;
    workerInstanceId: string;
    claimToken: string;
    claimExpiresAt: string;
    limit: number;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem[]> {
  const now = input.now ?? currentIso();
  const limit = Math.max(1, Math.floor(input.limit));
  const candidateLimit = limit * 4;
  return db.transaction(async (tx) => {
    const items = pgSchema.liveAdmissionWorkItemsPostgres;
    const candidates = await tx.execute<{ id: string }>(sql`
      WITH queued AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'queued'
        ORDER BY ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      due_deferred AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'deferred'
          AND ${items.deferUntil} <= ${now}
        ORDER BY ${items.deferUntil} ASC, ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      null_deferred AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'deferred'
          AND ${items.deferUntil} IS NULL
        ORDER BY ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      expired_claimed AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'claimed'
          AND ${items.claimExpiresAt} IS NOT NULL
          AND ${items.claimExpiresAt} <= ${now}
        ORDER BY ${items.claimExpiresAt} ASC, ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      candidates AS (
        SELECT id, created_at FROM queued
        UNION ALL
        SELECT id, created_at FROM due_deferred
        UNION ALL
        SELECT id, created_at FROM null_deferred
        UNION ALL
        SELECT id, created_at FROM expired_claimed
      )
      SELECT id
      FROM candidates
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `);
    const ids = candidates.rows.map((candidate) => candidate.id);
    if (ids.length === 0) return [];
    const rows = await tx
      .update(items)
      .set({
        state: 'claimed',
        claimWorkerInstanceId: input.workerInstanceId,
        claimToken: input.claimToken,
        claimExpiresAt: input.claimExpiresAt,
        fencingVersion: sql`${items.fencingVersion} + 1`,
        retryCount: sql`${items.retryCount} + 1`,
        deferUntil: null,
        deferredReason: null,
        claimedAt: now,
        updatedAt: now,
      })
      .where(inArray(items.id, ids))
      .returning();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is LiveAdmissionWorkItemRow => Boolean(row))
      .map(toLiveAdmissionWorkItem);
  });
}

export async function renewLiveAdmissionWorkItemClaim(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    claimExpiresAt: string;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      claimExpiresAt: input.claimExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning({ id: items.id });
  return rows.length > 0;
}

export async function deferLiveAdmissionWorkItem(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
    countFailure?: boolean;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      state: 'deferred',
      claimWorkerInstanceId: null,
      claimToken: null,
      claimExpiresAt: null,
      failureCount: input.countFailure
        ? sql`${items.failureCount} + 1`
        : sql`${items.failureCount}`,
      deferUntil: input.deferUntil,
      deferredReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning({ id: items.id });
  return rows.length > 0;
}

export async function settleLiveAdmissionWorkItem(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<
      LiveAdmissionWorkItem['state'],
      'completed' | 'failed' | 'canceled'
    >;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      state: input.state,
      updatedAt: now,
      endedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning({ id: items.id });
  return rows.length > 0;
}

async function findLiveAdmissionWorkItemByIdempotencyKey(
  db: CanonicalExecutor,
  idempotencyKey: string,
): Promise<LiveAdmissionWorkItem | null> {
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .select()
    .from(items)
    .where(eq(items.idempotencyKey, idempotencyKey))
    .limit(1);
  const row = rows[0];
  return row ? toLiveAdmissionWorkItem(row) : null;
}

async function findLiveAdmissionWorkItemById(
  db: CanonicalExecutor,
  id: string,
): Promise<LiveAdmissionWorkItem | null> {
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
  const row = rows[0];
  return row ? toLiveAdmissionWorkItem(row) : null;
}
