import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

describe('limits settings (per-provider rate caps)', () => {
  it('defaults provider_session_max_input_tokens to 150000', () => {
    const parsed = parseRuntimeSettings('agent:\n  name: Gantry\n');
    expect(parsed.limits).toEqual({
      providerSessionMaxInputTokens: 150_000,
      providers: {},
    });
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

  it('rejects provider_session_max_input_tokens outside the supported range with a path-level error', () => {
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  provider_session_max_input_tokens: 19999\n',
      ),
    ).toThrow(
      'limits.provider_session_max_input_tokens must be an integer between 20000 and 900000',
    );
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  provider_session_max_input_tokens: 900001\n',
      ),
    ).toThrow(
      'limits.provider_session_max_input_tokens must be an integer between 20000 and 900000',
    );
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  provider_session_max_input_tokens: 150000.5\n',
      ),
    ).toThrow(
      'limits.provider_session_max_input_tokens must be an integer between 20000 and 900000',
    );
    expect(() =>
      parseRuntimeSettings(
        'limits:\n  provider_session_max_input_tokens: null\n',
      ),
    ).toThrow(
      'limits.provider_session_max_input_tokens must be an integer between 20000 and 900000',
    );
  });

  it('renders configured caps and round-trips through the parser', () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits = {
      providerSessionMaxInputTokens: 240_000,
      providers: { anthropic: { requestsPerMinute: 45 } },
    };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('limits:');
    expect(yaml).toContain('  provider_session_max_input_tokens: 240000');
    expect(yaml).toContain('  anthropic:');
    expect(yaml).toContain('    requests_per_minute: 45');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.limits.providers).toEqual({
      anthropic: { requestsPerMinute: 45 },
    });
    expect(parsed.limits.providerSessionMaxInputTokens).toBe(240_000);
  });

  it('emits the limits block for a cap configured with no provider entries', () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits.providerSessionMaxInputTokens = 300_000;
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain(
      'limits:\n  provider_session_max_input_tokens: 300000',
    );
  });
});
