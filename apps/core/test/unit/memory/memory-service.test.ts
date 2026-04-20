import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryService } from '@core/memory/memory-service.js';
import type { MemoryItem, MemoryProcedure } from '@core/memory/memory-types.js';

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: overrides.id || 'item-1',
    scope: overrides.scope || 'group',
    group_folder: overrides.group_folder || 'team',
    user_id: overrides.user_id ?? null,
    kind: overrides.kind || 'fact',
    key: overrides.key || 'fact:key',
    value: overrides.value || 'value',
    why: overrides.why,
    load_bearing: overrides.load_bearing,
    source_turn_id: overrides.source_turn_id ?? null,
    source: overrides.source || 'agent',
    confidence: overrides.confidence ?? 0.8,
    is_pinned: overrides.is_pinned ?? false,
    version: overrides.version ?? 1,
    last_used_at: overrides.last_used_at ?? null,
    last_retrieved_at: overrides.last_retrieved_at ?? null,
    retrieval_count: overrides.retrieval_count ?? 0,
    total_score: overrides.total_score ?? 0,
    max_score: overrides.max_score ?? 0,
    query_hashes_json: overrides.query_hashes_json || '[]',
    recall_days_json: overrides.recall_days_json || '[]',
    embedding_json: overrides.embedding_json ?? null,
    created_at: overrides.created_at || now,
    updated_at: overrides.updated_at || now,
  };
}

function makeProcedure(
  overrides: Partial<MemoryProcedure> = {},
): MemoryProcedure {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: overrides.id || 'proc-1',
    scope: overrides.scope || 'group',
    group_folder: overrides.group_folder || 'team',
    title: overrides.title || 'Deploy',
    body: overrides.body || 'Run build and tests.',
    tags: overrides.tags || [],
    origin: overrides.origin,
    trigger: overrides.trigger ?? null,
    source: overrides.source || 'agent',
    confidence: overrides.confidence ?? 0.8,
    version: overrides.version ?? 1,
    last_used_at: overrides.last_used_at ?? null,
    created_at: overrides.created_at || now,
    updated_at: overrides.updated_at || now,
  };
}

function makeServiceFixture() {
  let saveCounter = 0;
  const savedItems: MemoryItem[] = [];

  const store = {
    providerName: 'mock-store',
    close: vi.fn(),
    getCachedEmbedding: vi.fn(() => null),
    putCachedEmbedding: vi.fn(),
    listIndexedFiles: vi.fn(() => []),
    getItemByFilePath: vi.fn(() => null),
    markItemEmbeddingPending: vi.fn(),
    listTopItems: vi.fn(() => []),
    listTopProcedures: vi.fn(() => []),
    getProcedureById: vi.fn(() => null),
    patchProcedure: vi.fn(),
    touchItem: vi.fn(),
    recordEvent: vi.fn(),
    applyRetentionPolicies: vi.fn(() => ({
      removedItemIds: [],
      removedProcedureIds: [],
      evictedChunkIds: [],
    })),
    softDeleteItem: vi.fn(),
    findItemByKey: vi.fn(() => null),
    findSimilarItems: vi.fn(() => []),
    patchItem: vi.fn(),
    pinItem: vi.fn(),
    saveItemEmbedding: vi.fn(),
    setItemFileMetadata: vi.fn(),
    saveItem: vi.fn(
      (input: {
        scope: 'user' | 'group' | 'global';
        group_folder: string;
        user_id: string | null;
        key: string;
        value: string;
        kind: MemoryItem['kind'];
        source: string;
        confidence: number;
        why?: string;
        load_bearing?: boolean;
        source_turn_id?: string;
        is_pinned: boolean;
      }) => {
        saveCounter += 1;
        const saved = makeItem({
          id: `saved-${saveCounter}`,
          scope: input.scope,
          group_folder: input.group_folder,
          user_id: input.user_id,
          key: input.key,
          value: input.value,
          kind: input.kind,
          source: input.source,
          confidence: input.confidence,
          why: input.why,
          load_bearing: input.load_bearing,
          source_turn_id: input.source_turn_id || null,
          is_pinned: input.is_pinned,
        });
        savedItems.push(saved);
        return saved;
      },
    ),
    getLatestEvent: vi.fn(() => null),
    listActiveItems: vi.fn(() => []),
    searchItemsByText: vi.fn(() => []),
    lexicalSearch: vi.fn(() => []),
    vectorSearch: vi.fn(() => []),
  };

  const embeddings = {
    validateConfiguration: vi.fn(),
    isEnabled: vi.fn(() => false),
    embedOne: vi.fn(async () => [0.1, 0.2]),
    embedMany: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  };

  const extractor = {
    providerName: 'mock-extractor',
    extractFacts: vi.fn(async () => []),
  };
  const journal = {
    append: vi.fn(),
    close: vi.fn(),
  };

  const service = new MemoryService(
    store as unknown as ConstructorParameters<typeof MemoryService>[0],
    embeddings as unknown as ConstructorParameters<typeof MemoryService>[1],
    extractor as unknown as ConstructorParameters<typeof MemoryService>[2],
    journal as unknown as ConstructorParameters<typeof MemoryService>[3],
  );
  (
    service as unknown as { indexer: { indexFile: (p: string) => void } }
  ).indexer = {
    indexFile: vi.fn(),
  };

  return {
    service,
    store,
    embeddings,
    extractor,
    journal,
    savedItems,
  };
}

function makeTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-service-test-'));
  const filePath = path.join(dir, 'session-1.jsonl');
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  fs.writeFileSync(filePath, text, 'utf-8');
  return filePath;
}

afterEach(() => {
  MemoryService.closeInstance();
  vi.restoreAllMocks();
});

describe('MemoryService boundary extraction', () => {
  it('blocks direct sensitive memory writes outside extractor path', async () => {
    const fixture = makeServiceFixture();

    await expect(
      fixture.service.saveMemory(
        {
          scope: 'group',
          group_folder: 'team',
          key: 'credential:test',
          value: 'sk-ant-abcdefghijklmnopqrstuvwxyz123456',
          confidence: 0.9,
        },
        {
          isMain: false,
          groupFolder: 'team',
          actor: 'mcp-tool',
        },
      ),
    ).rejects.toThrow(/sensitive material blocked/i);

    expect(fixture.store.saveItem).not.toHaveBeenCalled();
    expect(fixture.store.recordEvent).toHaveBeenCalledWith(
      'sensitive_material_filtered',
      'memory_write',
      'team',
      expect.objectContaining({
        actor: 'mcp-tool',
        field: 'value',
        reason: 'provider_token',
      }),
    );
  });

  it('keeps writes successful when embedding persistence fails and records fallback telemetry', async () => {
    const fixture = makeServiceFixture();
    fixture.store.saveItemEmbedding.mockImplementation(() => {
      throw new Error('vec insert failed');
    });

    const saved = await fixture.service.saveMemory(
      {
        scope: 'group',
        group_folder: 'team',
        key: 'preference:style',
        value: 'Keep answers concise.',
        confidence: 0.9,
      },
      {
        isMain: false,
        groupFolder: 'team',
        actor: 'agent',
      },
    );

    expect(saved.id).toBe('saved-1');
    expect(fixture.store.recordEvent).toHaveBeenCalledWith(
      'memory_embedding_persist_failed',
      'memory_item',
      'saved-1',
      expect.objectContaining({
        fallback: 'keyword_only',
      }),
    );
  });

  it('saveMemory retries once on stale patch and succeeds with refreshed version', async () => {
    const fixture = makeServiceFixture();
    const existing = makeItem({
      id: 'item-stale',
      version: 2,
      key: 'preference:style',
      value: 'Verbose responses.',
    });
    const refreshed = makeItem({
      id: 'item-stale',
      version: 3,
      key: 'preference:style',
      value: 'Verbose responses.',
    });
    const patched = makeItem({
      id: 'item-stale',
      version: 4,
      key: 'preference:style',
      value: 'Concise responses.',
      source: 'agent',
      confidence: 0.9,
    });

    fixture.store.findItemByKey
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(refreshed);
    fixture.store.patchItem
      .mockImplementationOnce(() => {
        throw new Error('stale patch: expected version 2, current 3');
      })
      .mockReturnValueOnce(patched);

    const saved = await fixture.service.saveMemory(
      {
        scope: 'group',
        group_folder: 'team',
        key: 'preference:style',
        value: 'Concise responses.',
        why: 'Use short responses and no fluff.',
        confidence: 0.9,
      },
      {
        isMain: false,
        groupFolder: 'team',
      },
    );

    expect(saved.id).toBe('item-stale');
    expect(fixture.store.patchItem).toHaveBeenCalledTimes(2);
    expect(fixture.store.patchItem).toHaveBeenNthCalledWith(
      1,
      'item-stale',
      2,
      expect.objectContaining({
        key: 'preference:style',
        value: 'Concise responses.',
      }),
    );
    expect(fixture.store.patchItem).toHaveBeenNthCalledWith(
      2,
      'item-stale',
      3,
      expect.objectContaining({
        key: 'preference:style',
        value: 'Concise responses.',
      }),
    );
  });

  it('pinIfNeeded updates in-memory pin state after persisting pin', () => {
    const fixture = makeServiceFixture();
    const item = makeItem({
      id: 'pin-1',
      is_pinned: false,
      confidence: 0.95,
    });

    const changed = (fixture.service as any).pinIfNeeded(item);

    expect(changed).toBe(true);
    expect(item.is_pinned).toBe(true);
    expect(fixture.store.pinItem).toHaveBeenCalledWith('pin-1', true);
  });

  it('buildBrief renders decisions, facts, and procedures and touches items', async () => {
    const fixture = makeServiceFixture();
    fixture.store.listTopItems
      .mockReturnValueOnce([
        makeItem({
          id: 'g1',
          kind: 'decision',
          scope: 'group',
          value: 'Use pnpm for this repo.',
        }),
      ])
      .mockReturnValueOnce([
        makeItem({
          id: 'x1',
          kind: 'fact',
          scope: 'global',
          value: 'Runtime is Node.js.',
        }),
      ]);
    fixture.store.listTopProcedures.mockReturnValue([
      makeProcedure({
        id: 'p1',
        title: 'Release',
        body: 'Run build, run tests, then publish.',
      }),
    ]);

    const brief = await fixture.service.buildBrief({
      groupFolder: 'team',
      maxItems: 20,
    });

    expect(brief).toContain('## Memory Brief');
    expect(brief).toContain('### Active Decisions');
    expect(brief).toContain('Use pnpm for this repo.');
    expect(brief).toContain('### Facts');
    expect(brief).toContain('Runtime is Node.js.');
    expect(brief).toContain('### Procedures');
    expect(brief).toContain('**Release**');
    expect(fixture.store.touchItem).toHaveBeenCalledWith('g1');
    expect(fixture.store.touchItem).toHaveBeenCalledWith('x1');
  });

  it('buildBrief includes user-scoped items only when userId is provided', async () => {
    const fixture = makeServiceFixture();
    fixture.store.listTopItems
      .mockReturnValueOnce([
        makeItem({
          id: 'u1',
          scope: 'user',
          user_id: 'user-1',
          value: 'Ravi prefers terse replies.',
        }),
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    const brief = await fixture.service.buildBrief({
      groupFolder: 'team',
      maxItems: 20,
      userId: 'user-1',
    });

    expect(brief).toContain('Ravi prefers terse replies.');
  });

  it('extractFromTranscript saves extracted facts and applies supersedes within scope', async () => {
    const fixture = makeServiceFixture();
    const transcriptPath = makeTranscript([
      {
        type: 'user',
        message: { content: 'Use short responses and no fluff.' },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Understood.' }] },
      },
    ]);

    fixture.store.listTopItems
      .mockReturnValueOnce([
        makeItem({
          id: 'old-user',
          scope: 'user',
          user_id: 'user-99',
          key: 'preference:style',
          value: 'Verbose.',
        }),
      ])
      .mockReturnValueOnce([
        makeItem({
          id: 'old-group',
          scope: 'group',
          key: 'decision:style',
          value: 'Verbose style.',
        }),
      ])
      .mockReturnValueOnce([]);

    fixture.extractor.extractFacts.mockResolvedValue([
      {
        scope: 'user',
        kind: 'preference',
        key: 'preference:concise',
        value: 'Ravi prefers concise responses without fluff.',
        why: 'Use short responses and no fluff.',
        confidence: 0.95,
      },
      {
        scope: 'group',
        kind: 'decision',
        key: 'decision:concise-style',
        value: 'Team responses should stay concise.',
        why: 'Use short responses and no fluff.',
        confidence: 0.88,
        supersedes: ['old-group'],
      },
      {
        scope: 'global',
        kind: 'fact',
        key: 'fact:skip-global',
        value: 'This should not be saved from extraction.',
        why: 'Use short responses and no fluff.',
        confidence: 0.91,
      },
    ]);

    await fixture.service.extractFromTranscript({
      transcriptPath,
      trigger: 'precompact',
      groupFolder: 'team',
      sessionId: 'session-1',
    });

    expect(fixture.savedItems).toHaveLength(2);
    expect(fixture.savedItems[0].scope).toBe('group');
    expect(fixture.savedItems[0].key).toBe('preference:concise');
    expect(fixture.savedItems[1].scope).toBe('group');
    expect(fixture.savedItems[1].source).toBe('precompact');
    expect(fixture.store.softDeleteItem).toHaveBeenCalledWith(
      'old-group',
      'saved-2',
    );
  });

  it('extractFromTranscript records zero-fact event when no valid turns exist', async () => {
    const fixture = makeServiceFixture();
    const transcriptPath = makeTranscript([
      { type: 'system', message: { content: 'ignored' } },
      { type: 'tool', message: { content: 'ignored' } },
    ]);

    await fixture.service.extractFromTranscript({
      transcriptPath,
      trigger: 'session-end',
      groupFolder: 'team',
      sessionId: 'session-1',
    });

    expect(fixture.extractor.extractFacts).not.toHaveBeenCalled();
    expect(fixture.store.recordEvent).toHaveBeenCalledWith(
      'reflection_completed',
      'reflection',
      'team',
      expect.objectContaining({ facts_extracted: 0, facts_saved: 0 }),
    );
  });

  it('extractFromTranscript records extractor token usage when reported', async () => {
    const fixture = makeServiceFixture();
    const transcriptPath = makeTranscript([
      {
        type: 'user',
        message: { content: 'Keep responses concise.' },
      },
      {
        type: 'assistant',
        message: { content: 'Understood.' },
      },
    ]);

    fixture.extractor.extractFacts.mockImplementationOnce(async (input) => {
      input.onUsage?.({
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 120,
        output_tokens: 33,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      });
      return [];
    });

    await fixture.service.extractFromTranscript({
      transcriptPath,
      trigger: 'precompact',
      groupFolder: 'team',
      sessionId: 'session-1',
    });

    expect(fixture.store.recordEvent).toHaveBeenCalledWith(
      'memory_extractor_usage',
      'memory_extractor',
      'team',
      expect.objectContaining({
        trigger: 'precompact',
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 120,
        output_tokens: 33,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      }),
    );
  });

  it('patchProcedure deletes stale markdown file when title slug changes', () => {
    const fixture = makeServiceFixture();
    const existing = makeProcedure({
      id: 'proc-1',
      title: 'Old Title',
      group_folder: 'team',
      source: 'agent',
    });
    const patched = makeProcedure({
      id: 'proc-1',
      title: 'New Title',
      group_folder: 'team',
      source: 'agent',
      version: 2,
    });
    fixture.store.getProcedureById.mockReturnValue(existing);
    fixture.store.patchProcedure.mockReturnValue(patched);

    const removeSpy = vi.spyOn(
      fixture.service as unknown as {
        removeManagedMemoryFile: (
          filePath: string,
          managedSubdir: string,
        ) => void;
      },
      'removeManagedMemoryFile',
    );

    const result = fixture.service.patchProcedure(
      {
        id: 'proc-1',
        expected_version: 1,
        title: 'New Title',
      },
      {
        isMain: false,
        groupFolder: 'team',
      },
    );

    expect(result.title).toBe('New Title');
    expect(removeSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.join('procedures', 'old-title-proc-1.md')),
      'procedures',
    );
  });

  it('does not delete stale item file paths outside memory root', async () => {
    const fixture = makeServiceFixture();
    const outsideFilePath = path.join(os.tmpdir(), 'outside-memory-root.md');
    const existing = makeItem({
      id: 'item-outside',
      key: 'preference:style',
      value: 'Verbose responses.',
      source: 'agent',
      file_path: outsideFilePath,
      content_hash: 'old-hash',
      indexed_at: '2026-01-01T00:00:00.000Z',
    });
    const patched = makeItem({
      ...existing,
      value: 'Concise responses.',
      version: 2,
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    fixture.store.findItemByKey.mockReturnValue(existing);
    fixture.store.patchItem.mockReturnValue(patched);

    const rmSpy = vi.spyOn(fs, 'rmSync');

    await fixture.service.saveMemory(
      {
        scope: 'group',
        group_folder: 'team',
        key: 'preference:style',
        value: 'Concise responses.',
        confidence: 0.9,
      },
      {
        isMain: false,
        groupFolder: 'team',
        actor: 'agent',
      },
    );

    expect(rmSpy).not.toHaveBeenCalledWith(path.resolve(outsideFilePath), {
      force: true,
    });
  });

  it('treats missing cache usage fields as zero for counters', async () => {
    const fixture = makeServiceFixture();
    const transcriptPath = makeTranscript([
      { type: 'user', message: { content: 'Remember this preference.' } },
      { type: 'assistant', message: { content: 'Done.' } },
    ]);
    const before = MemoryService.getCountersSnapshot();

    fixture.extractor.extractFacts.mockImplementationOnce(async (input) => {
      input.onUsage?.({
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 42,
        output_tokens: 7,
      });
      return [];
    });

    await fixture.service.extractFromTranscript({
      transcriptPath,
      trigger: 'precompact',
      groupFolder: 'team',
      sessionId: 'session-2',
    });

    const after = MemoryService.getCountersSnapshot();
    expect(after.cache_read_tokens_total - before.cache_read_tokens_total).toBe(
      0,
    );
    expect(
      after.cache_creation_tokens_total - before.cache_creation_tokens_total,
    ).toBe(0);
  });
});
