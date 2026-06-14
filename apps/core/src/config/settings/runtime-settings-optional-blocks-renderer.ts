import type { RuntimeSettings } from './runtime-settings-types.js';

// Renderers for the optional tail blocks of settings.yaml (`limits`,
// `model_families`). Each is omitted entirely when empty so an absent block
// stays absent across round-trips. Extracted from runtime-settings-renderer.ts
// to keep that file under its line budget.

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
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
