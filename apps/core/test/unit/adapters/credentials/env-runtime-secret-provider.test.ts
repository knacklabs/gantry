import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { EnvRuntimeSecretProvider } from '@core/adapters/credentials/env-runtime-secret-provider.js';

describe('EnvRuntimeSecretProvider', () => {
  const originalHome = process.env.GANTRY_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.GANTRY_HOME;
    } else {
      process.env.GANTRY_HOME = originalHome;
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('falls back to runtime .env when using process.env', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-env-'));
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'TELEGRAM_BOT_TOKEN=123456:runtime-token\n',
      'utf8',
    );
    process.env.GANTRY_HOME = runtimeHome;
    const provider = new EnvRuntimeSecretProvider();

    expect(provider.getOptionalSecret({ env: 'TELEGRAM_BOT_TOKEN' })).toBe(
      '123456:runtime-token',
    );
  });

  it('parses JSON-quoted runtime .env values the same way as preflight', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-env-'));
    const keyring = JSON.stringify({
      active: 'primary',
      keys: {
        primary: Buffer.from(
          '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
          'hex',
        ).toString('base64'),
      },
    });
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      `SECRET_ENCRYPTION_KEYRING_JSON=${JSON.stringify(keyring)}\n`,
      'utf8',
    );
    process.env.GANTRY_HOME = runtimeHome;
    const provider = new EnvRuntimeSecretProvider();

    expect(
      provider.getOptionalSecret({ env: 'SECRET_ENCRYPTION_KEYRING_JSON' }),
    ).toBe(keyring);
  });

  it('does not fall back to runtime .env for explicit test sources', () => {
    const provider = new EnvRuntimeSecretProvider({});

    expect(provider.getOptionalSecret({ env: 'TELEGRAM_BOT_TOKEN' })).toBe(
      undefined,
    );
  });

  it('refuses wrong-lane provider credentials from process env and runtime .env', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-env-'));
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-runtime\n',
      'utf8',
    );
    process.env.GANTRY_HOME = runtimeHome;
    process.env.OPENAI_API_KEY = 'sk-openai-process';
    const provider = new EnvRuntimeSecretProvider();

    expect(provider.getOptionalSecret({ env: 'OPENAI_API_KEY' })).toBe(
      undefined,
    );
    expect(provider.getOptionalSecret({ env: 'ANTHROPIC_API_KEY' })).toBe(
      undefined,
    );
    expect(() => provider.getSecret({ env: 'OPENAI_API_KEY' })).toThrow(
      'OPENAI_API_KEY is required.',
    );
  });
});
