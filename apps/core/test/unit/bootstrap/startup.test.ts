import { describe, expect, it, vi } from 'vitest';

import { runStartup } from '@core/app/bootstrap/startup.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';

function makeApp(overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    channels: [],
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(async () => {}),
    saveState: vi.fn(async () => {}),
    getOrRecoverCursor: vi.fn(async () => ''),
    registerGroup: vi.fn(async () => {}),
    projectConversationRoute: vi.fn(async () => {}),
    setGroupModelOverride: vi.fn(async () => {}),
    setGroupThinkingOverride: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    setConversationRoutesForTest: vi.fn(),
    ensureCredentialBindingsForConversationRoutes: vi.fn(async () => {}),
    clearSessionForChatJid: vi.fn(async () => {}),
    processGroupMessages: vi.fn(),
    getConversationRoutes: vi.fn(() => ({
      'app:main': {
        name: 'Main Agent',
        folder: 'main_agent',
        trigger: '@Main Agent',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        isMain: true,
      },
    })),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
    setChannelRuntime: vi.fn(),
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
      ensureCredentialBindingsForConversationRoutes: vi.fn(async () => {
        order.push('ensure-credentials');
      }),
    });

    const runtimeSettings = {
      providers: {},
      storage: {
        postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
      },
      memory: {},
    } as any;
    const result = await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
      }),
      ensurePromptProfileBootstrapped: vi.fn(() => {
        order.push('prompt-bootstrap');
      }),
      initializeRuntimeStorage: vi.fn(async () => {
        order.push('init-storage');
        return {} as any;
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
      'load-settings',
      'init-storage',
      'log-db-init',
      'load-state',
      'ensure-credentials',
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
      initializeRuntimeStorage: vi.fn(async () => {
        order.push('init-storage');
        return {} as any;
      }),
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {},
            storage: {
              postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
            },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
      logger: {
        info: vi.fn(),
        warn,
      },
    });

    expect(order).toEqual(['layout', 'init-storage', 'restore-remote-control']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('creates an internal main agent for a fresh runtime with no registered groups', async () => {
    const groups: Record<string, any> = {};
    const app = makeApp({
      getConversationRoutes: vi.fn(() => groups),
      registerGroup: vi.fn(async (jid, group) => {
        groups[jid] = group;
      }),
    });

    await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(),
      ensurePromptProfileBootstrapped: vi.fn(),
      initializeRuntimeStorage: vi.fn(async () => ({}) as any),
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {},
            agent: { name: 'Main Agent' },
            storage: {
              postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
            },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(app.registerGroup).toHaveBeenCalledWith(
      'app:main',
      expect.objectContaining({
        name: 'Main Agent',
        folder: 'main_agent',
        trigger: '@Main Agent',
        requiresTrigger: false,
        isMain: true,
      }),
    );
  });

  it('does not treat Telegram approver IDs as recoverable chat bindings on startup', async () => {
    const groups: Record<string, any> = {};
    const app = makeApp({
      getConversationRoutes: vi.fn(() => groups),
      registerGroup: vi.fn(async (jid, group) => {
        groups[jid] = group;
      }),
    });

    await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(),
      ensurePromptProfileBootstrapped: vi.fn(),
      initializeRuntimeStorage: vi.fn(async () => ({}) as any),
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {
              telegram: { enabled: true },
            },
            providerConnections: {
              telegram_default: {
                provider: 'telegram',
                label: 'Telegram',
                runtimeSecretRefs: {},
              },
            },
            conversations: {
              main_telegram: {
                providerConnection: 'telegram_default',
                externalId: '123',
                kind: 'group',
                displayName: 'Main',
                senderPolicy: { allow: '*', mode: 'trigger' },
                controlApprovers: ['5759865942'],
              },
            },
            bindings: {
              main_telegram: {
                agent: 'main_agent',
                conversation: 'main_telegram',
                trigger: '@agent',
                addedAt: '2026-01-01T00:00:00.000Z',
                requiresTrigger: true,
                isMain: true,
                memoryScope: 'conversation',
              },
            },
            agent: { name: 'Ravi Agent' },
            storage: {
              postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
            },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(app.registerGroup).toHaveBeenCalledWith(
      'app:main',
      expect.objectContaining({
        name: 'Ravi Agent',
        folder: 'main_agent',
        trigger: '@Ravi Agent',
        requiresTrigger: false,
        isMain: true,
      }),
    );
  });

  it('waits for credential bindings before restoring remote control', async () => {
    const order: string[] = [];
    let releaseBinding!: () => void;
    const bindingStarted = new Promise<void>((resolve) => {
      const app = makeApp({
        loadState: vi.fn(async () => {
          order.push('load-state');
        }),
        ensureCredentialBindingsForConversationRoutes: vi.fn(async () => {
          order.push('ensure-credentials-start');
          resolve();
          await new Promise<void>((release) => {
            releaseBinding = release;
          });
          order.push('ensure-credentials-done');
        }),
      });
      const startup = runStartup(app, {
        ensureRuntimeLayoutDirectories: vi.fn(),
        ensurePromptProfileBootstrapped: vi.fn(),
        initializeRuntimeStorage: vi.fn(async () => ({}) as any),
        loadRuntimeSettings: vi.fn(
          () =>
            ({
              providers: {},
              storage: {
                postgres: {
                  urlEnv: 'MYCLAW_DATABASE_URL',
                  schema: 'myclaw',
                },
              },
              memory: {},
            }) as any,
        ),
        restoreRemoteControl: vi.fn(() => {
          order.push('restore-remote-control');
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      });
      void startup.then(() => {
        order.push('startup-done');
      });
    });

    await bindingStarted;
    expect(order).toEqual(['load-state', 'ensure-credentials-start']);
    releaseBinding();
    await vi.waitFor(() => {
      expect(order).toEqual([
        'load-state',
        'ensure-credentials-start',
        'ensure-credentials-done',
        'restore-remote-control',
        'startup-done',
      ]);
    });
  });

  it('continues startup when credential binding is slow', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const warn = vi.fn();
      const app = makeApp({
        loadState: vi.fn(async () => {
          order.push('load-state');
        }),
        ensureCredentialBindingsForConversationRoutes: vi.fn(async () => {
          order.push('ensure-credentials-start');
          await new Promise<void>(() => {});
        }),
      });

      const startup = runStartup(app, {
        ensureRuntimeLayoutDirectories: vi.fn(),
        ensurePromptProfileBootstrapped: vi.fn(),
        initializeRuntimeStorage: vi.fn(async () => ({}) as any),
        loadRuntimeSettings: vi.fn(
          () =>
            ({
              providers: {},
              storage: {
                postgres: {
                  urlEnv: 'MYCLAW_DATABASE_URL',
                  schema: 'myclaw',
                },
              },
              memory: {},
            }) as any,
        ),
        restoreRemoteControl: vi.fn(() => {
          order.push('restore-remote-control');
        }),
        logger: {
          info: vi.fn(),
          warn,
        },
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await startup;

      expect(order).toEqual([
        'load-state',
        'ensure-credentials-start',
        'restore-remote-control',
      ]);
      expect(warn).toHaveBeenCalledWith(
        { timeoutMs: 3_000 },
        expect.stringContaining('Credential broker binding did not finish'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('initializes Postgres storage for runtime settings', async () => {
    const initializeRuntimeStorage = vi.fn(async () => ({}) as any);
    await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(),
      ensurePromptProfileBootstrapped: vi.fn(),
      initializeRuntimeStorage,
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {},
            storage: { provider: 'postgres' },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(initializeRuntimeStorage).toHaveBeenCalledOnce();
  });
});
