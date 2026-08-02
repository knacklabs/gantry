import { normalizeSubject, visibleSubjectFilters, } from './app-memory-boundaries.js';
import { hashText, parseItemSource, toAppItem, } from './app-memory-canonical-codec.js';
import { nowIso as currentIso } from '../shared/time/datetime.js';
import { withStatementTimeout } from './app-memory-service-query-helpers.js';
import { runHybridRecall } from './app-memory-recall-hybrid.js';
const QUERY_EMBEDDING_TIMEOUT_MS = 1500;
function nowIso() {
    return currentIso();
}
function visibleSubjectFilterCount(input) {
    const context = normalizeSubject(input);
    const allowed = new Set(input.subjectTypes || ['user', 'group', 'channel', 'common']);
    let count = 0;
    if (input.includeCommon !== false && allowed.has('common'))
        count += 1;
    if (context.userId && allowed.has('user'))
        count += 1;
    if (context.groupId && allowed.has('group'))
        count += 1;
    if (context.channelId && allowed.has('channel'))
        count += 1;
    if (count === 0 && allowed.has(context.subjectType))
        count += 1;
    return count;
}
async function embedQueryWithDeadline(embedQuery, query, parentSignal) {
    parentSignal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error('memory recall query embedding timed out'));
    }, QUERY_EMBEDDING_TIMEOUT_MS);
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    try {
        return await embedQuery(query, controller.signal);
    }
    catch (error) {
        if (parentSignal?.aborted)
            throw error;
        if (controller.signal.aborted)
            return null;
        throw error;
    }
    finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener('abort', abortFromParent);
    }
}
export function describeAppMemorySearchOutcome(input, resultCount) {
    const resolvedSubject = normalizeSubject(input);
    if (resultCount > 0) {
        return { resolvedSubject };
    }
    return {
        resolvedSubject,
        empty_reason: visibleSubjectFilterCount(input) === 0
            ? 'no_visible_subject_filters'
            : 'no_matching_memory',
    };
}
export async function queryAppMemoryItems(db, input, ranked, deps, options = {}) {
    options.signal?.throwIfAborted();
    const { and, asc, desc, eq, or, sql } = deps.sqlOps;
    const context = normalizeSubject(input);
    const query = input.query?.trim() || '';
    const i = deps.schema.memoryItemsPostgres;
    if (ranked && query && deps.embeddings?.enabled) {
        const queryVector = await embedQueryWithDeadline(deps.embeddings.embedQuery, query, options.signal);
        options.signal?.throwIfAborted();
        if (queryVector) {
            return runHybridRecall(db, input, queryVector, {
                schema: { memoryItemsPostgres: i },
                sqlOps: deps.sqlOps,
                embeddings: {
                    provider: deps.embeddings.provider,
                    model: deps.embeddings.model,
                    dimensions: deps.embeddings.dimensions,
                    memoryItemEmbeddingsPostgres: deps.embeddings.memoryItemEmbeddingsPostgres,
                },
            }, options);
        }
    }
    const valueText = sql `${i.valueJson}->>'value'`;
    const whyText = sql `${i.valueJson}->>'why'`;
    const document = sql `to_tsvector('english', ${i.key} || ' ' || COALESCE(${valueText}, '') || ' ' || COALESCE(${whyText}, ''))`;
    const searchQuery = sql `plainto_tsquery('english', ${query})`;
    const lexicalScore = query
        ? sql `ts_rank_cd(${document}, ${searchQuery})`
        : sql `0`;
    const visible = visibleSubjectFilters(i, input);
    const vectorScore = sql `0`;
    const combinedScore = sql `(${lexicalScore} * 0.65) + (${i.confidence} * 0.10)`;
    const rows = (await withStatementTimeout(db, options.statementTimeoutMs, (timeoutMs) => sql `select set_config('statement_timeout', ${String(timeoutMs)}, true)`, (queryDb) => queryDb
        .select({
        row: i,
        lexicalScore,
        vectorScore,
        score: ranked ? combinedScore : sql `${i.confidence}`,
    })
        .from(i)
        .where(and(eq(i.status, 'active'), eq(i.appId, context.appId), visible.length === 0
        ? sql `false`
        : visible.length === 1
            ? visible[0]
            : or(...visible), query ? sql `${document} @@ ${searchQuery}` : undefined))
        .orderBy(ranked ? desc(combinedScore) : desc(i.updatedAt), desc(i.updatedAt), asc(i.key), asc(i.id))
        .limit(Math.max(1, Math.min(input.limit || 20, 100)))));
    options.signal?.throwIfAborted();
    return rows.map((row) => ({
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
export function toAppMemoryItems(rows) {
    return rows.map((row) => toAppItem(row.row));
}
export function toAppMemorySearchResults(rows) {
    return rows.map((row) => ({
        item: toAppItem(row.row),
        score: row.score,
        lexicalScore: row.lexicalScore,
        vectorScore: row.vectorScore,
        reasons: row.reasons,
    }));
}
export async function recordAppMemoryRecallEvents(db, input, results, deps) {
    if (results.length === 0)
        return;
    const { sql } = deps.sqlOps;
    const context = normalizeSubject(input);
    const queryHash = hashText(input.query || '');
    const createdAt = nowIso();
    await db.insert(deps.schema.memoryRecallEventsPostgres).values(results.map((result) => ({
        appId: context.appId,
        agentId: context.agentId,
        itemId: result.item.id,
        queryHash,
        score: result.score,
        subjectJson: JSON.stringify(context),
        createdAt,
    })));
    const uniqueResults = new Map();
    for (const result of results) {
        uniqueResults.set(result.item.id, Math.max(result.score, uniqueResults.get(result.item.id) ?? 0));
    }
    const items = deps.schema.memoryItemsPostgres;
    const idColumn = items.id;
    const scoreCases = [...uniqueResults].map(([id, score]) => sql `WHEN ${idColumn} = ${id} THEN ${score}`);
    const ids = [...uniqueResults.keys()].map((id) => sql `${id}`);
    await db
        .update(items)
        .set({
        sourceRefJson: sql `jsonb_set(
          jsonb_set(
            jsonb_set(
              ${items.sourceRefJson},
              '{retrievalCount}',
              to_jsonb(COALESCE((${items.sourceRefJson}->>'retrievalCount')::int, 0) + 1)
            ),
            '{totalScore}',
            to_jsonb(COALESCE((${items.sourceRefJson}->>'totalScore')::double precision, 0) + (CASE ${sql.join(scoreCases, sql ` `)} ELSE 0.0 END)::double precision)
          ),
          '{maxScore}',
          to_jsonb(GREATEST(COALESCE((${items.sourceRefJson}->>'maxScore')::double precision, 0), (CASE ${sql.join(scoreCases, sql ` `)} ELSE 0.0 END)::double precision))
        )`,
    })
        .where(sql `${idColumn} IN (${sql.join(ids, sql `, `)})`);
}
