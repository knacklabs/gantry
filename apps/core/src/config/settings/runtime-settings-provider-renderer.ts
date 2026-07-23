import type { RuntimeSettings } from './runtime-settings-types.js';
import { quoteYamlKey } from './runtime-settings-optional-blocks-renderer.js';

export function renderProvidersYaml(
  lines: string[],
  settings: RuntimeSettings,
): void {
  const enabledProviders = Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .sort(([a], [b]) => a.localeCompare(b));
  if (enabledProviders.length === 0) return;

  lines.push('providers:');
  for (const [providerId] of enabledProviders) {
    lines.push(`  ${quoteYamlKey(providerId)}:`, '    enabled: true');
  }
  lines.push('');
}
