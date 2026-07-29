import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-backfill-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

async function loadCommand() {
  const log = {
    error: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    log,
  }));
  const { runEmbeddingBackfillCommand } =
    await import('@core/cli/memory-embeddings-backfill.js');
  return { runEmbeddingBackfillCommand, log };
}

afterEach(() => {
  for (const home of runtimeHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/memory/memory-embeddings.js');
  vi.doUnmock('@core/memory/app-memory-backfill.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.unstubAllEnvs();
});

describe('gantry memory embeddings backfill', () => {
  it('rejects an invalid --mode without touching storage', async () => {
    const { runEmbeddingBackfillCommand, log } = await loadCommand();
    const code = await runEmbeddingBackfillCommand(makeRuntimeHome(), [
      '--mode',
      'turbo',
    ]);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('--mode must be one of'),
    );
  });

  it('rejects a non-positive --limit', async () => {
    const { runEmbeddingBackfillCommand, log } = await loadCommand();
    const code = await runEmbeddingBackfillCommand(makeRuntimeHome(), [
      '--limit',
      '0',
    ]);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('--limit must be a positive integer'),
    );
  });

  it('fails with exit 1 when embeddings are disabled', async () => {
    const { runEmbeddingBackfillCommand, log } = await loadCommand();
    const code = await runEmbeddingBackfillCommand(makeRuntimeHome(), []);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('embeddings are not enabled'),
    );
  });

  it("passes the requested runtime home's broker config to embeddings", async () => {
    const settings = createDefaultRuntimeSettings();
    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = 'openai';
    settings.credentialBroker.mode = 'gantry';
    settings.credentialBroker.gateway.bindHost = '::1';
    const createEmbeddingProvider = vi.fn(() => ({ kind: 'embedding' }));
    const release = vi.fn(async () => undefined);
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: () => settings,
    }));
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      createEmbeddingProvider,
    }));
    vi.doMock('@core/memory/app-memory-backfill.js', () => ({
      runEmbeddingBackfill: vi.fn(async () => ({
        runId: 'run-1',
        status: 'completed',
        mode: 'inline',
        totalCandidates: 0,
        indexed: 0,
        skippedReady: 0,
        pending: 0,
        submitted: 0,
        scanTruncated: false,
      })),
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      acquireRuntimeStorageForRuntimeHome: vi.fn(async () => ({
        storage: { service: { db: {} } },
        release,
      })),
    }));
    const globalHome = makeRuntimeHome();
    const targetHome = makeRuntimeHome();
    vi.stubEnv('GANTRY_HOME', globalHome);
    const { runEmbeddingBackfillCommand } = await loadCommand();

    await expect(runEmbeddingBackfillCommand(targetHome, [])).resolves.toBe(0);

    expect(createEmbeddingProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        credentialBrokerConfig: {
          mode: 'gantry',
          gatewayBindHost: '::1',
        },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
