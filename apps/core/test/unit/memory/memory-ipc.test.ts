import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function writeMemorySettings(runtimeHome: string): void {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  fs.writeFileSync(
    settingsPath,
    [
      'providers: {}',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
      'credential_broker:',
      '  mode: onecli',
      '  onecli:',
      '    url: http://localhost:10254',
      '  external:',
      '    base_url: ""',
      '',
    ].join('\n'),
    'utf-8',
  );
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-memory-ipc-'));
  tempRoots.push(root);
  process.env.GANTRY_HOME = root;
  writeMemorySettings(root);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  try {
    const { AppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    AppMemoryService.resetForTest();
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
    writeMemorySettings(process.env.GANTRY_HOME!);
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: vi.fn(async () => ({ id: 'mem_1' })),
        }),
      },
    }));
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
    expect(response.provider).toBe('postgres');
  });

  it('returns IPC error responses when memory service init fails', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => {
          throw new Error('memory init failed');
        },
        resetForTest: () => undefined,
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

    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('rejects invalid memory IPC requestId before processing', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          search: vi.fn(),
        }),
        resetForTest: () => undefined,
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
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('rejects malformed memory_save payloads before calling memory service', async () => {
    const saveMemory = vi.fn();
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
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
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('ignores cross-group overrides in IPC memory_search payloads', async () => {
    const search = vi.fn().mockResolvedValue([]);
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          searchReadOnly: search,
        }),
        resetForTest: () => undefined,
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
    expect(search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query: 'status',
        appId: 'default',
        agentId: 'agent:main-group',
        groupId: 'main-group',
      }),
    );
    expect(search.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('scopes IPC memory_search to trusted conversation without thread memory scope', async () => {
    const search = vi.fn().mockResolvedValue([]);
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          searchReadOnly: search,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-thread-search',
        action: 'memory_search',
        payload: { query: 'status', thread_id: 'attacker-thread' },
        context: { threadId: 'trusted-thread' },
      },
      'main-group',
      true,
    );

    expect(response.ok).toBe(true);
    expect(search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query: 'status',
        agentId: 'agent:main-group',
        groupId: 'main-group',
      }),
    );
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(search.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('uses trusted memory user context for user-scoped search', async () => {
    const search = vi.fn().mockResolvedValue([]);
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          searchReadOnly: search,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-user-search',
        action: 'memory_search',
        payload: { query: 'style', user_id: 'attacker' },
        context: { userId: 'trusted-user', defaultScope: 'user' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ userId: 'trusted-user' }),
    );
    expect(search.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('ignores caller-supplied and trusted topic ids in IPC memory_save payloads', async () => {
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-1' });
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-thread-save',
        action: 'memory_save',
        payload: {
          key: 'decision:one',
          value: 'Use the trusted thread.',
          topic_id: 'attacker-thread',
        },
        context: { threadId: 'trusted-thread' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('uses trusted memory user context for user-scoped saves', async () => {
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-user' });
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-user-save',
        action: 'memory_save',
        payload: {
          key: 'preference:style',
          value: 'Prefers concise replies.',
          scope: 'user',
          user_id: 'attacker',
        },
        context: { userId: 'trusted-user', defaultScope: 'user' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'trusted-user',
        subjectType: 'user',
      }),
    );
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('honors explicit group scope instead of DM default scope', async () => {
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-group' });
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-group-save',
        action: 'memory_save',
        payload: {
          key: 'team:decision',
          value: 'Use the shared support queue.',
          scope: 'group',
        },
        context: { userId: 'trusted-user', defaultScope: 'user' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'group',
      }),
    );
    expect(saveMemory.mock.calls[0]?.[0]).not.toHaveProperty('userId');
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('resolves group scope to channel subject when trusted conversation id exists', async () => {
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-channel' });
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-channel-save',
        action: 'memory_save',
        payload: {
          key: 'decision:channel-policy',
          value: 'Channel memories should bind to the conversation boundary.',
          scope: 'group',
        },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'channel',
        channelId: 'conversation:sl:C123',
        subjectId: 'conversation:sl:C123',
      }),
    );
    expect(saveMemory.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('rejects user-scoped saves without trusted user context', async () => {
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-user' });
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          save: saveMemory,
        }),
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-user-save-missing',
        action: 'memory_save',
        payload: {
          key: 'preference:style',
          value: 'Prefers concise replies.',
          scope: 'user',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('authenticated user');
    expect(saveMemory).not.toHaveBeenCalled();
    vi.doUnmock('@core/memory/app-memory-service.js');
  });

  it('memory_search succeeds when embeddings are disabled by default', async () => {
    // Embeddings are disabled by default, so search should stay available even
    // when OPENAI_API_KEY is empty.
    writeMemorySettings(process.env.GANTRY_HOME!);
    process.env.OPENAI_API_KEY = '';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          searchReadOnly: vi.fn(async () => []),
        }),
      },
    }));
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
    expect(response.provider).toBe('postgres');
    expect(response.data).toMatchObject({
      results: [],
      resolved_subject: {
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'group',
        subjectId: 'team',
        groupId: 'team',
      },
      empty_reason: 'no_matching_memory',
    });
  });

  it('returns error for empty search query', async () => {
    writeMemorySettings(process.env.GANTRY_HOME!);
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
    writeMemorySettings(process.env.GANTRY_HOME!);
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
    const save =
      overrides.save ||
      overrides.saveMemory ||
      overrides.saveProcedure ||
      vi.fn().mockResolvedValue({ id: 'mem-1' });
    const patch =
      overrides.patch ||
      overrides.patchMemory ||
      overrides.patchProcedure ||
      vi.fn().mockResolvedValue({ id: 'patched-mem' });
    const triggerDreaming =
      overrides.triggerDreaming ||
      overrides.consolidateGroupMemory ||
      overrides.runDreamingSweep ||
      vi.fn().mockResolvedValue({ runId: 'dream-1' });
    const listPendingReviews =
      overrides.listPendingReviews ||
      vi.fn().mockResolvedValue([{ id: 'mrv-1' }]);
    const listPendingReviewPage =
      overrides.listPendingReviewPage ||
      vi.fn().mockResolvedValue({
        reviews: [{ id: 'mrv-1' }],
        totalCount: 1,
        returnedCount: 1,
        remainingCount: 0,
        limit: 20,
        offset: 0,
        nextOffset: null,
      });
    const decideReview =
      overrides.decideReview ||
      vi.fn().mockResolvedValue({ id: 'mrv-1', status: 'applied' });
    const demote =
      overrides.demote ||
      vi.fn().mockResolvedValue({ id: 'mem-1', status: 'demoted' });
    const searchReadOnly =
      overrides.searchReadOnly ||
      overrides.search ||
      vi.fn().mockResolvedValue([]);
    const recordRecallEvents =
      overrides.recordRecallEvents || vi.fn().mockResolvedValue(undefined);
    const list = overrides.list || vi.fn().mockResolvedValue([]);
    const dreamingStatus =
      overrides.dreamingStatus || vi.fn().mockResolvedValue([]);
    return {
      getInstance: () => ({
        search: searchReadOnly,
        searchReadOnly,
        recordRecallEvents,
        list,
        save,
        patch,
        demote,
        triggerDreaming,
        dreamingStatus,
        listPendingReviews,
        listPendingReviewPage,
        decideReview,
        ...overrides,
      }),
      resetForTest: () => undefined,
    };
  }

  it('handles memory_patch action', async () => {
    vi.resetModules();
    const patchMemory = vi
      .fn()
      .mockReturnValue({ id: 'patched-mem', version: 2 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch',
        action: 'memory_patch',
        allowedActions: ['memory_patch'],
        payload: { id: 'mem-1', expected_version: 1, value: 'updated' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-patch');
    expect(response.provider).toBe('postgres');
    expect((response.data as { memory: unknown }).memory).toEqual({
      id: 'patched-mem',
      version: 2,
    });
    expect(patchMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mem-1',
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'group',
        subjectId: 'team',
        groupId: 'team',
        value: 'updated',
        expectedVersion: 1,
      }),
    );
  });

  it('patches trusted DM user memory subject and ignores spoofed payload subject fields', async () => {
    vi.resetModules();
    const patchMemory = vi
      .fn()
      .mockReturnValue({ id: 'patched-user-mem', version: 2 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch-user',
        action: 'memory_patch',
        allowedActions: ['memory_patch'],
        payload: {
          id: 'mem-user',
          expected_version: 1,
          value: 'trusted user value',
          group_folder: 'attacker-group',
          user_id: 'attacker-user',
        },
        context: {
          chatJid: 'sl:D123',
          userId: 'sl:U123',
          defaultScope: 'user',
          threadId: 'attacker-thread',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(patchMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mem-user',
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'user',
        subjectId: 'sl:U123',
        userId: 'sl:U123',
      }),
    );
    expect(patchMemory.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(patchMemory.mock.calls[0]?.[0]).not.toHaveProperty('channelId');
  });

  it('patches trusted channel memory subject without thread scope', async () => {
    vi.resetModules();
    const patchMemory = vi
      .fn()
      .mockReturnValue({ id: 'patched-thread-mem', version: 2 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch-channel-thread',
        action: 'memory_patch',
        allowedActions: ['memory_patch'],
        payload: { id: 'mem-thread', expected_version: 1, value: 'updated' },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(patchMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mem-thread',
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        groupId: 'team',
        channelId: 'conversation:sl:C123',
      }),
    );
    expect(patchMemory.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('handles memory_demote action for the trusted subject', async () => {
    vi.resetModules();
    const demote = vi
      .fn()
      .mockResolvedValue({ id: 'mem-1', status: 'demoted' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ demote }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-demote',
        action: 'memory_demote',
        allowedActions: ['memory_demote'],
        payload: {
          id: 'mem-1',
          expected_version: 2,
          reason: 'No longer reliable.',
          group_folder: 'attacker-group',
        },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect((response.data as { memory: unknown }).memory).toEqual({
      id: 'mem-1',
      status: 'demoted',
    });
    expect(demote).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
        id: 'mem-1',
        expectedVersion: 2,
        reason: 'No longer reliable.',
        actorId: 'mcp-tool',
      }),
    );
    expect(demote.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('rejects memory_demote when the host allowlist omits it', async () => {
    vi.resetModules();
    const demote = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ demote }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-demote-denied',
        action: 'memory_demote',
        allowedActions: ['memory_search'],
        payload: { id: 'mem-1' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'Memory IPC action is not allowed: memory_demote',
    );
    expect(demote).not.toHaveBeenCalled();
  });

  it('handles continuity_summary action with the service continuity status when available', async () => {
    vi.resetModules();
    const continuitySummary = vi.fn().mockResolvedValue({
      staged_count: 3,
      promoted_count: 2,
      needs_review_count: 1,
      last_injected_block: { subject: 'channel:team', bytes: 2048 },
    });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ continuitySummary }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-continuity',
        action: 'continuity_summary',
        payload: {},
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect((response.data as { continuity: unknown }).continuity).toMatchObject(
      {
        staged_count: 3,
        promoted_count: 2,
        needs_review_count: 1,
      },
    );
    expect(continuitySummary).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(continuitySummary.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('returns unavailable memory_search without calling storage when the IPC deadline is too close', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    const search = vi.fn().mockResolvedValue([{ id: 'mem-1' }]);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ search }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-search-deadline',
        action: 'memory_search',
        payload: { query: 'deploy' },
        deadlineAtMs: fixedNowMs + 500,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(search).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'deadline_exceeded',
      results: [],
    });
  });

  it('returns unavailable when an already-started memory_search exceeds the IPC deadline', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    let resolveSearch: ((value: unknown[]) => void) | undefined;
    const search = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ search }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const responsePromise = processMemoryRequest(
      {
        requestId: 'req-search-slow-deadline',
        action: 'memory_search',
        payload: { query: 'deploy' },
        deadlineAtMs: fixedNowMs + 1_200,
      },
      'team',
      false,
    );

    expect(search).toHaveBeenCalledTimes(1);
    const searchSignal = search.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(searchSignal).toBeInstanceOf(AbortSignal);
    expect(searchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(201);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(searchSignal?.aborted).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'deadline_exceeded',
      results: [],
    });
    resolveSearch?.([]);
  });

  it('passes a deadline abort signal to searchReadOnly and aborts in-flight work on timeout', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    let capturedSignal: AbortSignal | undefined;
    let capturedStatementTimeoutMs: number | undefined;
    let backgroundAborted = false;
    const searchReadOnly = vi.fn(
      (
        _input,
        options?: { signal?: AbortSignal; statementTimeoutMs?: number },
      ) => {
        capturedSignal =
          options?.signal ?? (_input as { signal?: AbortSignal }).signal;
        capturedStatementTimeoutMs = options?.statementTimeoutMs;
        capturedSignal?.addEventListener('abort', () => {
          backgroundAborted = true;
        });
        return new Promise<unknown[]>(() => undefined);
      },
    );
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ searchReadOnly }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const responsePromise = processMemoryRequest(
      {
        requestId: 'req-search-abort-signal',
        action: 'memory_search',
        payload: { query: 'deploy' },
        deadlineAtMs: fixedNowMs + 1_200,
      },
      'team',
      false,
    );

    expect(searchReadOnly).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(capturedStatementTimeoutMs).toBe(200);

    await vi.advanceTimersByTimeAsync(201);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'deadline_exceeded',
      results: [],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(backgroundAborted).toBe(true);
  });

  it('records recall events after successful memory_search without a deadline', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    const searchResult = {
      item: {
        id: 'mem-1',
        key: 'decision:deploy',
        value: 'Deploy after tests pass.',
      },
      score: 0.9,
      lexicalScore: 0.9,
      vectorScore: 0,
      reasons: ['lexical'],
    };
    const searchReadOnly = vi.fn().mockResolvedValue([searchResult]);
    const recordRecallEvents = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({
        searchReadOnly,
        recordRecallEvents,
      }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-search-recall',
        action: 'memory_search',
        payload: { query: 'deploy' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(searchReadOnly).toHaveBeenCalledTimes(1);
    expect(recordRecallEvents).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'deploy' }),
      [searchResult],
    );
  });

  it('skips recall event writes for deadline-bound memory_search responses', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    const searchResult = {
      item: {
        id: 'mem-1',
        key: 'decision:deploy',
        value: 'Deploy after tests pass.',
      },
      score: 0.9,
      lexicalScore: 0.9,
      vectorScore: 0,
      reasons: ['lexical'],
    };
    const searchReadOnly = vi.fn().mockResolvedValue([searchResult]);
    const recordRecallEvents = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({
        searchReadOnly,
        recordRecallEvents,
      }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-search-recall-deadline',
        action: 'memory_search',
        payload: { query: 'deploy' },
        deadlineAtMs: fixedNowMs + 5_000,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(searchReadOnly).toHaveBeenCalledTimes(1);
    expect(recordRecallEvents).not.toHaveBeenCalled();
  });

  it('returns unavailable memory_save without calling storage when the IPC deadline is too close', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-1' });
    const getInstance = vi.fn(() => ({
      save: saveMemory,
    }));
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance,
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-save-deadline',
        action: 'memory_save',
        payload: {
          key: 'decision:deadline',
          value: 'Do not start writes when the deadline is too close.',
        },
        deadlineAtMs: fixedNowMs + 500,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(getInstance).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'deadline_exceeded',
    });
  });

  it('does not return deadline_exceeded while an accepted memory_save is still committing', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    let resolveSave: ((value: unknown) => void) | undefined;
    let settled = false;
    const saveMemory = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveSave = resolve;
        }),
    );
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ save: saveMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const responsePromise = processMemoryRequest(
      {
        requestId: 'req-save-slow-deadline',
        action: 'memory_save',
        payload: {
          key: 'decision:deadline',
          value: 'Do not report unavailable while a write is still pending.',
        },
        deadlineAtMs: fixedNowMs + 1_200,
      },
      'team',
      false,
    ).then((response) => {
      settled = true;
      return response;
    });

    expect(saveMemory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);

    resolveSave?.({ id: 'mem-accepted' });
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ memory: { id: 'mem-accepted' } });
  });

  it('returns unavailable continuity summary without service work when the IPC deadline is too close', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    const continuitySummary = vi.fn().mockResolvedValue({
      overall_status: 'complete',
    });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ continuitySummary }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-continuity-deadline',
        action: 'continuity_summary',
        payload: {},
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
        deadlineAtMs: fixedNowMs + 500,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(continuitySummary).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({
      continuity: {
        overall_status: 'unavailable',
        sections: {
          memory_service: {
            status: 'unavailable',
            reason: 'deadline_exceeded',
          },
        },
      },
    });
  });

  it('passes a deadline abort signal to continuitySummary and aborts in-flight work on timeout', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    let capturedSignal: AbortSignal | undefined;
    let capturedStatementTimeoutMs: number | undefined;
    let backgroundAborted = false;
    const continuitySummary = vi.fn(
      (
        _input,
        options?: { signal?: AbortSignal; statementTimeoutMs?: number },
      ) => {
        capturedSignal =
          options?.signal ?? (_input as { signal?: AbortSignal }).signal;
        capturedStatementTimeoutMs =
          options?.statementTimeoutMs ??
          (_input as { statementTimeoutMs?: number }).statementTimeoutMs;
        capturedSignal?.addEventListener('abort', () => {
          backgroundAborted = true;
        });
        return new Promise(() => undefined);
      },
    );
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ continuitySummary }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const responsePromise = processMemoryRequest(
      {
        requestId: 'req-continuity-abort-signal',
        action: 'continuity_summary',
        payload: {},
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
        deadlineAtMs: fixedNowMs + 1_200,
      },
      'team',
      false,
    );

    expect(continuitySummary).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(capturedStatementTimeoutMs).toBe(200);

    await vi.advanceTimersByTimeAsync(201);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      continuity: {
        overall_status: 'unavailable',
        sections: {
          memory_service: {
            status: 'unavailable',
            reason: 'deadline_exceeded',
          },
        },
      },
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(backgroundAborted).toBe(true);
  });

  it('rejects expired memory IPC requests before initializing memory service', async () => {
    vi.resetModules();
    const getInstance = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance,
        resetForTest: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-expired',
        action: 'memory_search',
        payload: { query: 'deploy' },
        deadlineAtMs: Date.now() - 1,
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('memory IPC request expired');
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('rejects reviewed patch actions when the host allowlist omits them', async () => {
    vi.resetModules();
    const patchMemory = vi.fn().mockReturnValue({ id: 'should-not-patch' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch-denied',
        action: 'memory_patch',
        allowedActions: ['memory_search', 'memory_save'],
        payload: { id: 'mem-1', expected_version: 1, value: 'updated' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'Memory IPC action is not allowed: memory_patch',
    );
    expect(patchMemory).not.toHaveBeenCalled();
  });

  it('handles memory_consolidate action from a conversation-scoped route', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi.fn().mockResolvedValue({ merged: 3 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate',
        action: 'memory_consolidate',
        allowedActions: ['memory_consolidate'],
        payload: { group_folder: 'other-group' },
        context: { threadId: 'trusted-thread' },
      },
      'team',
      false, // conversation-scoped: should ignore requested group_folder
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-consolidate');
    expect((response.data as { consolidation: unknown }).consolidation).toEqual(
      {
        merged: 3,
      },
    );
    // conversation-scoped agents cannot override groupFolder
    expect(consolidateGroupMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
      }),
    );
    expect(consolidateGroupMemory.mock.calls[0]?.[0]).not.toHaveProperty(
      'threadId',
    );
  });

  it('scopes memory_consolidate to source group even for main', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi.fn().mockResolvedValue({ merged: 5 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate-main',
        action: 'memory_consolidate',
        allowedActions: ['memory_consolidate'],
        payload: { group_folder: 'other-group' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(consolidateGroupMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
      }),
    );
  });

  it('handles memory_dream action from a conversation-scoped route', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 2, decayed: 1 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream',
        action: 'memory_dream',
        allowedActions: ['memory_dream'],
        payload: { group_folder: 'other-group' },
        context: { threadId: 'trusted-thread' },
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
    // conversation-scoped: ignores requested group_folder
    expect(runDreamingSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
      }),
    );
    expect(runDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('lists pending memory reviews for the trusted subject', async () => {
    vi.resetModules();
    const listPendingReviewPage = vi.fn().mockResolvedValue({
      reviews: [
        {
          id: 'mrv-1',
          status: 'pending_review',
          proposedChange: {
            action: 'rewrite',
            summary: 'Change fact:preference from "old" to "new".',
            before: {
              itemId: 'mem-1',
              kind: 'fact',
              key: 'preference',
              value: 'old',
            },
            after: { kind: 'fact', key: 'preference', value: 'new' },
            reason: 'new evidence',
            confidence: 0.82,
            evidenceIds: ['mev-1'],
          },
        },
      ],
      totalCount: 7,
      returnedCount: 1,
      remainingCount: 3,
      limit: 3,
      offset: 3,
      nextOffset: 4,
    });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ listPendingReviewPage }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-pending',
        action: 'memory_review_pending',
        allowedActions: ['memory_review_pending'],
        payload: { limit: 3, offset: 3 },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(listPendingReviewPage).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        limit: 3,
        offset: 3,
      }),
    );
    expect(listPendingReviewPage.mock.calls[0]?.[0]).not.toHaveProperty(
      'threadId',
    );
    expect(response.data).toMatchObject({
      total_count: 7,
      returned_count: 1,
      remaining_count: 3,
      limit: 3,
      offset: 3,
      next_offset: 4,
      page_context: {
        review_ids: ['mrv-1'],
      },
      review_page: {
        items: [
          {
            number: 1,
            review_id: 'mrv-1',
            summary: 'Change fact:preference from "old" to "new".',
          },
        ],
      },
      reviews: [
        {
          proposedChange: expect.objectContaining({
            summary: 'Change fact:preference from "old" to "new".',
          }),
        },
      ],
    });
  });

  it('passes a deadline abort signal to pending review reads and aborts in-flight work on timeout', async () => {
    const fixedNowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNowMs));
    vi.resetModules();
    let capturedSignal: AbortSignal | undefined;
    let capturedStatementTimeoutMs: number | undefined;
    let backgroundAborted = false;
    const listPendingReviewPage = vi.fn(
      (
        _input,
        options?: { signal?: AbortSignal; statementTimeoutMs?: number },
      ) => {
        capturedSignal = options?.signal;
        capturedStatementTimeoutMs = options?.statementTimeoutMs;
        capturedSignal?.addEventListener('abort', () => {
          backgroundAborted = true;
        });
        return new Promise(() => undefined);
      },
    );
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ listPendingReviewPage }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const responsePromise = processMemoryRequest(
      {
        requestId: 'req-review-pending-abort-signal',
        action: 'memory_review_pending',
        allowedActions: ['memory_review_pending'],
        payload: {},
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
        deadlineAtMs: fixedNowMs + 1_200,
      },
      'team',
      false,
    );

    expect(listPendingReviewPage).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(capturedStatementTimeoutMs).toBe(200);

    await vi.advanceTimersByTimeAsync(201);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'deadline_exceeded',
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(backgroundAborted).toBe(true);
  });

  it('applies memory review decisions for the trusted subject', async () => {
    vi.resetModules();
    const decideReview = vi
      .fn()
      .mockResolvedValue({ id: 'mrv-1', status: 'applied' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          review_id: 'mrv-1',
          decision: 'edit_approve',
          edited_value: 'Updated value',
          edited_reason: 'Reviewer corrected wording.',
          reviewer_id: 'spoofed-reviewer',
        },
        context: {
          chatJid: 'sl:C123',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: true,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(decideReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'mrv-1',
        decision: 'edit_approve',
        editedValue: 'Updated value',
        editedReason: 'Reviewer corrected wording.',
        reviewerId: 'trusted-reviewer',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
      }),
    );
  });

  it('applies batch memory review decisions from numbered page context', async () => {
    vi.resetModules();
    const decideReview = vi.fn(
      async (input: { reviewId: string; decision: string }) => ({
        id: input.reviewId,
        status: input.decision === 'reject' ? 'rejected' : 'applied',
        applyOutcome:
          input.decision === 'reject'
            ? 'rejected by reviewer'
            : 'applied reviewed change',
      }),
    );
    const listPendingReviewPage = vi.fn().mockResolvedValue({
      reviews: [],
      totalCount: 0,
      returnedCount: 0,
      remainingCount: 0,
      limit: 1,
      offset: 0,
      nextOffset: null,
    });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({
        decideReview,
        listPendingReviewPage,
      }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-batch',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          page_context: {
            subject: {
              app_id: 'default',
              agent_id: 'agent:team',
              subject_type: 'channel',
              subject_id: 'conversation:sl:C123',
            },
            limit: 2,
            offset: 0,
            review_ids: ['mrv-1', 'mrv-2'],
          },
          decisions: [
            { number: 1, decision: 'approve' },
            {
              number: 2,
              decision: 'edit_approve',
              edited_value: 'Reviewer edited value',
              edited_reason: 'Reviewer corrected wording.',
            },
          ],
        },
        context: {
          chatJid: 'sl:C123',
          threadId: 'thread-7',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: true,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(decideReview).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reviewId: 'mrv-1',
        decision: 'approve',
        reviewerId: 'trusted-reviewer',
        subjectId: 'conversation:sl:C123',
      }),
    );
    expect(decideReview.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(decideReview).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reviewId: 'mrv-2',
        decision: 'edit_approve',
        editedValue: 'Reviewer edited value',
        editedReason: 'Reviewer corrected wording.',
        reviewerId: 'trusted-reviewer',
      }),
    );
    expect(response.data).toMatchObject({
      decision_batch: {
        requested_count: 2,
        processed_count: 2,
        failed_count: 0,
        remaining_count: 0,
        outcomes: [
          {
            number: 1,
            review_id: 'mrv-1',
            ok: true,
            review_status: 'applied',
          },
          {
            number: 2,
            review_id: 'mrv-2',
            ok: true,
            review_status: 'applied',
          },
        ],
      },
    });
  });

  it('rejects batch memory review decisions with stale page context scope', async () => {
    vi.resetModules();
    const decideReview = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-batch-stale',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          page_context: {
            subject: {
              app_id: 'default',
              agent_id: 'agent:team',
              subject_type: 'channel',
              subject_id: 'conversation:sl:OTHER',
            },
            limit: 1,
            offset: 0,
            review_ids: ['mrv-1'],
          },
          decisions: [{ number: 1, decision: 'approve' }],
        },
        context: {
          chatJid: 'sl:C123',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: true,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'memory_review_decision page_context is outside trusted subject scope',
    );
    expect(decideReview).not.toHaveBeenCalled();
  });

  it('returns per-item failure when a batch review number is not on the page', async () => {
    vi.resetModules();
    const decideReview = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-batch-missing-number',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          page_context: {
            subject: {
              app_id: 'default',
              agent_id: 'agent:team',
              subject_type: 'channel',
              subject_id: 'conversation:sl:C123',
            },
            limit: 1,
            offset: 0,
            review_ids: ['mrv-1'],
          },
          decisions: [{ number: 99, decision: 'approve' }],
        },
        context: {
          chatJid: 'sl:C123',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: true,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      decision_batch: {
        requested_count: 1,
        processed_count: 0,
        failed_count: 1,
        outcomes: [
          {
            number: 99,
            review_id: null,
            ok: false,
            error: 'review number is not present in page_context',
          },
        ],
      },
    });
    expect(decideReview).not.toHaveBeenCalled();
  });

  it('rejects a batch item when review_id does not match the page number', async () => {
    vi.resetModules();
    const decideReview = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-batch-mismatched-id',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          page_context: {
            subject: {
              app_id: 'default',
              agent_id: 'agent:team',
              subject_type: 'channel',
              subject_id: 'conversation:sl:C123',
            },
            limit: 2,
            offset: 0,
            review_ids: ['mrv-1', 'mrv-2'],
          },
          decisions: [{ number: 1, review_id: 'mrv-2', decision: 'approve' }],
        },
        context: {
          chatJid: 'sl:C123',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: true,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      decision_batch: {
        requested_count: 1,
        processed_count: 0,
        failed_count: 1,
        outcomes: [
          {
            number: 1,
            review_id: null,
            ok: false,
            error: 'review_id does not match page_context number',
          },
        ],
      },
    });
    expect(decideReview).not.toHaveBeenCalled();
  });

  it('rejects memory review decisions without a trusted reviewer identity', async () => {
    vi.resetModules();
    const decideReview = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-no-reviewer',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          review_id: 'mrv-1',
          decision: 'approve',
          reviewer_id: 'spoofed-reviewer',
        },
        context: { chatJid: 'sl:C123' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'memory_review_decision requires a trusted reviewer user id',
    );
    expect(decideReview).not.toHaveBeenCalled();
  });

  it('rejects memory review decisions when reviewer is not a control approver', async () => {
    vi.resetModules();
    const decideReview = vi.fn();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ decideReview }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-review-decision-not-approver',
        action: 'memory_review_decision',
        allowedActions: ['memory_review_decision'],
        payload: {
          review_id: 'mrv-1',
          decision: 'approve',
        },
        context: {
          chatJid: 'sl:C123',
          userId: 'trusted-reviewer',
          reviewerIsControlApprover: false,
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'memory_review_decision requires a conversation control approver',
    );
    expect(decideReview).not.toHaveBeenCalled();
  });

  it('rejects dreaming actions when the host allowlist omits them', async () => {
    vi.resetModules();
    const runDreamingSweep = vi.fn().mockResolvedValue({ promoted: 1 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-denied',
        action: 'memory_dream',
        allowedActions: ['memory_search'],
        payload: {},
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'Memory IPC action is not allowed: memory_dream',
    );
    expect(runDreamingSweep).not.toHaveBeenCalled();
  });

  it('scopes memory_dream to source group even for main', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 4, decayed: 0 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-main',
        action: 'memory_dream',
        allowedActions: ['memory_dream'],
        payload: { group_folder: 'special-group' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(runDreamingSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
      }),
    );
  });

  it('runs memory_dream against trusted channel subject when chat context exists', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 1, decayed: 0 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-channel',
        action: 'memory_dream',
        allowedActions: ['memory_dream'],
        payload: {},
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(runDreamingSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
      }),
    );
    expect(runDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('scopes channel memory_search to channel visibility only', async () => {
    vi.resetModules();
    const search = vi.fn().mockResolvedValue([]);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ search }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-search-channel-only',
        action: 'memory_search',
        payload: { query: 'deploy' },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query: 'deploy',
        appId: 'default',
        agentId: 'agent:team',
        channelId: 'conversation:sl:C123',
        subjectTypes: ['channel'],
        includeCommon: false,
      }),
    );
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(search.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('groupId');
  });

  it('runs memory_dream against trusted DM user subject and ignores threads', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 1, decayed: 0 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-dm',
        action: 'memory_dream',
        allowedActions: ['memory_dream'],
        payload: {},
        context: {
          chatJid: 'sl:D123',
          userId: 'sl:U123',
          defaultScope: 'user',
          threadId: 'attacker-thread',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(runDreamingSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'user',
        subjectId: 'sl:U123',
        userId: 'sl:U123',
        phase: 'all',
      }),
    );
    expect(runDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(runDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty('channelId');
  });

  it('handles procedure_save action', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-1', title: 'Deploy' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ saveProcedure }),
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
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
        key: 'procedure:Deploy',
        value: 'steps...',
      }),
    );
  });

  it('ignores procedure_save topic and trusted thread context', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-1', title: 'Deploy' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-thread-save',
        action: 'procedure_save',
        payload: { title: 'Deploy', body: 'steps...', topic_id: 'attacker' },
        context: { threadId: 'trusted-thread' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(saveProcedure.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('saves trusted channel procedures without thread memory scope', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-channel', title: 'Deploy' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-channel',
        action: 'procedure_save',
        payload: { title: 'Deploy', body: 'steps...' },
        context: { chatJid: 'sl:C123', threadId: 'thread-7' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveProcedure).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'channel',
        channelId: 'conversation:sl:C123',
      }),
    );
    expect(saveProcedure.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('uses trusted memory user context for user-scoped procedures', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-user', title: 'Travel' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-user',
        action: 'procedure_save',
        payload: {
          title: 'Travel',
          body: 'Book direct flights.',
          scope: 'user',
          user_id: 'attacker',
        },
        context: { userId: 'trusted-user', defaultScope: 'user' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveProcedure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'trusted-user',
        subjectType: 'user',
      }),
    );
    expect(saveProcedure.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('honors explicit group scope for procedures instead of DM default scope', async () => {
    vi.resetModules();
    const saveProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-group', title: 'Escalation' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-group',
        action: 'procedure_save',
        payload: {
          title: 'Escalation',
          body: 'Post in the shared incident conversation.',
          scope: 'group',
        },
        context: { userId: 'trusted-user', defaultScope: 'user' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveProcedure).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'group',
      }),
    );
    expect(saveProcedure.mock.calls[0]?.[0]).not.toHaveProperty('userId');
  });

  it('handles procedure_patch action', async () => {
    vi.resetModules();
    const patchProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-patched', version: 2 });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({ patchProcedure }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-patch',
        action: 'procedure_patch',
        allowedActions: ['procedure_patch'],
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
      expect.objectContaining({
        id: 'proc-1',
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'group',
        subjectId: 'team',
        groupId: 'team',
        value: 'updated steps',
        expectedVersion: 1,
      }),
    );
  });

  it('returns error when memory_patch throws', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockMemoryService({
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
        allowedActions: ['memory_patch'],
        payload: { id: 'mem-1', expected_version: 99 },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('version conflict');
    expect(response.provider).toBe('postgres');
  });
});

