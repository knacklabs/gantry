import {
  normalizeSubject,
  visibleSubjectFilters,
} from './app-memory-boundaries.js';
import { parseItemSource, toAppItem } from './app-memory-canonical-codec.js';
import { embeddingContentHash } from './app-memory-service-helpers.js';
import type { AppMemorySearchInput } from './memory-types.js';

export const RRF_K = 60;

/** Per-branch candidate fan-out for Reciprocal Rank Fusion. */
export function hybridCandidateLimit(limit: number): number {
  return Math.min(100, Math.max(limit * 4, 20));
}

export interface HybridRecallDeps {
  schema: { memoryItemsPostgres: any };
  sqlOps: {
    and: (...args: any[]) => any;
    asc: (value: any) => any;
    desc: (value: any) => any;
    eq: (left: any, right: any) => any;
    or: (...args: any[]) => any;
    sql: any;
  };
  embeddings: {
    provider: string;
    model: string;
    dimensions: number;
    memoryItemEmbeddingsPostgres: any;
  };
}

export interface HybridRankedRow {
  row: any;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  reasons: string[];
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function visibleClause(
  i: any,
  input: AppMemorySearchInput,
  sqlOps: HybridRecallDeps['sqlOps'],
): any {
  const visible = visibleSubjectFilters(i, input);
  if (visible.length === 0) return sqlOps.sql`false`;
  if (visible.length === 1) return visible[0];
  return sqlOps.or(...visible);
}

async function withHybridSearchSettings<T>(
  db: any,
  timeoutMs: number | undefined,
  sql: HybridRecallDeps['sqlOps']['sql'],
  work: (db: any) => Promise<T>,
): Promise<T> {
  const boundedTimeoutMs =
    timeoutMs === undefined || !Number.isFinite(timeoutMs)
      ? undefined
      : Math.max(1, Math.floor(timeoutMs));
  return db.transaction(async (tx: any) => {
    await tx.execute(
      sql`select set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '200', true)`,
    );
    if (boundedTimeoutMs !== undefined) {
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(boundedTimeoutMs)}, true)`,
      );
    }
    return work(tx);
  });
}

/**
 * Hybrid recall: fuse lexical (full-text) and vector (pgvector cosine) candidate
 * lists with Reciprocal Rank Fusion. Returns at most `input.limit` ranked rows.
 * Callers only reach here when embeddings are enabled and a query embedding was
 * produced; otherwise recall stays lexical-only.
 */
export async function runHybridRecall(
  db: any,
  input: AppMemorySearchInput,
  queryVector: number[],
  deps: HybridRecallDeps,
  options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
): Promise<HybridRankedRow[]> {
  options.signal?.throwIfAborted();
  const { and, asc, desc, eq, sql } = deps.sqlOps;
  const context = normalizeSubject(input);
  const query = input.query?.trim() || '';
  const i = deps.schema.memoryItemsPostgres;
  const emb = deps.embeddings.memoryItemEmbeddingsPostgres;
  const limit = Math.max(1, Math.min(input.limit || 20, 100));
  const candidateLimit = hybridCandidateLimit(limit);
  const visible = visibleClause(i, input, deps.sqlOps);

  const valueText = sql`COALESCE(${i.valueJson}->>'value', '')`;
  const whyText = sql`COALESCE(${i.valueJson}->>'why', '')`;
  const currentContentHash = sql`encode(digest(${i.key} || E'\n' || ${valueText} || E'\n' || ${whyText}, 'sha256'), 'hex')`;
  const document = sql`to_tsvector('english', ${i.key} || ' ' || ${valueText} || ' ' || ${whyText})`;
  const searchQuery = sql`plainto_tsquery('english', ${query})`;
  const lexicalScoreExpr = sql`ts_rank_cd(${document}, ${searchQuery})`;
  const distanceExpr = sql<number>`${emb.embedding} <=> ${toVectorLiteral(queryVector)}::vector`;

  const { lexicalRows, vectorRows } = await withHybridSearchSettings(
    db,
    options.statementTimeoutMs,
    sql,
    async (queryDb: any) => {
      const lexical = query
        ? ((await queryDb
            .select({ row: i, lexicalScore: lexicalScoreExpr })
            .from(i)
            .where(
              and(
                eq(i.status, 'active'),
                eq(i.appId, context.appId),
                visible,
                sql`${document} @@ ${searchQuery}`,
              ),
            )
            .orderBy(desc(lexicalScoreExpr))
            .limit(candidateLimit)) as Array<{
            row: any;
            lexicalScore: number;
          }>)
        : [];
      const vector = (await queryDb
        .select({
          row: i,
          distance: distanceExpr,
          contentHash: emb.contentHash,
        })
        .from(emb)
        .innerJoin(i, eq(emb.itemId, i.id))
        .where(
          and(
            eq(i.status, 'active'),
            eq(i.appId, context.appId),
            visible,
            eq(emb.provider, deps.embeddings.provider),
            eq(emb.model, deps.embeddings.model),
            eq(emb.dimensions, deps.embeddings.dimensions),
            eq(emb.status, 'ready'),
            sql`${emb.embedding} is not null`,
            sql`${emb.contentHash} = ${currentContentHash}`,
          ),
        )
        .orderBy(asc(distanceExpr))
        .limit(candidateLimit)) as Array<{
        row: any;
        distance: number;
        contentHash: string;
      }>;
      return { lexicalRows: lexical, vectorRows: vector };
    },
  );
  options.signal?.throwIfAborted();

  const merged = new Map<
    string,
    { row: any; lexicalScore: number; vectorScore: number; rrf: number }
  >();
  const ensure = (row: any) => {
    const existing = merged.get(row.id);
    if (existing) return existing;
    const created = { row, lexicalScore: 0, vectorScore: 0, rrf: 0 };
    merged.set(row.id, created);
    return created;
  };

  lexicalRows.forEach((candidate, index) => {
    const entry = ensure(candidate.row);
    entry.lexicalScore = Number(candidate.lexicalScore || 0);
    entry.rrf += 1 / (RRF_K + index + 1);
  });

  for (let index = 0; index < vectorRows.length; index += 1) {
    const candidate = vectorRows[index]!;
    const item = toAppItem(candidate.row);
    const currentHash = embeddingContentHash({
      key: item.key,
      value: item.value,
      why: item.why ?? null,
    });
    if (currentHash !== candidate.contentHash) continue; // stale vector for changed text
    const entry = ensure(candidate.row);
    entry.vectorScore = Math.max(0, 1 - Number(candidate.distance || 0));
    entry.rrf += 1 / (RRF_K + index + 1);
  }

  const ranked = [...merged.values()].map((entry) => {
    const confidence = Number(entry.row.confidence || 0);
    const reasons = [
      entry.lexicalScore
        ? entry.lexicalScore < 0.01
          ? 'keyword'
          : 'lexical'
        : '',
      entry.vectorScore ? 'semantic' : '',
      parseItemSource(entry.row).isPinned ? 'pinned' : '',
    ].filter(Boolean);
    return {
      row: entry.row,
      lexicalScore: entry.lexicalScore,
      vectorScore: entry.vectorScore,
      score: entry.rrf + confidence * 0.001,
      reasons,
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const updatedCompare = String(b.row.updatedAt).localeCompare(
      String(a.row.updatedAt),
    );
    if (updatedCompare !== 0) return updatedCompare;
    const keyCompare = String(a.row.key).localeCompare(String(b.row.key));
    if (keyCompare !== 0) return keyCompare;
    return String(a.row.id).localeCompare(String(b.row.id));
  });

  return ranked.slice(0, limit);
}
