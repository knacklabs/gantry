import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

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
  if (!existing) {
    throw new Error('Live admission work item conflict was not replayable.');
  }
  return { outcome: 'replayed', item: existing };
}

export async function claimLiveAdmissionWorkItems(
  db: CanonicalDb,
  input: {
    workerInstanceId: string;
    claimToken: string;
    claimExpiresAt: string;
    limit: number;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem[]> {
  const now = input.now ?? currentIso();
  const limit = Math.max(1, Math.floor(input.limit));
  return db.transaction(async (tx) => {
    const items = pgSchema.liveAdmissionWorkItemsPostgres;
    const candidates = await tx
      .select({ id: items.id })
      .from(items)
      .where(
        or(
          eq(items.state, 'queued'),
          and(
            eq(items.state, 'deferred'),
            or(isNull(items.deferUntil), lte(items.deferUntil, now)),
          ),
          and(
            eq(items.state, 'claimed'),
            sql`${items.claimExpiresAt} IS NOT NULL`,
            lte(items.claimExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const ids = candidates.map((candidate) => candidate.id);
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

export async function deferLiveAdmissionWorkItem(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
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
