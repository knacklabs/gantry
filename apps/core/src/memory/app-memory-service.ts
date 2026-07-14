import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { RUNTIME_MEMORY_ENABLED } from '../config/memory.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import type { PostgresStorageService } from '../adapters/storage/postgres/storage-service.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { ApplicationError } from '../application/common/application-error.js';
import { classifySensitiveMemoryMaterial } from '../shared/sensitive-material.js';
import { normalizeSubject, subjectIdFor } from './app-memory-boundaries.js';
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
} from './app-memory-service-record-mappers.js';
import type {
  AppMemoryItem,
  AppMemorySearchInput,
  AppMemorySearchResult,
  BlockedDreamDecision,
  DemoteDreamingMemoryInput,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  DreamingTriggerInput,
  MemoryReviewDecisionInput,
  MemoryReviewPage,
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
import { nowIso } from './app-memory-service-query-helpers.js';
import {
  queryAppMemoryItems,
  recordAppMemoryRecallEvents,
  toAppMemoryItems,
  toAppMemorySearchResults,
} from './app-memory-recall.js';
import {
  decideMemoryReview,
  listPendingMemoryReviewPage,
  listPendingMemoryReviews,
} from './app-memory-review.js';
import {
  demoteDreamingPromotedMemoryItem,
  deleteOwnedMemoryItem,
  findActiveMemoryByKey,
  getOwnedMemoryItem,
  listDreamingStatuses,
  listRecentBlockedDreamDecisions,
} from './app-memory-item-queries.js';
import {
  buildAppMemoryContinuityStatus,
  buildAppMemoryContinuitySummary,
} from './app-memory-continuity.js';
import { triggerAppMemoryDreaming } from './app-memory-trigger-dreaming.js';
import { buildRecallEmbeddingCapability } from './app-memory-recall-embedding.js';

type Db = NodePgDatabase<typeof pgSchema>;
const APP_MEMORY_RECALL_DEPS = {
  schema: {
    memoryItemsPostgres: pgSchema.memoryItemsPostgres,
    memoryRecallEventsPostgres: pgSchema.memoryRecallEventsPostgres,
  },
  sqlOps: { and, asc, desc, eq, isNull, or, sql },
} as const;

export class AppMemoryService {
  private static singleton: AppMemoryService | null = null;

  static getInstance(): AppMemoryService {
    AppMemoryService.singleton ??= new AppMemoryService();
    return AppMemoryService.singleton;
  }

  static resetForTest(): void {
    AppMemoryService.singleton = null;
  }

  constructor(private readonly explicitDb: Db | null = null) {}

  get db(): Db {
    if (this.explicitDb) return this.explicitDb;
    return (getRuntimeStorage().service as PostgresStorageService).db;
  }

  private recallDeps(input: AppMemorySearchInput) {
    const embeddings = buildRecallEmbeddingCapability(
      this.db,
      normalizeSubject(input).appId,
    );
    if (!embeddings) return APP_MEMORY_RECALL_DEPS;
    return { ...APP_MEMORY_RECALL_DEPS, embeddings };
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
      threadId: null,
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

  async list(
    input: AppMemorySearchInput = {},
    options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
  ): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      false,
      APP_MEMORY_RECALL_DEPS,
      {
        signal: options.signal,
        statementTimeoutMs: options.statementTimeoutMs,
      },
    );
    return toAppMemoryItems(rows);
  }

  async search(input: AppMemorySearchInput = {}) {
    const results = await this.searchReadOnly(input);
    await this.recordRecallEvents(input, results);
    return results;
  }

  recordRecallEvents = (
    input: AppMemorySearchInput,
    results: AppMemorySearchResult[],
  ) =>
    recordAppMemoryRecallEvents(
      this.db,
      input,
      results,
      APP_MEMORY_RECALL_DEPS,
    );

  async searchReadOnly(
    input: AppMemorySearchInput = {},
    options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      true,
      this.recallDeps(input),
      {
        signal: options.signal,
        statementTimeoutMs: options.statementTimeoutMs,
      },
    );
    return toAppMemorySearchResults(rows);
  }

  async listForHydrationReadOnly(
    input: AppMemorySearchInput = {},
    options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
  ): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      false,
      APP_MEMORY_RECALL_DEPS,
      {
        signal: options.signal,
        statementTimeoutMs: options.statementTimeoutMs,
      },
    );
    return toAppMemoryItems(rows);
  }

  async searchForHydrationReadOnly(
    input: AppMemorySearchInput = {},
    options: {
      signal?: AbortSignal;
      statementTimeoutMs?: number;
      allowEmbeddings?: boolean;
    } = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await queryAppMemoryItems(
      this.db,
      input,
      true,
      options.allowEmbeddings === false
        ? APP_MEMORY_RECALL_DEPS
        : this.recallDeps(input),
      {
        signal: options.signal,
        statementTimeoutMs: options.statementTimeoutMs,
      },
    );
    return toAppMemorySearchResults(rows);
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
    const nextValueJson = {
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
    };
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
              : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${input.expectedVersion}`,
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

  // prettier-ignore
  async delete(input: DeleteAppMemoryInput) {
    this.assertEnabled(); return deleteOwnedMemoryItem({ db: this.db, context: normalizeSubject(input), ...input });
  }

  // prettier-ignore
  async demoteDreamingPromoted(input: DemoteDreamingMemoryInput) {
    this.assertEnabled(); return demoteDreamingPromotedMemoryItem({ db: this.db, context: normalizeSubject(input), ...input });
  }

  async demote(input: DemoteDreamingMemoryInput) {
    return this.demoteDreamingPromoted(input);
  }

  async continuityStatus(input: Partial<MemoryBoundaryContext> = {}) {
    this.assertEnabled();
    return buildAppMemoryContinuityStatus(this, input);
  }

  async continuitySummary(
    input: Partial<MemoryBoundaryContext> & {
      deadlineAtMs?: number;
      nowMs?: number;
      signal?: AbortSignal;
      statementTimeoutMs?: number;
    } = {},
  ) {
    this.assertEnabled();
    return buildAppMemoryContinuitySummary(this, input);
  }

  async triggerDreaming(
    input: DreamingTriggerInput = {},
  ): Promise<DreamingRunStatus> {
    this.assertEnabled();
    return triggerAppMemoryDreaming({
      db: this.db,
      triggerInput: input,
      save: (value) => this.save(value),
      retire: (value) => this.delete(value),
    });
  }

  async dreamingStatus(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
    options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
  ): Promise<DreamingRunStatus[]> {
    if (!this.isEnabled()) return [];
    return listDreamingStatuses(this.db, input, options);
  }

  async listPendingReviews(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
    options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
  ): Promise<MemoryReviewRecord[]> {
    if (!this.isEnabled()) return [];
    options.signal?.throwIfAborted();
    const subject = normalizeSubject(input);
    const reviews = await listPendingMemoryReviews({
      db: this.db,
      subject,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    options.signal?.throwIfAborted();
    return reviews;
  }

  async listRecentBlockedDreamDecisions(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
    options: {
      signal?: AbortSignal;
      statementTimeoutMs?: number;
      limit?: number;
    } = {},
  ): Promise<BlockedDreamDecision[]> {
    if (!this.isEnabled()) return [];
    return listRecentBlockedDreamDecisions(this.db, input, options);
  }

  async listPendingReviewPage(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
    } = {},
    options: {
      signal?: AbortSignal;
      statementTimeoutMs?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<MemoryReviewPage> {
    if (!this.isEnabled()) {
      const limit =
        options.limit === undefined || !Number.isFinite(options.limit)
          ? 20
          : Math.max(1, Math.min(50, Math.trunc(options.limit)));
      const offset =
        options.offset === undefined || !Number.isFinite(options.offset)
          ? 0
          : Math.max(0, Math.trunc(options.offset));
      return {
        reviews: [],
        totalCount: 0,
        returnedCount: 0,
        remainingCount: 0,
        limit,
        offset,
        nextOffset: null,
      };
    }
    options.signal?.throwIfAborted();
    const subject = normalizeSubject(input);
    const page = await listPendingMemoryReviewPage({
      db: this.db,
      subject,
      statementTimeoutMs: options.statementTimeoutMs,
      limit: options.limit,
      offset: options.offset,
    });
    options.signal?.throwIfAborted();
    return page;
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
      save: (value) => this.save(value),
      patch: (value) => this.patch(value),
      delete: (value) => this.delete(value),
    });
  }
}
// prettier-ignore
export const _testAppMemory = { conversationIdForChannel, conflictingDreamPhases: pgSchema.conflictingDreamPhases, itemMatchesSubjectBoundary, normalizeSubject, subjectIdFor };
