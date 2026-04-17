import { describe, expect, it, vi } from 'vitest';

import { runStartup } from './startup.js';
import { RuntimeApp } from './runtime-app.js';

function makeApp(overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    channels: [],
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(),
    registerGroup: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setRegisteredGroupsForTest: vi.fn(),
    ensureOneCLIAgentsForRegisteredGroups: vi.fn(),
    processGroupMessages: vi.fn(),
    getRegisteredGroups: vi.fn(() => ({})),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
    ...overrides,
  };
}

describe('runStartup', () => {
  it('preserves startup order through host runtime startup', async () => {
    const order: string[] = [];
    const app = makeApp({
      loadState: vi.fn(() => {
        order.push('load-state');
      }),
      ensureOneCLIAgentsForRegisteredGroups: vi.fn(() => {
        order.push('ensure-onecli');
      }),
    });

    const runtimeSettings = { channels: {}, memory: {} } as any;
    const result = await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
      }),
      ensurePromptProfileBootstrapped: vi.fn(() => {
        order.push('prompt-bootstrap');
      }),
      initDatabase: vi.fn(() => {
        order.push('init-db');
      }),
      logger: {
        info: vi.fn(() => {
          order.push('log-db-init');
        }),
        warn: vi.fn(),
      },
      loadRuntimeSettings: vi.fn(() => {
        order.push('load-settings');
        return runtimeSettings;
      }),
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
    });

    expect(order).toEqual([
      'layout',
      'prompt-bootstrap',
      'init-db',
      'log-db-init',
      'load-settings',
      'load-state',
      'ensure-onecli',
      'restore-remote-control',
    ]);
    expect(result.runtimeSettings).toBe(runtimeSettings);
  });

  it('continues startup when prompt bootstrap fails', async () => {
    const order: string[] = [];
    const warn = vi.fn();

    await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
      }),
      ensurePromptProfileBootstrapped: vi.fn(() => {
        throw new Error('seed failed');
      }),
      initDatabase: vi.fn(() => {
        order.push('init-db');
      }),
      loadRuntimeSettings: vi.fn(() => ({ channels: {}, memory: {} }) as any),
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
      logger: {
        info: vi.fn(),
        warn,
      },
    });

    expect(order).toEqual(['layout', 'init-db', 'restore-remote-control']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
