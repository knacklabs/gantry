import type { ThinkingOverride } from '../domain/types.js';
import {
  findModelByRunnerModel,
  type NormalizedModelUsage,
} from '../shared/model-catalog.js';
import {
  formatModelCatalog,
  formatModelDisplay,
  formatTokenCount,
  type ModelCatalogFormatOptions,
} from '../shared/model-catalog-format.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
export { formatModelWhy } from '../shared/model-why-format.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';

export interface MemoryStatusSnapshot {
  memory_enabled?: boolean;
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  memory_pipeline?: {
    staged?: number;
    promoted?: number;
    needs_review?: number;
  };
  last_injected_block?: {
    subject?: string;
    bytes?: number;
    at?: string;
  };
  disk_kb?: Record<string, number>;
  retrieval?: {
    searchMode?:
      | 'lexical_keyword'
      | 'hybrid_semantic_partial'
      | 'hybrid_semantic_ready';
    embeddings?: 'disabled' | 'configured';
    vectorSearch?: 'inactive' | 'partial' | 'active';
    pauseReason?:
      | 'paused_budget'
      | 'paused_provider_quota'
      | 'paused_rate_limit'
      | 'paused_retryable_provider_error';
    ready?: number;
    pending?: number;
  };
}

export interface BrowserStatusSnapshot {
  profileName: string;
  profileLabel: string;
  running: boolean;
  cdpReady: boolean;
  profilePersistent?: boolean;
  userDataDir?: string;
  chromeExecutable?: string;
  hasState?: boolean;
  authMarkers?: string[];
  headless?: boolean;
  error?: string;
}

export interface CompactionStatusSnapshot {
  state:
    | 'idle'
    | 'queued'
    | 'running'
    | 'ready'
    | 'degraded'
    | 'failed'
    | 'timeout';
}

export function formatCompactionStatus(
  status: CompactionStatusSnapshot,
): string {
  return `Compaction status: ${status.state}`;
}

