import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { inspectRuntimeStorageReadiness } from '@core/adapters/storage/postgres/storage-readiness.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-storage-ready-'));
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
    settings.storage.postgres.urlEnv = 'MYCLAW_DATABASE_URL';
    saveRuntimeSettings(runtimeHome, settings);

    const result = await inspectRuntimeStorageReadiness(runtimeHome);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('MYCLAW_DATABASE_URL is required');
    expect(result.nextAction).toContain('docker-compose.yml');
  });
});
