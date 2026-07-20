import { describe, expect, it, vi } from 'vitest';

import {
  _testAppMemory,
  AppMemoryService,
} from '@core/memory/app-memory-service.js';
import {
  normalizeKind,
  parseItemSource,
} from '@core/memory/app-memory-canonical-codec.js';

function collectSqlParamValues(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as { constructor?: { name?: string }; value?: unknown };
  if (record.constructor?.name === 'Param') return [record.value];
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap(collectSqlParamValues) : [];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

function memoryRow(input: {
  id?: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  threadId?: string;
  version?: number;
  evidenceIds?: string[];
  isPinned?: boolean;
  retrievalCount?: number;
  totalScore?: number;
  maxScore?: number;
}) {
  return {
    id: input.id ?? 'mem_test',
    appId: input.appId,
    agentId: input.agentId,
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
      evidenceIds: input.evidenceIds ?? [],
      isPinned: input.isPinned ?? false,
      version: input.version ?? 1,
      ...(input.retrievalCount !== undefined
        ? { retrievalCount: input.retrievalCount }
        : {}),
      ...(input.totalScore !== undefined
        ? { totalScore: input.totalScore }
        : {}),
      ...(input.maxScore !== undefined ? { maxScore: input.maxScore } : {}),
    }),
    status: 'active',
    lastObservedAt: null,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
  };
}

