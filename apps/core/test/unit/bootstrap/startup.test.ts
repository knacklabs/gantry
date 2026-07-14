import { describe, expect, it, vi } from 'vitest';

import { runStartup } from '@core/app/bootstrap/startup.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import {
  createDefaultRuntimeSettings,
  type RuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { settingsToRevisionDocument } from '@core/config/settings/settings-import-service.js';

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
      'init-storage',
      'log-db-init',
      'load-settings',
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
            providerAccounts: {
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
        expect.stringContaining('Gantry Model Gateway binding did not finish'),
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

  it('does not promote local fleet settings when no settings revision exists', async () => {
    const fileSettings = createDefaultRuntimeSettings();
    fileSettings.runtime.deploymentMode = 'fleet';
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    };
    const importWorkstationSettings = vi.fn(async () => ({ revision: 1 }));
    const warn = vi.fn();

    const result = await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(),
      initializeRuntimeStorage: vi.fn(
        async () =>
          ({
            ops: {},
            repositories: { settingsRevisions },
            service: { pool: undefined },
          }) as any,
      ),
      settingsAuthority: 'revision',
      settingsFileExists: vi.fn(() => true),
      loadRuntimeSettings: vi.fn(() => fileSettings),
      importWorkstationSettings,
      logger: { info: vi.fn(), warn },
    });

    expect(importWorkstationSettings).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { appId: 'default' },
      'No settings revision exists; fleet startup will not promote local settings.yaml to durable authority',
    );
    expect(result.runtimeSettings.runtime.deploymentMode).toBe('fleet');
  });

  it('restores the latest revision when settings.yaml differs during revision-authority startup', async () => {
    const revisionSettings = createDefaultRuntimeSettings();
    revisionSettings.agent.name = 'Revision Agent';
    const fileSettings = structuredClone(revisionSettings) as RuntimeSettings;
    fileSettings.agent.name = 'File Agent';
    const latestRevision = {
      revision: 1,
      settingsDocument: settingsToRevisionDocument(revisionSettings),
    };
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => latestRevision),
    };
    const importWorkstationSettings = vi.fn(async () => ({}));
    const warn = vi.fn();
    const initializeRuntimeStorage = vi.fn(
      async () =>
        ({
          ops: {},
          repositories: { settingsRevisions },
          runtimeEventNotifier: { close: vi.fn(async () => undefined) },
          service: {
            pool: undefined,
            close: vi.fn(async () => undefined),
          },
        }) as any,
    );

    const result = await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(),
      initializeRuntimeStorage,
      settingsAuthority: 'revision',
      settingsFileExists: vi.fn(() => true),
      validateSettingsImportPreflight: vi.fn(() => ({ ok: true })),
      loadRuntimeSettings: vi.fn(() => fileSettings),
      importWorkstationSettings,
      logger: { info: vi.fn(), warn },
    });

    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        agent: expect.objectContaining({ name: 'Revision Agent' }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      { appId: 'default', revision: 1 },
      'settings.yaml differs from latest settings revision; restoring revision-authority mirror',
    );
    expect(initializeRuntimeStorage).toHaveBeenCalledTimes(2);
    expect(initializeRuntimeStorage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeSettings: expect.objectContaining({
          agent: expect.objectContaining({ name: 'Revision Agent' }),
        }),
      }),
    );
    expect(result.runtimeSettings.agent.name).toBe('Revision Agent');
  });

  it('rejects initial local settings promotion when preflight fails', async () => {
    const fileSettings = createDefaultRuntimeSettings();
    fileSettings.agent.name = 'Unsafe File Agent';
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    };
    const importWorkstationSettings = vi.fn(async () => ({ revision: 1 }));

    await expect(
      runStartup(makeApp(), {
        ensureRuntimeLayoutDirectories: vi.fn(),
        initializeRuntimeStorage: vi.fn(
          async () =>
            ({
              ops: {},
              repositories: { settingsRevisions },
              runtimeEventNotifier: { close: vi.fn(async () => undefined) },
              service: {
                pool: undefined,
                close: vi.fn(async () => undefined),
              },
            }) as any,
        ),
        settingsAuthority: 'revision',
        settingsFileExists: vi.fn(() => true),
        validateSettingsImportPreflight: vi.fn(() => ({
          ok: false,
          failure: {
            summary: 'Production security preflight failed.',
            details: ['unsafe production settings'],
          },
        })),
        formatRuntimePreflightFailure: vi.fn(
          (failure: { summary: string; details: string[] }) =>
            [failure.summary, ...failure.details].join('\n'),
        ),
        loadRuntimeSettings: vi.fn(() => fileSettings),
        importWorkstationSettings,
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow('Production security preflight failed.');
    expect(importWorkstationSettings).not.toHaveBeenCalled();
  });

  it('rejects settings revisions that require a newer reader during revision-authority startup', async () => {
    const revisionSettings = createDefaultRuntimeSettings();
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => ({
        revision: 3,
        minReaderVersion: 999,
        settingsDocument: settingsToRevisionDocument(revisionSettings),
      })),
    };

    await expect(
      runStartup(makeApp(), {
        ensureRuntimeLayoutDirectories: vi.fn(),
        initializeRuntimeStorage: vi.fn(
          async () =>
            ({
              ops: {},
              repositories: { settingsRevisions },
              runtimeEventNotifier: { close: vi.fn(async () => undefined) },
              service: {
                pool: undefined,
                close: vi.fn(async () => undefined),
              },
            }) as any,
        ),
        settingsAuthority: 'revision',
        settingsFileExists: vi.fn(() => true),
        loadRuntimeSettings: vi.fn(() => revisionSettings),
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      'Settings revision 3 requires settings reader version 999',
    );
  });

  it('uses settings.yaml storage config for revision-authority startup when it exists', async () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const fileSettings = createDefaultRuntimeSettings();
    fileSettings.agent.name = 'File Agent';
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    };
    const initializeRuntimeStorage = vi.fn(
      async () =>
        ({
          ops: {},
          repositories: { settingsRevisions },
          runtimeEventNotifier: { close: vi.fn(async () => undefined) },
          service: {
            pool: undefined,
            close: vi.fn(async () => undefined),
          },
        }) as any,
    );

    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@127.0.0.1:5432/bootstrap';

      await runStartup(makeApp(), {
        ensureRuntimeLayoutDirectories: vi.fn(),
        initializeRuntimeStorage,
        importWorkstationSettings: vi.fn(async () => ({ revision: 1 })),
        settingsAuthority: 'revision',
        settingsFileExists: vi.fn(() => true),
        validateSettingsImportPreflight: vi.fn(() => ({ ok: true })),
        loadRuntimeSettings: vi.fn(() => fileSettings),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      expect(initializeRuntimeStorage).toHaveBeenNthCalledWith(
        1,
        expect.not.objectContaining({
          storageConfig: expect.anything(),
        }),
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('keeps booting from the latest revision when settings.yaml is invalid', async () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSettingsSchema = process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA;
    const revisionSettings = createDefaultRuntimeSettings();
    revisionSettings.agent.name = 'Revision Agent';
    const latestRevision = {
      revision: 1,
      settingsDocument: settingsToRevisionDocument(revisionSettings),
    };
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => latestRevision),
    };
    const importWorkstationSettings = vi.fn(async () => ({}));
    const warn = vi.fn();
    const storageRuntime = {
      ops: {},
      repositories: { settingsRevisions },
      runtimeEventNotifier: { close: vi.fn(async () => undefined) },
      service: {
        pool: undefined,
        close: vi.fn(async () => undefined),
      },
    } as any;
    const initializeRuntimeStorage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Invalid runtime storage settings: invalid yaml'),
      )
      .mockResolvedValue(storageRuntime);

    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@127.0.0.1:5432/gantry_test';
      process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = 'revision_authority';

      const result = await runStartup(makeApp(), {
        ensureRuntimeLayoutDirectories: vi.fn(),
        initializeRuntimeStorage,
        settingsAuthority: 'revision',
        settingsFileExists: vi.fn(() => true),
        loadRuntimeSettings: vi.fn(() => {
          throw new Error('invalid yaml');
        }),
        importWorkstationSettings,
        logger: { info: vi.fn(), warn },
      });

      expect(initializeRuntimeStorage).toHaveBeenNthCalledWith(
        1,
        expect.not.objectContaining({
          storageConfig: expect.anything(),
        }),
      );
      expect(initializeRuntimeStorage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          storageConfig: expect.objectContaining({
            postgresUrlEnv: 'GANTRY_DATABASE_URL',
            postgresSchema: 'revision_authority',
          }),
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 1 }),
        'settings.yaml is invalid; using latest settings revision',
      );
      expect(importWorkstationSettings).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          agent: expect.objectContaining({ name: 'Revision Agent' }),
        }),
      );
      expect(result.runtimeSettings.agent.name).toBe('Revision Agent');
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSettingsSchema === undefined) {
        delete process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA;
      } else {
        process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = originalSettingsSchema;
      }
    }
  });
});
