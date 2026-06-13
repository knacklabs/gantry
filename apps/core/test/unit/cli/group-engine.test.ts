import { describe, expect, it } from 'vitest';

import {
  derivedAgentEngineForFolder,
  formatAgentEngineCell,
  formatAgentEngineLine,
} from '@core/cli/group-engine.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings-types.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';

function settingsWithModels(input: {
  defaultModel?: string;
  agentModel?: string;
}): RuntimeSettings {
  return {
    agent: { defaultModel: input.defaultModel ?? '' },
    agents: {
      support_agent: {
        name: 'Support',
        folder: 'support_agent',
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full',
        ...(input.agentModel ? { model: input.agentModel } : {}),
      },
    },
  } as unknown as RuntimeSettings;
}

describe('agent engine display helpers (provider-derived)', () => {
  it('derives Anthropic SDK from an anthropic-provider model', () => {
    const settings = settingsWithModels({ agentModel: 'opus' });
    expect(derivedAgentEngineForFolder(settings, 'support_agent')).toBe(
      DEFAULT_AGENT_ENGINE,
    );
    expect(formatAgentEngineCell(settings, 'support_agent')).toBe(
      'Anthropic SDK',
    );
    expect(formatAgentEngineLine(settings, 'support_agent')).toBe(
      'Agent engine: Anthropic SDK',
    );
  });

  it('derives DeepAgents from an openrouter/openai-provider model', () => {
    const settings = settingsWithModels({ agentModel: 'kimi' });
    expect(derivedAgentEngineForFolder(settings, 'support_agent')).toBe(
      'deepagents',
    );
    expect(formatAgentEngineLine(settings, 'support_agent')).toBe(
      'Agent engine: DeepAgents',
    );
  });

  it('falls back to the configured default model when the agent has none', () => {
    const settings = settingsWithModels({ defaultModel: 'kimi' });
    expect(derivedAgentEngineForFolder(settings, 'support_agent')).toBe(
      'deepagents',
    );
  });
});
