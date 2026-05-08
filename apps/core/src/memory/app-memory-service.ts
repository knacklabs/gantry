import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  MEMORY_DREAMING_EMBED_MODEL,
  MEMORY_DREAMING_EMBED_PROVIDER,
  MEMORY_DREAMING_EMBEDDINGS_ENABLED,
  RUNTIME_MEMORY_DREAMING_ENABLED,
  RUNTIME_MEMORY_ENABLED,
} from '../config/memory.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import type { PostgresStorageService } from '../adapters/storage/postgres/storage-service.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import { ApplicationError } from '../application/common/application-error.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';
import { runAppMemoryDreamPass } from './app-memory-dreaming.js';
import { normalizeSubject, subjectIdFor } from './app-memory-boundaries.js';
import { collectDurableMemoryAtBoundary } from './app-memory-session-boundary-collector.js';
import {
  clampConfidence,
  encodeItemSource,
  itemMatchesSubjectBoundary,
  parseItemSource,
  parseItemValue,
  parseJsonObject,
  toAppItem,
} from './app-memory-canonical-codec.js';
import {
  conversationIdForChannel,
  toEvidence,
  toRun,
} from './app-memory-service-record-mappers.js';
import type {
  AppMemoryItem,
  AppMemorySearchInput,
  AppMemorySearchResult,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  DreamingTriggerInput,
  MemoryReviewDecisionInput,
  MemoryReviewRecord,
  MemoryBoundaryContext,
  MemoryEvidenceRecord,
  MemorySubjectType,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from './memory-types.js';
import {
  buildMemoryItemWriteBase,
  isUniqueViolation,
  memoryContentHash,
} from './app-memory-service-helpers.js';
import {
  createSqlThreadIdentityFilter,
  nowIso,
} from './app-memory-service-query-helpers.js';
import {
  queryAppMemoryItems,
  recordAppMemoryRecallEvents,
} from './app-memory-recall.js';
import {
  hasDreamingStatusSubjectScope,
  summarizeDreamDecisions,
} from './app-memory-service-dreaming.js';
import { createEmbeddingProvider } from './memory-embeddings.js';
import {
  DREAM_EMBEDDING_DEADLINE_MS,
  runWithTimeout,
  storeDreamItemEmbedding,
} from './app-memory-dream-embeddings.js';
import {
  proposeMemoryConsolidationActions,
  proposeMemoryDreamingActions,
} from './extractor-llm.js';
import {
  createPendingMemoryReview,
  decideMemoryReview,
  listPendingMemoryReviews,
} from './app-memory-review.js';
import {
  deleteOwnedMemoryItem,
  findActiveMemoryByKey,
  getOwnedMemoryItem,
} from './app-memory-item-queries.js';

type Db = NodePgDatabase<typeof pgSchema>;
const APP_MEMORY_RECALL_DEPS = {
  schema: {
    memoryItemsPostgres: pgSchema.memoryItemsPostgres,
    memoryRecallEventsPostgres: pgSchema.memoryRecallEventsPostgres,
  },
  sqlOps: { and, asc, desc, eq, isNull, or, sql },
} as const;
const sqlThreadIdentityFilter = createSqlThreadIdentityFilter({ eq, isNull });
export class AppMemoryService {
  private static singleton: AppMemoryService | null = null;

  static getInstance(): AppMemoryService {
    AppMemoryService.singleton ??= new AppMemoryService();
    return AppMemoryService.singleton;
  }

  static resetForTest(): void {
    AppMemoryService.singleton = null;
  }

  private readonly explicitDb: Db | null;

  constructor(db?: Db) {
    this.explicitDb = db ?? null;
  }

  get db(): Db {
    if (this.explicitDb) return this.explicitDb;
    return (getRuntimeStorage().service as PostgresStorageService).db;
  }

  isEnabled(): boolean {
    return RUNTIME_MEMORY_ENABLED;
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error('memory is disabled in runtime settings');
    }
  }

  async recordEvidence(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
      sourceType: MemoryEvidenceRecord['sourceType'];
      sourceId?: string;
      actorId?: string;
      text: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<MemoryEvidenceRecord> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    const text = input.text.trim();
    if (!text) throw new Error('memory evidence text is required');
    const sensitiveReason = classifySensitiveMemoryMaterial(text);
    if (sensitiveReason) {
      throw new Error(
        `sensitive material blocked in memory evidence: ${sensitiveReason}`,
      );
    }
    const row = {
      id: `mev_${randomUUID().replace(/-/g, '')}`,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: subject.userId ?? null,
      groupId: subject.groupId ?? null,
      channelId: subject.channelId ?? null,
      threadId: subject.threadId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      actorId: input.actorId ?? null,
      text,
      metadataJson: JSON.stringify(input.metadata || {}),
      createdAt: nowIso(),
    } satisfies typeof pgSchema.memoryEvidencePostgres.$inferInsert;
    const [saved] = await this.db
      .insert(pgSchema.memoryEvidencePostgres)
      .values(row)
      .returning();
    return toEvidence(saved!);
  }

  async save(input: SaveAppMemoryInput): Promise<AppMemoryItem> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    if (subject.subjectType === 'common' && !input.isAdminWrite) {
      throw new Error('common memory writes require admin/service authority');
    }
    for (const [field, value] of [
      ['key', input.key],
      ['value', input.value],
      ['why', input.why || ''],
    ] as const) {
      const reason = classifySensitiveMemoryMaterial(value);
      if (reason) {
        throw new Error(
          `sensitive material blocked in memory ${field}: ${reason}`,
        );
      }
    }
    const evidenceIds = [...(input.evidenceIds || [])];
    if (input.evidenceText?.trim()) {
      const evidence = await this.recordEvidence({
        ...subject,
        sourceType: 'manual',
        sourceId: input.source,
        actorId: input.actorId,
        text: input.evidenceText,
      });
      evidenceIds.push(evidence.id);
    }
    const key = input.key.trim();
    const value = input.value.trim();
    const existing = await findActiveMemoryByKey({
      db: this.db,
      subject,
      key,
    });
    const now = nowIso();
    const base = buildMemoryItemWriteBase({
      subject,
      saveInput: input,
      key,
      value,
      evidenceIds,
      existingSource: existing ? parseItemSource(existing) : null,
      timestamp: now,
    });
    try {
      const [row] = await this.db
        .insert(pgSchema.memoryItemsPostgres)
        .values({
          id: `mem_${randomUUID().replace(/-/g, '')}`,
          ...base,
          createdAt: now,
        })
        .returning();
      return toAppItem(row!);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const conflicting = await findActiveMemoryByKey({
        db: this.db,
        subject,
        key,
      });
      if (!conflicting) {
        throw err;
      }
      const conflictNow = nowIso();
      const conflictBase = buildMemoryItemWriteBase({
        subject,
        saveInput: input,
        key,
        value,
        evidenceIds,
        existingSource: parseItemSource(conflicting),
        timestamp: conflictNow,
      });
      const [row] = await this.db
        .update(pgSchema.memoryItemsPostgres)
        .set(conflictBase)
        .where(
          and(
            eq(pgSchema.memoryItemsPostgres.id, conflicting.id),
            eq(pgSchema.memoryItemsPostgres.status, 'active'),
          ),
        )
        .returning();
      if (!row) {
        throw err;
      }
      return toAppItem(row);
    }
  }

  async list(input: AppMemorySearchInput = {}): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      false,
      APP_MEMORY_RECALL_DEPS,
    );
    return rows.map((row) => toAppItem(row.row));
  }

  async search(
    input: AppMemorySearchInput = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      true,
      APP_MEMORY_RECALL_DEPS,
    );
    const results = rows.map((row) => ({
      item: toAppItem(row.row),
      score: row.score,
      lexicalScore: row.lexicalScore,
      vectorScore: row.vectorScore,
      reasons: row.reasons,
    }));
    await recordAppMemoryRecallEvents(
      this.db,
      input,
      results,
      APP_MEMORY_RECALL_DEPS,
    );
    return results;
  }

  async listForHydrationReadOnly(
    input: AppMemorySearchInput = {},
  ): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      false,
      APP_MEMORY_RECALL_DEPS,
      { threadScope: 'exact' },
    );
    return rows.map((row) => toAppItem(row.row));
  }

  async searchForHydrationReadOnly(
    input: AppMemorySearchInput = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      true,
      APP_MEMORY_RECALL_DEPS,
      { threadScope: 'exact' },
    );
    return rows.map((row) => ({
      item: toAppItem(row.row),
      score: row.score,
      lexicalScore: row.lexicalScore,
      vectorScore: row.vectorScore,
      reasons: row.reasons,
    }));
  }

  async patch(input: PatchAppMemoryInput): Promise<AppMemoryItem> {
    this.assertEnabled();
    const current = await getOwnedMemoryItem({
      db: this.db,
      context: normalizeSubject(input),
      id: input.id,
    });
    if (!current) throw new Error('memory item not found');
    const currentSource = parseItemSource(current);
    if (currentSource.subject.subjectType === 'common' && !input.isAdminWrite) {
      throw new Error('common memory patches require admin/service authority');
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== currentSource.version
    ) {
      throw new Error('stale memory patch');
    }
    for (const value of [input.key, input.value, input.why || undefined]) {
      if (!value) continue;
      const reason = classifySensitiveMemoryMaterial(value);
      if (reason)
        throw new Error(
          `sensitive material blocked in memory patch: ${reason}`,
        );
    }
    const currentValue = parseItemValue(current);
    const nextKey = input.key !== undefined ? input.key.trim() : current.key;
    const nextValue =
      input.value !== undefined ? input.value.trim() : currentValue.value;
    if (nextKey !== current.key) {
      const collision = await findActiveMemoryByKey({
        db: this.db,
        subject: currentSource.subject,
        key: nextKey,
      });
      if (collision && collision.id !== current.id) {
        throw new ApplicationError(
          'CONFLICT',
          'Memory key already exists for this subject',
        );
      }
    }
    const nextValueJson = JSON.stringify({
      ...parseJsonObject(current.valueJson),
      value: nextValue,
      why:
        input.why !== undefined ? input.why?.trim() || null : currentValue.why,
      contentHash: memoryContentHash({
        appId: currentSource.subject.appId,
        agentId: currentSource.subject.agentId,
        subjectType: currentSource.subject.subjectType,
        subjectId: currentSource.subject.subjectId,
        key: nextKey,
        value: nextValue,
      }),
    });
    let row: typeof pgSchema.memoryItemsPostgres.$inferSelect | undefined;
    try {
      [row] = await this.db
        .update(pgSchema.memoryItemsPostgres)
        .set({
          ...(input.key !== undefined ? { key: nextKey } : {}),
          valueJson: nextValueJson,
          ...(input.confidence !== undefined
            ? { confidence: clampConfidence(input.confidence) }
            : {}),
          sourceRefJson: encodeItemSource({
            ...currentSource,
            isPinned: input.isPinned ?? currentSource.isPinned,
            version: currentSource.version + 1,
          }),
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(pgSchema.memoryItemsPostgres.id, current.id),
            input.expectedVersion === undefined
              ? undefined
              : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb->>'version')::int = ${input.expectedVersion}`,
          ),
        )
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApplicationError(
          'CONFLICT',
          'Memory key already exists for this subject',
          { cause: err },
        );
      }
      throw err;
    }
    if (!row) throw new Error('stale memory patch');
    return toAppItem(row!);
  }

  async delete(input: DeleteAppMemoryInput): Promise<{ deleted: boolean }> {
    this.assertEnabled();
    return deleteOwnedMemoryItem({
      db: this.db,
      context: normalizeSubject(input),
      id: input.id,
      expectedVersion: input.expectedVersion,
      isAdminWrite: input.isAdminWrite,
    });
  }

  async triggerDreaming(
    input: DreamingTriggerInput = {},
  ): Promise<DreamingRunStatus> {
    this.assertEnabled();
    if (!RUNTIME_MEMORY_DREAMING_ENABLED) {
      throw new ApplicationError(
        'CONFLICT',
        'memory dreaming is disabled in runtime settings',
      );
    }
    const subject = normalizeSubject(input);
    const phase = input.phase || 'all';
    const now = nowIso();
    const running = await pgSchema.findRunningDreamRun({
      db: this.db,
      subject,
      phase,
      now,
    });
    if (running) return toRun(running);
    await pgSchema.expireStaleDreamRuns({ db: this.db, subject, phase, now });
    const runningAfterExpiry = await pgSchema.findRunningDreamRun({
      db: this.db,
      subject,
      phase,
      now,
    });
    if (runningAfterExpiry) return toRun(runningAfterExpiry);
    const runId = `mdr_${randomUUID().replace(/-/g, '')}`;
    const finalizeRun = async (
      status: DreamingRunStatus['status'],
      summary: Record<string, unknown>,
    ): Promise<DreamingRunStatus> => {
      const [row] = await this.db
        .update(pgSchema.memoryDreamRunsPostgres)
        .set({
          status,
          summaryJson: JSON.stringify(summary),
          completedAt: nowIso(),
        })
        .where(eq(pgSchema.memoryDreamRunsPostgres.id, runId))
        .returning();
      return toRun(row!);
    };
    try {
      await this.db.insert(pgSchema.memoryDreamRunsPostgres).values({
        id: runId,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        threadId: subject.threadId ?? null,
        phase,
        status: 'running',
        summaryJson: '{}',
        startedAt: now,
        leaseExpiresAt: pgSchema.dreamRunLeaseExpiresAt(now),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const conflictNow = nowIso();
        await pgSchema.expireStaleDreamRuns({
          db: this.db,
          subject,
          phase,
          now: conflictNow,
        });
        const runningAfterConflict = await pgSchema.findRunningDreamRun({
          db: this.db,
          subject,
          phase,
          now: conflictNow,
        });
        if (runningAfterConflict) return toRun(runningAfterConflict);
      }
      throw error;
    }
    const embeddingsEnabled =
      MEMORY_DREAMING_EMBEDDINGS_ENABLED &&
      MEMORY_DREAMING_EMBED_PROVIDER !== 'disabled';
    const embeddingProvider = embeddingsEnabled
      ? createEmbeddingProvider(MEMORY_DREAMING_EMBED_PROVIDER, {
          model: MEMORY_DREAMING_EMBED_MODEL,
        })
      : null;
    if (embeddingProvider) {
      try {
        await runWithTimeout(async (signal) => {
          embeddingProvider.validateConfiguration();
          await embeddingProvider.validateReady?.({ signal });
        }, DREAM_EMBEDDING_DEADLINE_MS);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'unknown readiness error';
        return finalizeRun('failed', {
          stage: 'embedding_readiness',
          error: reason,
          embeddingsEnabled: true,
          embeddingProvider: MEMORY_DREAMING_EMBED_PROVIDER,
          embeddingModel: MEMORY_DREAMING_EMBED_MODEL,
          dryRun: Boolean(input.dryRun),
        });
      }
    }
    let decisions: Awaited<ReturnType<typeof runAppMemoryDreamPass>>;
    try {
      decisions = await runAppMemoryDreamPass({
        db: this.db,
        runId,
        subject,
        phase,
        dryRun: Boolean(input.dryRun),
        listItems: () =>
          queryAppMemoryItems(
            this.db,
            { ...subject, limit: 100 },
            false,
            APP_MEMORY_RECALL_DEPS,
            { threadScope: 'exact' },
          ),
        save: (value) => this.save(value),
        retire: (value) => this.delete(value),
        storeDreamEmbedding: async (value) => {
          if (!embeddingProvider) return { status: 'disabled' as const };
          return storeDreamItemEmbedding({
            db: this.db,
            schema: {
              memoryItemEmbeddingsPostgres:
                pgSchema.memoryItemEmbeddingsPostgres,
            },
            sqlOps: { and, eq },
            now: nowIso,
            provider: embeddingProvider,
            providerName: MEMORY_DREAMING_EMBED_PROVIDER,
            model: MEMORY_DREAMING_EMBED_MODEL,
            ...value,
          });
        },
        proposeDreaming: ({ evidence, candidates, activeItems }) =>
          proposeMemoryDreamingActions({
            subject,
            evidence,
            candidates,
            activeItems,
          }),
        proposeConsolidation: ({ activeItems }) =>
          proposeMemoryConsolidationActions({
            subject,
            activeItems,
          }),
        createPendingReview: (proposal) =>
          createPendingMemoryReview({
            db: this.db,
            runId,
            subject,
            phase,
            proposal,
          }),
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'unknown dreaming error';
      return finalizeRun('failed', {
        stage: 'dreaming_pass',
        error: reason,
        dryRun: Boolean(input.dryRun),
      });
    }
    const summary = summarizeDreamDecisions(decisions, Boolean(input.dryRun));
    return finalizeRun('completed', summary);
  }

  async dreamingStatus(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
  ): Promise<DreamingRunStatus[]> {
    if (!this.isEnabled()) return [];
    const hasSubjectScope = hasDreamingStatusSubjectScope(input);
    const subject = normalizeSubject(input);
    const subjectFilters = hasSubjectScope
      ? [
          eq(pgSchema.memoryDreamRunsPostgres.subjectType, subject.subjectType),
          eq(pgSchema.memoryDreamRunsPostgres.subjectId, subject.subjectId),
          sqlThreadIdentityFilter(
            pgSchema.memoryDreamRunsPostgres,
            subject.threadId,
          ),
        ]
      : [];
    const rows = await this.db
      .select()
      .from(pgSchema.memoryDreamRunsPostgres)
      .where(
        and(
          eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
          eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
          ...subjectFilters,
        ),
      )
      .orderBy(desc(pgSchema.memoryDreamRunsPostgres.startedAt))
      .limit(20);
    return rows.map(toRun);
  }

  async listPendingReviews(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
  ): Promise<MemoryReviewRecord[]> {
    if (!this.isEnabled()) return [];
    const subject = normalizeSubject(input);
    return listPendingMemoryReviews({ db: this.db, subject });
  }

  async decideReview(
    input: MemoryReviewDecisionInput,
  ): Promise<MemoryReviewRecord> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    return decideMemoryReview({
      db: this.db,
      subject,
      decision: input,
      patch: (value) => this.patch(value),
      delete: (value) => this.delete(value),
    });
  }
}

export const collectDurableMemoryAtSessionBoundary: SessionMemoryCollector =
  async (input) => {
    const { repositories } = getRuntimeStorage();
    const memoryService = AppMemoryService.getInstance();
    return collectDurableMemoryAtBoundary(input, {
      repositories,
      memory: {
        recordEvidence: (value) => memoryService.recordEvidence(value),
      },
    });
  };

export const _testAppMemory = {
  conversationIdForChannel,
  conflictingDreamPhases: pgSchema.conflictingDreamPhases,
  itemMatchesSubjectBoundary,
  normalizeSubject,
  subjectIdFor,
};
