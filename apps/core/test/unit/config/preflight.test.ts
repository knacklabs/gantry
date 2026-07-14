import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { saveRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import {
  inspectRuntimeSecretReadiness,
  inspectRuntimeStorageReadiness,
} from '@core/adapters/storage/postgres/storage-readiness.js';
import { validateRuntimePreflightWithStorage } from '@core/config/preflight.js';

vi.mock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
  inspectRuntimeStorageReadiness: vi.fn(async () => ({
    status: 'pass',
    message: 'storage ready',
  })),
  inspectRuntimeSecretReadiness: vi.fn(async () => ({
    status: 'pass',
    message: 'secrets ready',
  })),
}));

const mockedInspectRuntimeStorageReadiness = vi.mocked(
  inspectRuntimeStorageReadiness,
);
const mockedInspectRuntimeSecretReadiness = vi.mocked(
  inspectRuntimeSecretReadiness,
);
const runtimeHomes: string[] = [];
const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
const originalRuntimeEnv = process.env.GANTRY_RUNTIME_ENV;
const strongEncryptionKey = Buffer.from(
  '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
  'hex',
).toString('base64');

function createRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-preflight-test-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  if (originalDatabaseUrl === undefined) {
    delete process.env.GANTRY_DATABASE_URL;
  } else {
    process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
  }
  if (originalSecretEncryptionKey === undefined) {
    delete process.env.SECRET_ENCRYPTION_KEY;
  } else {
    process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
  }
  if (originalRuntimeEnv === undefined) {
    delete process.env.GANTRY_RUNTIME_ENV;
  } else {
    process.env.GANTRY_RUNTIME_ENV = originalRuntimeEnv;
  }
  vi.clearAllMocks();
});

describe('runtime preflight', () => {
  it('fails production security before running storage migrations', async () => {
    const runtimeHome = createRuntimeHome();
    process.env.GANTRY_DATABASE_URL =
      'postgres://gantry:gantry@localhost:5432/gantry_test';
    process.env.SECRET_ENCRYPTION_KEY = strongEncryptionKey;
    const settings = createDefaultRuntimeSettings();
    settings.runtime.sandbox.provider = 'direct';
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_RUNTIME_ENV=remote\n',
    );

    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        summary: 'Production security preflight failed.',
      },
    });
    expect(mockedInspectRuntimeStorageReadiness).not.toHaveBeenCalled();
  });

  it('does not let blank process env mask runtime .env production posture', async () => {
    const runtimeHome = createRuntimeHome();
    process.env.GANTRY_DATABASE_URL =
      'postgres://gantry:gantry@localhost:5432/gantry_test';
    process.env.SECRET_ENCRYPTION_KEY = strongEncryptionKey;
    process.env.GANTRY_RUNTIME_ENV = '';
    const settings = createDefaultRuntimeSettings();
    settings.runtime.sandbox.provider = 'direct';
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_RUNTIME_ENV=remote\n',
    );

    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        summary: 'Production security preflight failed.',
      },
    });
    expect(mockedInspectRuntimeStorageReadiness).not.toHaveBeenCalled();
  });

  it('fails when enabled provider runtime secret refs do not resolve', async () => {
    mockedInspectRuntimeSecretReadiness.mockResolvedValueOnce({
      status: 'fail',
      message: 'Runtime secret preflight failed.',
      details: [
        'provider_accounts.slack_default.provider slack runtime_secret_refs.bot_token runtime secret ref gantry-secret:SLACK_BOT_TOKEN did not resolve.',
        'provider_accounts.slack_default.provider slack runtime_secret_refs.app_token runtime secret ref gantry-secret:SLACK_APP_TOKEN did not resolve.',
      ],
    });
    const runtimeHome = createRuntimeHome();
    process.env.GANTRY_DATABASE_URL =
      'postgres://gantry:gantry@localhost:5432/gantry_test';
    process.env.SECRET_ENCRYPTION_KEY = strongEncryptionKey;
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {
        bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
        app_token: 'gantry-secret:SLACK_APP_TOKEN',
      },
    };
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      `GANTRY_DATABASE_URL=${process.env.GANTRY_DATABASE_URL}\nSECRET_ENCRYPTION_KEY=${strongEncryptionKey}\n`,
    );

    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        summary: 'Runtime secret preflight failed.',
        details: [
          'provider_accounts.slack_default.provider slack runtime_secret_refs.bot_token runtime secret ref gantry-secret:SLACK_BOT_TOKEN did not resolve.',
          'provider_accounts.slack_default.provider slack runtime_secret_refs.app_token runtime secret ref gantry-secret:SLACK_APP_TOKEN did not resolve.',
        ],
      },
    });
    expect(mockedInspectRuntimeSecretReadiness).toHaveBeenCalled();
  });
});
