import type { ConsolidationResult } from './memory-consolidation.js';
import type { MemoryProvider } from './memory-provider.js';
import type { MemoryItem } from './memory-types.js';

export interface GroupStats {
  maxRetrievalCount: number;
  totalItems: number;
}

export interface ScoredItem {
  item: MemoryItem;
  score: number;
  signals: {
    frequency: number;
    relevance: number;
    diversity: number;
    recency: number;
    consolidation: number;
    confidence: number;
    uniqueQueries: number;
  };
}

export interface DreamingResult {
  groupFolder: string;
  totalItems: number;
  scoredItems: number;
  promotedCount: number;
  decayedCount: number;
  retiredCount: number;
  consolidation: ConsolidationResult | null;
  topPromoted: Array<{ key: string; score: number }>;
  durationMs: number;
}

interface RunDreamingSweepArgs {
  groupFolder: string;
  store: Pick<
    MemoryProvider,
    | 'listActiveItems'
    | 'adjustConfidence'
    | 'getItemById'
    | 'pinItem'
    | 'softDeleteItem'
    | 'recordEvent'
  >;
  enabled: boolean;
  consolidationEnabled: boolean;
  consolidateGroupMemory: (groupFolder: string) => Promise<ConsolidationResult>;
  retentionPinThreshold: number;
  promotionThreshold: number;
  decayThreshold: number;
  minRecalls: number;
  minUniqueQueries: number;
  confidenceBoost: number;
  confidenceDecay: number;
}

export async function runDreamingSweep(
  args: RunDreamingSweepArgs,
): Promise<DreamingResult> {
  const startedAt = Date.now();
  const items = args.store.listActiveItems(args.groupFolder);

  if (!args.enabled) {
    return {
      groupFolder: args.groupFolder,
      totalItems: items.length,
      scoredItems: 0,
      promotedCount: 0,
      decayedCount: 0,
      retiredCount: 0,
      consolidation: null,
      topPromoted: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const groupStats: GroupStats = {
    maxRetrievalCount: items.reduce(
      (max, item) => Math.max(max, item.retrieval_count),
      1,
    ),
    totalItems: items.length,
  };

  const scoredItems: ScoredItem[] = [];
  for (const item of items) {
    if (item.retrieval_count < args.minRecalls) continue;

    const uniqueQueries = uniqueQueryCount(item);
    if (uniqueQueries < args.minUniqueQueries) continue;

    const scored = computePromotionScore(item, groupStats, uniqueQueries);
    scoredItems.push(scored);
  }

  const promoted = scoredItems
    .filter((entry) => entry.score >= args.promotionThreshold)
    .sort((a, b) => b.score - a.score);
  const decayed = scoredItems
    .filter(
      (entry) => entry.score <= args.decayThreshold && !entry.item.is_pinned,
    )
    .sort((a, b) => a.score - b.score);

  if (promoted.length > 0 && args.confidenceBoost > 0) {
    args.store.adjustConfidence(
      promoted.map((entry) => entry.item.id),
      args.confidenceBoost,
    );
  }

  for (const promotedItem of promoted) {
    const latest = args.store.getItemById(promotedItem.item.id);
    if (!latest) continue;
    if (!latest.is_pinned && latest.confidence >= args.retentionPinThreshold) {
      args.store.pinItem(latest.id, true);
    }
  }

  if (decayed.length > 0 && args.confidenceDecay > 0) {
    args.store.adjustConfidence(
      decayed.map((entry) => entry.item.id),
      -Math.abs(args.confidenceDecay),
    );
  }

  let retiredCount = 0;
  for (const decayedItem of decayed) {
    const latest = args.store.getItemById(decayedItem.item.id);
    if (!latest || latest.is_pinned) continue;
    if (latest.confidence < 0.1) {
      args.store.softDeleteItem(latest.id);
      retiredCount += 1;
    }
  }

  let consolidation: ConsolidationResult | null = null;
  if (args.consolidationEnabled) {
    consolidation = await args.consolidateGroupMemory(args.groupFolder);
  }

  const result: DreamingResult = {
    groupFolder: args.groupFolder,
    totalItems: items.length,
    scoredItems: scoredItems.length,
    promotedCount: promoted.length,
    decayedCount: decayed.length,
    retiredCount,
    consolidation,
    topPromoted: promoted.slice(0, 5).map((entry) => ({
      key: entry.item.key,
      score: round3(entry.score),
    })),
    durationMs: Date.now() - startedAt,
  };

  args.store.recordEvent(
    'dreaming_completed',
    'memory_dreaming',
    args.groupFolder,
    {
      ...result,
      thresholds: {
        promotion: args.promotionThreshold,
        decay: args.decayThreshold,
        min_recalls: args.minRecalls,
        min_unique_queries: args.minUniqueQueries,
      },
    },
  );

  return result;
}

function computePromotionScore(
  item: MemoryItem,
  groupStats: GroupStats,
  uniqueQueries = uniqueQueryCount(item),
): ScoredItem {
  const frequency = normalizeLog(
    item.retrieval_count,
    groupStats.maxRetrievalCount,
  );
  const relevance =
    item.retrieval_count > 0 && item.max_score > 0
      ? clamp(item.total_score / item.retrieval_count)
      : 0;
  const diversity = clamp(uniqueQueries / Math.max(1, item.retrieval_count));
  const recency = computeRecencyScore(item.last_retrieved_at, 30);
  const consolidation = item.retrieval_count >= 3 && uniqueQueries >= 2 ? 1 : 0;
  const confidence = clamp(item.confidence);

  const score =
    0.24 * frequency +
    0.3 * relevance +
    0.15 * diversity +
    0.15 * recency +
    0.1 * consolidation +
    0.06 * confidence;

  return {
    item,
    score: clamp(score),
    signals: {
      frequency,
      relevance,
      diversity,
      recency,
      consolidation,
      confidence,
      uniqueQueries,
    },
  };
}

function uniqueQueryCount(item: MemoryItem): number {
  return new Set(parseStringArray(item.query_hashes_json)).size;
}

function computeRecencyScore(
  lastRetrievedAt: string | null,
  windowDays: number,
): number {
  if (!lastRetrievedAt) return 0;
  const lastRetrievedMs = Date.parse(lastRetrievedAt);
  if (!Number.isFinite(lastRetrievedMs)) return 0;

  const ageDays = Math.max(0, (Date.now() - lastRetrievedMs) / 86_400_000);
  return clamp(1 - ageDays / Math.max(1, windowDays));
}

function normalizeLog(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0;
  return clamp(Math.log1p(value) / Math.log1p(maxValue));
}

function parseStringArray(value: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
