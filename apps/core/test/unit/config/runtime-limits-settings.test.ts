import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

describe('limits settings (per-provider rate caps)', () => {
  it('defaults to no provider caps when the block is absent', () => {
    const parsed = parseRuntimeSettings('agent:\n  name: Gantry\n');
    expect(parsed.limits).toEqual({ providers: {} });
  });

  it('parses per-provider requests_per_minute caps', () => {
    const parsed = parseRuntimeSettings(
      'limits:\n  anthropic:\n    requests_per_minute: 30\n  groq:\n    requests_per_minute: 120\n',
    );
    expect(parsed.limits.providers).toEqual({
      anthropic: { requestsPerMinute: 30 },
      groq: { requestsPerMinute: 120 },
    });
  });

  it('rejects an unknown provider id', () => {
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  not-a-provider:\n    requests_per_minute: 10\n',
      ),
    ).toThrow(/limits.not-a-provider is not a supported model provider/);
  });

  it('rejects a non-positive or non-integer cap', () => {
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  anthropic:\n    requests_per_minute: 0\n',
      ),
    ).toThrow(
      /limits.anthropic.requests_per_minute must be a positive integer/,
    );
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  anthropic:\n    requests_per_minute: 1.5\n',
      ),
    ).toThrow(
      /limits.anthropic.requests_per_minute must be a positive integer/,
    );
  });

  it('rejects an unsupported nested key', () => {
    expect(() =>
      parseRuntimeSettings('limits:\n  anthropic:\n    per_hour: 10\n'),
    ).toThrow(/limits.anthropic.per_hour is not supported/);
  });

  it('renders configured caps and round-trips through the parser', () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits = { providers: { anthropic: { requestsPerMinute: 45 } } };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('limits:');
    expect(yaml).toContain('  anthropic:');
    expect(yaml).toContain('    requests_per_minute: 45');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.limits.providers).toEqual({
      anthropic: { requestsPerMinute: 45 },
    });
  });

  it('omits the limits block entirely when no caps are configured', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('limits:');
  });
});
