import { describe, expect, it } from 'vitest';

import {
  createDefaultRuntimeSettings,
  DEFAULT_LLM_GLOBAL_MAX_IN_FLIGHT,
  DEFAULT_LLM_PER_APP_KEY_MAX_IN_FLIGHT,
} from '@core/config/settings/runtime-settings-defaults.js';
import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

describe('runtime LLM admission settings', () => {
  it('uses conservative process-local defaults when the block is absent', () => {
    const parsed = parseRuntimeSettings('agent:\n  name: Gantry\n');

    expect(parsed.runtime.llmAdmission).toEqual({
      globalMaxInFlight: DEFAULT_LLM_GLOBAL_MAX_IN_FLIGHT,
      perAppKeyMaxInFlight: DEFAULT_LLM_PER_APP_KEY_MAX_IN_FLIGHT,
    });
    expect(DEFAULT_LLM_GLOBAL_MAX_IN_FLIGHT).toBe(32);
    expect(DEFAULT_LLM_PER_APP_KEY_MAX_IN_FLIGHT).toBe(8);
  });

  it('parses and renders configured admission ceilings', () => {
    const parsed = parseRuntimeSettings(
      [
        'runtime:',
        '  llm_admission:',
        '    global_max_in_flight: 12',
        '    per_app_key_max_in_flight: 3',
        '',
      ].join('\n'),
    );
    expect(parsed.runtime.llmAdmission).toEqual({
      globalMaxInFlight: 12,
      perAppKeyMaxInFlight: 3,
    });

    const yaml = renderRuntimeSettingsYaml(parsed);
    expect(yaml).toContain('  llm_admission:');
    expect(yaml).toContain('    global_max_in_flight: 12');
    expect(yaml).toContain('    per_app_key_max_in_flight: 3');
    expect(parseRuntimeSettings(yaml).runtime.llmAdmission).toEqual(
      parsed.runtime.llmAdmission,
    );
  });

  it('omits the default admission block with the rest of default runtime settings', () => {
    const yaml = renderRuntimeSettingsYaml(createDefaultRuntimeSettings());
    expect(yaml).not.toContain('llm_admission:');
  });

  it.each([
    ['global_max_in_flight', 0],
    ['per_app_key_max_in_flight', 1.5],
  ])('rejects invalid %s values', (key, value) => {
    expect(() =>
      parseRuntimeSettings(
        `runtime:\n  llm_admission:\n    ${key}: ${value}\n`,
      ),
    ).toThrow(`runtime.llm_admission.${key} must be a positive integer`);
  });

  it('rejects unsupported admission keys', () => {
    expect(() =>
      parseRuntimeSettings(
        'runtime:\n  llm_admission:\n    max_in_flight: 4\n',
      ),
    ).toThrow(/runtime\.llm_admission\.max_in_flight is not supported/);
  });
});
