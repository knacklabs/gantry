import { and, eq, isNull, sql } from 'drizzle-orm';

import type {
  ConversationHistoryCoverage,
  ConversationHistoryCoverageReadResult,
  ConversationHistoryCoverageRepository,
  ConversationHistoryCoverageWriteResult,
  ConversationHistoryScope,
} from '../../../../domain/ports/conversation-history-coverage.js';
import type { ProviderAccountId } from '../../../../domain/provider/provider.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const HISTORY_COVERAGE_GENERATION_PREFIX = 'history_coverage:';

function generationKey(providerAccountId: ProviderAccountId): string {
  return `${HISTORY_COVERAGE_GENERATION_PREFIX}${providerAccountId}`;
}

function scopeId(scope: ConversationHistoryScope): string | null {
  return scope.kind === 'thread' ? scope.id : null;
}

function normalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function safeGeneration(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${context} returned an invalid generation: ${String(value)}`,
    );
  }
  return value;
}

type CoverageRow =
  typeof pgSchema.conversationHistoryCoveragePostgres.$inferSelect;

function mapCoverage(row: CoverageRow): ConversationHistoryCoverage {
  return {
    providerAccountId:
      row.providerAccountId as ConversationHistoryCoverage['providerAccountId'],
    conversationId:
      row.conversationId as ConversationHistoryCoverage['conversationId'],
    scope:
      row.scopeKind === 'thread' && row.scopeId !== null
        ? { kind: 'thread', id: row.scopeId }
        : { kind: 'channel' },
    complete: row.complete,
    ...(row.coveredThroughExternalId !== null
      ? { coveredThroughExternalId: row.coveredThroughExternalId }
      : {}),
    ...(row.coveredThroughTimestamp
      ? {
          coveredThroughTimestamp: normalizeTimestamp(
            row.coveredThroughTimestamp,
          ),
        }
      : {}),
    providerGeneration: safeGeneration(
      row.providerGeneration,
      'Conversation history coverage read',
    ),
    recordedAt: normalizeTimestamp(row.recordedAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
  };
}

export class PostgresConversationHistoryCoverageRepository implements ConversationHistoryCoverageRepository {
  constructor(private readonly db: CanonicalDb) {}

  async readProviderGeneration(
    providerAccountId: ProviderAccountId,
  ): Promise<number> {
    const generations = pgSchema.runtimeLeaseGenerationsPostgres;
    const rows = await this.db
      .select({ generation: generations.generation })
      .from(generations)
      .where(eq(generations.leaseKey, generationKey(providerAccountId)))
      .limit(1);
    return safeGeneration(
      rows[0]?.generation ?? 0,
      'Conversation history generation read',
    );
  }

  async bumpProviderGeneration(
    providerAccountId: ProviderAccountId,
  ): Promise<number> {
    const generations = pgSchema.runtimeLeaseGenerationsPostgres;
    const key = generationKey(providerAccountId);
    const rows = await this.db
      .insert(generations)
      .values({
        leaseKey: key,
        generation: 1,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: generations.leaseKey,
        set: {
          generation: sql`${generations.generation} + 1`,
          holder: null,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ generation: generations.generation });
    return safeGeneration(
      rows[0]?.generation ?? -1,
      'Conversation history generation bump',
    );
  }

  async getCoverage(
    input: Parameters<ConversationHistoryCoverageRepository['getCoverage']>[0],
  ): Promise<ConversationHistoryCoverageReadResult> {
    const coverage = pgSchema.conversationHistoryCoveragePostgres;
    const generations = pgSchema.runtimeLeaseGenerationsPostgres;
    const id = scopeId(input.scope);
    const rows = await this.db
      .select({ coverage, currentGeneration: generations.generation })
      .from(sql`(VALUES (1)) AS coverage_seed(value)`)
      .leftJoin(
        generations,
        eq(generations.leaseKey, generationKey(input.providerAccountId)),
      )
      .leftJoin(
        coverage,
        and(
          eq(coverage.providerAccountId, input.providerAccountId),
          eq(coverage.conversationId, input.conversationId),
          eq(coverage.scopeKind, input.scope.kind),
          id === null ? isNull(coverage.scopeId) : eq(coverage.scopeId, id),
        ),
      )
      .limit(1);
    const row = rows[0];
    const currentProviderGeneration = safeGeneration(
      row?.currentGeneration ?? 0,
      'Conversation history generation-aware coverage read',
    );
    const mapped = row?.coverage ? mapCoverage(row.coverage) : null;
    return {
      coverage: mapped,
      currentProviderGeneration,
      isCurrentGeneration:
        mapped !== null &&
        mapped.providerGeneration === currentProviderGeneration,
    };
  }

  async upsertCoverage(
    input: Parameters<
      ConversationHistoryCoverageRepository['upsertCoverage']
    >[0],
  ): Promise<ConversationHistoryCoverageWriteResult> {
    return this.db.transaction(async (tx) => {
      const generations = pgSchema.runtimeLeaseGenerationsPostgres;
      const key = generationKey(input.providerAccountId);
      await tx
        .insert(generations)
        .values({ leaseKey: key, generation: 0, updatedAt: input.updatedAt })
        .onConflictDoNothing({ target: generations.leaseKey });
      const locked = await tx
        .select({ generation: generations.generation })
        .from(generations)
        .where(eq(generations.leaseKey, key))
        .for('update')
        .limit(1);
      const currentGeneration = safeGeneration(
        locked[0]?.generation ?? -1,
        'Conversation history coverage fence',
      );
      if (currentGeneration !== input.providerGeneration) {
        return { status: 'stale', currentGeneration };
      }

      const conversations = pgSchema.conversationsPostgres;
      const owner = await tx
        .select({ providerAccountId: conversations.providerAccountId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update')
        .limit(1);
      if (owner[0]?.providerAccountId !== input.providerAccountId) {
        throw new Error(
          `Conversation ${input.conversationId} is not owned by Provider Account ${input.providerAccountId}`,
        );
      }

      const coverage = pgSchema.conversationHistoryCoveragePostgres;
      const rows = await tx
        .insert(coverage)
        .values({
          providerAccountId: input.providerAccountId,
          conversationId: input.conversationId,
          scopeKind: input.scope.kind,
          scopeId: scopeId(input.scope),
          complete: input.complete,
          coveredThroughExternalId: input.coveredThroughExternalId ?? null,
          coveredThroughTimestamp: input.coveredThroughTimestamp ?? null,
          providerGeneration: input.providerGeneration,
          recordedAt: input.recordedAt,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            coverage.providerAccountId,
            coverage.conversationId,
            coverage.scopeKind,
            coverage.scopeId,
          ],
          set: {
            complete: input.complete,
            coveredThroughExternalId: input.coveredThroughExternalId ?? null,
            coveredThroughTimestamp: input.coveredThroughTimestamp ?? null,
            providerGeneration: input.providerGeneration,
            recordedAt: input.recordedAt,
            updatedAt: input.updatedAt,
          },
        })
        .returning();
      const written = rows[0];
      if (!written) {
        throw new Error('Conversation history coverage upsert returned no row');
      }
      return { status: 'written', coverage: mapCoverage(written) };
    });
  }
}
