import {
  normalizeSubject,
  visibleSubjectFilters,
} from './app-memory-boundaries.js';
import {
  hashText,
  parseItemSource,
  toAppItem,
} from './app-memory-canonical-codec.js';
import type {
  AppMemoryItem,
  AppMemorySearchInput,
  AppMemorySearchResult,
  NormalizedMemorySubject,
} from './memory-types.js';
import { nowIso as currentIso } from '../shared/time/datetime.js';
import { withStatementTimeout } from './app-memory-service-query-helpers.js';

export type AppMemorySearchEmptyReason =
  | 'no_visible_subject_filters'
  | 'no_matching_memory';

export interface AppMemorySearchOutcome {
  resolvedSubject: NormalizedMemorySubject;
  empty_reason?: AppMemorySearchEmptyReason;
}

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
  return currentIso();
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

function visibleSubjectFilterCount(input: AppMemorySearchInput): number {
  const context = normalizeSubject(input);
  const allowed = new Set(
    input.subjectTypes || ['user', 'group', 'channel', 'common'],
  );
  let count = 0;
  if (input.includeCommon !== false && allowed.has('common')) count += 1;
  if (context.userId && allowed.has('user')) count += 1;
  if (context.groupId && allowed.has('group')) count += 1;
  if (context.channelId && allowed.has('channel')) count += 1;
  if (count === 0 && allowed.has(context.subjectType)) count += 1;
  return count;
}

export function describeAppMemorySearchOutcome(
  input: AppMemorySearchInput,
  resultCount: number,
): AppMemorySearchOutcome {
  const resolvedSubject = normalizeSubject(input);
  if (resultCount > 0) {
    return { resolvedSubject };
  }
  return {
    resolvedSubject,
    empty_reason:
      visibleSubjectFilterCount(input) === 0
        ? 'no_visible_subject_filters'
        : 'no_matching_memory',
  };
}

export async function queryAppMemoryItems(
  db: any,
  input: AppMemorySearchInput,
  ranked: boolean,
  deps: AppMemoryRecallDeps,
  options: {
    threadScope?: 'visible' | 'exact';
    signal?: AbortSignal;
    statementTimeoutMs?: number;
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
  options.signal?.throwIfAborted();
  const { and, asc, desc, eq, or, sql } = deps.sqlOps;
  const context = normalizeSubject(input);
  const query = input.query?.trim() || '';
  const i = deps.schema.memoryItemsPostgres;
  const valueText = sql`${i.valueJson}->>'value'`;
  const whyText = sql`${i.valueJson}->>'why'`;
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
  const rows = (await withStatementTimeout(
    db,
    options.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (queryDb) =>
      queryDb
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
        .limit(Math.max(1, Math.min(input.limit || 20, 100))),
  )) as Array<{
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
  }>;
  options.signal?.throwIfAborted();
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

export function toAppMemoryItems(rows: Array<{ row: any }>): AppMemoryItem[] {
  return rows.map((row) => toAppItem(row.row));
}

export function toAppMemorySearchResults(
  rows: Array<{
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
    reasons: string[];
  }>,
): AppMemorySearchResult[] {
  return rows.map((row) => ({
    item: toAppItem(row.row),
    score: row.score,
    lexicalScore: row.lexicalScore,
    vectorScore: row.vectorScore,
    reasons: row.reasons,
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
              ${items.sourceRefJson},
              '{retrievalCount}',
              to_jsonb(COALESCE((${items.sourceRefJson}->>'retrievalCount')::int, 0) + 1)
            ),
            '{totalScore}',
            to_jsonb(COALESCE((${items.sourceRefJson}->>'totalScore')::double precision, 0) + (CASE ${sql.join(scoreCases, sql` `)} ELSE 0 END))
          ),
          '{maxScore}',
          to_jsonb(GREATEST(COALESCE((${items.sourceRefJson}->>'maxScore')::double precision, 0), (CASE ${sql.join(scoreCases, sql` `)} ELSE 0 END)))
        )`,
    })
    .where(sql`${idColumn} IN (${sql.join(ids, sql`, `)})`);
}
