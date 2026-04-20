import fs from 'fs';
import os from 'os';
import path from 'path';

import * as prompts from '@clack/prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertEnvFile } from '@core/cli/env-file.js';
import * as memoryHealth from '@core/cli/memory-health.js';
import { runMemoryCommand } from '@core/cli/memory.js';
import { envFilePath } from '@core/cli/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/cli/runtime-settings.js';
import { MemoryService } from '@core/memory/memory-service.js';
import { MemoryStore } from '@core/memory/memory-store.js';

vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const promptMocks = prompts as unknown as {
  note: ReturnType<typeof vi.fn>;
  log: {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
};

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
  const originalMemoryRoot = process.env.MEMORY_ROOT;

  beforeEach(() => {
    runtimeHome = createRuntimeHome();
    vi.clearAllMocks();
    if (originalMemoryRoot === undefined) {
      delete process.env.MEMORY_ROOT;
    } else {
      process.env.MEMORY_ROOT = originalMemoryRoot;
    }
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
    saveRuntimeSettings(runtimeHome, settings);

    const code = await runMemoryCommand(runtimeHome, ['dreaming', 'on']);
    expect(code).toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.memory.enabled).toBe(true);
    expect(updated.memory.root).toBe('memory');
    expect(updated.memory.dreaming.enabled).toBe(true);
  });

  it('prints structured json for memory status --json', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const code = await runMemoryCommand(runtimeHome, ['status', '--json']);
      expect(code).toBe(0);
      const output = stdoutWrite.mock.calls
        .map((call) => String(call[0] || ''))
        .join('');
      const parsed = JSON.parse(output) as {
        mode?: string;
        liveDbPath?: string;
        counters?: Record<string, unknown>;
      };
      expect(typeof parsed.mode).toBe('string');
      expect(typeof parsed.liveDbPath).toBe('string');
      expect(parsed.counters).toBeTruthy();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it('prints memory health journal status', async () => {
    const code = await runMemoryCommand(runtimeHome, [
      'health',
      'journal-status',
    ]);
    expect(code).toBe(0);
    expect(promptMocks.note).toHaveBeenCalled();
  });

  it('uses MEMORY_ROOT env override for journal-status root resolution', async () => {
    upsertEnvFile(envFilePath(runtimeHome), { MEMORY_ROOT: 'env-memory' });
    const code = await runMemoryCommand(runtimeHome, [
      'health',
      'journal-status',
    ]);
    expect(code).toBe(0);
    const expectedRoot = path.resolve(runtimeHome, 'env-memory', '.journal');
    expect(promptMocks.note).toHaveBeenCalledWith(
      expect.stringContaining(`Root: ${expectedRoot}`),
      'Memory Health',
    );
  });

  it('prefers process env MEMORY_ROOT over runtime env file for journal-status', async () => {
    upsertEnvFile(envFilePath(runtimeHome), { MEMORY_ROOT: 'env-memory' });
    process.env.MEMORY_ROOT = 'process-memory';
    const code = await runMemoryCommand(runtimeHome, [
      'health',
      'journal-status',
    ]);
    expect(code).toBe(0);
    const expectedRoot = path.resolve(
      runtimeHome,
      'process-memory',
      '.journal',
    );
    expect(promptMocks.note).toHaveBeenCalledWith(
      expect.stringContaining(`Root: ${expectedRoot}`),
      'Memory Health',
    );
  });

  it('returns success when divergence check reports no mismatch', async () => {
    vi.spyOn(memoryHealth, 'inspectMemoryDivergence').mockResolvedValue({
      journalRoot: '/tmp/journal',
      liveDbPath: '/tmp/live.db',
      replayDbPath: '/tmp/replay.db',
      live: { items: 1, procedures: 1, pinnedItems: 1 },
      replayed: { items: 1, procedures: 1, pinnedItems: 1 },
      diff: { items: 0, procedures: 0, pinnedItems: 0 },
      hasDivergence: false,
    });
    const code = await runMemoryCommand(runtimeHome, ['health', 'divergence']);
    expect(code).toBe(0);
  });

  it('returns failure when divergence check reports mismatch', async () => {
    vi.spyOn(memoryHealth, 'inspectMemoryDivergence').mockResolvedValue({
      journalRoot: '/tmp/journal',
      liveDbPath: '/tmp/live.db',
      replayDbPath: '/tmp/replay.db',
      live: { items: 2, procedures: 1, pinnedItems: 1 },
      replayed: { items: 1, procedures: 1, pinnedItems: 1 },
      diff: { items: 1, procedures: 0, pinnedItems: 0 },
      hasDivergence: true,
    });
    const code = await runMemoryCommand(runtimeHome, ['health', 'divergence']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      'Memory divergence detected between live DB and journal replay.',
    );
  });

  it('returns failure when divergence check throws', async () => {
    vi.spyOn(memoryHealth, 'inspectMemoryDivergence').mockRejectedValue(
      new Error('journal missing'),
    );
    const code = await runMemoryCommand(runtimeHome, ['health', 'divergence']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Memory divergence check failed: journal missing',
      ),
    );
  });

  it('skips unreadable files during list command instead of failing', async () => {
    const memoryFilePath = path.join(
      runtimeHome,
      'memory',
      'items',
      'fact',
      'sample.md',
    );
    fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
    fs.writeFileSync(
      memoryFilePath,
      ['---', 'id: sample-1', 'kind: fact', '---', '', 'hello'].join('\n'),
      'utf-8',
    );

    const originalReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      options?: any,
    ) => {
      if (
        typeof target === 'string' &&
        path.resolve(target) === path.resolve(memoryFilePath)
      ) {
        throw new Error('unreadable');
      }
      return originalReadFileSync(target, options as never);
    }) as typeof fs.readFileSync);

    const code = await runMemoryCommand(runtimeHome, ['list']);
    readSpy.mockRestore();
    expect(code).toBe(0);
    expect(promptMocks.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 1 unreadable memory file(s).'),
    );
    expect(promptMocks.note).toHaveBeenCalledWith(
      'No memory files found.',
      'Memory List',
    );
  });

  it('prints in-process counters', async () => {
    const code = await runMemoryCommand(runtimeHome, ['counters']);
    expect(code).toBe(0);
    expect(promptMocks.note).toHaveBeenCalled();
  });

  it('rejects full reindex when memory root resolves outside runtime home', async () => {
    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.root = path.join(os.tmpdir(), 'outside-memory-root');
    saveRuntimeSettings(runtimeHome, settings);

    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('must resolve inside runtime home'),
    );
  });

  it('rejects reindex when memory root resolves outside runtime home', async () => {
    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.root = path.join(os.tmpdir(), 'outside-memory-root');
    saveRuntimeSettings(runtimeHome, settings);

    const code = await runMemoryCommand(runtimeHome, ['reindex']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('memory.root must resolve inside runtime home'),
    );
  });

  it('rejects full reindex when MEMORY_ROOT env override resolves outside runtime home', async () => {
    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.root = 'memory';
    saveRuntimeSettings(runtimeHome, settings);
    upsertEnvFile(envFilePath(runtimeHome), {
      MEMORY_ROOT: path.join(os.tmpdir(), 'outside-memory-root'),
    });

    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('must resolve inside runtime home'),
    );
  });

  it('rejects full reindex when process env MEMORY_ROOT resolves outside runtime home', async () => {
    process.env.MEMORY_ROOT = path.join(os.tmpdir(), 'outside-memory-root');
    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('must resolve inside runtime home'),
    );
  });

  it('rejects full reindex when memory root is a symlink escaping runtime home', async () => {
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-outside-'),
    );
    const symlinkName = path.join(runtimeHome, 'memory-link');
    try {
      fs.symlinkSync(outsideRoot, symlinkName, 'dir');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        return;
      }
      throw err;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.root = 'memory-link';
    saveRuntimeSettings(runtimeHome, settings);

    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('must resolve inside runtime home'),
    );
  });

  it('rejects full reindex when inspected sqlite path does not match configured root', async () => {
    const settings = loadRuntimeSettings(runtimeHome);
    settings.memory.root = 'memory';
    saveRuntimeSettings(runtimeHome, settings);
    const inspectSpy = vi
      .spyOn(memoryHealth, 'inspectMemoryHealth')
      .mockReturnValue({
        ...memoryHealth.inspectMemoryHealth(runtimeHome, settings, {}),
        sqlitePath: path.join(runtimeHome, 'unexpected.db'),
      } as ReturnType<typeof memoryHealth.inspectMemoryHealth>);

    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(1);
    expect(promptMocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('resolved DB path mismatch'),
    );
    inspectSpy.mockRestore();
  });

  it('removes deleted item markdown by frontmatter id before full reindex', async () => {
    const sqlitePath = path.join(runtimeHome, 'memory', '.cache', 'memory.db');
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const store = new MemoryStore(sqlitePath);
    try {
      store.saveItem({
        id: 'mem-deleted-1',
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: 'fact:stale',
        value: 'stale value',
        source: 'test',
        confidence: 0.6,
        is_deleted: true,
        deleted_at: '2026-04-20T00:00:00.000Z',
        source_folder: 'items',
      });
    } finally {
      store.close();
    }

    const staleMirror = path.join(
      runtimeHome,
      'memory',
      'items',
      'fact',
      'stale.md',
    );
    fs.mkdirSync(path.dirname(staleMirror), { recursive: true });
    fs.writeFileSync(
      staleMirror,
      [
        '---',
        'id: mem-deleted-1',
        'scope: group',
        'group_folder: team',
        'kind: fact',
        'key: fact:stale',
        '---',
        '',
        'stale value',
      ].join('\n'),
      'utf-8',
    );

    const code = await runMemoryCommand(runtimeHome, ['reindex', '--full']);
    expect(code).toBe(0);
    expect(fs.existsSync(staleMirror)).toBe(false);
  });

  it('runs reindex without touching MemoryService singleton', async () => {
    const getInstanceSpy = vi.spyOn(MemoryService, 'getInstance');
    const closeInstanceSpy = vi.spyOn(MemoryService, 'closeInstance');
    const code = await runMemoryCommand(runtimeHome, ['reindex']);
    expect(code).toBe(0);
    expect(getInstanceSpy).not.toHaveBeenCalled();
    expect(closeInstanceSpy).not.toHaveBeenCalled();
  });

  it('sets a per-task memory model override', async () => {
    const code = await runMemoryCommand(runtimeHome, [
      'model',
      'set',
      'dreaming',
      'claude-haiku-4-5-20251001',
    ]);
    expect(code).toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.memory.llm.models.dreaming).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('applies the cheap model profile across all memory tasks', async () => {
    const code = await runMemoryCommand(runtimeHome, [
      'model',
      'profile',
      'cheap',
    ]);
    expect(code).toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.memory.llm.models.extractor).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(updated.memory.llm.models.dreaming).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(updated.memory.llm.models.consolidation).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(updated.memory.llm.models.sessionSummary).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('applies the quality model profile across all memory tasks', async () => {
    const code = await runMemoryCommand(runtimeHome, [
      'model',
      'profile',
      'quality',
    ]);
    expect(code).toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.memory.llm.models.extractor).toBe('claude-sonnet-4-6');
    expect(updated.memory.llm.models.dreaming).toBe('claude-sonnet-4-6');
    expect(updated.memory.llm.models.consolidation).toBe('claude-sonnet-4-6');
    expect(updated.memory.llm.models.sessionSummary).toBe('claude-sonnet-4-6');
  });
});
