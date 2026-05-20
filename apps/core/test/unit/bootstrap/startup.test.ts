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
      'app:default': {
        name: 'Default Agent',
        folder: 'main_agent',
        trigger: '@Default Agent',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
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
        postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
      },
      memory: {},
    } as any;
    const result = await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
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
    });

    expect(order).toEqual([
      'layout',
      'load-settings',
      'init-storage',
      'log-db-init',
      'load-state',
      'ensure-credentials',
    ]);
    expect(result.runtimeSettings).toBe(runtimeSettings);
  });

  it('creates an internal default agent for a fresh runtime with no registered groups', async () => {
    const groups: Record<string, any> = {};
    const app = makeApp({
      getConversationRoutes: vi.fn(() => groups),
      registerGroup: vi.fn(async (jid, group) => {
        groups[jid] = group;
      }),
    });

    await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(),
      initializeRuntimeStorage: vi.fn(async () => ({}) as any),
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {},
            agent: { name: 'Default Agent' },
            storage: {
              postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
            },
            memory: {},
          }) as any,
      ),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(app.registerGroup).toHaveBeenCalledWith(
      'app:default',
      expect.objectContaining({
        name: 'Default Agent',
        folder: 'main_agent',
        trigger: '@Default Agent',
        requiresTrigger: false,
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
                memoryScope: 'conversation',
              },
            },
            agent: { name: 'Ravi Agent' },
            storage: {
              postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
            },
            memory: {},
          }) as any,
      ),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(app.registerGroup).toHaveBeenCalledWith(
      'app:default',
      expect.objectContaining({
        name: 'Ravi Agent',
        folder: 'main_agent',
        trigger: '@Ravi Agent',
        requiresTrigger: false,
      }),
    );
  });

  it('waits for credential bindings before completing startup', async () => {
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
        initializeRuntimeStorage: vi.fn(async () => ({}) as any),
        loadRuntimeSettings: vi.fn(
          () =>
            ({
              providers: {},
              storage: {
                postgres: {
                  urlEnv: 'GANTRY_DATABASE_URL',
                  schema: 'gantry',
                },
              },
              memory: {},
            }) as any,
        ),
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
        initializeRuntimeStorage: vi.fn(async () => ({}) as any),
        loadRuntimeSettings: vi.fn(
          () =>
            ({
              providers: {},
              storage: {
                postgres: {
                  urlEnv: 'GANTRY_DATABASE_URL',
                  schema: 'gantry',
                },
              },
              memory: {},
            }) as any,
        ),
        logger: {
          info: vi.fn(),
          warn,
        },
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await startup;

      expect(order).toEqual(['load-state', 'ensure-credentials-start']);
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
      initializeRuntimeStorage,
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            providers: {},
            storage: { provider: 'postgres' },
            memory: {},
          }) as any,
      ),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(initializeRuntimeStorage).toHaveBeenCalledOnce();
  });
});
