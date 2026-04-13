import { MEMORY_SOURCE_TYPE_BOOSTS } from '../core/config.js';
import { MemorySearchResult } from './memory-types.js';

export interface FuseOptions {
  minScore?: number;
  halfLifeDays?: number;
  mmrLambda?: number;
  lexicalWeight?: number;
  vectorWeight?: number;
  sourceTypeBoosts?: Record<string, number>;
}

export function fuseSearchResults(
  lexical: MemorySearchResult[],
  vector: MemorySearchResult[],
  limit: number,
  options: FuseOptions = {},
): MemorySearchResult[] {
  const byId = new Map<string, MemorySearchResult>();

  // Reciprocal-rank fusion with lexical/vector channels.
  const K = 60;
  const lexicalWeight = Math.max(0, options.lexicalWeight ?? 1);
  const vectorWeight = Math.max(0, options.vectorWeight ?? 1);
  const minScore = Math.max(0, options.minScore ?? 0);
  const halfLifeDays = Math.max(
    1,
    options.halfLifeDays ?? Number.POSITIVE_INFINITY,
  );
  const sourceTypeBoosts = {
    ...MEMORY_SOURCE_TYPE_BOOSTS,
    ...(options.sourceTypeBoosts || {}),
  };
  const mmrLambda =
    options.mmrLambda === undefined
      ? null
      : Math.max(0, Math.min(1, options.mmrLambda));

  lexical.forEach((item, index) => {
    const current = byId.get(item.id) || { ...item, fused_score: 0 };
    current.lexical_score = item.lexical_score;
    current.fused_score += lexicalWeight * (1 / (K + index + 1));
    byId.set(item.id, current);
  });

  vector.forEach((item, index) => {
    const current = byId.get(item.id) || { ...item, fused_score: 0 };
    current.vector_score = item.vector_score;
    current.fused_score += vectorWeight * (1 / (K + index + 1));
    byId.set(item.id, current);
  });

  const boosted = [...byId.values()].map((item) => {
    const boost = Math.max(0, sourceTypeBoosts[item.source_type] ?? 1);
    const decay = computeTemporalDecay(item.created_at, halfLifeDays);
    return {
      ...item,
      fused_score: item.fused_score * boost * decay,
    };
  });

  const ranked = boosted
    .filter((item) => item.fused_score >= minScore)
    .sort((a, b) => b.fused_score - a.fused_score);

  if (mmrLambda === null) {
    return ranked.slice(0, limit);
  }
  return applyMmr(ranked, limit, mmrLambda);
}

function computeTemporalDecay(createdAt: string, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays)) return 1;

  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 1;

  const ageMs = Math.max(0, Date.now() - createdMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function applyMmr(
  ranked: MemorySearchResult[],
  limit: number,
  lambda: number,
): MemorySearchResult[] {
  if (ranked.length <= 1 || limit <= 1) return ranked.slice(0, limit);

  const selected: MemorySearchResult[] = [];
  const remaining = [...ranked];
  const tokenCache = new Map<string, Set<string>>();
  const maxFusedScore = Math.max(
    1e-9,
    ...ranked.map((item) => item.fused_score || 0),
  );

  while (selected.length < limit && remaining.length > 0) {
    if (selected.length === 0) {
      selected.push(remaining.shift()!);
      continue;
    }

    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRelevance = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      const relevance = candidate.fused_score / maxFusedScore;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        const similarity = jaccardSimilarity(
          getTokenSet(tokenCache, candidate),
          getTokenSet(tokenCache, chosen),
        );
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (
        mmrScore > bestScore ||
        (mmrScore === bestScore && relevance > bestRelevance)
      ) {
        bestScore = mmrScore;
        bestIndex = i;
        bestRelevance = relevance;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }

  return selected;
}

function getTokenSet(
  tokenCache: Map<string, Set<string>>,
  item: MemorySearchResult,
): Set<string> {
  const cached = tokenCache.get(item.id);
  if (cached) return cached;
  const tokens = new Set(
    item.text
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) || [],
  );
  tokenCache.set(item.id, tokens);
  return tokens;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}
