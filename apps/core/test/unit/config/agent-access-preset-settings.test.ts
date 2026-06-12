import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

const agentYaml = (presetLine: string): string => `agents:
  support_agent:
    name: Support
    access:
${presetLine}`;

describe('agent access preset settings', () => {
  it('defaults the preset to full when access block is absent', () => {
    const parsed = parseRuntimeSettings(`agents:
  support_agent:
    name: Support
`);
    expect(parsed.agents.support_agent.accessPreset).toBe('full');
  });

  it('parses an explicit full preset', () => {
    const parsed = parseRuntimeSettings(agentYaml('      preset: full'));
    expect(parsed.agents.support_agent.accessPreset).toBe('full');
  });

  it('parses a locked preset', () => {
    const parsed = parseRuntimeSettings(agentYaml('      preset: locked'));
    expect(parsed.agents.support_agent.accessPreset).toBe('locked');
  });

  it('rejects an unknown preset value via the strict parser', () => {
    expect(() =>
      parseRuntimeSettings(agentYaml('      preset: paranoid')),
    ).toThrow(/preset must be full or locked/);
  });

  it('rejects unknown keys inside the access block', () => {
    expect(() => parseRuntimeSettings(agentYaml('      mode: locked'))).toThrow(
      /is not supported. Configure sources, selections, or preset/,
    );
  });

  it('renders only the locked preset and round-trips through the parser', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.support_agent = {
      name: 'Support',
      folder: 'support_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'locked',
    };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('preset: locked');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agents.support_agent.accessPreset).toBe('locked');
  });

  it('omits the access block for a default full agent to avoid settings drift', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.support_agent = {
      name: 'Support',
      folder: 'support_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('preset:');
    expect(yaml).not.toContain('access:');
  });
});
