import { describe, expect, it } from 'vitest';

import { runBrainDreamBatch } from '@core/brain/brain-dreaming.js';

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
});
