import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeEnvFile } from '@core/config/env/file.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

function makeStorageRuntime() {
  return {
    service: {
      assertMigrationsCurrent: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({
        lexicalSearch: true,
        vectorSearch: true,
        textSearch: true,
        jobQueue: true,
        runtimeEvents: true,
        eventBusOutbox: true,
      })),
      close: vi.fn(async () => undefined),
    },
    repositories: {
      modelCredentials: { kind: 'target-home-model-credentials' },
      workerCoordination: {},
      liveTurns: {},
    },
    liveTurnCommandWakeupSource: {
      close: vi.fn(async () => undefined),
    },
    liveAdmissionWakeupSource: {
      close: vi.fn(async () => undefined),
    },
    runtimeEventNotifier: {
      close: vi.fn(async () => undefined),
    },
  };
}

describe('model CLI runtime-home storage', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('acquires credential storage from the explicit runtime home', async () => {
    const defaultHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-model-default-home-'),
    );
    const targetHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-model-target-home-'),
    );
    const previousGantryHome = process.env.GANTRY_HOME;
    const envKey = 'GANTRY_MODEL_COMMAND_TEST_DATABASE_URL';
    const previousDatabaseUrl = process.env[envKey];
    process.env.GANTRY_HOME = defaultHome;
    delete process.env[envKey];
    writeEnvFile(path.join(defaultHome, '.env'), {
      [envKey]: 'postgresql://default:default@localhost/default',
    });
    writeEnvFile(path.join(targetHome, '.env'), {
      [envKey]: 'postgresql://target:target@localhost/target',
    });

    const storage = makeStorageRuntime();
    const createStorageRuntime = vi.fn(() => storage);
    const preflightModelProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));
    vi.doMock(
      '@core/adapters/storage/postgres/factory.js',
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import('@core/adapters/storage/postgres/factory.js')
        >()),
        createStorageRuntime,
      }),
    );
    vi.doMock('@core/adapters/llm/model-provider-preflight.js', () => ({
      preflightModelProvider,
    }));

    try {
      const { runWithModelCommandPreflight } =
        await import('@core/cli/model-command-preflight.js');
      const settings = createDefaultRuntimeSettings();
      settings.credentialBroker.mode = 'gantry';
      settings.storage.postgres.urlEnv = envKey;
      settings.storage.postgres.schema = 'target_home';

      await expect(
        runWithModelCommandPreflight({
          runtimeHome: targetHome,
          run: (preflightProvider) =>
            preflightProvider(targetHome, 'openai', settings, 'gpt-terra').then(
              (result) => (result.ok ? 0 : 1),
            ),
        }),
      ).resolves.toBe(0);

      expect(createStorageRuntime).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          runtimeSettings: settings,
          storageConfig: expect.objectContaining({
            postgresUrl: 'postgresql://target:target@localhost/target',
            postgresUrlEnv: envKey,
            postgresSchema: 'target_home',
          }),
        }),
      );
      expect(preflightModelProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHome: targetHome,
          modelCredentials: storage.repositories.modelCredentials,
        }),
      );
    } finally {
      if (previousGantryHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = previousGantryHome;
      if (previousDatabaseUrl === undefined) delete process.env[envKey];
      else process.env[envKey] = previousDatabaseUrl;
      fs.rmSync(defaultHome, { recursive: true, force: true });
      fs.rmSync(targetHome, { recursive: true, force: true });
    }
  });
});
