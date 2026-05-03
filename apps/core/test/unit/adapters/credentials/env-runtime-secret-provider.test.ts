import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { EnvRuntimeSecretProvider } from '@core/adapters/credentials/env-runtime-secret-provider.js';

describe('EnvRuntimeSecretProvider', () => {
  const originalHome = process.env.MYCLAW_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MYCLAW_HOME;
    } else {
      process.env.MYCLAW_HOME = originalHome;
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('falls back to runtime .env when using process.env', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-env-'));
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'TELEGRAM_BOT_TOKEN=123456:runtime-token\n',
      'utf8',
    );
    process.env.MYCLAW_HOME = runtimeHome;
    const provider = new EnvRuntimeSecretProvider();

    expect(provider.getOptionalSecret({ env: 'TELEGRAM_BOT_TOKEN' })).toBe(
      '123456:runtime-token',
    );
  });

  it('does not fall back to runtime .env for explicit test sources', () => {
    const provider = new EnvRuntimeSecretProvider({});

    expect(provider.getOptionalSecret({ env: 'TELEGRAM_BOT_TOKEN' })).toBe(
      undefined,
    );
  });

  it('refuses wrong-lane provider credentials from process env and runtime .env', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-env-'));
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-runtime\n',
      'utf8',
    );
    process.env.MYCLAW_HOME = runtimeHome;
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
