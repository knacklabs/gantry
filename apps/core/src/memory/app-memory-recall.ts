import {
  normalizeSubject,
  visibleSubjectFilters,
} from './app-memory-boundaries.js';
import { hashText, parseItemSource } from './app-memory-canonical-codec.js';
import type {
  AppMemorySearchInput,
  AppMemorySearchResult,
} from './memory-types.js';

interface AppMemoryRecallDeps {
  schema: {
    memoryItemsPostgres: any;
    memoryRecallEventsPostgres: any;
  };
  sqlOps: {
    and: (...args: any[]) => any;
    asc: (value: any) => any;
    desc: (value: any) => any;
    eq: (left: any, right: any) => any;
    isNull: (value: any) => any;
    or: (...args: any[]) => any;
    sql: any;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sqlThreadVisibilityFilter(
  deps: AppMemoryRecallDeps,
  i: any,
  threadId: string | undefined,
  mode: 'visible' | 'exact' = 'visible',
) {
  const { or, eq, isNull } = deps.sqlOps;
  if (mode === 'exact') {
    return threadId ? eq(i.threadId, threadId) : isNull(i.threadId);
  }
  return threadId
    ? or(eq(i.threadId, threadId), isNull(i.threadId))
    : isNull(i.threadId);
}

export async function queryAppMemoryItems(
  db: any,
  input: AppMemorySearchInput,
  ranked: boolean,
  deps: AppMemoryRecallDeps,
  options: {
    threadScope?: 'visible' | 'exact';
  } = {},
): Promise<
  Array<{
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
    reasons: string[];
  }>
> {
  const { and, asc, desc, eq, or, sql } = deps.sqlOps;
  const context = normalizeSubject(input);
  const query = input.query?.trim() || '';
  const i = deps.schema.memoryItemsPostgres;
  const valueText = sql`${i.valueJson}::jsonb->>'value'`;
  const whyText = sql`${i.valueJson}::jsonb->>'why'`;
  const document = sql`to_tsvector('english', ${i.key} || ' ' || COALESCE(${valueText}, '') || ' ' || COALESCE(${whyText}, ''))`;
  const searchQuery = sql`plainto_tsquery('english', ${query})`;
  const lexicalScore = query
    ? sql`ts_rank_cd(${document}, ${searchQuery})`
    : sql`0`;
  const visible = visibleSubjectFilters(i, input);
  const threadFilter = sqlThreadVisibilityFilter(
    deps,
    i,
    context.threadId,
    options.threadScope ?? 'visible',
  );
  const vectorScore = sql`0`;
  const combinedScore = sql`(${lexicalScore} * 0.65) + (${i.confidence} * 0.10)`;
  const rows = await db
    .select({
      row: i,
      lexicalScore,
      vectorScore,
      score: ranked ? combinedScore : sql`${i.confidence}`,
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
    .orderBy(
      ranked ? desc(combinedScore) : desc(i.updatedAt),
      desc(i.updatedAt),
      asc(i.key),
      asc(i.id),
    )
    .limit(Math.max(1, Math.min(input.limit || 20, 100)));
  return rows.map((row: any) => ({
    row: row.row,
    score: Number(row.score || 0),
    lexicalScore: Number(row.lexicalScore || 0),
    vectorScore: Number(row.vectorScore || 0),
    reasons: [
      row.lexicalScore
        ? Number(row.lexicalScore) < 0.01
          ? 'keyword'
          : 'lexical'
        : '',
      row.vectorScore ? 'semantic' : '',
      parseItemSource(row.row).isPinned ? 'pinned' : '',
    ].filter(Boolean),
  }));
}

export async function recordAppMemoryRecallEvents(
  db: any,
  input: AppMemorySearchInput,
  results: AppMemorySearchResult[],
  deps: AppMemoryRecallDeps,
): Promise<void> {
  if (results.length === 0) return;
  const { sql } = deps.sqlOps;
  const context = normalizeSubject(input);
  const queryHash = hashText(input.query || '');
  const createdAt = nowIso();
  await db.insert(deps.schema.memoryRecallEventsPostgres).values(
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
  const uniqueResults = new Map<string, number>();
  for (const result of results) {
    uniqueResults.set(
      result.item.id,
      Math.max(result.score, uniqueResults.get(result.item.id) ?? 0),
    );
  }
  const items = deps.schema.memoryItemsPostgres;
  const idColumn = items.id;
  const scoreCases = [...uniqueResults].map(
    ([id, score]) => sql`WHEN ${idColumn} = ${id} THEN ${score}`,
  );
  const ids = [...uniqueResults.keys()].map((id) => sql`${id}`);
  await db
    .update(items)
    .set({
      sourceRefJson: sql`jsonb_set(
          jsonb_set(
            jsonb_set(
              ${items.sourceRefJson}::jsonb,
              '{retrievalCount}',
              to_jsonb(COALESCE((${items.sourceRefJson}::jsonb->>'retrievalCount')::int, 0) + 1)
            ),
            '{totalScore}',
            to_jsonb(COALESCE((${items.sourceRefJson}::jsonb->>'totalScore')::double precision, 0) + (CASE ${sql.join(scoreCases, sql` `)} ELSE 0 END))
          ),
          '{maxScore}',
          to_jsonb(GREATEST(COALESCE((${items.sourceRefJson}::jsonb->>'maxScore')::double precision, 0), (CASE ${sql.join(scoreCases, sql` `)} ELSE 0 END)))
        )::text`,
    })
    .where(sql`${idColumn} IN (${sql.join(ids, sql`, `)})`);
}
