import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

describe('runtime.deployment_mode settings', () => {
  it('defaults to workstation when the key is absent', () => {
    const parsed = parseRuntimeSettings('agent:\n  name: Gantry\n');
    expect(parsed.runtime.deploymentMode).toBe('workstation');
  });

  it('parses an explicit fleet deployment mode', () => {
    const parsed = parseRuntimeSettings('runtime:\n  deployment_mode: fleet\n');
    expect(parsed.runtime.deploymentMode).toBe('fleet');
  });

  it('parses an explicit workstation deployment mode', () => {
    const parsed = parseRuntimeSettings(
      'runtime:\n  deployment_mode: workstation\n',
    );
    expect(parsed.runtime.deploymentMode).toBe('workstation');
  });

  it('rejects an unknown deployment mode via the strict parser', () => {
    expect(() =>
      parseRuntimeSettings('runtime:\n  deployment_mode: cluster\n'),
    ).toThrow(/runtime.deployment_mode must be workstation or fleet/);
  });

  it('rejects a non-string deployment mode value', () => {
    expect(() =>
      parseRuntimeSettings('runtime:\n  deployment_mode: 3\n'),
    ).toThrow(/runtime.deployment_mode/);
  });

  it('renders the fleet deployment mode and round-trips through the parser', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.deploymentMode = 'fleet';
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('  deployment_mode: fleet');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.deploymentMode).toBe('fleet');
  });

  it('omits the deployment_mode key for the default workstation mode to avoid drift', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('deployment_mode:');
  });
});
