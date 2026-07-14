import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimeStorageConfig } from '@core/config/settings/storage.js';
import { settingsFilePath } from '@core/config/settings/runtime-home.js';
import { parseRuntimeSettings } from '@core/config/settings/runtime-settings.js';

const ENV_KEYS = [
  'GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING',
  'GANTRY_DATABASE_URL',
  'GANTRY_SETTINGS_POSTGRES_SCHEMA',
  'GANTRY_DB_SCHEMA',
  'GANTRY_BOOTSTRAP_DEPLOYMENT_MODE',
  'GANTRY_DEPLOYMENT_MODE',
  'GANTRY_BOOTSTRAP_SANDBOX_PROVIDER',
] as const;

function withCleanEnv(fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('runtime storage bootstrap', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates minimal workstation settings when the container starts with an empty runtime home', () => {
    withCleanEnv(() => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-storage-bootstrap-'),
      );
      homes.push(runtimeHome);

      process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING = '1';
      process.env.GANTRY_DATABASE_URL =
        'postgres://user:pass@127.0.0.1:5432/gantry?schema=reagent';

      const config = resolveRuntimeStorageConfig(runtimeHome, runtimeHome);

      expect(config.postgresSchema).toBe('reagent');
      expect(config.postgresUrl).toBe(process.env.GANTRY_DATABASE_URL);
      expect(fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8')).toContain(
        'deployment_mode: workstation',
      );
      expect(fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8')).toContain(
        'schema: reagent',
      );
    });
  });

  it('defaults bootstrap settings to workstation mode and the Gantry Postgres schema', () => {
    withCleanEnv(() => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-storage-bootstrap-'),
      );
      homes.push(runtimeHome);

      process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING = '1';

      const config = resolveRuntimeStorageConfig(runtimeHome, runtimeHome);

      expect(config.postgresSchema).toBe('gantry');
      expect(config.postgresUrl).toBeNull();
      expect(fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8')).toContain(
        'deployment_mode: workstation',
      );
      expect(fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8')).toContain(
        'schema: gantry',
      );
    });
  });

  it('fails invalid settings.yaml even when env storage is available', () => {
    withCleanEnv(() => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-storage-bootstrap-'),
      );
      homes.push(runtimeHome);

      fs.writeFileSync(settingsFilePath(runtimeHome), '{');
      process.env.GANTRY_DATABASE_URL =
        'postgres://user:pass@127.0.0.1:5432/gantry?schema=revision_authority';

      expect(() =>
        resolveRuntimeStorageConfig(runtimeHome, runtimeHome),
      ).toThrow('Invalid runtime storage settings');
    });
  });

  it('fails invalid settings.yaml when no env storage is available', () => {
    withCleanEnv(() => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-storage-bootstrap-'),
      );
      homes.push(runtimeHome);

      fs.writeFileSync(settingsFilePath(runtimeHome), '{');

      expect(() =>
        resolveRuntimeStorageConfig(runtimeHome, runtimeHome),
      ).toThrow('Invalid runtime storage settings');
    });
  });

  it('reads storage while full runtime settings still reject stale root keys', () => {
    withCleanEnv(() => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-storage-bootstrap-'),
      );
      homes.push(runtimeHome);
      const yaml = [
        'provider_connections: {}',
        'storage:',
        '  postgres:',
        '    url_env: GANTRY_DATABASE_URL',
        '    schema: revision_authority',
        '',
      ].join('\n');

      fs.writeFileSync(settingsFilePath(runtimeHome), yaml);
      process.env.GANTRY_DATABASE_URL =
        'postgres://user:pass@127.0.0.1:5432/gantry';

      expect(
        resolveRuntimeStorageConfig(runtimeHome, runtimeHome),
      ).toMatchObject({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'revision_authority',
      });
      expect(() => parseRuntimeSettings(yaml)).toThrow(
        'provider_connections is no longer supported',
      );
    });
  });
});
