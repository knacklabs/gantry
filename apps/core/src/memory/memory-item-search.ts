import type Database from 'better-sqlite3';

import { MemoryScope, MemorySearchResult } from './memory-types.js';

export function createItemSearcher(db: Database.Database) {
  return (
    query: string,
    groupFolder: string,
    limit: number,
    userId?: string,
    topicId?: string,
  ): MemorySearchResult[] =>
    searchMemoryItemsByText(db, query, groupFolder, limit, userId, topicId);
}

export function buildFtsMatchQuery(input: string): string | null {
  const tokens = tokenizeMemorySearch(input);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

function searchMemoryItemsByText(
  db: Database.Database,
  query: string,
  groupFolder: string,
  limit: number,
  userId?: string,
  topicId?: string,
): MemorySearchResult[] {
  const tokens = tokenizeMemorySearch(query).slice(0, 8);
  if (tokens.length === 0) return [];

  const matchClauses = tokens.map(
    (_, index) =>
      `(lower(kind) LIKE @token_${index} OR lower(key) LIKE @token_${index} OR lower(value) LIKE @token_${index})`,
  );
  const rows = db
    .prepare(
      `SELECT id, scope, group_folder, kind, key, value, confidence, updated_at
       FROM memory_items
       WHERE is_deleted = 0
         AND (scope = 'global'
           OR (group_folder = @group_folder
             AND (scope != 'user' OR (@user_id IS NOT NULL AND user_id = @user_id))))
         AND (scope = 'user' OR COALESCE(topic_id, '') = COALESCE(@topic_id, ''))
         AND (${matchClauses.join(' OR ')})
       ORDER BY updated_at DESC`,
    )
    .all({
      group_folder: groupFolder,
      user_id: userId || null,
      topic_id: topicId || null,
      ...Object.fromEntries(
        tokens.map((token, index) => [
          `token_${index}`,
          `%${token.toLowerCase()}%`,
        ]),
      ),
    }) as Record<string, unknown>[];

  return rows
    .map((row) => toSearchResult(row, tokens))
    .filter((result): result is MemorySearchResult => result !== null)
    .sort((a, b) => b.fused_score - a.fused_score)
    .slice(0, limit);
}

function tokenizeMemorySearch(input: string): string[] {
  return input.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function toSearchResult(
  row: Record<string, unknown>,
  tokens: string[],
): MemorySearchResult | null {
  const kind = String(row.kind);
  const key = String(row.key);
  const value = String(row.value);
  const haystack = `${kind} ${key} ${value}`.toLowerCase();
  const matched = tokens.filter((token) =>
    haystack.includes(token.toLowerCase()),
  ).length;
  if (matched === 0) return null;

  const scope = row.scope as MemoryScope;
  const lexicalScore = (matched / tokens.length) * Number(row.confidence);
  return {
    id: String(row.id),
    source_type: 'memory_item',
    source_path: `memory:${scope}:${kind}:${key}`,
    text: value,
    scope,
    group_folder: String(row.group_folder),
    created_at: String(row.updated_at),
    lexical_score: lexicalScore,
    vector_score: 0,
    fused_score: lexicalScore,
  };
}
