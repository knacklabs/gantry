import { randomUUID } from 'node:crypto';

import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { RUNTIME_MEMORY_ENABLED } from '../config/memory-state.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import type { PostgresStorageService } from '../adapters/storage/postgres/storage-service.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';
import { runAppMemoryDreamPass } from './app-memory-dreaming.js';
import {
  normalizeSubject,
  visibleSubjectFilters,
} from './app-memory-boundaries.js';
import {
  type CanonicalMemoryItemRow,
  clampConfidence,
  encodeItemSource,
  hashText,
  itemMatchesSubjectBoundary,
  normalizeKind,
  parseItemSource,
  parseItemValue,
  parseJsonObject,
  subjectIdFor,
  toAppItem,
} from './app-memory-canonical-codec.js';
import type {
  AppMemoryItem,
  AppMemorySearchInput,
  AppMemorySearchResult,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  DreamingTriggerInput,
  MemoryBoundaryContext,
  MemoryEvidenceRecord,
  MemorySubjectType,
  NormalizedMemorySubject,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = CanonicalMemoryItemRow;
type MemoryEvidenceRow = typeof pgSchema.memoryEvidencePostgres.$inferSelect;
type MemoryDreamRunRow = typeof pgSchema.memoryDreamRunsPostgres.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function conversationIdForChannel(
  channelId: string | undefined,
): string | null {
  return channelId ? `conversation:${channelId}` : null;
}

function toEvidence(row: MemoryEvidenceRow): MemoryEvidenceRecord {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.groupId ? { groupId: row.groupId } : {}),
    ...(row.channelId ? { channelId: row.channelId } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    sourceType: row.sourceType as MemoryEvidenceRecord['sourceType'],
    sourceId: row.sourceId,
    actorId: row.actorId,
    text: row.text,
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  };
}

