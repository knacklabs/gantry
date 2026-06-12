import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  effectiveAgentEngineForFolder,
  formatAgentEngineLine,
} from '@core/cli/group-engine.js';
import {
  AGENT_ENGINES,
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
  unsupportedAgentEngineMessage,
} from '@core/shared/agent-engine.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings-types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/config/settings/desired-settings-writer.js');
});

function settingsWithAgent(
  agentEngine?: (typeof AGENT_ENGINES)[number],
): RuntimeSettings {
  return {
    agent: { defaultAgentEngine: DEFAULT_AGENT_ENGINE },
    agents: {
      support_agent: {
        name: 'Support',
        folder: 'support_agent',
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full',
        ...(agentEngine ? { agentEngine } : {}),
      },
    },
  } as unknown as RuntimeSettings;
}

function mockClack() {
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({ log, note: vi.fn() }));
  return log;
}

describe('agent engine display helpers', () => {
  it('reports the configured default as inherited', () => {
    const settings = settingsWithAgent();
    expect(effectiveAgentEngineForFolder(settings, 'support_agent')).toEqual({
      engine: DEFAULT_AGENT_ENGINE,
      isOverride: false,
    });
    expect(formatAgentEngineLine(settings, 'support_agent')).toBe(
      'Agent engine: Anthropic SDK (default)',
    );
  });

  it('reports a per-agent override without the default annotation', () => {
    const settings = settingsWithAgent(DEEPAGENTS_ENGINE);
    expect(effectiveAgentEngineForFolder(settings, 'support_agent')).toEqual({
      engine: DEEPAGENTS_ENGINE,
      isOverride: true,
    });
    expect(formatAgentEngineLine(settings, 'support_agent')).toBe(
      'Agent engine: DeepAgents',
    );
  });
});

describe('agent engine CLI (runEngine)', () => {
  it('writes the engine to settings.yaml via the desired-state writer', async () => {
    mockClack();
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => settingsWithAgent()),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      writeDesiredRuntimeSettings,
    }));
    const { runEngine } = await import('@core/cli/group-engine.js');

    const code = await runEngine('/tmp/gantry-engine-test', [
      'support_agent',
      DEEPAGENTS_ENGINE,
    ]);

    expect(code).toBe(0);
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledTimes(1);
    const written = writeDesiredRuntimeSettings.mock.calls[0]?.[0] as {
      settings: { agents: Record<string, { agentEngine?: string }> };
    };
    expect(written.settings.agents.support_agent.agentEngine).toBe(
      DEEPAGENTS_ENGINE,
    );
  });

  it('prints the locked success copy for the updated engine', async () => {
    const log = mockClack();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => settingsWithAgent()),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      writeDesiredRuntimeSettings: vi.fn(async () => ({ reconciled: true })),
    }));
    const { runEngine } = await import('@core/cli/group-engine.js');

    await runEngine('/tmp/gantry-engine-test', [
      'support_agent',
      DEEPAGENTS_ENGINE,
    ]);

    expect(log.success).toHaveBeenCalledWith(
      'Agent engine updated: support_agent now uses DeepAgents. Existing jobs and conversations use this engine on their next run.',
    );
  });

  it('rejects an unsupported engine with the locked parse copy', async () => {
    const log = mockClack();
    const writeDesiredRuntimeSettings = vi.fn();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => settingsWithAgent()),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      writeDesiredRuntimeSettings,
    }));
    const { runEngine } = await import('@core/cli/group-engine.js');

    const code = await runEngine('/tmp/gantry-engine-test', [
      'support_agent',
      'langchain',
    ]);

    expect(code).toBe(1);
    expect(writeDesiredRuntimeSettings).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      unsupportedAgentEngineMessage('langchain'),
    );
  });

  it('returns 1 for an unknown agent folder', async () => {
    const log = mockClack();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => settingsWithAgent()),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      writeDesiredRuntimeSettings: vi.fn(),
    }));
    const { runEngine } = await import('@core/cli/group-engine.js');

    expect(
      await runEngine('/tmp/gantry-engine-test', ['ghost', DEEPAGENTS_ENGINE]),
    ).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'No configured agent named "ghost". Run "gantry agent list" to see configured agents.',
    );
  });
});
