import type { ThinkingOverride } from '../domain/types.js';
import {
  findModelByRunnerModel,
  formatModelCatalog,
  formatModelDisplay,
  formatTokenCount,
  type ModelDefaultAliases,
  type NormalizedModelUsage,
} from '../shared/model-catalog.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';

export interface MemoryStatusSnapshot {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
  retrieval?: {
    searchMode?: 'lexical_keyword';
    embeddings?: 'disabled' | 'configured';
    vectorSearch?: 'inactive' | 'active';
  };
}

export interface BrowserStatusSnapshot {
  profileName: string;
  profileLabel: string;
  running: boolean;
  cdpReady: boolean;
  hasState?: boolean;
  authMarkers?: string[];
  headless?: boolean;
  error?: string;
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
  const lines = [
    'Browser status',
    `Using ${status.profileLabel}.`,
    `State: ${state}`,
    `Profile data: ${profileData}`,
    `Signed-in sites: ${authMarkers}`,
  ];
  if (typeof status.headless === 'boolean') {
    lines.push(`Mode: ${status.headless ? 'headless' : 'visible browser'}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);
  return lines.join('\n');
}

export function formatMemoryStatus(status: MemoryStatusSnapshot): string {
  const kinds = Object.entries(status.items_by_kind || {})
    .map(([kind, count]) => `${kind}:${count}`)
    .join(', ');
  const scopes = Object.entries(status.items_by_scope || {})
    .map(([scope, count]) => `${scope}:${count}`)
    .join(', ');
  const used = (status.top10_most_used || [])
    .slice(0, 5)
    .map((row) => `${row.key}(${row.retrieval_count})`)
    .join(', ');
  const stalest = (status.top10_stalest || [])
    .slice(0, 5)
    .map((row) => `${row.key}@${row.updated_at.slice(0, 10)}`)
    .join(', ');
  const dream = status.last_dream_run?.at || 'never';
  const disk = status.disk_kb
    ? Object.entries(status.disk_kb)
        .map(([k, v]) => `${k}:${v}kb`)
        .join(', ')
    : 'n/a';
  const retrieval = status.retrieval;
  const searchMode =
    retrieval?.searchMode === 'lexical_keyword'
      ? 'lexical + keyword'
      : 'lexical + keyword';
  return [
    'Memory status',
    `kinds: ${kinds || 'none'}`,
    `scopes: ${scopes || 'none'}`,
    `retrieval: ${searchMode}`,
    `embeddings: ${retrieval?.embeddings || 'unknown'}`,
    `vector_search: ${retrieval?.vectorSearch || 'inactive'}`,
    `top_used: ${used || 'none'}`,
    `stale: ${stalest || 'none'}`,
    `last_dream: ${dream}`,
    `disk: ${disk}`,
  ].join('\n');
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

export function formatModelsList(defaults: ModelDefaultAliases = {}): string {
  return formatModelCatalog(defaults);
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
      `Max output: ${formatTokenCount(entry.maxOutputTokens)} tokens`,
      `Cache: ${entry.cacheMode}`,
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
