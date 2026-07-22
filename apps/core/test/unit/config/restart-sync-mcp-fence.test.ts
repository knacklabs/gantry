import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '@core/domain/mcp/mcp-servers.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const reconcile = vi.hoisted(() => vi.fn());

vi.mock('@core/config/settings/desired-state-service.js', () => ({
  SettingsDesiredStateService: class {
    reconcile = reconcile;
  },
}));

vi.mock('@core/config/settings/configured-capability-normalization.js', () => ({
  normalizeConfiguredCapabilitiesInSettings: async (input: {
    settings: RuntimeSettings;
  }) => ({
    settings: input.settings,
    changed: false,
    changedAgentFolders: [],
  }),
}));

vi.mock('@core/config/settings/runtime-settings-validation.js', () => ({
  validateLoadedRuntimeSettings: () => ({ ok: true }),
}));

import { applyRuntimeSettingsDesiredState } from '@core/config/settings/restart-sync.js';

describe('runtime settings MCP approval fence', () => {
  it('leaves the previous file untouched when the initial authority fence rejects', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-fence-reject-'),
    );
    const previousSettings = settingsWithMcpSource(['get-sum']);
    const nextSettings = structuredClone(previousSettings);
    nextSettings.agents.main_agent.toolRules = ['capability:mcp.e2e-sum.read'];
    saveRuntimeSettings(runtimeHome, previousSettings);
    reconcile.mockReset();
    reconcile.mockRejectedValueOnce(
      new McpBindingAuthorityChangedError('mcp:e2e-sum'),
    );
    const reloadRuntimeState = vi.fn();

    try {
      await expect(
        applyRuntimeSettingsDesiredState({
          runtimeHome,
          settings: nextSettings,
          previousSettings,
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          reloadRuntimeState,
          expectedMcpBindings: [bindingPrecondition(['get-sum'])],
        }),
      ).rejects.toThrow('changed during capability approval');

      expect(reconcile).toHaveBeenCalledOnce();
      expect(reloadRuntimeState).not.toHaveBeenCalled();
      expect(
        loadRuntimeSettings(runtimeHome).agents.main_agent.toolRules,
      ).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('uses the fresh complete binding snapshot for compensating rollback', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-fence-'),
    );
    const previousSettings = settingsWithMcpSource([
      'get-sum',
      'search_delete',
    ]);
    const nextSettings = structuredClone(previousSettings);
    nextSettings.agents.main_agent.toolRules = ['capability:mcp.e2e-sum.read'];
    const precondition = bindingPrecondition(['get-sum', 'search_delete']);
    const currentPrecondition = {
      ...bindingPrecondition(['get-sum']),
      status: 'disabled' as const,
    };
    reconcile.mockReset();
    reconcile
      .mockResolvedValueOnce({
        applied: [],
        skipped: [],
        invalidReferences: [],
      })
      .mockResolvedValueOnce({
        applied: [],
        skipped: [],
        invalidReferences: [],
      });
    const reloadRuntimeState = vi
      .fn()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(
        applyRuntimeSettingsDesiredState({
          runtimeHome,
          settings: nextSettings,
          previousSettings,
          ops: {} as never,
          repositories: {
            mcpServers: {
              listAgentBindings: vi.fn(async () => [
                {
                  ...currentPrecondition,
                  createdAt: '2026-07-21T12:00:00.000Z',
                  updatedAt: '2026-07-21T12:00:00.000Z',
                },
              ]),
            },
          } as never,
          appId: 'default' as never,
          reloadRuntimeState,
          expectedMcpBindings: [precondition],
        }),
      ).rejects.toThrow('reload failed');

      expect(reconcile).toHaveBeenCalledTimes(2);
      const [rollbackSettings, rollbackOptions] = reconcile.mock.calls[1] as [
        RuntimeSettings,
        {
          expectedMcpBindingAgentIds?: string[];
          expectedMcpBindings?: McpBindingAuthorityPrecondition[];
        },
      ];
      expect(rollbackOptions.expectedMcpBindingAgentIds).toEqual([
        'agent:main_agent',
      ]);
      expect(rollbackOptions.expectedMcpBindings).toEqual([
        currentPrecondition,
      ]);
      expect(rollbackSettings.agents.main_agent.sources.mcpServers).toEqual([
        {
          id: 'mcp:e2e-sum',
          status: 'disabled',
          tools: ['get-sum'],
        },
      ]);
      expect(
        loadRuntimeSettings(runtimeHome).agents.main_agent.sources.mcpServers,
      ).toEqual([
        {
          id: 'mcp:e2e-sum',
          status: 'disabled',
          tools: ['get-sum'],
        },
      ]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});

function settingsWithMcpSource(tools: string[]): RuntimeSettings {
  const settings = createDefaultRuntimeSettings();
  settings.agents.main_agent = {
    name: 'Main',
    folder: 'main_agent',
    delegates: [],
    bindings: {},
    sources: {
      skills: [],
      mcpServers: [{ id: 'mcp:e2e-sum', tools }],
      tools: [],
    },
    capabilities: [],
  };
  return settings;
}

function bindingPrecondition(
  allowedToolPatterns: string[],
): McpBindingAuthorityPrecondition {
  return {
    id: 'agent-mcp-binding:agent:main_agent:mcp:e2e-sum' as never,
    appId: 'default' as never,
    agentId: 'agent:main_agent' as never,
    serverId: 'mcp:e2e-sum' as never,
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns,
  };
}