function toRun(row: MemoryDreamRunRow): DreamingRunStatus {
  return {
    runId: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    phase: row.phase as DreamingRunStatus['phase'],
    status: row.status as DreamingRunStatus['status'],
    summary: parseJsonObject(row.summaryJson),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function sqlThreadVisibilityFilter(
  i: typeof pgSchema.memoryItemsPostgres,
  threadId: string | undefined,
) {
  return threadId
    ? or(
        sql`${i.sourceRefJson}::jsonb->'subject'->>'threadId' = ${threadId}`,
        sql`NOT (${i.sourceRefJson}::jsonb->'subject' ? 'threadId')`,
      )
    : sql`NOT (${i.sourceRefJson}::jsonb->'subject' ? 'threadId')`;
}

function sqlThreadIdentityFilter(
  i: typeof pgSchema.memoryItemsPostgres,
  threadId: string | undefined,
) {
  return threadId
    ? sql`${i.sourceRefJson}::jsonb->'subject'->>'threadId' = ${threadId}`
    : sql`NOT (${i.sourceRefJson}::jsonb->'subject' ? 'threadId')`;
}

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
    const now = nowIso();
    const existing = await this.findActiveByKey(subject, input.key);
    const nextEvidenceIds = Array.from(
      new Set([
        ...(existing ? parseItemSource(existing).evidenceIds : []),
        ...evidenceIds,
      ]),
    );
    const existingSource = existing ? parseItemSource(existing) : null;
    const nextVersion = existingSource ? existingSource.version + 1 : 1;
    const base = {
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subjectIdFor(subject),
      userId: subject.userId ?? null,
      conversationId: conversationIdForChannel(subject.channelId),
      threadId: subject.threadId ?? null,
      kind: normalizeKind(input.kind),
      key: input.key.trim(),
      valueJson: JSON.stringify({
        value: input.value.trim(),
        why: input.why?.trim() || null,
        contentHash: hashText(
          `${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}:${input.key}:${input.value}`,
        ),
      }),
      sourceRefJson: encodeItemSource({
        subject,
        source: input.source || 'sdk',
        evidenceIds: nextEvidenceIds,
        isPinned: existingSource?.isPinned ?? false,
        version: nextVersion,
        retrievalCount: existingSource?.retrievalCount,
        totalScore: existingSource?.totalScore,
        maxScore: existingSource?.maxScore,
      }),
      confidence: clampConfidence(input.confidence),
      status: 'active',
      lastObservedAt: now,
      updatedAt: now,
    };
    const [row] = await this.db
      .insert(pgSchema.memoryItemsPostgres)
      .values({
        id: `mem_${randomUUID().replace(/-/g, '')}`,
        ...base,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pgSchema.memoryItemsPostgres.appId,
          pgSchema.memoryItemsPostgres.agentId,
          pgSchema.memoryItemsPostgres.subjectType,
          pgSchema.memoryItemsPostgres.subjectId,
          pgSchema.memoryItemsPostgres.kind,
          pgSchema.memoryItemsPostgres.key,
        ],
        targetWhere: sql`${pgSchema.memoryItemsPostgres.status} = 'active'`,
        set: base,
      })
      .returning();
    return toAppItem(row!);
  }

  async list(input: AppMemorySearchInput = {}): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await this.queryItems(input, false);
    return rows.map((row) => toAppItem(row.row));
  }

  async search(
    input: AppMemorySearchInput = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await this.queryItems(input, true);
    const results = rows.map((row) => ({
      item: toAppItem(row.row),
      score: row.score,
      lexicalScore: row.lexicalScore,
      vectorScore: row.vectorScore,
      reasons: row.reasons,
    }));
    await this.recordRecallEvents(input, results);
    return results;
  }

  async patch(input: PatchAppMemoryInput): Promise<AppMemoryItem> {
    this.assertEnabled();
    const current = await this.getOwnedItem(input);
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
    const [row] = await this.db
      .update(pgSchema.memoryItemsPostgres)
      .set({
        ...(input.key !== undefined ? { key: input.key.trim() } : {}),
        valueJson: JSON.stringify({
          ...parseJsonObject(current.valueJson),
          value:
            input.value !== undefined ? input.value.trim() : currentValue.value,
          why:
            input.why !== undefined
              ? input.why?.trim() || null
              : currentValue.why,
        }),
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
    if (!row) throw new Error('stale memory patch');
    return toAppItem(row!);
  }

  async delete(input: DeleteAppMemoryInput): Promise<{ deleted: boolean }> {
    this.assertEnabled();
    const current = await this.getOwnedItem(input);
    if (!current) return { deleted: false };
    if (
      parseItemSource(current).subject.subjectType === 'common' &&
      !input.isAdminWrite
    ) {
      throw new Error('common memory deletes require admin/service authority');
    }
    await this.db
      .update(pgSchema.memoryItemsPostgres)
      .set({ status: 'deleted', updatedAt: nowIso() })
      .where(eq(pgSchema.memoryItemsPostgres.id, current.id));
    return { deleted: true };
  }

  async triggerDreaming(
    input: DreamingTriggerInput = {},
  ): Promise<DreamingRunStatus> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    const phase = input.phase || 'all';
    const now = nowIso();
    const runId = `mdr_${randomUUID().replace(/-/g, '')}`;
    await this.db.insert(pgSchema.memoryDreamRunsPostgres).values({
      id: runId,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      phase,
      status: 'running',
      summaryJson: '{}',
      startedAt: now,
    });
    const decisions = await runAppMemoryDreamPass({
      db: this.db,
      runId,
      subject,
      phase,
      dryRun: Boolean(input.dryRun),
      listItems: () => this.queryItems({ ...subject, limit: 100 }, false),
      save: (value) => this.save(value),
    });
    const completedAt = nowIso();
    const summary = {
      decisions: decisions.length,
      promoted: decisions.filter((decision) => decision.action === 'promote')
        .length,
      needsReview: decisions.filter(
        (decision) => decision.action === 'needs_review',
      ).length,
      dryRun: Boolean(input.dryRun),
    };
    const [row] = await this.db
      .update(pgSchema.memoryDreamRunsPostgres)
      .set({
        status: 'completed',
        summaryJson: JSON.stringify(summary),
        completedAt,
      })
      .where(eq(pgSchema.memoryDreamRunsPostgres.id, runId))
      .returning();
    return toRun(row!);
  }

  async dreamingStatus(
    input: Partial<MemoryBoundaryContext> = {},
  ): Promise<DreamingRunStatus[]> {
    if (!this.isEnabled()) return [];
    const subject = normalizeSubject(input);
    const rows = await this.db
      .select()
      .from(pgSchema.memoryDreamRunsPostgres)
      .where(
        and(
          eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
          eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
        ),
      )
      .orderBy(desc(pgSchema.memoryDreamRunsPostgres.startedAt))
      .limit(20);
    return rows.map(toRun);
  }

  private async findActiveByKey(
    subject: NormalizedMemorySubject,
    key: string,
  ): Promise<MemoryItemRow | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.status, 'active'),
          eq(pgSchema.memoryItemsPostgres.appId, subject.appId),
          eq(pgSchema.memoryItemsPostgres.agentId, subject.agentId),
          eq(pgSchema.memoryItemsPostgres.subjectType, subject.subjectType),
          eq(pgSchema.memoryItemsPostgres.subjectId, subjectIdFor(subject)),
          sql`${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb @> ${JSON.stringify({ subject: { agentId: subject.agentId, subjectType: subject.subjectType, subjectId: subject.subjectId } })}::jsonb`,
          sqlThreadIdentityFilter(
            pgSchema.memoryItemsPostgres,
            subject.threadId,
          ),
          eq(pgSchema.memoryItemsPostgres.key, key.trim()),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getOwnedItem(
    input: { id: string } & Partial<MemoryBoundaryContext>,
  ): Promise<MemoryItemRow | null> {
    const context = normalizeSubject(input);
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.id, input.id),
          eq(pgSchema.memoryItemsPostgres.status, 'active'),
          eq(pgSchema.memoryItemsPostgres.appId, context.appId),
        ),
      )
      .limit(1);
    const row = rows[0] ?? null;
    return row && itemMatchesSubjectBoundary(row, context) ? row : null;
  }

  private async queryItems(
    input: AppMemorySearchInput,
    ranked: boolean,
  ): Promise<
    Array<{
      row: MemoryItemRow;
      score: number;
      lexicalScore: number;
      vectorScore: number;
      reasons: string[];
    }>
  > {
    const context = normalizeSubject(input);
    const query = input.query?.trim() || '';
    const i = pgSchema.memoryItemsPostgres;
    const valueText = sql<string>`${i.valueJson}::jsonb->>'value'`;
    const whyText = sql<string>`${i.valueJson}::jsonb->>'why'`;
    const document = sql`to_tsvector('english', ${i.key} || ' ' || COALESCE(${valueText}, '') || ' ' || COALESCE(${whyText}, ''))`;
    const searchQuery = sql`plainto_tsquery('english', ${query})`;
    const lexicalScore = query
      ? sql<number>`ts_rank_cd(${document}, ${searchQuery})`
      : sql<number>`0`;
    const visible = visibleSubjectFilters(i, input);
    const threadFilter = sqlThreadVisibilityFilter(i, context.threadId);
    const vectorScore = sql<number>`0`;
    const combinedScore = sql<number>`(${lexicalScore} * 0.65) + (${i.confidence} * 0.10)`;
    const rows = await this.db
      .select({
        row: i,
        lexicalScore,
        vectorScore,
        score: ranked ? combinedScore : sql<number>`${i.confidence}`,
      })
      .from(i)
      .where(
        and(
          eq(i.status, 'active'),
          eq(i.appId, context.appId),
          visible.length === 0
            ? sql`false`
            : visible.length === 1
              ? visible[0]
              : or(...visible),
          threadFilter,
          query ? sql`${document} @@ ${searchQuery}` : undefined,
        ),
      )
      .orderBy(ranked ? desc(combinedScore) : desc(i.updatedAt))
      .limit(Math.max(1, Math.min(input.limit || 20, 100)));
    return rows.map((row) => ({
      row: row.row,
      score: Number(row.score || 0),
      lexicalScore: Number(row.lexicalScore || 0),
      vectorScore: Number(row.vectorScore || 0),
      reasons: [
        row.lexicalScore ? 'lexical' : '',
        row.vectorScore ? 'semantic' : '',
        parseItemSource(row.row).isPinned ? 'pinned' : '',
      ].filter(Boolean),
    }));
  }

  private async recordRecallEvents(
    input: AppMemorySearchInput,
    results: AppMemorySearchResult[],
  ): Promise<void> {
    if (results.length === 0) return;
    const context = normalizeSubject(input);
    const queryHash = hashText(input.query || '');
    const createdAt = nowIso();
    await this.db.insert(pgSchema.memoryRecallEventsPostgres).values(
      results.map((result) => ({
        appId: context.appId,
        agentId: context.agentId,
        itemId: result.item.id,
        queryHash,
        score: result.score,
        subjectJson: JSON.stringify(context),
        createdAt,
      })),
    );
    await Promise.all(
      results.map(async (result) => {
        await this.db
          .update(pgSchema.memoryItemsPostgres)
          .set({
            sourceRefJson: sql<string>`jsonb_set(
              jsonb_set(
                jsonb_set(
                  ${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb,
                  '{retrievalCount}',
                  to_jsonb(COALESCE((${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb->>'retrievalCount')::int, 0) + 1)
                ),
                '{totalScore}',
                to_jsonb(COALESCE((${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb->>'totalScore')::double precision, 0) + ${result.score})
              ),
              '{maxScore}',
              to_jsonb(GREATEST(COALESCE((${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb->>'maxScore')::double precision, 0), ${result.score}))
            )::text`,
          })
          .where(eq(pgSchema.memoryItemsPostgres.id, result.item.id));
      }),
    );
  }
}

export const _testAppMemory = {
  conversationIdForChannel,
  itemMatchesSubjectBoundary,
  sqlThreadIdentityFilter,
  sqlThreadVisibilityFilter,
  normalizeSubject,
  visibleSubjectFilters,
};
