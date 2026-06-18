import { describe, expect, it } from 'vitest';

import {
  formatAgentHarnessCell,
  formatAgentHarnessLine,
  selectedAgentHarnessForFolder,
} from '@core/cli/group-engine.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings-types.js';

function settingsWithHarness(input: {
  defaultHarness?: 'auto' | 'anthropic_sdk' | 'deepagents';
  agentHarness?: 'auto' | 'anthropic_sdk' | 'deepagents';
}): RuntimeSettings {
  return {
    agent: { defaultModel: '', agentHarness: input.defaultHarness ?? 'auto' },
    agents: {
      support_agent: {
        name: 'Support',
        folder: 'support_agent',
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full',
        ...(input.agentHarness ? { agentHarness: input.agentHarness } : {}),
      },
    },
  } as unknown as RuntimeSettings;
}

describe('agent harness display helpers', () => {
  it('uses the per-agent harness when configured', () => {
    const settings = settingsWithHarness({ agentHarness: 'anthropic_sdk' });
    expect(selectedAgentHarnessForFolder(settings, 'support_agent')).toBe(
      'anthropic_sdk',
    );
    expect(formatAgentHarnessCell(settings, 'support_agent')).toBe(
      'anthropic_sdk',
    );
    expect(formatAgentHarnessLine(settings, 'support_agent')).toBe(
      'Agent harness: anthropic_sdk',
    );
  });

  it('falls back to the configured default harness', () => {
    const settings = settingsWithHarness({ defaultHarness: 'deepagents' });
    expect(selectedAgentHarnessForFolder(settings, 'support_agent')).toBe(
      'deepagents',
    );
    expect(formatAgentHarnessLine(settings, 'support_agent')).toBe(
      'Agent harness: deepagents',
    );
  });

  it('defaults to auto when nothing is configured', () => {
    const settings = settingsWithHarness({});
    expect(selectedAgentHarnessForFolder(settings, 'support_agent')).toBe(
      'auto',
    );
  });
});
