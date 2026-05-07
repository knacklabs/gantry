import { describe, expect, it, vi } from 'vitest';

import {
  _testAppMemory,
  AppMemoryService,
} from '@core/memory/app-memory-service.js';

function memoryRow(input: {
  id?: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  threadId?: string;
  version?: number;
}) {
  return {
    id: input.id ?? 'mem_test',
    appId: input.appId,
    subjectId: `subject:${input.subjectId}`,
    kind: 'fact',
    key: 'key',
    valueJson: JSON.stringify({ value: 'value', why: null }),
    confidence: 0.7,
    sourceRefJson: JSON.stringify({
      subject: {
        agentId: input.agentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
      source: 'test',
      evidenceIds: [],
      isPinned: false,
      version: input.version ?? 1,
    }),
    status: 'active',
    lastObservedAt: null,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
  };
}

describe('app-grade memory boundaries', () => {
  it('normalizes personal defaults without relying on storage providers', () => {
    const context = _testAppMemory.normalizeSubject({});

    expect(context).toMatchObject({
      appId: 'default',
      agentId: 'agent:personal',
      subjectType: 'group',
      subjectId: 'default',
    });
  });

  it('uses channel boundaries when channel context is present', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      userId: 'user-1',
      groupId: 'workspace-1',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'channel',
      subjectId: 'sl:C123',
      userId: 'user-1',
      groupId: 'workspace-1',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });
  });

  it('maps channel ids to canonical conversation ids for persistence', () => {
    expect(_testAppMemory.conversationIdForChannel('sl:C123')).toBe(
      'conversation:sl:C123',
    );
    expect(_testAppMemory.conversationIdForChannel(undefined)).toBeNull();
  });

  it('keeps common memory as an explicit app subject', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'common',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'common',
      subjectId: 'common',
    });
  });

  it('rejects invalid boundary identifiers', () => {
    expect(() =>
      _testAppMemory.normalizeSubject({
        appId: '../bad',
        agentId: 'agent',
      }),
    ).toThrow(/Invalid memory id/);
  });

  it('matches owned rows only inside the same normalized subject boundary', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });
    const row = memoryRow({
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'channel',
      subjectId: 'sl:C123',
      threadId: 'thread-1',
    });

    expect(_testAppMemory.itemMatchesSubjectBoundary(row, context)).toBe(true);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(
        memoryRow({
          appId: 'app-a',
          agentId: 'agent-a',
          subjectType: 'channel',
          subjectId: 'sl:C999',
          threadId: 'thread-1',
        }),
        context,
      ),
    ).toBe(false);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(
        memoryRow({
          appId: 'app-a',
          agentId: 'agent-b',
          subjectType: 'channel',
          subjectId: 'sl:C123',
          threadId: 'thread-1',
        }),
        context,
      ),
    ).toBe(false);
  });

  it('allows broad memories in threaded contexts but blocks threaded rows from broad patch/delete contexts', () => {
    const threadedContext = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      threadId: 'thread-1',
    });
    const broadContext = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
    });
    const broadRow = memoryRow({
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
    });
    const threadedRow = memoryRow({
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      threadId: 'thread-1',
    });

    expect(
      _testAppMemory.itemMatchesSubjectBoundary(broadRow, threadedContext),
    ).toBe(true);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(threadedRow, broadContext),
    ).toBe(false);
  });

  it('rejects non-admin patches to common memory', async () => {
    const commonRow = memoryRow({
      id: 'mem_common',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'common',
      subjectId: 'common',
      version: 1,
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [commonRow]),
          })),
        })),
      })),
      update: vi.fn(),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.patch({
        id: 'mem_common',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'common',
        subjectId: 'common',
        value: 'changed',
      }),
    ).rejects.toThrow(/common memory patches require admin/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('recomputes content hash when patching memory content', async () => {
    const current = memoryRow({
      id: 'mem_patch',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      version: 1,
    });
    const updated = {
      ...current,
      valueJson: JSON.stringify({
        value: 'updated value',
        why: null,
        contentHash: 'placeholder',
      }),
      sourceRefJson: JSON.stringify({
        ...JSON.parse(current.sourceRefJson),
        version: 2,
      }),
    };
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [updated]),
      })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [current]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    };
    const service = new AppMemoryService(db as any);

    await service.patch({
      id: 'mem_patch',
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      value: 'updated value',
    });

    const valueJson = JSON.parse(set.mock.calls[0]![0].valueJson);
    expect(valueJson.value).toBe('updated value');
    expect(valueJson.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(valueJson.contentHash).not.toBe(
      JSON.parse(current.valueJson).contentHash,
    );
  });

  it('returns a typed conflict before renaming onto an existing subject key', async () => {
    const current = memoryRow({
      id: 'mem_current',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      version: 1,
    });
    const collision = {
      ...current,
      id: 'mem_collision',
      key: 'existing',
    };
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [current]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [collision]),
          })),
        })),
      });
    const db = {
      select,
      update: vi.fn(),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.patch({
        id: 'mem_current',
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        key: 'existing',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Memory key already exists for this subject',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('uses full-text search for embeddings-off recall', async () => {
    const row = {
      ...memoryRow({
        id: 'mem_keyword',
        appId: 'default',
        agentId: 'agent:kai',
        subjectType: 'group',
        subjectId: 'kai',
      }),
      key: 'persona:path',
      valueJson: JSON.stringify({
        value: 'Persona memory DB lives under ~/persona/state.sqlite.',
        why: null,
      }),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [
                { row, lexicalScore: 0.02, vectorScore: 0, score: 0.083 },
              ]),
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    const results = await service.search({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      query: 'state.sqlite',
    });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.item.id).toBe('mem_keyword');
    expect(results[0]?.reasons).toContain('lexical');
  });

  it('records recall metrics with one bulk memory item update', async () => {
    const rows = ['mem_one', 'mem_two'].map((id, index) => ({
      row: memoryRow({
        id,
        appId: 'default',
        agentId: 'agent:kai',
        subjectType: 'group',
        subjectId: 'kai',
      }),
      lexicalScore: 0.05,
      vectorScore: 0,
      score: 0.1 + index,
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => rows),
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    await service.search({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      query: 'status',
    });

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('does not expose legacy default-user memories to group searches', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    const results = await service.search({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      userId: '5759865942',
      query: 'sender ids',
    });

    expect(results).toHaveLength(0);
  });
});

describe('app memory dreaming settings', () => {
  it('rejects manual dreaming when memory.dreaming.enabled is false', async () => {
    vi.resetModules();
    vi.doMock('@core/config/memory-state.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: false,
      runtimeMemorySettings: { dreamingEnabled: false },
    }));
    const { AppMemoryService: MockedAppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    const db = {
      insert: vi.fn(),
    };
    const service = new MockedAppMemoryService(db as any);

    await expect(
      service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'memory dreaming is disabled in runtime settings',
    });
    expect(db.insert).not.toHaveBeenCalled();
    vi.doUnmock('@core/config/memory-state.js');
  });
});
