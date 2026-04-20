import { MODEL_DREAMING, MEMORY_DREAMING_DRY_RUN } from '../core/config.js';
import { runClaudeQuery } from './claude-query.js';
import { MEMORY_DREAM_REVIEW_PROMPT } from './prompts/dream.js';
import type { ConsolidationResult } from './memory-consolidation.js';
import type { MemoryStore } from './memory-store.js';
import { sanitizeOutboundLlmText } from './sensitive-material.js';
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
    MemoryStore,
    | 'listActiveItems'
    | 'adjustConfidence'
    | 'getItemById'
    | 'pinItem'
    | 'patchItem'
    | 'softDeleteItem'
    | 'recordEvent'
  >;
  enabled: boolean;
  consolidateGroupMemory: (groupFolder: string) => Promise<ConsolidationResult>;
  retentionPinThreshold: number;
  promotionThreshold: number;
  decayThreshold: number;
  minRecalls: number;
  minUniqueQueries: number;
  confidenceBoost: number;
  confidenceDecay: number;
  dryRun?: boolean;
}

interface DreamReviewDecision {
  id: string;
  action: 'keep' | 'rewrite' | 'merge_into' | 'retire';
  target?: string;
  rewrittenValue?: string;
  reason?: string;
}

export async function runDreamingSweep(
  args: RunDreamingSweepArgs,
): Promise<DreamingResult> {
  const startedAt = Date.now();
  // Cap sweep at 5000 items to bound per-sweep maintenance and LLM cost.
  const items = args.store.listActiveItems(args.groupFolder, 5000);

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

  const isDryRun = args.dryRun ?? MEMORY_DREAMING_DRY_RUN;
  args.store.recordEvent('dream_started', 'memory_dreaming', args.groupFolder, {
    group: args.groupFolder,
    candidates_a: scoredItems.length,
    promote_n: promoted.length,
    decay_n: decayed.length,
    review_n: Math.min(scoredItems.length, 30),
    dry_run: isDryRun,
  });

  if (!isDryRun && promoted.length > 0 && args.confidenceBoost > 0) {
    args.store.adjustConfidence(
      promoted.map((entry) => entry.item.id),
      args.confidenceBoost,
    );
  }

  if (!isDryRun) {
    for (const promotedItem of promoted) {
      const latest = args.store.getItemById(promotedItem.item.id);
      if (!latest) continue;
      if (
        !latest.is_pinned &&
        latest.confidence >= args.retentionPinThreshold
      ) {
        args.store.pinItem(latest.id, true);
      }
    }
  }

  if (!isDryRun && decayed.length > 0 && args.confidenceDecay > 0) {
    args.store.adjustConfidence(
      decayed.map((entry) => entry.item.id),
      -Math.abs(args.confidenceDecay),
    );
  }

  let retiredCount = 0;
  if (!isDryRun) {
    for (const decayedItem of decayed) {
      const latest = args.store.getItemById(decayedItem.item.id);
      if (!latest || latest.is_pinned) continue;
      if (latest.confidence < 0.1) {
        args.store.softDeleteItem(latest.id);
        retiredCount += 1;
      }
    }
  }

  const reviewDecisions = await reviewDreamCandidates(
    scoredItems.map((entry) => entry.item).slice(0, 30),
  );
  let reviewRewrittenCount = 0;
  let reviewMergedCount = 0;
  let reviewRetiredCount = 0;
  let reviewKeptCount = 0;
  let rejectedHallucinations = 0;
  const candidateIds = new Set(scoredItems.map((entry) => entry.item.id));
  for (const decision of reviewDecisions) {
    if (!candidateIds.has(decision.id)) continue;
    if (decision.action === 'keep') {
      reviewKeptCount += 1;
      if (!isDryRun) {
        const current = args.store.getItemById(decision.id);
        if (current) {
          args.store.patchItem(current.id, current.version, {
            last_reviewed_at: new Date().toISOString(),
          });
        }
      }
      continue;
    }
    if (decision.action === 'rewrite') {
      const current = args.store.getItemById(decision.id);
      if (!current || !decision.rewrittenValue) continue;
      const ungrounded = firstUngroundedToken(decision.rewrittenValue, [
        current.value,
        current.why || '',
      ]);
      if (ungrounded) {
        rejectedHallucinations += 1;
        args.store.recordEvent(
          'dream_hallucination_rejected',
          'memory_dreaming',
          decision.id,
          {
            group: args.groupFolder,
            offending_token: ungrounded,
            source: 'review',
          },
        );
        continue;
      }
      if (!isDryRun) {
        args.store.patchItem(current.id, current.version, {
          value: decision.rewrittenValue,
          why: `[dream-rewrite] ${decision.reason || 'review rewrite'}`,
          last_reviewed_at: new Date().toISOString(),
        });
      }
      reviewRewrittenCount += 1;
      continue;
    }
    if (decision.action === 'merge_into') {
      if (!decision.target || decision.target === decision.id) continue;
      if (!candidateIds.has(decision.target)) continue;
      const source = args.store.getItemById(decision.id);
      const target = args.store.getItemById(decision.target);
      if (!source || !target) continue;
      const ungrounded = firstUngroundedToken(target.value, [
        source.value,
        source.why || '',
        target.value,
        target.why || '',
      ]);
      if (ungrounded) {
        rejectedHallucinations += 1;
        args.store.recordEvent(
          'dream_hallucination_rejected',
          'memory_dreaming',
          decision.id,
          {
            group: args.groupFolder,
            offending_token: ungrounded,
            source: 'review',
          },
        );
        continue;
      }
      if (!isDryRun) {
        args.store.softDeleteItem(decision.id, decision.target);
      }
      reviewMergedCount += 1;
      continue;
    }
    if (decision.action === 'retire') {
      if (!isDryRun) {
        args.store.softDeleteItem(decision.id);
      }
      reviewRetiredCount += 1;
    }
  }

  const consolidation = await args.consolidateGroupMemory(args.groupFolder);

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
    'dream_completed',
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
      llm_review: {
        reviewed: reviewDecisions.length,
        kept: reviewKeptCount,
        rewritten: reviewRewrittenCount,
        merged: reviewMergedCount,
        retired: reviewRetiredCount,
        rejected_hallucinations: rejectedHallucinations,
      },
      dry_run: isDryRun,
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

const TOKEN_PATTERN =
  /\b(?:[a-zA-Z_][a-zA-Z0-9_./:-]{2,}|[0-9]{2,}|[a-z]+-[a-z0-9-]{2,})\b/g;

const STOP_TOKENS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'have',
  'will',
  'were',
  'been',
  'into',
  'about',
  'after',
  'before',
  'where',
  'which',
  'their',
  'there',
  'should',
  'could',
  'would',
  'because',
  'while',
  'when',
  'what',
  'your',
  'they',
  'them',
  'than',
  'then',
  'over',
  'under',
  'more',
  'most',
  'less',
  'very',
  'true',
  'false',
  'none',
]);

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function requiresStrictGrounding(token: string): boolean {
  return /[0-9_./:]/.test(token) || token.includes('-');
}

