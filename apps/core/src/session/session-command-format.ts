import type { ThinkingOverride } from '../domain/types.js';
import {
  findModelByRunnerModel,
  type ModelDefaultAliases,
  type NormalizedModelUsage,
} from '../shared/model-catalog.js';
import {
  formatModelCatalog,
  formatModelDisplay,
  formatTokenCount,
} from '../shared/model-catalog-format.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';

export interface MemoryStatusSnapshot {
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

function describeBackfillPause(
  reason: NonNullable<MemoryStatusSnapshot['retrieval']>['pauseReason'],
): string {
  switch (reason) {
    case 'paused_budget':
      return 'paused (daily embedding budget reached; resumes tomorrow or when the limit is raised)';
    case 'paused_provider_quota':
      return 'paused (provider quota unavailable; resumes on the next run)';
    case 'paused_rate_limit':
      return 'paused (provider rate limit; resumes on the next run)';
    case 'paused_retryable_provider_error':
      return 'paused (provider error; resumes on the next run)';
    default:
      return 'paused';
  }
}

export function formatMemoryStatus(status: MemoryStatusSnapshot): string {
  const kinds = Object.entries(status.items_by_kind || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(', ');
  const scopes = Object.entries(status.items_by_scope || {})
    .sort(([a], [b]) => a.localeCompare(b))
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
  const pipeline = status.memory_pipeline;
  const lastInjected = status.last_injected_block;
  const lastInjectedText = lastInjected
    ? [
        lastInjected.subject || 'unknown subject',
        typeof lastInjected.bytes === 'number'
          ? `${lastInjected.bytes} bytes`
          : 'unknown bytes',
        lastInjected.at ? `at ${lastInjected.at}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(', ')
    : 'none';
  const disk = status.disk_kb
    ? Object.entries(status.disk_kb)
        .map(([k, v]) => `${k}:${v}kb`)
        .join(', ')
    : 'n/a';
  const retrieval = status.retrieval;
  const searchMode = retrieval?.searchMode || 'lexical_keyword';
  const vectorSearch = retrieval?.vectorSearch || 'inactive';
  const pending = retrieval?.pending ?? 0;
  const vectorDetail =
    retrieval?.ready !== undefined || retrieval?.pending !== undefined
      ? ` (${retrieval?.ready ?? 0} ready, ${pending} pending` +
        (vectorSearch === 'partial' && pending > 0
          ? '; run `gantry memory embeddings backfill` to index the rest)'
          : ')')
      : '';
  const pauseLine = retrieval?.pauseReason
    ? `backfill: ${describeBackfillPause(retrieval.pauseReason)}`
    : undefined;
  return [
    'Memory status',
    'sample: latest 100 active memories; counts/top/stale are from this sample',
    `kinds: ${kinds || 'none'}`,
    `scopes: ${scopes || 'none'}`,
    `retrieval: ${searchMode}`,
    `embeddings: ${retrieval?.embeddings || 'unknown'}`,
    `vector_search: ${vectorSearch}${vectorDetail}`,
    ...(pauseLine ? [pauseLine] : []),
    `pipeline: staged:${pipeline?.staged ?? 0}, promoted:${pipeline?.promoted ?? 0}, needs_review:${pipeline?.needs_review ?? 0}`,
    `last_injected_block: ${lastInjectedText}`,
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
