import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
