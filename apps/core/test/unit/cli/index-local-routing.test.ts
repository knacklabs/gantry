import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cli-db-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/infrastructure/service/manager.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/adapters/storage/postgres/storage-service.js');
  vi.doUnmock('@core/cli/channel.js');
  vi.doUnmock('@core/cli/local.js');
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('CLI local routing', () => {
  it('bypasses top-level settings validation for local status and prints Compose guidance', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'storage: nope\n',
    );
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'local', 'status']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker-compose.yml'),
      'Local Status',
    );
  });

  it('does not stop local Docker services from the MyClaw CLI', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['stop']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose stop'),
      'Local Stop',
    );
  });

  it('points local logs to docker compose without requiring configured services', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['logs']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose logs'),
      'Local Logs',
    );
  });

  it('routes top-level channel commands to the channel command family', async () => {
    const runtimeHome = makeRuntimeHome();
    const runChannelCommand = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
      readRuntimeMemorySettingsSnapshot: vi.fn(() => ({
        memoryEnabled: false,
        storage: {
          postgresUrlEnv: 'MYCLAW_DATABASE_URL',
          postgresSchema: 'myclaw',
        },
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-large',
        },
        dreaming: { enabled: false },
        llmModels: {
          extractor: 'claude-haiku-4-5-20251001',
          dreaming: 'claude-sonnet-4-6',
          consolidation: 'claude-sonnet-4-6',
        },
      })),
      readRuntimeStorageSettingsSnapshot: vi.fn(() => ({
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      })),
    }));
    vi.doMock('@core/cli/channel.js', () => ({ runChannelCommand }));

    const { main } = await import('@core/cli/index.js');
    const code = await main([
      '--runtime-home',
      runtimeHome,
      'channel',
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runChannelCommand).toHaveBeenCalledWith(
      expect.any(String),
      runtimeHome,
      ['connect', 'telegram'],
    );
  });
});
