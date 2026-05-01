import { describe, expect, it } from 'vitest';

import {
  createDefaultRuntimeSettings,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

describe('runtime settings', () => {
  it('defaults, renders, and parses agent.name', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.agent.name).toBe('Main Agent');

    settings.agent.name = 'Kai';
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('name: Kai');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.name).toBe('Kai');
  });

  it('defaults, renders, and parses job model defaults', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'sonnet';
    settings.agent.oneTimeJobDefaultModel = 'kimi';
    settings.agent.recurringJobDefaultModel = 'opus-4.6';

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('one_time_job_default_model: kimi');
    expect(yaml).toContain('recurring_job_default_model: opus-4.6');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.defaultModel).toBe('sonnet');
    expect(parsed.agent.oneTimeJobDefaultModel).toBe('kimi');
    expect(parsed.agent.recurringJobDefaultModel).toBe('opus-4.6');
  });

  it('rejects unsupported agent settings keys', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings).replace(
      '  default_model:',
      '  raw_env: true\n  default_model:',
    );
    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agent.raw_env is not supported',
    );
  });
});