function extractGroundingTokens(text: string): string[] {
  const tokens = text.match(TOKEN_PATTERN) || [];
  return tokens
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));
}

function firstUngroundedToken(
  candidateText: string,
  sourceTexts: string[],
): string | null {
  const sourceTokenSet = new Set<string>();
  for (const text of sourceTexts) {
    for (const token of extractGroundingTokens(text)) {
      sourceTokenSet.add(token);
    }
  }
  for (const token of extractGroundingTokens(candidateText)) {
    if (!requiresStrictGrounding(token)) {
      continue;
    }
    if (!sourceTokenSet.has(token)) {
      return token;
    }
  }
  return null;
}

async function reviewDreamCandidates(
  items: MemoryItem[],
): Promise<DreamReviewDecision[]> {
  if (items.length === 0) return [];

  const payload = items.flatMap((item) => {
    const sanitizedValue = sanitizeOutboundLlmText(item.value);
    const sanitizedWhy = sanitizeOutboundLlmText(item.why || '');
    if (sanitizedValue.blocked || sanitizedWhy.blocked) {
      return [];
    }
    return [
      {
        id: item.id,
        kind: item.kind,
        value: sanitizedValue.text,
        why: sanitizedWhy.text,
        confidence: item.confidence,
        retrieval_count: item.retrieval_count,
        last_used_at: item.last_used_at,
        age_days: Math.max(
          0,
          (Date.now() - Date.parse(item.updated_at || item.created_at)) /
            86_400_000,
        ),
        pre_rank_signal: {
          total_score: item.total_score,
          max_score: item.max_score,
        },
      },
    ];
  });
  if (payload.length === 0) return [];

  try {
    const text = await runClaudeQuery({
      model: MODEL_DREAMING,
      prompt: `${MEMORY_DREAM_REVIEW_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
    });
    if (!text) return [];
    return parseDreamReviewResponse(text);
  } catch {
    return [];
  }
}

function parseDreamReviewResponse(text: string): DreamReviewDecision[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const decisions: DreamReviewDecision[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const id =
      'id' in row && typeof row.id === 'string' ? row.id.trim() : undefined;
    const action =
      'action' in row && typeof row.action === 'string'
        ? row.action.trim()
        : undefined;
    if (!id || !action) continue;
    if (
      action !== 'keep' &&
      action !== 'rewrite' &&
      action !== 'merge_into' &&
      action !== 'retire'
    ) {
      continue;
    }
    const target =
      'target' in row && typeof row.target === 'string'
        ? row.target.trim()
        : undefined;
    const targetId =
      'target_id' in row && typeof row.target_id === 'string'
        ? row.target_id.trim()
        : undefined;
    const rewrittenValue =
      'rewritten_value' in row && typeof row.rewritten_value === 'string'
        ? row.rewritten_value.trim().slice(0, 500)
        : undefined;
    const reason =
      'reason' in row && typeof row.reason === 'string'
        ? row.reason.trim().slice(0, 240)
        : undefined;
    decisions.push({
      id,
      action,
      ...(target || targetId ? { target: target || targetId } : {}),
      ...(rewrittenValue ? { rewrittenValue } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return decisions;
}