export function formatBrowserStatus(status: BrowserStatusSnapshot): string {
  const state = status.running
    ? status.cdpReady
      ? 'running and ready'
      : 'running, not ready yet'
    : 'stopped';
  const profileData =
    status.hasState === undefined
      ? 'unknown'
      : status.hasState
        ? 'saved'
        : 'empty';
  const authMarkers =
    status.authMarkers && status.authMarkers.length > 0
      ? status.authMarkers.join(', ')
      : 'none detected';
  const persistentProfile =
    status.profilePersistent === undefined
      ? 'unknown'
      : status.profilePersistent
        ? 'yes'
        : 'no';
  const lines = [
    'Browser status',
    `Using ${status.profileLabel}.`,
    `State: ${state}`,
    `Persistent profile: ${persistentProfile}`,
    `Profile data: ${profileData}`,
    `Signed-in sites: ${authMarkers}`,
  ];
  if (status.userDataDir)
    lines.push(`Profile directory: ${status.userDataDir}`);
  if (status.chromeExecutable) lines.push(`Chrome: ${status.chromeExecutable}`);
  if (typeof status.headless === 'boolean') {
    lines.push(`Mode: ${status.headless ? 'headless' : 'visible browser'}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);
  return lines.join('\n');
}

export function formatMemoryStatus(status: MemoryStatusSnapshot): string {
  const dream = status.last_dream_run?.at || 'never';
  const pipeline = status.memory_pipeline;
  const lastInjected = status.last_injected_block;
  const injectedCount = lastInjected ? 1 : 0;
  const memoryOn = status.memory_enabled === true;
  return [
    `Memory: ${memoryOn ? 'on' : 'off'}`,
    `Pre-answer recall: ${memoryOn ? 'on' : 'off'}`,
    ...formatRetrievalLines(status.retrieval),
    `Last dream: ${dream}`,
    `Review queue: ${pipeline?.needs_review ?? 0}`,
    `Injected this run: ${injectedCount}`,
  ].join('\n');
}

function describePauseReason(
  reason: NonNullable<MemoryStatusSnapshot['retrieval']>['pauseReason'],
): string {
  switch (reason) {
    case 'paused_budget':
      return 'daily embedding budget reached';
    case 'paused_provider_quota':
      return 'embedding provider quota reached';
    case 'paused_rate_limit':
      return 'embedding provider rate limit';
    case 'paused_retryable_provider_error':
      return 'temporary embedding provider error';
    default:
      return 'embedding provider unavailable';
  }
}

// The "Semantic recall" line is derived from vectorSearch (whether vectors are
// actually contributing) and pauseReason, so it can never contradict the
// "Search mode" line above it: full-text mode pairs with off/indexing/paused
// copy, hybrid modes pair with "on". Full-text recall is the always-on baseline;
// semantic recall is an optional enhancement, never required for memory to work.
function describeSemanticRecall(
  retrieval: NonNullable<MemoryStatusSnapshot['retrieval']>,
): string {
  if (retrieval.embeddings !== 'configured') {
    return 'Semantic recall: off (optional)';
  }
  const vectorSearch = retrieval.vectorSearch ?? 'inactive';
  const paused = retrieval.pauseReason;
  if (vectorSearch === 'active') {
    return 'Semantic recall: on';
  }
  if (vectorSearch === 'partial') {
    return paused
      ? `Semantic recall: on (index build paused: ${describePauseReason(paused)})`
      : 'Semantic recall: on (index building)';
  }
  // No vectors are contributing yet, so full-text recall is doing the work.
  return paused
    ? `Semantic recall paused: ${describePauseReason(paused)}. Full-text memory is still active.`
    : 'Semantic recall: index building. Full-text memory is still active.';
}

function formatRetrievalLines(
  retrieval: MemoryStatusSnapshot['retrieval'],
): string[] {
  const searchMode = retrieval?.searchMode ?? 'lexical_keyword';
  const searchLabel =
    searchMode === 'hybrid_semantic_ready'
      ? 'hybrid'
      : searchMode === 'hybrid_semantic_partial'
        ? 'hybrid partial'
        : 'full-text';
  const lines = [
    `Search mode: ${searchLabel}`,
    retrieval
      ? describeSemanticRecall(retrieval)
      : 'Semantic recall: off (optional)',
  ];
  if (
    typeof retrieval?.ready === 'number' &&
    typeof retrieval?.pending === 'number'
  ) {
    lines.push(
      `Semantic index: ${retrieval.ready} ready, ${retrieval.pending} pending`,
    );
  }
  return lines;
}

export function describeThinking(value: ThinkingOverride): string {
  if (value.mode === 'disabled') return 'disabled';
  if (value.mode === 'adaptive') {
    if (value.effort) return `adaptive (effort ${value.effort})`;
    return 'adaptive';
  }
  if (value.mode === 'enabled') {
    if (typeof value.budgetTokens === 'number') {
      return `enabled (budget ${value.budgetTokens} tokens)`;
    }
    return 'enabled';
  }
  return value.mode;
}

export function formatCurrentModel(
  defaultModel: string | undefined,
  groupOverrideModel: string | undefined,
): string {
  const overrideEntry = findModelByRunnerModel(groupOverrideModel);
  if (groupOverrideModel) {
    return `Current model: ${overrideEntry ? formatModelDisplay(overrideEntry) : groupOverrideModel} (session override).`;
  }
  const defaultEntry = findModelByRunnerModel(defaultModel);
  if (defaultEntry)
    return `Current model: ${formatModelDisplay(defaultEntry)} (chat default).`;
  if (defaultModel) return `Current model: ${defaultModel} (default).`;
  return 'Current model: CLI default (no explicit override).';
}

export function formatModelsList(
  options: ModelCatalogFormatOptions = {},
): string {
  return formatModelCatalog(options);
}

function formatUsageLine(
  label: string,
  usage: NormalizedModelUsage | undefined,
): string {
  if (!usage) {
    return `${label}: input unknown, output unknown, cache read unknown, cache write unknown`;
  }
  const cost =
    typeof usage.estimatedCostUsd === 'number'
      ? `, estimated cost $${usage.estimatedCostUsd.toFixed(4)}`
      : '';
  return (
    `${label}: input ${usage.inputTokens}, output ${usage.outputTokens}, ` +
    `cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}, ` +
    `cache ${usage.cacheStatus}${cost}`
  );
}

function inputSideTokens(usage: NormalizedModelUsage | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if (value >= 10) return `${value.toFixed(0)}%`;
  return `${value.toFixed(1)}%`;
}

function cacheHitPercent(
  usage: NormalizedModelUsage | undefined,
): number | undefined {
  const denominator = inputSideTokens(usage);
  if (!usage || denominator <= 0) return undefined;
  return (usage.cacheReadTokens / denominator) * 100;
}

function formatContextLine(
  snapshot: RuntimeModelStatusSnapshot | undefined,
  contextWindowTokens: number | undefined,
): string {
  if (snapshot?.contextUsage) {
    const context = snapshot.contextUsage;
    return `Context: ${formatTokenCount(context.totalTokens)} / ${formatTokenCount(context.maxTokens)} tokens (${formatPercent(context.percentage)} used)`;
  }
  const inputTokens = inputSideTokens(snapshot?.lastUsage);
  if (inputTokens > 0 && contextWindowTokens) {
    const pct = (inputTokens / contextWindowTokens) * 100;
    return `Context: about ${formatTokenCount(inputTokens)} / ${formatTokenCount(contextWindowTokens)} tokens (${formatPercent(pct)} used)`;
  }
  if (contextWindowTokens) {
    return `Context window: ${formatTokenCount(contextWindowTokens)} tokens`;
  }
  return 'Context: unknown';
}

function formatContextContributors(
  snapshot: RuntimeModelStatusSnapshot | undefined,
): string | undefined {
  const categories = snapshot?.contextUsage?.categories;
  if (!categories || categories.length === 0) return undefined;
  const top = [...categories]
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4)
    .map(
      (category) =>
        `${category.name} ${formatTokenCount(category.tokens)}${
          typeof category.percentage === 'number'
            ? ` (${formatPercent(category.percentage)})`
            : ''
        }`,
    )
    .join(', ');
  return top ? `Top context: ${top}` : undefined;
}

export function formatModelStatus(
  snapshot: RuntimeModelStatusSnapshot | undefined,
  fallback: {
    currentModel?: string;
    defaultModel?: string;
    source: string;
  },
): string {
  const entry =
    snapshot?.model ??
    findModelByRunnerModel(fallback.currentModel) ??
    findModelByRunnerModel(fallback.defaultModel);
  const modelText = entry
    ? formatModelDisplay(entry)
    : fallback.currentModel || fallback.defaultModel || 'CLI default';
  const lines = [
    'Model status',
    `Using ${modelText} (${snapshot?.selectionSource || fallback.source}).`,
  ];
  if (entry) {
    lines.push(
      formatContextLine(snapshot, entry.contextWindowTokens),
      typeof entry.maxOutputTokens === 'number'
        ? `Max output: ${formatTokenCount(entry.maxOutputTokens)} tokens`
        : 'Max output: reported at runtime',
      `Cache: ${resolveModelCacheSupport(entry).statusLabel}`,
    );
  } else {
    lines.push(
      'Context window: unknown',
      'Max output: unknown',
      'Cache: unknown',
    );
  }
  const contributors = formatContextContributors(snapshot);
  if (contributors) lines.push(contributors);
  lines.push(
    `Cache hit: current ${formatPercent(cacheHitPercent(snapshot?.lastUsage))}, session ${formatPercent(cacheHitPercent(snapshot?.cumulativeUsage))}`,
  );
  lines.push(formatUsageLine('Current turn tokens', snapshot?.lastUsage));
  lines.push(formatUsageLine('Session tokens', snapshot?.cumulativeUsage));
  return lines.join('\n');
}
