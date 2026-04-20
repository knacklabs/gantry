import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

function writeMemorySettings(runtimeHome: string): void {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  fs.writeFileSync(
    settingsPath,
    [
      'memory:',
      '  enabled: true',
      '  root: memory',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '',
    ].join('\n'),
    'utf-8',
  );
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-ipc-'));
  tempRoots.push(root);
  process.env.AGENT_ROOT = root;
});

afterEach(async () => {
  vi.resetModules();
  try {
    const { MemoryService } = await import('@core/memory/memory-service.js');
    MemoryService.closeInstance();
  } catch {
    // Best-effort teardown.
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe('memory IPC provider integration', () => {
  it('routes memory IPC requests through memory service', async () => {
    writeMemorySettings(process.env.AGENT_ROOT!);
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-1',
        action: 'memory_save',
        payload: {
          key: 'style',
          value: 'concise',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.provider).toBe('sqlite');
  });

  it('returns IPC error responses when memory service init fails', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: {
        getInstance: () => {
          throw new Error('memory init failed');
        },
        closeInstance: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-init-fail',
        action: 'memory_search',
        payload: { query: 'test' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.provider).toBe('uninitialized');
    expect(response.error).toContain('memory init failed');

    vi.doUnmock('@core/memory/memory-service.js');
  });

  it('rejects invalid memory IPC requestId before processing', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: {
        getInstance: () => ({
          getProviderName: () => 'mock-provider',
        }),
        closeInstance: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: '../escape',
        action: 'memory_search',
        payload: { query: 'test' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Invalid memory IPC requestId');
    vi.doUnmock('@core/memory/memory-service.js');
  });

  it('rejects malformed memory_save payloads before calling memory service', async () => {
    const saveMemory = vi.fn();
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: {
        getInstance: () => ({
          getProviderName: () => 'mock',
          saveMemory,
        }),
        closeInstance: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-bad-save',
        action: 'memory_save',
        payload: { key: 123, value: 'ok' } as unknown as Record<
          string,
          unknown
        >,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('memory_save requires key and value');
    expect(saveMemory).not.toHaveBeenCalled();
    vi.doUnmock('@core/memory/memory-service.js');
  });

  it('ignores cross-group overrides in IPC memory_search payloads', async () => {
    const search = vi.fn().mockResolvedValue([]);
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: {
        getInstance: () => ({
          getProviderName: () => 'mock',
          search,
        }),
        closeInstance: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-scope',
        action: 'memory_search',
        payload: {
          query: 'status',
          group_folder: 'other-group',
        },
      },
      'main-group',
      true,
    );

    expect(response.ok).toBe(true);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'status', groupFolder: 'main-group' }),
    );
    vi.doUnmock('@core/memory/memory-service.js');
  });

  it('memory_search succeeds when embeddings are disabled by default', async () => {
    // Embeddings are disabled by default, so search should stay available even
    // when OPENAI_API_KEY is empty.
    writeMemorySettings(process.env.AGENT_ROOT!);
    process.env.OPENAI_API_KEY = '';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-search',
        action: 'memory_search',
        payload: { query: 'deployment process' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-search');
    expect(response.provider).toBe('sqlite');
  });

  it('returns error for empty search query', async () => {
    writeMemorySettings(process.env.AGENT_ROOT!);
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-empty',
        action: 'memory_search',
        payload: { query: '' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('query is required');
  });

  it('returns error for unsupported memory action', async () => {
    writeMemorySettings(process.env.AGENT_ROOT!);
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-unsupported',
        action: 'fake_action' as never,
        payload: {},
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported memory action');
  });
});

/* ------------------------------------------------------------------ */
/*  processMemoryRequest — branches that were previously uncovered     */
/* ------------------------------------------------------------------ */
describe('processMemoryRequest additional branches', () => {
  function mockMemoryService(overrides: Record<string, unknown> = {}) {
    return {
      getInstance: () => ({
        getProviderName: () => 'mock-provider',
        search: vi.fn(),
        saveMemory: vi.fn(),
        patchMemory: vi.fn().mockReturnValue({ id: 'patched-mem' }),
        consolidateGroupMemory: vi.fn().mockResolvedValue({ merged: 1 }),
        runDreamingSweep: vi
          .fn()
          .mockResolvedValue({ promoted: 2, decayed: 1 }),
        saveProcedure: vi.fn().mockReturnValue({ id: 'proc-1' }),
        patchProcedure: vi.fn().mockReturnValue({ id: 'proc-patched' }),
        ingestGroupSources: vi.fn(),
        ingestGlobalKnowledge: vi.fn(),
        ...overrides,
      }),
      closeInstance: () => undefined,
    };
  }

  it('handles memory_patch action', async () => {
    vi.resetModules();
    const patchMemory = vi
      .fn()
      .mockReturnValue({ id: 'patched-mem', version: 2 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch',
        action: 'memory_patch',
        payload: { id: 'mem-1', expected_version: 1, value: 'updated' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-patch');
    expect(response.provider).toBe('mock-provider');
    expect((response.data as { memory: unknown }).memory).toEqual({
      id: 'patched-mem',
      version: 2,
    });
    expect(patchMemory).toHaveBeenCalledWith(
      { id: 'mem-1', expected_version: 1, value: 'updated' },
      { isMain: false, groupFolder: 'team', actor: 'mcp-tool' },
    );
  });

  it('handles memory_consolidate action (non-main)', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi.fn().mockResolvedValue({ merged: 3 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate',
        action: 'memory_consolidate',
        payload: { group_folder: 'other-group' },
      },
      'team',
      false, // non-main: should ignore requested group_folder
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-consolidate');
    expect((response.data as { consolidation: unknown }).consolidation).toEqual(
      {
        merged: 3,
      },
    );
    // non-main agents cannot override groupFolder
    expect(consolidateGroupMemory).toHaveBeenCalledWith('team');
  });

  it('scopes memory_consolidate to source group even for main', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi.fn().mockResolvedValue({ merged: 5 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate-main',
        action: 'memory_consolidate',
        payload: { group_folder: 'other-group' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(consolidateGroupMemory).toHaveBeenCalledWith('team');
  });

  it('handles memory_dream action (non-main)', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 2, decayed: 1 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream',
        action: 'memory_dream',
        payload: { group_folder: 'other-group' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-dream');
    expect((response.data as { dreaming: unknown }).dreaming).toEqual({
      promoted: 2,
      decayed: 1,
    });
    // non-main: ignores requested group_folder
    expect(runDreamingSweep).toHaveBeenCalledWith('team');
  });

  it('scopes memory_dream to source group even for main', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 4, decayed: 0 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-main',
        action: 'memory_dream',
        payload: { group_folder: 'special-group' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(runDreamingSweep).toHaveBeenCalledWith('team');
  });

  it('handles procedure_save action', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-1', title: 'Deploy' });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-save',
        action: 'procedure_save',
        payload: { title: 'Deploy', body: 'steps...', tags: ['devops'] },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-proc-save');
    expect((response.data as { procedure: unknown }).procedure).toEqual({
      id: 'proc-1',
      title: 'Deploy',
    });
    expect(saveProcedure).toHaveBeenCalledWith(
      { title: 'Deploy', body: 'steps...', tags: ['devops'] },
      { isMain: true, groupFolder: 'team', actor: 'mcp-tool' },
    );
  });

  it('handles procedure_patch action', async () => {
    vi.resetModules();
    const patchProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-patched', version: 2 });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({ patchProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-patch',
        action: 'procedure_patch',
        payload: { id: 'proc-1', expected_version: 1, body: 'updated steps' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-proc-patch');
    expect((response.data as { procedure: unknown }).procedure).toEqual({
      id: 'proc-patched',
      version: 2,
    });
    expect(patchProcedure).toHaveBeenCalledWith(
      { id: 'proc-1', expected_version: 1, body: 'updated steps' },
      { isMain: false, groupFolder: 'team', actor: 'mcp-tool' },
    );
  });

  it('returns error when memory_patch throws', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockMemoryService({
        patchMemory: () => {
          throw new Error('version conflict');
        },
      }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch-err',
        action: 'memory_patch',
        payload: { id: 'mem-1', expected_version: 99 },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('version conflict');
    expect(response.provider).toBe('mock-provider');
  });
});

describe('processMemoryRequest validation branches', () => {
  function mockValidatedService(overrides: Record<string, unknown> = {}) {
    return {
      getInstance: () => ({
        getProviderName: () => 'mock-provider',
        saveMemory: vi.fn().mockResolvedValue({ id: 'mem-1' }),
        patchMemory: vi.fn().mockReturnValue({ id: 'mem-1' }),
        saveProcedure: vi.fn().mockReturnValue({ id: 'proc-1' }),
        patchProcedure: vi.fn().mockReturnValue({ id: 'proc-1' }),
        ...overrides,
      }),
      closeInstance: () => undefined,
    };
  }

  it('rejects removed memory kind recent_work', async () => {
    vi.resetModules();
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-recent' });
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockValidatedService({ saveMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-recent-work',
        action: 'memory_save',
        payload: {
          key: 'daily-work',
          value: 'shipped IPC hardening',
          kind: 'recent_work',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.not.objectContaining({ kind: 'recent_work' }),
      { isMain: false, groupFolder: 'team', actor: 'mcp-tool' },
    );
  });

  it('rejects non-object payloads for memory_save', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockValidatedService(),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-save-non-object',
        action: 'memory_save',
        payload: 'bad-payload' as unknown as Record<string, unknown>,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('memory_save payload must be an object');
  });

  it('rejects non-object payloads and missing required fields for memory_patch', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockValidatedService(),
    }));
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const nonObject = await processMemoryRequest(
      {
        requestId: 'req-patch-non-object',
        action: 'memory_patch',
        payload: 'bad' as unknown as Record<string, unknown>,
      },
      'team',
      false,
    );
    expect(nonObject.ok).toBe(false);
    expect(nonObject.error).toContain('memory_patch payload must be an object');

    const missingFields = await processMemoryRequest(
      {
        requestId: 'req-patch-missing',
        action: 'memory_patch',
        payload: { id: '' },
      },
      'team',
      false,
    );
    expect(missingFields.ok).toBe(false);
    expect(missingFields.error).toContain(
      'memory_patch requires id and expected_version',
    );
  });

  it('rejects invalid procedure_save payload shapes', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockValidatedService(),
    }));
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const nonObject = await processMemoryRequest(
      {
        requestId: 'req-proc-save-non-object',
        action: 'procedure_save',
        payload: 'bad' as unknown as Record<string, unknown>,
      },
      'team',
      false,
    );
    expect(nonObject.ok).toBe(false);
    expect(nonObject.error).toContain(
      'procedure_save payload must be an object',
    );

    const missingRequired = await processMemoryRequest(
      {
        requestId: 'req-proc-save-missing',
        action: 'procedure_save',
        payload: { title: 'Only title' },
      },
      'team',
      false,
    );
    expect(missingRequired.ok).toBe(false);
    expect(missingRequired.error).toContain(
      'procedure_save requires title and body',
    );
  });

  it('rejects invalid procedure_patch payload shapes', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/memory-service.js', () => ({
      MemoryService: mockValidatedService(),
    }));
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const nonObject = await processMemoryRequest(
      {
        requestId: 'req-proc-patch-non-object',
        action: 'procedure_patch',
        payload: 'bad' as unknown as Record<string, unknown>,
      },
      'team',
      false,
    );
    expect(nonObject.ok).toBe(false);
    expect(nonObject.error).toContain(
      'procedure_patch payload must be an object',
    );

    const missingRequired = await processMemoryRequest(
      {
        requestId: 'req-proc-patch-missing',
        action: 'procedure_patch',
        payload: { id: 'proc-1' },
      },
      'team',
      false,
    );
    expect(missingRequired.ok).toBe(false);
    expect(missingRequired.error).toContain(
      'procedure_patch requires id and expected_version',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  writeMemoryResponse                                                */
/* ------------------------------------------------------------------ */
describe('writeMemoryResponse', () => {
  it('writes a JSON response file via atomic rename', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));

    vi.resetModules();
    vi.doMock('@core/platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryResponse } = await import('@core/memory/memory-ipc.js');

    const response = {
      ok: true as const,
      requestId: 'req-42',
      provider: 'sqlite',
      data: { results: [1, 2, 3] },
    };

    writeMemoryResponse('team', 'req-42', response);

    const responsesDir = path.join(tmpDir, 'memory-responses');
    const filePath = path.join(responsesDir, 'req-42.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written).toEqual(response);

    // tmp file should not remain
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);

    // cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the memory-responses directory if it does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-mkdir-'));

    vi.resetModules();
    vi.doMock('@core/platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryResponse } = await import('@core/memory/memory-ipc.js');

    const responsesDir = path.join(tmpDir, 'memory-responses');
    expect(fs.existsSync(responsesDir)).toBe(false);

    writeMemoryResponse('team', 'req-mkdir', {
      ok: false,
      requestId: 'req-mkdir',
      error: 'boom',
    });

    expect(fs.existsSync(responsesDir)).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(responsesDir, 'req-mkdir.json'), 'utf-8'),
    );
    expect(written.ok).toBe(false);
    expect(written.error).toBe('boom');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects unsafe requestId values when writing responses', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-bad-reqid-'));

    vi.resetModules();
    vi.doMock('@core/platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryResponse } = await import('@core/memory/memory-ipc.js');

    expect(() =>
      writeMemoryResponse('team', '../escape', {
        ok: false,
        requestId: '../escape',
        error: 'bad',
      }),
    ).toThrow('Invalid memory IPC requestId');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
