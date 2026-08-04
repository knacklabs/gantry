import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockConfigEnvModule(values: Record<string, string> = {}) {
  const readValue = (key: string) =>
    process.env[key]?.trim() || values[key]?.trim() || '';
  return {
    envConfig: values,
    envValue: readValue,
    runtimeEnvValue: readValue,
    envValueDynamic: readValue,
    runtimeEnvValueDynamic: readValue,
  };
}

describe('ipc auth secret source', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GANTRY_IPC_AUTH_SECRET;
  });

  afterEach(() => {
    delete process.env.GANTRY_IPC_AUTH_SECRET;
    vi.restoreAllMocks();
  });

  it('loads GANTRY_IPC_AUTH_SECRET from .env when process env is missing', async () => {
    vi.doMock('@core/config/env/index.js', () =>
      mockConfigEnvModule({
        GANTRY_IPC_AUTH_SECRET: 'env-file-secret',
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: () => ({
        agent: { defaultModel: '' },
        credentialBroker: {
          mode: 'none',
          model_gateway: {
            url: '',
            postgres: {
              urlEnv: 'GANTRY_MODEL_GATEWAY_DATABASE_URL',
              schema: 'model_gateway',
            },
          },
          external: { baseUrl: '' },
        },
      }),
      readRuntimeMemorySettingsSnapshot: () => ({}),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    }));
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: { warn: vi.fn() },
      withLogContext: (_context: unknown, callback: () => unknown) =>
        callback(),
      updateLogContext: vi.fn(),
    }));

    const { computeIpcAuthToken } = await import('@core/runtime/ipc-auth.js');
    const token = computeIpcAuthToken('team-alpha');
    const expected = createHmac('sha256', 'env-file-secret')
      .update('team-alpha')
      .digest('hex');

    expect(token).toBe(expected);
  });

  it('prefers process.env over .env secret when both are present', async () => {
    process.env.GANTRY_IPC_AUTH_SECRET = 'process-secret';

    vi.doMock('@core/config/env/index.js', () =>
      mockConfigEnvModule({
        GANTRY_IPC_AUTH_SECRET: 'env-file-secret',
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: () => ({
        agent: { defaultModel: '' },
        credentialBroker: {
          mode: 'none',
          model_gateway: {
            url: '',
            postgres: {
              urlEnv: 'GANTRY_MODEL_GATEWAY_DATABASE_URL',
              schema: 'model_gateway',
            },
          },
          external: { baseUrl: '' },
        },
      }),
      readRuntimeMemorySettingsSnapshot: () => ({}),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    }));
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: { warn: vi.fn() },
      withLogContext: (_context: unknown, callback: () => unknown) =>
        callback(),
      updateLogContext: vi.fn(),
    }));

    const { computeIpcAuthToken } = await import('@core/runtime/ipc-auth.js');
    const token = computeIpcAuthToken('team-alpha');
    const expected = createHmac('sha256', 'process-secret')
      .update('team-alpha')
      .digest('hex');

    expect(token).toBe(expected);
  });

  it('refuses ephemeral fallback when runtime .env posture requires production secrets', async () => {
    vi.doMock('@core/config/env/index.js', () =>
      mockConfigEnvModule({
        GANTRY_RUNTIME_ENV: 'production',
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: () => ({
        agent: { defaultModel: '' },
        credentialBroker: {
          mode: 'none',
          model_gateway: {
            url: '',
            postgres: {
              urlEnv: 'GANTRY_MODEL_GATEWAY_DATABASE_URL',
              schema: 'model_gateway',
            },
          },
          external: { baseUrl: '' },
        },
      }),
      readRuntimeMemorySettingsSnapshot: () => ({}),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    }));
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: { warn: vi.fn() },
      withLogContext: (_context: unknown, callback: () => unknown) =>
        callback(),
      updateLogContext: vi.fn(),
    }));

    await expect(import('@core/runtime/ipc-auth.js')).rejects.toThrow(
      'GANTRY_IPC_AUTH_SECRET is required in production or remote control mode.',
    );
  });
});
