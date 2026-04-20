import {
  MODEL_CONSOLIDATION,
  MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK,
  MEMORY_RETENTION_PIN_THRESHOLD,
} from '../core/config.js';
import { EmbeddingProvider } from './memory-embeddings.js';
import { MemoryStore } from './memory-store.js';
import { MemoryItem } from './memory-types.js';
import { buildConsolidationPrompt } from './prompts/consolidate.js';
import { runClaudeQuery } from './claude-query.js';
import { sanitizeOutboundLlmText } from './sensitive-material.js';

interface ConsolidationOptions {
  groupFolder: string;
  store: MemoryStore;
  embeddings: EmbeddingProvider;
  minItems: number;
  clusterThreshold: number;
  maxClusters: number;
  embeddingFallback?: boolean;
}

interface EmbeddedItem {
  item: MemoryItem;
  embedding: number[];
}

interface ConsolidatedFact {
  key: string;
  value: string;
  why?: string;
  confidence: number;
  retiredIds: string[];
  mode: 'llm' | 'heuristic';
}

export interface ConsolidationResult {
  enabled: boolean;
  consideredItems: number;
  clustersFound: number;
  clustersProcessed: number;
  mergedItems: number;
  retiredItems: number;
  mode: 'llm' | 'heuristic' | 'none';
  skippedReason?: string;
}

export async function consolidateMemoryItems(
  input: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const allowLexicalFallback =
    input.embeddingFallback ?? MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK;
  const active = input.store.listActiveItems(input.groupFolder, 10_000);
  if (active.length < input.minItems) {
    return {
      enabled: true,
      consideredItems: active.length,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'none',
      skippedReason: `min_items_not_reached:${input.minItems}`,
    };
  }

  let consideredItems = active.length;
  let clusters: MemoryItem[][] = [];
  let clusteringMode: 'embedding' | 'lexical' = 'embedding';

  if (input.embeddings.isEnabled()) {
    const embedded = await ensureEmbeddings(
      active,
      input.store,
      input.embeddings,
    );
    consideredItems = embedded.length;
    if (embedded.length >= input.minItems) {
      clusters = buildClusters(embedded, input.clusterThreshold)
        .filter((cluster) => cluster.length >= 2)
        .map((cluster) => cluster.map((entry) => entry.item))
        .sort((a, b) => b.length - a.length);
    }
  }

  if (
    clusters.length === 0 &&
    allowLexicalFallback &&
    active.length >= input.minItems
  ) {
    clusteringMode = 'lexical';
    clusters = buildLexicalClusters(active).sort((a, b) => b.length - a.length);
  }

  if (clusters.length === 0) {
    return {
      enabled: true,
      consideredItems,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'none',
      skippedReason:
        clusteringMode === 'embedding' && consideredItems < input.minItems
          ? 'insufficient_embedded_items'
          : 'no_similar_clusters',
    };
  }

  const selected = clusters.slice(0, Math.max(1, input.maxClusters));

  let mergedItems = 0;
  let retiredItems = 0;
  let mode: ConsolidationResult['mode'] = 'none';

  for (const cluster of selected) {
    const merged = await mergeCluster(cluster);
    if (!merged) continue;
    const retiredIds = new Set(merged.retiredIds.filter(Boolean));
    const clusterById = new Map(cluster.map((item) => [item.id, item]));
    const retireBeforeInsert = [...retiredIds].filter((id) => {
      const source = clusterById.get(id);
      if (!source) return false;
      return (
        source.scope === 'group' &&
        source.group_folder === input.groupFolder &&
        source.user_id === null &&
        source.key === merged.key
      );
    });
    for (const id of retireBeforeInsert) {
      input.store.softDeleteItem(id);
      retiredIds.delete(id);
      retiredItems += 1;
    }

    const saved = input.store.saveItem({
      scope: 'group',
      group_folder: input.groupFolder,
      user_id: null,
      kind: 'fact',
      key: merged.key,
      value: merged.value,
      why: merged.why,
      source: 'consolidation',
      confidence: clamp01(merged.confidence),
      is_pinned: merged.confidence >= MEMORY_RETENTION_PIN_THRESHOLD,
    });

    if (input.embeddings.isEnabled()) {
      const embedding = await input.embeddings.embedOne(
        `${saved.key}: ${saved.value}`,
      );
      input.store.saveItemEmbedding(saved.id, embedding);
    }

    for (const id of retiredIds) {
      if (id === saved.id) continue;
      input.store.softDeleteItem(id);
      retiredItems += 1;
    }

    input.store.recordEvent('memory_consolidated', 'memory_item', saved.id, {
      group_folder: input.groupFolder,
      merged_key: saved.key,
      merged_confidence: saved.confidence,
      retired_ids: merged.retiredIds,
      mode: merged.mode,
    });

    mergedItems += 1;
    mode = merged.mode;
  }

  return {
    enabled: true,
    consideredItems,
    clustersFound: clusters.length,
    clustersProcessed: selected.length,
    mergedItems,
    retiredItems,
    mode,
  };
}

async function ensureEmbeddings(
  items: MemoryItem[],
  store: MemoryStore,
  embeddings: EmbeddingProvider,
): Promise<EmbeddedItem[]> {
  const out: EmbeddedItem[] = [];
  const missing: MemoryItem[] = [];

  for (const item of items) {
    const parsed = parseEmbedding(item.embedding_json);
    if (parsed) {
      out.push({ item, embedding: parsed });
    } else {
      missing.push(item);
    }
  }

  if (missing.length > 0) {
    const vectors = await embeddings.embedMany(
      missing.map((item) => `${item.key}: ${item.value}`),
    );
    for (let i = 0; i < missing.length; i += 1) {
      const item = missing[i]!;
      const embedding = vectors[i];
      if (!embedding || embedding.length === 0) continue;
      store.saveItemEmbedding(item.id, embedding);
      out.push({ item, embedding });
    }
  }

  return out;
}

