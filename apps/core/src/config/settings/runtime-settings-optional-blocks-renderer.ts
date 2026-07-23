import type { RuntimeSettings } from './runtime-settings-types.js';
import { quoteYamlString } from './yaml.js';

// Renderers for the optional tail blocks of settings.yaml. Each is omitted
// entirely when default so an absent block stays absent across round-trips.
// Extracted from runtime-settings-renderer.ts to keep that file under its line
// budget.

export function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

export function renderAgentDelegatesYaml(
  lines: string[],
  delegates: string[] | undefined,
): void {
  if (!delegates?.length) return;
  lines.push('    delegates:');
  for (const delegate of delegates) {
    lines.push(`      - ${quoteYamlString(delegate)}`);
  }
}

// Optional in-memory per-provider request rate caps. Omitted when no caps are
// configured (default).
export function renderLimitsSettingsYaml(
  lines: string[],
  limits: RuntimeSettings['limits'],
): void {
  const entries = Object.entries(limits.providers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) return;
  lines.push('limits:');
  for (const [providerId, limit] of entries) {
    lines.push(
      `  ${quoteYamlKey(providerId)}:`,
      `    requests_per_minute: ${limit.requestsPerMinute}`,
    );
  }
  lines.push('');
}

export function renderObservabilitySettingsYaml(
  lines: string[],
  observability: RuntimeSettings['observability'],
): void {
  const { tracing } = observability;
  if (
    !tracing.enabled &&
    tracing.endpoint === '' &&
    tracing.captureContent &&
    tracing.sampleRate === 1 &&
    tracing.environment === undefined
  ) {
    return;
  }
  lines.push(
    'observability:',
    '  tracing:',
    `    enabled: ${tracing.enabled ? 'true' : 'false'}`,
    `    endpoint: ${quoteYamlString(tracing.endpoint)}`,
    `    capture_content: ${tracing.captureContent ? 'true' : 'false'}`,
    `    sample_rate: ${tracing.sampleRate}`,
  );
  if (tracing.environment !== undefined) {
    lines.push(`    environment: ${quoteYamlString(tracing.environment)}`);
  }
  lines.push('');
}

export function renderObserverSettingsYaml(
  lines: string[],
  observer: RuntimeSettings['observer'],
): void {
  if (!observer.enabled && !observer.owner) return;
  lines.push('observer:', `  enabled: ${observer.enabled ? 'true' : 'false'}`);
  if (observer.owner) {
    lines.push(
      '  owner:',
      `    recipient: ${quoteYamlString(observer.owner.recipient)}`,
      `    conversation: ${quoteYamlString(observer.owner.conversation)}`,
    );
  }
  lines.push('');
}

// Optional per-family member-order override. Omitted when no family has a
// non-empty override.
export function renderModelFamiliesYaml(
  lines: string[],
  modelFamilies: Record<string, string[]>,
): void {
  const entries = Object.entries(modelFamilies)
    .filter(([, members]) => members.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return;
  lines.push('model_families:');
  for (const [alias, members] of entries) {
    lines.push(`  ${quoteYamlKey(alias)}: ${JSON.stringify(members)}`);
  }
  lines.push('');
}

export function renderModelAliasesYaml(
  lines: string[],
  modelAliases: RuntimeSettings['modelAliases'],
): void {
  const entries = Object.entries(modelAliases).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) return;
  lines.push('model_aliases:');
  for (const [aliasId, alias] of entries) {
    lines.push(
      `  ${quoteYamlKey(aliasId)}:`,
      `    provider: ${JSON.stringify(alias.provider)}`,
      `    provider_model_id: ${JSON.stringify(alias.providerModelId)}`,
      `    display_name: ${JSON.stringify(alias.displayName)}`,
      `    aliases: ${JSON.stringify(alias.aliases)}`,
      `    recommended_alias: ${JSON.stringify(alias.recommendedAlias)}`,
      `    supported_workloads: ${JSON.stringify(alias.supportedWorkloads)}`,
    );
    if (alias.contextWindowTokens !== undefined) {
      lines.push(`    context_window_tokens: ${alias.contextWindowTokens}`);
    }
    if (alias.maxOutputTokens !== undefined) {
      lines.push(`    max_output_tokens: ${alias.maxOutputTokens}`);
    }
    if (alias.inputUsdPerMillionTokens !== undefined) {
      lines.push(
        `    input_usd_per_million_tokens: ${alias.inputUsdPerMillionTokens}`,
      );
    }
    if (alias.outputUsdPerMillionTokens !== undefined) {
      lines.push(
        `    output_usd_per_million_tokens: ${alias.outputUsdPerMillionTokens}`,
      );
    }
    if (alias.cachedInputUsdPerMillionTokens !== undefined) {
      lines.push(
        `    cached_input_usd_per_million_tokens: ${alias.cachedInputUsdPerMillionTokens}`,
      );
    }
    if (alias.cacheWriteUsdPerMillionTokens !== undefined) {
      lines.push(
        `    cache_write_usd_per_million_tokens: ${alias.cacheWriteUsdPerMillionTokens}`,
      );
    }
    if (alias.supportsThinking !== undefined) {
      lines.push(
        `    supports_thinking: ${alias.supportsThinking ? 'true' : 'false'}`,
      );
    }
    if (alias.supportsTools !== undefined) {
      lines.push(
        `    supports_tools: ${alias.supportsTools ? 'true' : 'false'}`,
      );
    }
    lines.push(
      '    source:',
      `      label: ${JSON.stringify(alias.source.label)}`,
      `      url: ${JSON.stringify(alias.source.url)}`,
      `      verified_at: ${JSON.stringify(alias.source.verifiedAt)}`,
    );
  }
  lines.push('');
}
