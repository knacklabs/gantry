import { describe, expect, it } from 'vitest';

import { formatModelCatalog } from '@core/shared/model-catalog-format.js';
import { formatModelWhy } from '@core/shared/model-why-format.js';

function rowFor(text: string, alias: string): string {
  const line = text.split('\n').find((row) => row.startsWith(`${alias} |`));
  if (!line) throw new Error(`row for ${alias} not found`);
  return line;
}

describe('formatModelCatalog availability badges', () => {
  it('renders NO availability column without a configured set (graceful)', () => {
    const text = formatModelCatalog();
    expect(text).not.toContain('Availability');
    // gpt-oss family row shows the default member order, no badge.
    expect(text).toContain('gpt-oss | GPT-OSS 120B | groq-oss > cerebras');
  });

  it('badges concrete rows available vs needs-key from the configured set', () => {
    const text = formatModelCatalog({
      configuredProviders: new Set(['cerebras']),
    });
    expect(text).toContain('Availability');
    // A cerebras-routed alias is available now.
    expect(rowFor(text, 'cerebras')).toContain('available');
    // An anthropic alias needs its key.
    expect(rowFor(text, 'opus')).toContain('needs Anthropic key');
  });

  it('badges family rows: available via the configured member', () => {
    const text = formatModelCatalog({
      configuredProviders: new Set(['cerebras']),
    });
    // Only cerebras configured -> gpt-oss resolves to cerebras.
    expect(rowFor(text, 'gpt-oss')).toContain('available via Cerebras');
  });

  it('badges family rows: needs a key when no member is configured', () => {
    const text = formatModelCatalog({ configuredProviders: new Set() });
    const row = rowFor(text, 'gpt-oss');
    expect(row).toContain('needs a key for one of: Groq, Cerebras');
  });

  it('reflects the family order override in the family row order + badge', () => {
    const text = formatModelCatalog({
      configuredProviders: new Set(['groq', 'cerebras']),
      familyOrder: { 'gpt-oss': ['cerebras', 'groq-oss'] },
    });
    const row = rowFor(text, 'gpt-oss');
    expect(row).toContain('cerebras > groq-oss');
    // Both configured + override puts cerebras first -> available via Cerebras.
    expect(row).toContain('available via Cerebras');
  });
});

describe('formatModelWhy', () => {
  it('shows the resolved provider + reason for a family', () => {
    const text = formatModelWhy({
      value: 'gpt-oss',
      configuredProviders: new Set(['cerebras']),
    });
    expect(text).toContain('Why model family gpt-oss');
    expect(text).toContain('groq-oss [Groq] > cerebras [Cerebras]');
    expect(text).toContain('gpt-oss → cerebras via Cerebras');
    expect(text).toContain('Groq not configured');
  });

  it('shows the needs-key fallback for a family with no provider configured', () => {
    const text = formatModelWhy({
      value: 'gpt-oss',
      configuredProviders: new Set(),
    });
    expect(text).toContain('gpt-oss → groq-oss via Groq');
    expect(text).toContain('needs a key for one of: Groq, Cerebras');
  });

  it('shows the configured/needs-key line for a concrete alias', () => {
    expect(
      formatModelWhy({
        value: 'opus',
        configuredProviders: new Set(['anthropic']),
      }),
    ).toContain('Anthropic key is configured');
    expect(
      formatModelWhy({ value: 'opus', configuredProviders: new Set() }),
    ).toContain('needs Anthropic key');
  });

  it('omits the credential line when the configured set is unavailable', () => {
    const text = formatModelWhy({ value: 'opus' });
    expect(text).toContain('Why model opus');
    expect(text).not.toContain('credential:');
  });

  it('honors the family order override', () => {
    const text = formatModelWhy({
      value: 'gpt-oss',
      configuredProviders: new Set(['groq', 'cerebras']),
      familyOrder: { 'gpt-oss': ['cerebras', 'groq-oss'] },
    });
    expect(text).toContain('cerebras [Cerebras] > groq-oss [Groq]');
    expect(text).toContain('gpt-oss → cerebras via Cerebras');
  });

  it('reports unknown aliases gracefully', () => {
    expect(formatModelWhy({ value: 'nope' })).toContain('Unknown model "nope"');
  });
});