describe('app-grade memory boundaries', () => {
  it('requires explicit agent context for normalized app memory boundaries', () => {
    expect(() => _testAppMemory.normalizeSubject({})).toThrow(
      /memory subject requires appId/,
    );

    const context = _testAppMemory.normalizeSubject({
      appId: 'default',
      agentId: 'agent:kai',
    });

    expect(context).toMatchObject({
      appId: 'default',
      agentId: 'agent:kai',
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
    });
    expect(context).not.toHaveProperty('threadId');
  });

  it('does not treat thread ids as top-level scope for user memory subjects', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'user',
      userId: 'user-1',
      threadId: 'thread-1',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'user',
      subjectId: 'user-1',
      userId: 'user-1',
    });
    expect(context).not.toHaveProperty('threadId');
  });

  it('normalizes public personId to the personal memory subject', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      personId: 'person-1',
      userId: 'provider-user-1',
      subjectType: 'user',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'user',
      subjectId: 'person-1',
      userId: 'person-1',
    });
  });

  it('maps channel ids to canonical conversation ids for persistence', () => {
    expect(_testAppMemory.conversationIdForChannel('sl:C123')).toBe(
      'conversation:sl:C123',
    );
    expect(
      _testAppMemory.conversationIdForChannel('conversation:sl:C123'),
    ).toBe('conversation:sl:C123');
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

  it('does not preserve retired project_fact as an active memory kind', () => {
    expect(normalizeKind('project_fact')).toBe('fact');
  });

  it('uses the trusted row agent id when decoded source metadata omits agentId', () => {
    const row = memoryRow({
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
    });
    const source = JSON.parse(row.sourceRefJson);
    delete source.subject.agentId;
    row.sourceRefJson = JSON.stringify(source);

    expect(parseItemSource(row).subject.agentId).toBe('agent-a');
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

  it('matches memory rows by whole group/channel without thread narrowing', () => {
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
    ).toBe(true);
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

  it('blocks secrets but allows benign prompt-injection discussion in memory evidence', async () => {
    const insertedRows: any[] = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => ({
          returning: vi.fn(async () => {
            insertedRows.push(value);
            return [value];
          }),
        })),
      })),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.recordEvidence({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        sourceType: 'manual',
        text: 'This evidence discusses prompt injection and system prompt handling.',
      }),
    ).resolves.toMatchObject({
      text: 'This evidence discusses prompt injection and system prompt handling.',
    });

    await expect(
      service.recordEvidence({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        sourceType: 'manual',
        text: 'api_key=abcdefghi',
      }),
    ).rejects.toThrow(/sensitive material blocked in memory evidence/);
    expect(insertedRows).toHaveLength(1);
  });

  it('blocks secrets but allows benign prompt-injection discussion in direct memory saves', async () => {
    const insertedRows: any[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => ({
          returning: vi.fn(async () => {
            insertedRows.push(value);
            return [value];
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.save({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        key: 'decision:security-discussion',
        value:
          'Discuss prompt injection, system prompt exposure, and ignore previous instructions examples as threat-model text.',
      }),
    ).resolves.toMatchObject({
      key: 'decision:security-discussion',
      value:
        'Discuss prompt injection, system prompt exposure, and ignore previous instructions examples as threat-model text.',
    });

    await expect(
      service.save({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        key: 'fact:secret',
        value: 'access_token=abcdefghi',
      }),
    ).rejects.toThrow(/sensitive material blocked in memory value/);
    expect(insertedRows).toHaveLength(1);
  });

  it('blocks secrets but allows benign prompt-injection discussion in memory patches', async () => {
    const current = memoryRow({
      id: 'mem_patch_security',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      version: 1,
    });
    const updated = {
      ...current,
      valueJson: JSON.stringify({
        value:
          'Track prompt injection, system prompt, and ignore previous instructions as benign discussion phrases.',
        why: null,
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

    await expect(
      service.patch({
        id: 'mem_patch_security',
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        value:
          'Track prompt injection, system prompt, and ignore previous instructions as benign discussion phrases.',
      }),
    ).resolves.toMatchObject({
      value:
        'Track prompt injection, system prompt, and ignore previous instructions as benign discussion phrases.',
    });

    await expect(
      service.patch({
        id: 'mem_patch_security',
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        value: 'password=abcdefghi',
      }),
    ).rejects.toThrow(/sensitive material blocked in memory patch/);
    expect(set).toHaveBeenCalledTimes(1);
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

    const valueJson = jsonRecord(set.mock.calls[0]![0].valueJson);
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
    const orderBy = vi.fn(() => ({
      limit: vi.fn(async () => [
        { row, lexicalScore: 0.02, vectorScore: 0, score: 0.083 },
      ]),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy,
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
    expect(orderBy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.item.id).toBe('mem_keyword');
    expect(results[0]?.reasons).toContain('lexical');
  });

  it('lists and searches rows saved with hashed persisted subject ids', async () => {
    const rows: any[] = [];
    const whereParams: unknown[][] = [];
    const db = {
      select: vi.fn((selection?: unknown) => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            whereParams.push(collectSqlParamValues(condition));
            const selectedRows = async () =>
              selection
                ? rows.map((row) => ({
                    row,
                    lexicalScore: 0.04,
                    vectorScore: 0,
                    score: 0.42,
                  }))
                : [];
            return {
              limit: vi.fn(selectedRows),
              orderBy: vi.fn(() => ({ limit: vi.fn(selectedRows) })),
            };
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => ({
          returning: vi.fn(async () => {
            rows[0] = value;
            return [value];
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);
    const saved = await service.save({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      kind: 'decision',
      key: 'decision:memory-visibility',
      value: 'Saved memory must remain visible after persistence.',
    });

    const persisted = rows[0]!;
    const source = jsonRecord(persisted.sourceRefJson);
    expect(saved.subjectId).toBe('kai');
    expect(persisted.subjectId).toMatch(/^msu_[a-f0-9]{32}$/);
    expect(persisted.subjectId).toBe(
      _testAppMemory.subjectIdFor(
        _testAppMemory.normalizeSubject({
          appId: 'default',
          agentId: 'agent:kai',
          groupId: 'kai',
        }),
      ),
    );
    expect(source.subject).toMatchObject({
      subjectType: 'group',
      subjectId: 'kai',
    });

    whereParams.length = 0;
    const listed = await service.list({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
    });
    const searched = await service.search({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      query: 'visibility',
    });

    expect(listed.map((item) => item.id)).toEqual([saved.id]);
    expect(searched.map((result) => result.item.id)).toEqual([saved.id]);
    expect(whereParams[0]).toContain(persisted.subjectId);
    expect(whereParams[1]).toContain(persisted.subjectId);
    expect(whereParams[0]).not.toContain('kai');
    expect(whereParams[1]).not.toContain('kai');
  });

  it('persists dreaming promotion metadata in source references', async () => {
    const rows: any[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => ({
          returning: vi.fn(async () => {
            rows[0] = value;
            return [value];
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    await service.save({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      kind: 'fact',
      key: 'fact:runtime-home',
      value: 'Runtime home defaults to ~/gantry.',
      source: 'dreaming',
      evidenceIds: ['mev-one'],
      dreamingPromotion: {
        runId: 'mdr-one',
        promotedAt: '2026-05-08T00:00:00.000Z',
        candidateId: 'mca-one',
      },
    });

    expect(jsonRecord(rows[0]!.sourceRefJson)).toMatchObject({
      source: 'dreaming',
      evidenceIds: ['mev-one'],
      promoted_by: 'dreaming',
      promoted_at: '2026-05-08T00:00:00.000Z',
      dream_run_id: 'mdr-one',
      dream_candidate_id: 'mca-one',
    });
  });

  it('demotes only dreaming-promoted active memory rows', async () => {
    const current = {
      ...memoryRow({
        id: 'mem_dreamed',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'group',
        subjectId: 'group-a',
        version: 3,
      }),
      sourceRefJson: JSON.stringify({
        subject: {
          agentId: 'agent-a',
          subjectType: 'group',
          subjectId: 'group-a',
        },
        source: 'dreaming',
        evidenceIds: ['mev-one'],
        isPinned: false,
        version: 3,
        promoted_by: 'dreaming',
        promoted_at: '2026-05-08T00:00:00.000Z',
        dream_run_id: 'mdr-one',
      }),
    };
    const set = vi.fn((value: any) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: current.id, ...value }]),
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

    await expect(
      service.demoteDreamingPromoted({
        id: 'mem_dreamed',
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        expectedVersion: 3,
      }),
    ).resolves.toEqual({ demoted: true });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'demoted',
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      }),
    );
    expect(jsonRecord(set.mock.calls[0]![0].sourceRefJson)).toMatchObject({
      promoted_by: 'dreaming',
      dream_run_id: 'mdr-one',
      demoted_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it('rejects demotion for memory not promoted by dreaming', async () => {
    const current = memoryRow({
      id: 'mem_manual',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [current]),
          })),
        })),
      })),
      update: vi.fn(),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.demoteDreamingPromoted({
        id: 'mem_manual',
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      }),
    ).rejects.toThrow(/only dreaming-promoted memory can be demoted/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('exposes retrieval metadata on search results from source references', async () => {
    const row = memoryRow({
      id: 'mem_recalled',
      appId: 'default',
      agentId: 'agent:kai',
      subjectType: 'group',
      subjectId: 'kai',
      version: 7,
      evidenceIds: ['mev_one', 'mev_two'],
      isPinned: true,
      retrievalCount: 4,
      totalScore: 1.25,
      maxScore: 0.75,
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [
                { row, lexicalScore: 0.04, vectorScore: 0, score: 0.75 },
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
      query: 'recall',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.item).toMatchObject({
      id: 'mem_recalled',
      subjectType: 'group',
      subjectId: 'kai',
      evidenceIds: ['mev_one', 'mev_two'],
      isPinned: true,
      version: 7,
      retrievalCount: 4,
      totalScore: 1.25,
      maxScore: 0.75,
    });
    expect(results[0]?.reasons).toContain('pinned');
  });

  it('exposes retrieval metadata on list results without changing broad thread visibility', async () => {
    const row = memoryRow({
      id: 'mem_broad',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      retrievalCount: 2,
      totalScore: 0.6,
      maxScore: 0.4,
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [
                { row, lexicalScore: 0, vectorScore: 0, score: 0.7 },
              ]),
            })),
          })),
        })),
      })),
    };
    const service = new AppMemoryService(db as any);

    const results = await service.list({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      threadId: 'thread-1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'mem_broad',
      subjectType: 'group',
      subjectId: 'group-a',
      retrievalCount: 2,
      totalScore: 0.6,
      maxScore: 0.4,
    });
    expect(results[0]?.threadId).toBeUndefined();
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

  it('keeps hydration recall read-only', async () => {
    const row = {
      row: memoryRow({
        id: 'mem_read_only',
        appId: 'default',
        agentId: 'agent:kai',
        subjectType: 'group',
        subjectId: 'kai',
      }),
      lexicalScore: 0.05,
      vectorScore: 0,
      score: 0.5,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [row]),
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

    const results = await service.searchForHydrationReadOnly({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      query: 'status',
    });

    expect(results.map((result) => result.item.id)).toEqual(['mem_read_only']);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not expose legacy default-user memories to group searches', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const limit = vi.fn(async () => []);
            return {
              limit,
              orderBy: vi.fn(() => ({ limit })),
            };
          }),
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

  it('ignores thread scope in upsert identity for whole-conversation memory', async () => {
    const whereParams: unknown[][] = [];
    const insertedRows: any[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            whereParams.push(collectSqlParamValues(condition));
            return {
              limit: vi.fn(async () => []),
              orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
            };
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => ({
          returning: vi.fn(async () => {
            insertedRows.push(value);
            return [value];
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const service = new AppMemoryService(db as any);

    await service.save({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      threadId: 'thread-1',
      key: 'decision:queue-policy',
      value: 'Use scoped queues for the whole conversation.',
    });
    await service.save({
      appId: 'default',
      agentId: 'agent:kai',
      groupId: 'kai',
      threadId: 'thread-2',
      key: 'decision:queue-policy',
      value: 'Use scoped queues for the whole conversation.',
    });

    expect(whereParams.some((params) => params.includes('thread-1'))).toBe(
      false,
    );
    expect(whereParams.some((params) => params.includes('thread-2'))).toBe(
      false,
    );
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]?.threadId).toBeNull();
    expect(insertedRows[1]?.threadId).toBeNull();
  });

  it('filters dreaming status by resolved subject without thread narrowing', async () => {
    const rows = [
      {
        id: 'mdr-channel-thread-1',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        threadId: 'thread-1',
        phase: 'all',
        status: 'completed',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:00:00.000Z',
        completedAt: '2026-05-08T00:01:00.000Z',
      },
      {
        id: 'mdr-channel-thread-2',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        threadId: 'thread-2',
        phase: 'all',
        status: 'completed',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:02:00.000Z',
        completedAt: '2026-05-08T00:03:00.000Z',
      },
      {
        id: 'mdr-user',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'user',
        subjectId: 'sl:U123',
        threadId: null,
        phase: 'all',
        status: 'completed',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:04:00.000Z',
        completedAt: '2026-05-08T00:05:00.000Z',
      },
    ];
    const whereParams: unknown[][] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            const params = collectSqlParamValues(condition);
            whereParams.push(params);
            const hasSubjectFilter =
              params.includes('channel') || params.includes('user');
            const selected = hasSubjectFilter
              ? rows.filter(
                  (row) =>
                    params.includes(row.appId) &&
                    params.includes(row.agentId) &&
                    params.includes(row.subjectType) &&
                    params.includes(row.subjectId),
                )
              : rows;
            return {
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => selected),
              })),
            };
          }),
        })),
      })),
    };
    const service = new AppMemoryService(db as any);

    const scoped = await service.dreamingStatus({
      appId: 'app-a',
      agentId: 'agent-a',
      channelId: 'conversation:sl:C123',
      threadId: 'thread-1',
    });

    expect(scoped.map((run) => run.runId)).toEqual([
      'mdr-channel-thread-1',
      'mdr-channel-thread-2',
    ]);
    expect(whereParams[0]).toEqual(
      expect.arrayContaining([
        'app-a',
        'agent-a',
        'channel',
        'conversation:sl:C123',
      ]),
    );
    expect(whereParams[0]).not.toContain('thread-1');

    const appWide = await service.dreamingStatus({
      appId: 'app-a',
      agentId: 'agent-a',
    });

    expect(appWide.map((run) => run.runId)).toEqual([
      'mdr-channel-thread-1',
      'mdr-channel-thread-2',
      'mdr-user',
    ]);
    expect(whereParams[1]).toEqual(['app-a', 'agent-a']);
  });
});

