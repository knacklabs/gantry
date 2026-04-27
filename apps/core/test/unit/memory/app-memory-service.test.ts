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
});