describe('processMemoryRequest validation branches', () => {
  function mockValidatedService(overrides: Record<string, unknown> = {}) {
    const save =
      overrides.save ||
      overrides.saveMemory ||
      vi.fn().mockResolvedValue({ id: 'mem-1' });
    const patch =
      overrides.patch ||
      overrides.patchMemory ||
      vi.fn().mockResolvedValue({ id: 'mem-1' });
    return {
      getInstance: () => ({
        save,
        patch,
        triggerDreaming: vi.fn().mockResolvedValue({ runId: 'dream-1' }),
        ...overrides,
      }),
      resetForTest: () => undefined,
    };
  }

  it.each(['context', 'recent_work', 'project_fact'] as const)(
    'rejects unsupported memory kind %s before calling memory service',
    async (kind) => {
      vi.resetModules();
      const saveMemory = vi.fn().mockResolvedValue({ id: `mem-${kind}` });
      vi.doMock('@core/memory/app-memory-service.js', () => ({
        AppMemoryService: mockValidatedService({ saveMemory }),
      }));

      const { processMemoryRequest } =
        await import('@core/memory/memory-ipc.js');
      const response = await processMemoryRequest(
        {
          requestId: 'req-recent-work',
          action: 'memory_save',
          payload: {
            key: 'daily-work',
            value: 'shipped IPC hardening',
            kind,
          },
        },
        'team',
        false,
      );

      expect(response.ok).toBe(false);
      expect(response.error).toContain(
        'memory_save.kind must be one of preference, decision, fact, correction, or constraint',
      );
      expect(saveMemory).not.toHaveBeenCalled();
    },
  );

  it('defaults omitted memory kind before calling memory service', async () => {
    vi.resetModules();
    const saveMemory = vi.fn().mockResolvedValue({ id: 'mem-default-kind' });
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockValidatedService({ saveMemory }),
    }));

    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-default-kind',
        action: 'memory_save',
        payload: {
          key: 'daily-work',
          value: 'shipped IPC hardening',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: undefined }),
    );
  });

  it('rejects non-object payloads for memory_save', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockValidatedService(),
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
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockValidatedService(),
    }));
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const nonObject = await processMemoryRequest(
      {
        requestId: 'req-patch-non-object',
        action: 'memory_patch',
        allowedActions: ['memory_patch'],
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
        allowedActions: ['memory_patch'],
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
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockValidatedService(),
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
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: mockValidatedService(),
    }));
    const { processMemoryRequest } = await import('@core/memory/memory-ipc.js');

    const nonObject = await processMemoryRequest(
      {
        requestId: 'req-proc-patch-non-object',
        action: 'procedure_patch',
        allowedActions: ['procedure_patch'],
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
        allowedActions: ['procedure_patch'],
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

    const keys = createIpcResponseSigningKeyPair();
    const response = {
      ok: true as const,
      requestId: 'req-42',
      provider: 'postgres',
      data: { results: [1, 2, 3] },
    };

    writeMemoryResponse('team', 'req-42', response, keys.privateKeyPem);

    const responsesDir = path.join(tmpDir, 'memory-responses');
    const filePath = path.join(responsesDir, 'req-42.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written).toMatchObject(response);
    expect(
      verifyIpcResponsePayload(keys.publicKeyPem, response, written.signature),
    ).toBe(true);
    expect(fileMode(responsesDir)).toBe(0o700);
    expect(fileMode(filePath)).toBe(0o600);

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

    const keys = createIpcResponseSigningKeyPair();
    writeMemoryResponse(
      'team',
      'req-mkdir',
      {
        ok: false,
        requestId: 'req-mkdir',
        error: 'boom',
      },
      keys.privateKeyPem,
    );

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
