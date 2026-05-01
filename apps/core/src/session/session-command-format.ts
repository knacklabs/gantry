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

interface MemoryStatusSnapshotLike {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
}

export function formatMemoryStatus(status: MemoryStatusSnapshotLike): string {
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
  return [
    'Memory status',
    `kinds: ${kinds || 'none'}`,
    `scopes: ${scopes || 'none'}`,
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
      `Context window: ${formatTokenCount(entry.contextWindowTokens)} tokens`,
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
  lines.push(formatUsageLine('Current turn tokens', snapshot?.lastUsage));
  lines.push(formatUsageLine('Session tokens', snapshot?.cumulativeUsage));
  return lines.join('\n');
}
