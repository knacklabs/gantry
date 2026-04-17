import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertEnvFile } from './env-file.js';
import { runMemoryCommand } from './memory.js';
import { envFilePath } from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

describe('memory CLI commands', () => {
  let runtimeHome: string;

  beforeEach(() => {
    runtimeHome = createRuntimeHome();
  });

  it('sets provider to qmd and keeps memory enabled', async () => {
    const code = await runMemoryCommand(runtimeHome, ['provider', 'qmd']);
    expect(code).toBe(0);

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.provider).toBe('qmd');
  });

  it('rejects openai embeddings when OPENAI_API_KEY is missing', async () => {
    upsertEnvFile(envFilePath(runtimeHome), { OPENAI_API_KEY: null });
    const before = loadRuntimeSettings(runtimeHome);
    expect(before.memory.embeddings.enabled).toBe(false);

    const code = await runMemoryCommand(runtimeHome, ['embeddings', 'openai']);
    expect(code).toBe(1);

    const after = loadRuntimeSettings(runtimeHome);
    expect(after.memory.embeddings.enabled).toBe(false);
    expect(after.memory.embeddings.provider).toBe('disabled');
  });

  it('enables persistent sqlite memory when dreaming is turned on', async () => {
    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.enabled = false;
    settings.memory.provider = 'noop';
    saveRuntimeSettings(runtimeHome, settings);

    const code = await runMemoryCommand(runtimeHome, ['dreaming', 'on']);
    expect(code).toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.memory.enabled).toBe(true);
    expect(updated.memory.provider).toBe('sqlite');
    expect(updated.memory.dreaming.enabled).toBe(true);
  });
});
