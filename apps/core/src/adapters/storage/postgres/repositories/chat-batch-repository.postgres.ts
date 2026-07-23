import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';

import type {
  ChatBatchRecord,
  ChatBatchRepository,
  ChatBatchState,
  ChatBatchUsage,
} from '../../../../domain/ports/chat-batches.js';
import { ChatBatchDailyCostLimitError } from '../../../../domain/ports/chat-batches.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const Batches = pgSchema.chatBatchesPostgres;
const ACTIVE_REMOTE_STATES: ChatBatchState[] = ['submitted', 'processing'];

export class PostgresChatBatchRepository implements ChatBatchRepository {
  constructor(private readonly db: CanonicalDb) {}

  async createIntent(
    input: Parameters<ChatBatchRepository['createIntent']>[0],
  ): Promise<ChatBatchRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`chat_batch_budget:${input.appId}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(Batches)
        .where(
          and(
            eq(Batches.appId, input.appId),
            eq(Batches.providerId, input.providerId),
            eq(Batches.correlationId, input.correlationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.contentHash !== input.contentHash) {
          throw new Error(
            'Chat batch correlation id already belongs to a different content snapshot',
          );
        }
        if (existing.state !== 'preflight_failed') return mapBatch(existing);
      }

      const [daily] = await tx
        .select({
          amount: sql<number>`coalesce(sum(greatest(${Batches.reservedCostUsd}, coalesce(${Batches.estimatedCostUsd}, 0))), 0)::double precision`,
        })
        .from(Batches)
        .where(
          and(
            eq(Batches.appId, input.appId),
            ne(Batches.state, 'preflight_failed'),
            gte(Batches.createdAt, input.dayStartIso),
            lt(Batches.createdAt, input.dayEndIso),
          ),
        );
      if (
        Number(daily?.amount ?? 0) + input.reservedCostUsd >
        input.dailyCostLimitUsd
      ) {
        throw new ChatBatchDailyCostLimitError();
      }

      if (existing) {
        const [reopened] = await tx
          .update(Batches)
          .set({
            state: 'submission_intent',
            reservedCostUsd: input.reservedCostUsd,
            attentionRequired: false,
            lastError: null,
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(Batches.id, existing.id),
              eq(Batches.state, 'preflight_failed'),
            ),
          )
          .returning();
        return mapBatch(reopened ?? existing);
      }

      const [created] = await tx
        .insert(Batches)
        .values({
          id: input.id,
          appId: input.appId,
          providerId: input.providerId,
          model: input.model,
          correlationId: input.correlationId,
          contentHash: input.contentHash,
          state: 'submission_intent',
          requestSnapshot: [...input.requestSnapshot],
          requestCount: input.requestCount,
          snapshotBytes: input.snapshotBytes,
          reservedCostUsd: input.reservedCostUsd,
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        })
        .returning();
      return mapBatch(created!);
    });
  }

  async findById(id: string): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .select()
      .from(Batches)
      .where(eq(Batches.id, id))
      .limit(1);
    return row ? mapBatch(row) : null;
  }

  async findByCorrelationId(input: {
    appId: string;
    providerId: string;
    correlationId: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .select()
      .from(Batches)
      .where(
        and(
          eq(Batches.appId, input.appId),
          eq(Batches.providerId, input.providerId),
          eq(Batches.correlationId, input.correlationId),
        ),
      )
      .limit(1);
    return row ? mapBatch(row) : null;
  }

  async listSubmissionUnknown(input: {
    appId?: string;
    limit: number;
  }): Promise<ChatBatchRecord[]> {
    const rows = await this.db
      .select()
      .from(Batches)
      .where(
        and(
          eq(Batches.state, 'submission_unknown'),
          input.appId ? eq(Batches.appId, input.appId) : undefined,
        ),
      )
      .orderBy(asc(Batches.createdAt), asc(Batches.id))
      .limit(clampLimit(input.limit));
    return rows.map(mapBatch);
  }

  async recordPreflightFailure(
    input: Parameters<ChatBatchRepository['recordPreflightFailure']>[0],
  ): Promise<ChatBatchRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`chat_batch_preflight:${input.appId}:${input.providerId}:${input.correlationId}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(Batches)
        .where(
          and(
            eq(Batches.appId, input.appId),
            eq(Batches.providerId, input.providerId),
            eq(Batches.correlationId, input.correlationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.contentHash !== input.contentHash) {
          throw new Error(
            'Chat batch correlation id already belongs to a different content snapshot',
          );
        }
        if (
          !['submission_intent', 'preflight_failed'].includes(existing.state)
        ) {
          return mapBatch(existing);
        }
        const [failed] = await tx
          .update(Batches)
          .set({
            state: 'preflight_failed',
            attentionRequired: true,
            lastError: input.error,
            updatedAt: input.nowIso,
          })
          .where(eq(Batches.id, existing.id))
          .returning();
        return mapBatch(failed ?? existing);
      }
      const [failed] = await tx
        .insert(Batches)
        .values({
          id: input.id,
          appId: input.appId,
          providerId: input.providerId,
          model: input.model,
          correlationId: input.correlationId,
          contentHash: input.contentHash,
          state: 'preflight_failed',
          requestSnapshot: [...input.requestSnapshot],
          requestCount: input.requestCount,
          snapshotBytes: input.snapshotBytes,
          reservedCostUsd: input.reservedCostUsd,
          attentionRequired: true,
          lastError: input.error,
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        })
        .returning();
      return mapBatch(failed!);
    });
  }

  async markSubmissionUnknown(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .update(Batches)
      .set({
        state: 'submission_unknown',
        submitAttempts: sql`${Batches.submitAttempts} + 1`,
        attentionRequired: true,
        lastError:
          'Provider submission outcome is unknown; reconciliation required',
        updatedAt: input.nowIso,
      })
      .where(
        and(eq(Batches.id, input.id), eq(Batches.state, 'submission_intent')),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }

  async markSubmitted(input: {
    id: string;
    providerBatchId: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .update(Batches)
      .set({
        state: 'submitted',
        providerBatchId: input.providerBatchId,
        attentionRequired: false,
        lastError: null,
        submittedAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      .where(
        and(eq(Batches.id, input.id), eq(Batches.state, 'submission_unknown')),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }

  async markProcessing(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .update(Batches)
      .set({
        state: 'processing',
        lastError: null,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(Batches.id, input.id),
          inArray(Batches.state, ACTIVE_REMOTE_STATES),
        ),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }

  async recordAttemptError(input: {
    id: string;
    phase: 'poll' | 'result';
    error: string;
    terminal: boolean;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const attempts =
      input.phase === 'poll'
        ? { pollAttempts: sql`${Batches.pollAttempts} + 1` }
        : { resultAttempts: sql`${Batches.resultAttempts} + 1` };
    const terminal = input.terminal
      ? { state: 'failed', attentionRequired: true }
      : {};
    const [row] = await this.db
      .update(Batches)
      .set({
        ...attempts,
        ...terminal,
        lastError: input.error,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(Batches.id, input.id),
          inArray(Batches.state, ACTIVE_REMOTE_STATES),
        ),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }

  async applyResults(input: {
    id: string;
    results: readonly Record<string, unknown>[];
    usage: ChatBatchUsage;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .update(Batches)
      .set({
        state: 'applied',
        resultSnapshot: [...input.results],
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        estimatedCostUsd: input.usage.estimatedCostUsd,
        resultAttempts: sql`${Batches.resultAttempts} + 1`,
        attentionRequired: false,
        lastError: null,
        appliedAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(Batches.id, input.id),
          inArray(Batches.state, ACTIVE_REMOTE_STATES),
        ),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }

  async abandonSubmission(input: {
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const [row] = await this.db
      .update(Batches)
      .set({
        state: 'abandoned',
        attentionRequired: true,
        lastError: input.reason,
        updatedAt: input.nowIso,
      })
      .where(
        and(eq(Batches.id, input.id), eq(Batches.state, 'submission_unknown')),
      )
      .returning();
    return row ? mapBatch(row) : null;
  }
}

function mapBatch(row: typeof Batches.$inferSelect): ChatBatchRecord {
  return {
    id: row.id,
    appId: row.appId,
    providerId: row.providerId,
    model: row.model,
    correlationId: row.correlationId,
    contentHash: row.contentHash,
    state: row.state as ChatBatchState,
    providerBatchId: row.providerBatchId,
    requestSnapshot: row.requestSnapshot as Record<string, unknown>[],
    resultSnapshot: row.resultSnapshot as Record<string, unknown>[] | null,
    requestCount: row.requestCount,
    snapshotBytes: row.snapshotBytes,
    reservedCostUsd: row.reservedCostUsd,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      estimatedCostUsd: row.estimatedCostUsd,
    },
    submitAttempts: row.submitAttempts,
    pollAttempts: row.pollAttempts,
    resultAttempts: row.resultAttempts,
    attentionRequired: row.attentionRequired,
    lastError: row.lastError,
    submittedAt: row.submittedAt,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}