function buildClusters(
  entries: EmbeddedItem[],
  threshold: number,
): EmbeddedItem[][] {
  const used = new Set<string>();
  const clusters: EmbeddedItem[][] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const seed = entries[i]!;
    if (used.has(seed.item.id)) continue;

    const cluster: EmbeddedItem[] = [seed];
    used.add(seed.item.id);

    for (let j = i + 1; j < entries.length; j += 1) {
      const candidate = entries[j]!;
      if (used.has(candidate.item.id)) continue;
      const similarity = cosineSimilarity(seed.embedding, candidate.embedding);
      if (similarity < threshold) continue;
      cluster.push(candidate);
      used.add(candidate.item.id);
    }

    clusters.push(cluster);
  }

  return clusters;
}

function buildLexicalClusters(items: MemoryItem[]): MemoryItem[][] {
  const used = new Set<string>();
  const analyzed = items.map((item) => ({
    item,
    keyTokens: tokenize(item.key),
    valueTokens: new Set(tokenize(item.value)),
  }));
  const clusters: MemoryItem[][] = [];

  for (let i = 0; i < analyzed.length; i += 1) {
    const seed = analyzed[i]!;
    if (used.has(seed.item.id)) continue;
    used.add(seed.item.id);
    const cluster: MemoryItem[] = [seed.item];

    for (let j = i + 1; j < analyzed.length; j += 1) {
      const candidate = analyzed[j]!;
      if (used.has(candidate.item.id)) continue;
      if (
        hasKeyPrefixOverlap(seed.keyTokens, candidate.keyTokens, 3) ||
        jaccardSimilarity(seed.valueTokens, candidate.valueTokens) >= 0.6
      ) {
        cluster.push(candidate.item);
        used.add(candidate.item.id);
      }
    }

    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

async function mergeCluster(
  items: MemoryItem[],
): Promise<ConsolidatedFact | null> {
  if (items.length < 2) return null;

  const llmMerge = await tryMergeWithClaude(items);
  if (llmMerge) {
    return {
      ...llmMerge,
      mode: 'llm',
    };
  }

  const ranked = [...items].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
  const anchor = ranked[0]!;
  const mergedValue = ranked
    .map((item) => item.value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  return {
    key: `consolidated:${anchor.key.replace(/^consolidated:/, '')}`,
    value: mergedValue || anchor.value,
    why: anchor.why,
    confidence: Math.max(anchor.confidence, 0.8),
    retiredIds: items.map((item) => item.id),
    mode: 'heuristic',
  };
}

async function tryMergeWithClaude(
  items: MemoryItem[],
): Promise<Omit<ConsolidatedFact, 'mode'> | null> {
  const sanitizedItems = items.flatMap((item) => {
    const sanitizedKey = sanitizeOutboundLlmText(item.key);
    const sanitizedValue = sanitizeOutboundLlmText(item.value);
    if (sanitizedKey.blocked || sanitizedValue.blocked) {
      return [];
    }
    return [
      {
        ...item,
        key: sanitizedKey.text,
        value: sanitizedValue.text,
      },
    ];
  });
  if (sanitizedItems.length < 2) return null;
  const prompt = buildConsolidationPrompt(sanitizedItems);

  try {
    const text = await runClaudeQuery({
      model: MODEL_CONSOLIDATION,
      prompt,
    });
    if (!text) return null;

    const parsed = parseFirstJsonObject(text) as {
      key?: unknown;
      value?: unknown;
      why?: unknown;
      confidence?: unknown;
      retired_ids?: unknown;
    } | null;
    if (!parsed) return null;

    const key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
    const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
    const why = typeof parsed.why === 'string' ? parsed.why.trim() : '';
    const confidence = Number(parsed.confidence);
    const allowedIds = new Set(sanitizedItems.map((item) => item.id));
    const retiredIds = Array.isArray(parsed.retired_ids)
      ? parsed.retired_ids
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.trim().length > 0,
          )
          .map((id) => id.trim())
          .filter((id) => allowedIds.has(id))
      : [];

    if (!key || !value) return null;
    const groundingInputs = sanitizedItems.flatMap((item) => [
      item.key,
      item.value,
      item.why || '',
    ]);
    if (firstUngroundedToken(value, groundingInputs)) {
      return null;
    }
    return {
      key,
      value,
      ...(why ? { why } : {}),
      confidence: Number.isFinite(confidence) ? clamp01(confidence) : 0.8,
      retiredIds:
        retiredIds.length > 0
          ? retiredIds
          : sanitizedItems.map((item) => item.id),
    };
  } catch {
    return null;
  }
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const values = parsed.map((value) => Number(value));
    return values.every((value) => Number.isFinite(value)) ? values : null;
  } catch {
    return null;
  }
}

function parseFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA <= 0 || magB <= 0) return 0;
  return dot / Math.sqrt(magA * magB);
}

function clamp01(value: number): number {
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

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function hasKeyPrefixOverlap(
  left: string[],
  right: string[],
  minTokens: number,
): boolean {
  const min = Math.min(left.length, right.length);
  let matched = 0;
  for (let index = 0; index < min; index += 1) {
    if (left[index] !== right[index]) break;
    matched += 1;
  }
  return matched >= minTokens;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
