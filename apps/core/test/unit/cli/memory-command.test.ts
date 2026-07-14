import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-memory-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

async function loadMemoryCommand() {
  const log = {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    log,
  }));
  const { runMemoryCommand } = await import('@core/cli/memory.js');
  return { runMemoryCommand, log };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('memory command', () => {
  it('does not save a provider that is registered but not configured', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runMemoryCommand, log } = await loadMemoryCommand();

    const code = await runMemoryCommand(runtimeHome, ['embeddings', 'openai']);

    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Embedding provider "openai" is not ready'),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.embeddings.provider).toBe('disabled');
  });

  it('enables OpenAI embeddings when the provider validates successfully', async () => {
    const runtimeHome = makeRuntimeHome();
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      isEmbeddingProviderRegistered: vi.fn(
        (provider: string) => provider === 'openai',
      ),
      validateEmbeddingProviderReady: vi.fn(async () => undefined),
    }));
    saveRuntimeSettings(runtimeHome, loadRuntimeSettings(runtimeHome));
    const { runMemoryCommand, log } = await loadMemoryCommand();

    const code = await runMemoryCommand(runtimeHome, ['embeddings', 'openai']);

    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(
      'Memory embeddings set to openai in settings.yaml.',
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.memory.embeddings.enabled).toBe(true);
    expect(settings.memory.embeddings.provider).toBe('openai');
  });

  it('prints restart guidance when dreaming changes', async () => {
    const runtimeHome = makeRuntimeHome();
    saveRuntimeSettings(runtimeHome, loadRuntimeSettings(runtimeHome));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runMemoryCommand } = await loadMemoryCommand();

    const code = await runMemoryCommand(runtimeHome, ['dreaming', 'on']);

    expect(code).toBe(0);
    expect(consoleLog).toHaveBeenCalledWith(
      'This change requires a restart to take effect — run `gantry restart`.',
    );
  });
});