describe('app memory dreaming settings', () => {
  function createDreamingDb() {
    const inserted: any[] = [];
    const updated: any[] = [];
    const db: any = {};
    Object.assign(db, {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const limit = vi.fn(async () => []);
            return {
              limit,
              orderBy: vi.fn(() => ({ limit })),
            };
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: any) => {
          inserted.push(value);
          return {
            onConflictDoUpdate: vi.fn(async () => undefined),
            returning: vi.fn(async () => [value]),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: any) => {
          updated.push(value);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                const run =
                  inserted.find(
                    (row) =>
                      row &&
                      typeof row === 'object' &&
                      row.status === 'running' &&
                      typeof row.summaryJson === 'string',
                  ) || {};
                return [{ ...run, ...value }];
              }),
            })),
          };
        }),
      })),
      transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) =>
        work({ ...db, execute: vi.fn(async () => undefined) }),
      ),
    });
    return { db, inserted, updated };
  }

  it('rejects manual dreaming when memory.dreaming.enabled is false', async () => {
    vi.resetModules();
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: false,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
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
    vi.doUnmock('@core/config/memory.js');
  });

  it('records a failed dream run when embedding readiness validation fails', async () => {
    vi.resetModules();
    const validateConfiguration = vi.fn();
    const validateReady = vi.fn(async () => {
      throw new Error('broker unavailable');
    });
    const createEmbeddingProvider = vi.fn(() => ({
      isEnabled: () => true,
      validateConfiguration,
      validateReady,
      embedOne: vi.fn(),
      embedMany: vi.fn(),
    }));
    const runAppMemoryDreamPass = vi.fn();
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: true,
      MEMORY_DREAMING_EMBED_PROVIDER: 'test_embedder',
      MEMORY_DREAMING_EMBED_MODEL: 'test-embedding-model',
      MEMORY_EMBED_DIMENSIONS: 1536,
    }));
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      createEmbeddingProvider,
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    const { AppMemoryService: MockedAppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    const { db, inserted, updated } = createDreamingDb();
    const service = new MockedAppMemoryService(db as any);

    await expect(
      service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      summary: {
        stage: 'embedding_readiness',
        error: 'broker unavailable',
        embeddingProvider: 'test_embedder',
        embeddingModel: 'test-embedding-model',
      },
    });

    expect(createEmbeddingProvider).toHaveBeenCalledWith('test_embedder', {
      appId: 'app-a',
      model: 'test-embedding-model',
    });
    expect(validateConfiguration).toHaveBeenCalledOnce();
    expect(validateReady).toHaveBeenCalledOnce();
    expect(inserted).toContainEqual(
      expect.objectContaining({
        status: 'running',
        summaryJson: '{}',
      }),
    );
    expect(updated).toContainEqual(
      expect.objectContaining({
        status: 'failed',
      }),
    );
    expect(runAppMemoryDreamPass).not.toHaveBeenCalled();
    vi.doUnmock('@core/config/memory.js');
    vi.doUnmock('@core/memory/memory-embeddings.js');
    vi.doUnmock('@core/memory/app-memory-dreaming.js');
  });

  it('creates dreaming embedding providers with the configured dreaming model', async () => {
    vi.resetModules();
    const validateConfiguration = vi.fn();
    const validateReady = vi.fn(async () => undefined);
    const createEmbeddingProvider = vi.fn(() => ({
      isEnabled: () => true,
      validateConfiguration,
      validateReady,
      embedOne: vi.fn(),
      embedMany: vi.fn(),
    }));
    const runAppMemoryDreamPass = vi.fn(async () => []);
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: true,
      MEMORY_DREAMING_EMBED_PROVIDER: 'openai',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
      MEMORY_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      createEmbeddingProvider,
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    const { AppMemoryService: MockedAppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    const { db } = createDreamingDb();
    const service = new MockedAppMemoryService(db as any);

    await service.triggerDreaming({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
    });

    expect(createEmbeddingProvider).toHaveBeenCalledWith('openai', {
      appId: 'app-a',
      model: 'text-embedding-3-small',
    });
    expect(validateConfiguration).toHaveBeenCalledOnce();
    expect(validateReady).toHaveBeenCalledOnce();
    vi.doUnmock('@core/config/memory.js');
    vi.doUnmock('@core/memory/memory-embeddings.js');
    vi.doUnmock('@core/memory/app-memory-dreaming.js');
  });

  it('does not create an embedding provider when dreaming embeddings are disabled', async () => {
    vi.resetModules();
    const createEmbeddingProvider = vi.fn();
    const runAppMemoryDreamPass = vi.fn(async (input: any) => {
      await expect(
        input.storeDreamEmbedding({
          item: {
            id: 'mem-disabled',
            key: 'decision:no-vector-recall',
            value: 'Runtime recall remains lexical in this slice.',
          },
          contentHash: 'hash-disabled',
        }),
      ).resolves.toEqual({ status: 'disabled' });
      return [];
    });
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      createEmbeddingProvider,
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    const { AppMemoryService: MockedAppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    const { db } = createDreamingDb();
    const service = new MockedAppMemoryService(db as any);

    await expect(
      service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      summary: { decisions: 0 },
    });

    expect(createEmbeddingProvider).not.toHaveBeenCalled();
    expect(runAppMemoryDreamPass).toHaveBeenCalledOnce();
    vi.doUnmock('@core/config/memory.js');
    vi.doUnmock('@core/memory/memory-embeddings.js');
    vi.doUnmock('@core/memory/app-memory-dreaming.js');
  });

  it('uses the requested dreaming timeout for the run lease and pass deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
    vi.resetModules();
    const runAppMemoryDreamPass = vi.fn(async (input: any) => {
      expect(input.signal).toEqual(expect.any(AbortSignal));
      expect(input.remainingTimeoutMs()).toBeGreaterThan(0);
      expect(input.remainingTimeoutMs()).toBeLessThanOrEqual(90_000);
      return [];
    });
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, inserted } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      await expect(
        service.triggerDreaming({
          appId: 'app-a',
          agentId: 'agent-a',
          groupId: 'group-a',
          timeoutMs: 90_000,
        }),
      ).resolves.toMatchObject({
        status: 'completed',
      });

      expect(inserted).toContainEqual(
        expect.objectContaining({
          status: 'running',
          leaseExpiresAt: '2026-05-08T00:01:30.000Z',
        }),
      );
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
      vi.useRealTimers();
    }
  });

  it('bounds requested dreaming timeout by the scheduler work deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
    vi.resetModules();
    const runAppMemoryDreamPass = vi.fn(async (input: any) => {
      expect(input.signal).toEqual(expect.any(AbortSignal));
      expect(input.remainingTimeoutMs()).toBeGreaterThan(0);
      expect(input.remainingTimeoutMs()).toBeLessThanOrEqual(30_000);
      return [];
    });
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, inserted } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      await expect(
        service.triggerDreaming({
          appId: 'app-a',
          agentId: 'agent-a',
          groupId: 'group-a',
          timeoutMs: 90_000,
          deadlineAtMs: Date.now() + 30_000,
        }),
      ).resolves.toMatchObject({
        status: 'completed',
      });

      expect(inserted).toContainEqual(
        expect.objectContaining({
          status: 'running',
          leaseExpiresAt: '2026-05-08T00:00:30.000Z',
        }),
      );
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
      vi.useRealTimers();
    }
  });

  it('finalizes and rethrows overall dreaming deadline expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
    vi.resetModules();
    const runAppMemoryDreamPass = vi.fn(
      async (input: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
    );
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, updated } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      const expectation = expect(
        service.triggerDreaming({
          appId: 'app-a',
          agentId: 'agent-a',
          groupId: 'group-a',
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow('memory dreaming deadline exceeded after 5000ms');
      await vi.advanceTimersByTimeAsync(5_001);
      await expectation;
      expect(updated).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          summaryJson: expect.stringContaining('dreaming_timeout'),
        }),
      );
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
      vi.useRealTimers();
    }
  });

  it('dedupes concurrent dreaming by returning the running run for the same subject and phase', async () => {
    vi.resetModules();
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const runningRow = {
        id: 'mdr-running',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'group',
        subjectId: 'group-a',
        threadId: 'thread-1',
        phase: 'deep',
        status: 'running',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:00:00.000Z',
        completedAt: null,
      };
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => [runningRow]),
              })),
            })),
          })),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      const service = new MockedAppMemoryService(db as any);

      const run = await service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        threadId: 'thread-1',
        phase: 'deep',
      });

      expect(run).toMatchObject({
        runId: 'mdr-running',
        status: 'running',
        phase: 'deep',
      });
      expect(run).not.toHaveProperty('threadId');
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@core/config/memory.js');
    }
  });

  it('recovers stale running dream rows before acquiring a replacement run', async () => {
    vi.resetModules();
    const runAppMemoryDreamPass = vi.fn(async () => []);
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, inserted, updated } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      const run = await service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        threadId: 'thread-1',
        phase: 'deep',
      });

      expect(run).toMatchObject({
        status: 'completed',
        phase: 'deep',
      });
      expect(updated[0]).toMatchObject({
        status: 'failed',
      });
      expect(JSON.parse(updated[0].summaryJson)).toMatchObject({
        stage: 'stale_running_recovery',
        supersededByPhase: 'deep',
      });
      expect(inserted).toContainEqual(
        expect.objectContaining({
          status: 'running',
          phase: 'deep',
          leaseExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        }),
      );
      expect(runAppMemoryDreamPass).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
    }
  });

  it('treats a running all-phase dream as a conflict for concrete IPC/control phases', async () => {
    vi.resetModules();
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const runningRow = {
        id: 'mdr-all-running',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'group',
        subjectId: 'group-a',
        threadId: null,
        phase: 'all',
        status: 'running',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:00:00.000Z',
        leaseExpiresAt: '2026-05-08T00:20:00.000Z',
        completedAt: null,
      };
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(async () => [runningRow]),
                })),
              };
            }),
          })),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      const service = new MockedAppMemoryService(db as any);

      const run = await service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        phase: 'deep',
      });

      expect(run).toMatchObject({
        runId: 'mdr-all-running',
        phase: 'all',
        status: 'running',
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(_testAppMemory.conflictingDreamPhases('deep')).toEqual([
        'deep',
        'all',
      ]);
    } finally {
      vi.doUnmock('@core/config/memory.js');
    }
  });

  it('treats running concrete light dreams as conflicts for scheduler all-phase acquisition', async () => {
    vi.resetModules();
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
      MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
      MEMORY_DREAMING_EMBED_MODEL: 'text-embedding-3-small',
    }));
    try {
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const runningRow = {
        id: 'mdr-light-running',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'group',
        subjectId: 'group-a',
        threadId: null,
        phase: 'light',
        status: 'running',
        summaryJson: '{}',
        startedAt: '2026-05-08T00:00:00.000Z',
        leaseExpiresAt: '2026-05-08T00:20:00.000Z',
        completedAt: null,
      };
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(async () => [runningRow]),
                })),
              };
            }),
          })),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      const service = new MockedAppMemoryService(db as any);

      const run = await service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
        phase: 'all',
      });

      expect(run).toMatchObject({
        runId: 'mdr-light-running',
        phase: 'light',
        status: 'running',
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(_testAppMemory.conflictingDreamPhases('all')).toEqual([
        'all',
        'light',
        'rem',
        'deep',
      ]);
    } finally {
      vi.doUnmock('@core/config/memory.js');
    }
  });

  it('bounds hanging embedding readiness validation and finalizes a failed run', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const validateReady = vi.fn(
        (_options?: { signal?: AbortSignal }) =>
          new Promise<void>(() => undefined),
      );
      const createEmbeddingProvider = vi.fn(() => ({
        isEnabled: () => true,
        validateConfiguration: vi.fn(),
        validateReady,
        embedOne: vi.fn(),
        embedMany: vi.fn(),
      }));
      const runAppMemoryDreamPass = vi.fn();
      vi.doMock('@core/config/memory.js', () => ({
        RUNTIME_MEMORY_ENABLED: true,
        RUNTIME_MEMORY_DREAMING_ENABLED: true,
        MEMORY_DREAMING_EMBEDDINGS_ENABLED: true,
        MEMORY_DREAMING_EMBED_PROVIDER: 'test_embedder',
        MEMORY_DREAMING_EMBED_MODEL: 'test-embedding-model',
        MEMORY_EMBED_DIMENSIONS: 1536,
      }));
      vi.doMock('@core/memory/memory-embeddings.js', () => ({
        createEmbeddingProvider,
      }));
      vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
        runAppMemoryDreamPass,
      }));
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, inserted, updated } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      const triggerPromise = service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      });
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await triggerPromise;

      expect(result).toMatchObject({
        status: 'failed',
        summary: {
          stage: 'embedding_readiness',
          embeddingProvider: 'test_embedder',
          embeddingModel: 'test-embedding-model',
        },
      });
      expect(String(result.summary.error)).toContain('deadline exceeded');
      expect(validateReady).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(inserted).toContainEqual(
        expect.objectContaining({
          status: 'running',
          leaseExpiresAt: expect.any(String),
        }),
      );
      expect(updated).toContainEqual(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(runAppMemoryDreamPass).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/memory-embeddings.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
      vi.useRealTimers();
    }
  });

  it('times out hanging dream embeddings and continues with retryable blocked decisions', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const embedOne = vi.fn(() => new Promise<number[]>(() => undefined));
      const createEmbeddingProvider = vi.fn(() => ({
        isEnabled: () => true,
        validateConfiguration: vi.fn(),
        validateReady: vi.fn(async () => undefined),
        embedOne,
        embedMany: vi.fn(),
      }));
      const runAppMemoryDreamPass = vi.fn(async (input: any) => {
        const embedResult = await input.storeDreamEmbedding({
          item: {
            id: 'mem-embed-timeout',
            key: 'decision:embed-timeout',
            value: 'Dreaming embeddings must be bounded by deadlines.',
            why: 'Slow embeddings must not block maintenance forever.',
          },
          contentHash: 'hash-timeout',
        });
        expect(embedResult).toMatchObject({
          status: 'retryable',
        });
        expect(String(embedResult.reason)).toContain('deadline exceeded');
        return [{ action: 'promote' }, { action: 'blocked' }];
      });
      vi.doMock('@core/config/memory.js', () => ({
        RUNTIME_MEMORY_ENABLED: true,
        RUNTIME_MEMORY_DREAMING_ENABLED: true,
        MEMORY_DREAMING_EMBEDDINGS_ENABLED: true,
        MEMORY_DREAMING_EMBED_PROVIDER: 'test_embedder',
        MEMORY_DREAMING_EMBED_MODEL: 'test-embedding-model',
        MEMORY_EMBED_DIMENSIONS: 1536,
      }));
      vi.doMock('@core/memory/memory-embeddings.js', () => ({
        createEmbeddingProvider,
      }));
      vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
        runAppMemoryDreamPass,
      }));
      const { AppMemoryService: MockedAppMemoryService } =
        await import('@core/memory/app-memory-service.js');
      const { db, inserted } = createDreamingDb();
      const service = new MockedAppMemoryService(db as any);

      const triggerPromise = service.triggerDreaming({
        appId: 'app-a',
        agentId: 'agent-a',
        groupId: 'group-a',
      });
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await triggerPromise;

      expect(result).toMatchObject({
        status: 'completed',
        summary: {
          decisions: 2,
          promoted: 1,
          blocked: 1,
        },
      });
      expect(embedOne).toHaveBeenCalledTimes(1);
      expect(inserted).toContainEqual(
        expect.objectContaining({
          itemId: 'mem-embed-timeout',
          provider: 'test_embedder',
          model: 'test-embedding-model',
          contentHash: 'hash-timeout',
          embeddingJson: null,
          status: 'retryable_error',
        }),
      );
    } finally {
      vi.doUnmock('@core/config/memory.js');
      vi.doUnmock('@core/memory/memory-embeddings.js');
      vi.doUnmock('@core/memory/app-memory-dreaming.js');
      vi.useRealTimers();
    }
  });

  it('records retryable dream embedding failures without failing applied memory decisions', async () => {
    vi.resetModules();
    const embedOne = vi.fn(async () => {
      throw new Error('temporary embedding outage');
    });
    const createEmbeddingProvider = vi.fn(() => ({
      isEnabled: () => true,
      validateConfiguration: vi.fn(),
      validateReady: vi.fn(async () => undefined),
      embedOne,
      embedMany: vi.fn(),
    }));
    const runAppMemoryDreamPass = vi.fn(async (input: any) => {
      await expect(
        input.storeDreamEmbedding({
          item: {
            id: 'mem-embed',
            key: 'decision:queue-policy',
            value: 'Runtime queue policy belongs under runtime.queue.',
            why: 'Queue policy is runtime configuration.',
          },
          contentHash: 'hash-embed',
        }),
      ).resolves.toMatchObject({ status: 'retryable' });
      return [{ action: 'promote' }, { action: 'blocked' }];
    });
    vi.doMock('@core/config/memory.js', () => ({
      RUNTIME_MEMORY_ENABLED: true,
      RUNTIME_MEMORY_DREAMING_ENABLED: true,
      MEMORY_DREAMING_EMBEDDINGS_ENABLED: true,
      MEMORY_DREAMING_EMBED_PROVIDER: 'test_embedder',
      MEMORY_DREAMING_EMBED_MODEL: 'test-embedding-model',
      MEMORY_EMBED_DIMENSIONS: 1536,
    }));
    vi.doMock('@core/memory/memory-embeddings.js', () => ({
      createEmbeddingProvider,
    }));
    vi.doMock('@core/memory/app-memory-dreaming.js', () => ({
      runAppMemoryDreamPass,
    }));
    const { AppMemoryService: MockedAppMemoryService } =
      await import('@core/memory/app-memory-service.js');
    const { db, inserted } = createDreamingDb();
    const service = new MockedAppMemoryService(db as any);

    const result = await service.triggerDreaming({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
    });

    expect(result).toMatchObject({
      status: 'completed',
      summary: {
        decisions: 2,
        promoted: 1,
        blocked: 1,
      },
    });
    expect(embedOne).toHaveBeenCalledWith(
      [
        'decision:queue-policy',
        'Runtime queue policy belongs under runtime.queue.',
        'Queue policy is runtime configuration.',
      ].join('\n'),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(createEmbeddingProvider).toHaveBeenCalledWith('test_embedder', {
      appId: 'app-a',
      model: 'test-embedding-model',
    });
    expect(inserted).toContainEqual(
      expect.objectContaining({
        itemId: 'mem-embed',
        provider: 'test_embedder',
        model: 'test-embedding-model',
        contentHash: 'hash-embed',
        embeddingJson: null,
        status: 'retryable_error',
        error: 'temporary embedding outage',
      }),
    );
    vi.doUnmock('@core/config/memory.js');
    vi.doUnmock('@core/memory/memory-embeddings.js');
    vi.doUnmock('@core/memory/app-memory-dreaming.js');
  });
});
