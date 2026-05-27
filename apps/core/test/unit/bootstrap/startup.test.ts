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
    setProviderSettings: vi.fn(),
    getProviderSettings: vi.fn(() => undefined),
    setAgentsSettings: vi.fn(),
    getAgentSettings: vi.fn(() => undefined),
    getCredentialBroker: vi.fn(async () => undefined),
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
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
    });

    expect(order).toEqual([
      'layout',
      'load-settings',
      'init-storage',
      'log-db-init',
      'load-state',
      'ensure-credentials',
      'restore-remote-control',
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
      restoreRemoteControl: vi.fn(),
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
      restoreRemoteControl: vi.fn(),
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

  describe('Interakt inbound routing validation', () => {
    const makeDeps = (runtimeSettings: any) => ({
      ensureRuntimeLayoutDirectories: vi.fn(),
      initializeRuntimeStorage: vi.fn(async () => ({}) as any),
      loadRuntimeSettings: vi.fn(() => runtimeSettings),
      restoreRemoteControl: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    it('passes when providers.interakt.default_agent is set', async () => {
      const runtimeSettings = {
        providers: {
          interakt: { enabled: true, defaultAgent: 'boondi_support' },
        },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {},
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).resolves.toBeDefined();
    });

    it('passes when a template:true conversation has a wa:* external_id', async () => {
      const runtimeSettings = {
        providers: { interakt: { enabled: true } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {
          boondi_template: {
            providerConnection: 'interakt_default',
            externalId: 'wa:template',
            kind: 'dm',
            displayName: 'Boondi',
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: [],
            isTemplate: true,
          },
        },
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).resolves.toBeDefined();
    });

    it('throws when template:true conversation is outside the wa:* JID space', async () => {
      // A template in a different channel namespace (e.g. tg:template) does
      // not route Interakt inbound. Startup should not accept it as
      // sufficient Interakt routing.
      const runtimeSettings = {
        providers: { interakt: { enabled: true } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {
          tg_template: {
            providerConnection: 'telegram_default',
            externalId: 'tg:template',
            kind: 'dm',
            displayName: 'TG Template',
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: [],
            isTemplate: true,
          },
        },
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).rejects.toThrow(
        /Interakt is enabled but no inbound routing is configured/,
      );
    });

    it('throws when only a specific wa:<phone> conversation is configured (no template, no default_agent)', async () => {
      // A wa:<phone> entry routes ONE customer only; it is not a routing
      // source for new customers. Without default_agent or template:true the
      // runtime cannot route new inbound, so we fail fast.
      const runtimeSettings = {
        providers: { interakt: { enabled: true } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {
          known_customer: {
            providerConnection: 'interakt_default',
            externalId: 'wa:919654405340',
            kind: 'dm',
            displayName: 'Customer',
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: [],
          },
        },
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).rejects.toThrow(
        /Interakt is enabled but no inbound routing is configured/,
      );
    });

    it('throws when Interakt is enabled but no routing target is configured', async () => {
      const runtimeSettings = {
        providers: { interakt: { enabled: true } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {},
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).rejects.toThrow(
        /Interakt is enabled but no inbound routing is configured/,
      );
    });

    it('does not throw when Interakt is disabled', async () => {
      const runtimeSettings = {
        providers: { interakt: { enabled: false } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        conversations: {},
      } as any;
      await expect(
        runStartup(makeApp(), makeDeps(runtimeSettings)),
      ).resolves.toBeDefined();
    });

    it('warns when more than one wa:* template is configured', async () => {
      const warn = vi.fn();
      const runtimeSettings = {
        providers: { interakt: { enabled: true } },
        storage: {
          postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
        },
        providerConnections: {},
        conversations: {
          t1: {
            providerConnection: 'interakt_default',
            externalId: 'wa:template_one',
            kind: 'dm',
            displayName: 'T1',
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: [],
            isTemplate: true,
          },
          t2: {
            providerConnection: 'interakt_default',
            externalId: 'wa:template_two',
            kind: 'dm',
            displayName: 'T2',
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: [],
            isTemplate: true,
          },
        },
      } as any;
      await runStartup(makeApp(), {
        ...makeDeps(runtimeSettings),
        logger: { info: vi.fn(), warn },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          templates: expect.arrayContaining([
            'wa:template_one',
            'wa:template_two',
          ]),
        }),
        expect.stringMatching(/Multiple template:true conversations/),
      );
    });
  });
});
