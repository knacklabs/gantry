import { describe, expect, it, vi } from 'vitest';

import { runBrainDreamBatch } from '@core/brain/brain-dreaming.js';
import type { BrainPage } from '@core/brain/brain-types.js';

describe('brain dreaming dependencies', () => {
  it('requires a review repository for non-observer dreaming', async () => {
    await expect(
      runBrainDreamBatch({
        brain: {} as never,
        repository: {} as never,
        appId: 'default',
      }),
    ).rejects.toThrow('Brain dreaming requires a review repository.');
  });

  it('allows observer-only dreaming without a review repository', async () => {
    const result = await runBrainDreamBatch({
      brain: {} as never,
      repository: {
        getDreamCursor: async () => null,
        listPagesForDream: async () => [],
      } as never,
      appId: 'default',
      observer: {
        enabled: true,
        ownerRecipient: 'owner',
        cursorSubject: 'observer:app',
        repository: {
          getInsightCursor: async () => null,
        } as never,
        patterns: {} as never,
        activeMemory: {} as never,
        embedding: {
          isEnabled: () => false,
        } as never,
        embeddingModel: 'test',
        embeddingDimensions: 1,
      },
    });

    expect(result.pages).toBe(0);
    expect(result.observer?.persisted).toBe(0);
  });

  it('journals observer destructive operations without a review repository', async () => {
    const journalDreamDecision = vi.fn();
    const saveDreamCursor = vi.fn();
    const result = await runBrainDreamBatch({
      brain: {} as never,
      repository: {
        getDreamCursor: async () => null,
        listPagesForDream: async () => [page],
        graphForPages: async () => ({ entities: [], edges: [] }),
        journalDreamDecision,
        saveDreamCursor,
      } as never,
      appId: 'default',
      proposer: {
        propose: async () => ({
          operations: [{ action: 'delete_page', pageId: page.id }],
          surfaceableInsights: [],
        }),
      },
      observer: {
        enabled: true,
        ownerRecipient: 'owner',
        cursorSubject: 'observer:app',
        repository: {
          getInsightCursor: async () => null,
        } as never,
        patterns: {} as never,
        activeMemory: {} as never,
        embedding: {
          isEnabled: () => false,
        } as never,
        embeddingModel: 'test',
        embeddingDimensions: 1,
      },
    });

    expect(result.proposed).toBe(1);
    expect(journalDreamDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        pageId: page.id,
        op: { action: 'delete_page', pageId: page.id },
        outcome: 'proposed',
        reason: 'delete_page was journaled by observer dreaming without review',
      }),
    );
    expect(saveDreamCursor).toHaveBeenCalledOnce();
  });
});

const page: BrainPage = {
  id: 'page-1',
  appId: 'default',
  slug: 'channel-page',
  title: 'Channel page',
  markdown: 'The team will ship on Friday.',
  sourceKind: 'channel',
  sourceRef: 'slack-one:slack:C123#2026-07-22',
  authorId: null,
  metadata: {},
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};
