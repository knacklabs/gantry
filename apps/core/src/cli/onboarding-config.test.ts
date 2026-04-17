import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { readEnvFile } from './env-file.js';
import { persistOnboardingConfig } from './onboarding-config.js';
import { envFilePath } from './runtime-home.js';
import { loadRuntimeSettings } from './runtime-settings.js';

function createRuntimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-onboarding-config-'));
}

describe('persistOnboardingConfig', () => {
  it('persists env-only credential mode and removes ONECLI_URL', () => {
    const runtimeHome = createRuntimeHome();
    const envPath = envFilePath(runtimeHome);
    fs.writeFileSync(
      envPath,
      [
        'ONECLI_URL=http://localhost:10254',
        'MYCLAW_CREDENTIAL_MODE=hybrid',
      ].join('\n'),
      'utf-8',
    );

    persistOnboardingConfig({
      runtimeHome,
      telegramBotToken: 'token',
      credentialMode: 'env-only',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    const env = readEnvFile(envPath);
    expect(env.MYCLAW_CREDENTIAL_MODE).toBe('env-only');
    expect(env.ONECLI_URL).toBeUndefined();

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.channels.telegram.enabled).toBe(true);
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.provider).toBe('sqlite');
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.embeddings.provider).toBe('disabled');
    expect(settings.memory.dreaming.enabled).toBe(false);
  });

  it('persists onecli URL for hybrid mode', () => {
    const runtimeHome = createRuntimeHome();
    const envPath = envFilePath(runtimeHome);

    persistOnboardingConfig({
      runtimeHome,
      telegramBotToken: 'token',
      credentialMode: 'hybrid',
      onecliUrl: 'http://localhost:10254',
      memoryEnabled: true,
      embeddingsEnabled: true,
      dreamingEnabled: true,
      openAiApiKey: 'sk-openai',
    });

    const env = readEnvFile(envPath);
    expect(env.MYCLAW_CREDENTIAL_MODE).toBe('hybrid');
    expect(env.ONECLI_URL).toBe('http://localhost:10254');
    expect(env.OPENAI_API_KEY).toBe('sk-openai');
    expect(env.MEMORY_PROVIDER).toBeUndefined();
    expect(env.MEMORY_EMBED_PROVIDER).toBeUndefined();
    expect(env.MEMORY_DREAMING_ENABLED).toBeUndefined();

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.provider).toBe('sqlite');
    expect(settings.memory.embeddings.enabled).toBe(true);
    expect(settings.memory.embeddings.provider).toBe('openai');
    expect(settings.memory.dreaming.enabled).toBe(true);
  });
});
