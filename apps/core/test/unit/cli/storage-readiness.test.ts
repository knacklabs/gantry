import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectRuntimeStorageReadiness } from '@core/adapters/storage/postgres/storage-readiness.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/adapters/storage/postgres/storage-service.js');
});

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-storage-ready-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

describe('inspectRuntimeStorageReadiness', () => {
  it('fails when postgres url env is missing', async () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
    saveRuntimeSettings(runtimeHome, settings);

    const result = await inspectRuntimeStorageReadiness(runtimeHome);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('GANTRY_DATABASE_URL is required');
    expect(result.nextAction).toContain('docker-compose.yml');
  });

  it('runs migrations before health checks when requested', async () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
    settings.storage.postgres.schema = 'gantry';
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:5432/gantry\n',
    );
    const migrate = vi.fn().mockResolvedValue(undefined);
    const healthCheck = vi.fn().mockResolvedValue({
      lexicalSearch: true,
      vectorSearch: true,
      textSearch: true,
      jobQueue: true,
      runtimeEvents: true,
      eventBusOutbox: true,
    });
    const close = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@core/adapters/storage/postgres/storage-service.js', () => ({
      createStorageService: vi.fn(() => ({
        migrate,
        healthCheck,
        close,
      })),
    }));
    const { inspectRuntimeStorageReadiness: inspectWithMock } =
      await import('@core/adapters/storage/postgres/storage-readiness.js');

    const result = await inspectWithMock(runtimeHome, { migrate: true });

    expect(result.status).toBe('pass');
    expect(migrate).toHaveBeenCalledBefore(healthCheck);
    expect(close).toHaveBeenCalled();
  });

  it('passes the fleet rehearsal postgres hostname allowlist into storage', async () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
    settings.storage.postgres.schema = 'gantry';
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'GANTRY_DATABASE_URL=postgres://gantry_app:pass@postgres:5432/gantry',
        'GANTRY_FLEET_REHEARSAL_AUTO_SECRETS=1',
        '',
      ].join('\n'),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const createStorageService = vi.fn(() => ({
      healthCheck: vi.fn().mockResolvedValue({
        lexicalSearch: true,
        vectorSearch: true,
        textSearch: true,
        jobQueue: true,
        runtimeEvents: true,
        eventBusOutbox: true,
      }),
      close,
    }));
    vi.doMock('@core/adapters/storage/postgres/storage-service.js', () => ({
      createStorageService,
    }));
    const { inspectRuntimeStorageReadiness: inspectWithMock } =
      await import('@core/adapters/storage/postgres/storage-readiness.js');

    const result = await inspectWithMock(runtimeHome);

    expect(result.status).toBe('pass');
    expect(createStorageService).toHaveBeenCalledWith(
      expect.objectContaining({
        postgresPlaintextHostAllowlist: ['postgres'],
      }),
    );
    expect(close).toHaveBeenCalled();
  });
});
